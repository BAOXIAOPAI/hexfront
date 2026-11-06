/**
 * 房间：内存里持有唯一真相（GameState）。
 *
 * 职责边界：
 * - 只管「谁能坐哪个位」「命令如何被裁决」「裁决后推给谁」
 * - 不做任何规则判断（全部交给 @hexfront/engine）
 * - 不用知道 WebSocket 是什么（SocketLike 只要求 send），方便单测与以后换传输层
 *
 * 广播时机由调用方（server）控制：join/start/leave 只改内存，调用 sync() 才推。
 * 这样 WELCOME 一定先于第一条 STATE 到达客户端。
 */

import {
  applyCommand,
  buildBoard,
  createGame,
  MAP_4P,
  PLAYER_COLORS,
  RESOURCES,
  viewFor,
  type Board,
  type Command,
  type GameEvent,
  type GameState,
  type PlayerColor,
  type PlayerView,
  type RejectReason,
  type ResourceCount,
} from '@hexfront/engine';
import {
  DEFAULT_SETTINGS,
  OFFER_SEND_COOLDOWN_MS,
  OFFER_TTL_MS,
  encode,
  type LobbyPlayer,
  type OfferEndReason,
  type OfferRejectReason,
  type OfferSnapshot,
  type OfferView,
  type RoomSettings,
  type ServerMessage,
} from './protocol.js';

export interface SocketLike {
  send(data: string): void;
}

export interface RoomOptions {
  board?: Board;
  /** 座位上限 2..4，默认 4 */
  capacity?: number;
  /** 可控时钟（毫秒）：测试用来推进 10 秒期限 / 3 秒冷却，避免真实等待 */
  now?: () => number;
}

export type JoinResult =
  | { ok: true; seat: number; view: PlayerView | null; reclaimed: boolean }
  | { ok: false; reason: 'ROOM_FULL' | 'IN_PROGRESS' | 'SEAT_TAKEN' };

export type StartResult =
  | { ok: true }
  | { ok: false; reason: 'NEED_MORE_PLAYERS' | 'ALREADY_STARTED' | 'NOT_SEATED' };

export type CommandOutcome =
  | { ok: true; seq: number; events: GameEvent[] }
  | { ok: false; reason: RejectReason | OfferRejectReason; detail?: string };

export type OfferOutcome =
  | { ok: true; offerId: string; seq?: number; events?: GameEvent[] }
  | { ok: false; reason: RejectReason | OfferRejectReason; detail?: string };

interface Member {
  seat: number;
  name: string;
  connected: boolean;
}

/** 房间内的活跃报价；order 只用于稳定排序，不进入对外视图 */
interface LiveOffer extends OfferView {
  order: number;
}

const MAX_NAME = 16;

function normalizeName(raw: string, seat: number): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return `玩家 ${seat + 1}`;
  return trimmed.slice(0, MAX_NAME);
}

/** 客户端传来的资源清单不可信：只留五种资源、正整数 */
function sanitizeCount(raw: Partial<ResourceCount>): Partial<ResourceCount> {
  const out: Partial<ResourceCount> = {};
  for (const r of RESOURCES) {
    const n = raw[r];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[r] = Math.floor(n);
  }
  return out;
}

function countOf(res: Partial<ResourceCount>): number {
  let sum = 0;
  for (const r of RESOURCES) sum += res[r] ?? 0;
  return sum;
}

export class Room {
  readonly id: string;
  readonly board: Board;
  readonly capacity: number;

  /** null = 还在等待开局 */
  game: GameState | null = null;

  private members: Member[] = [];
  private sockets = new Map<number, SocketLike>();
  private seq = 0;
  /** 多条报价并存；每位玩家最多一条，按创建时间排序 */
  private offers: LiveOffer[] = [];
  private offerCounter = 0;
  private offersVersion = 0;
  /** 最近因过期被清理的报价 ID → 清理时刻；有限期保留，用于返回明确的过期原因 */
  private readonly expiredIds = new Map<string, number>();
  /** 座位 → 下次允许发送报价的服务端时间；重连不清除 */
  private readonly cooldown = new Map<number, number>();
  private readonly now: () => number;
  /** 房间级规则设置：只在开局前可改，开局后锁定到整局结束 */
  private settings: RoomSettings = { ...DEFAULT_SETTINGS };

  constructor(id: string, opts: RoomOptions = {}) {
    this.id = id;
    this.board = opts.board ?? buildBoard(MAP_4P);
    const cap = opts.capacity ?? 4;
    this.capacity = Math.max(2, Math.min(PLAYER_COLORS.length, Math.floor(cap)));
    this.now = opts.now ?? (() => Date.now());
  }

  // -------------------------------------------------------------------------
  // 只读
  // -------------------------------------------------------------------------

  get started(): boolean {
    return this.game !== null;
  }

  get playerCount(): number {
    return this.members.length;
  }

  get connectedCount(): number {
    let n = 0;
    for (const m of this.members) if (m.connected) n++;
    return n;
  }

  get version(): number {
    return this.seq;
  }

  get roomSettings(): RoomSettings {
    return { ...this.settings };
  }

  get settingsLocked(): boolean {
    return this.game !== null;
  }

  /** 开局前改设置；已开局一律拒绝，避免打一半改规则 */
  setSettings(patch: Partial<RoomSettings>): boolean {
    if (this.settingsLocked) return false;
    if (typeof patch.setupGrant === 'boolean') this.settings.setupGrant = patch.setupGrant;
    return true;
  }

  /** 把权威设置推给房间内所有人，客户端只负责显示 */
  broadcastSettings(): void {
    this.sendAll({ t: 'SETTINGS', settings: this.roomSettings, locked: this.settingsLocked });
  }

  lobbyPlayers(): LobbyPlayer[] {
    return this.members.map((m) => ({ seat: m.seat, name: m.name, connected: m.connected }));
  }

  seatOfName(name: string): number | null {
    const clean = name.trim();
    const hit = this.members.find((m) => m.name === clean);
    return hit ? hit.seat : null;
  }

  isSeated(seat: number): boolean {
    return this.members.some((m) => m.seat === seat);
  }

  viewOf(seat: number): PlayerView | null {
    if (!this.game) return null;
    if (!this.isSeated(seat)) return null;
    return viewFor(this.board, this.game, seat);
  }

  // -------------------------------------------------------------------------
  // 入座
  // -------------------------------------------------------------------------

  /**
   * 入座规则（宁可简单可预测）：
   * 1. 同名且原座位没人连着 → 视为重连，回到原座位（T7 的地基）
   * 2. 同名但座位有人连着 → SEAT_TAKEN，防止顶号
   * 3. 未开局 → 按入座顺序分配下一个空位
   * 4. 已开局 → 不再加人（观战留到后面）
   */
  join(rawName: string, socket: SocketLike): JoinResult {
    const bySeat = this.members.length;
    const name = normalizeName(rawName, bySeat);

    const existing = this.members.find((m) => m.name === name);
    if (existing) {
      const live = this.sockets.get(existing.seat);
      if (live && live !== socket) return { ok: false, reason: 'SEAT_TAKEN' };
      this.sockets.set(existing.seat, socket);
      existing.connected = true;
      if (this.game) this.game.players[existing.seat]!.name = name;
      return { ok: true, seat: existing.seat, view: this.viewOf(existing.seat), reclaimed: true };
    }

    if (this.members.length >= this.capacity) return { ok: false, reason: 'ROOM_FULL' };
    if (this.game) return { ok: false, reason: 'IN_PROGRESS' };

    const seat = this.members.length;
    const finalName = normalizeName(rawName, seat);
    this.members.push({ seat, name: finalName, connected: true });
    this.sockets.set(seat, socket);

    // 满员自动开局（2 人房两人到齐即开）
    if (this.members.length === this.capacity) this.start();
    return { ok: true, seat, view: this.viewOf(seat), reclaimed: false };
  }

  reconnect(seat: number, socket: SocketLike): void {
    const member = this.members.find((m) => m.seat === seat);
    if (!member) return;
    this.sockets.set(seat, socket);
    member.connected = true;
  }

  /** 断线不释放座位：30 分钟内可原座重连（T7） */
  leave(seat: number): void {
    const member = this.members.find((m) => m.seat === seat);
    if (!member) return;
    this.sockets.delete(seat);
    member.connected = false;
  }

  // -------------------------------------------------------------------------
  // 开局
  // -------------------------------------------------------------------------

  start(): StartResult {
    if (this.game) return { ok: false, reason: 'ALREADY_STARTED' };
    if (this.members.length < 2) return { ok: false, reason: 'NEED_MORE_PLAYERS' };

    const ordered = this.members.slice().sort((a, b) => a.seat - b.seat);
    const names = ordered.map((m) => m.name);
    const colors: PlayerColor[] = Array.from(PLAYER_COLORS).slice(0, names.length);

    this.game = createGame(this.board, names, colors, this.settings.setupGrant);
    this.seq += 1;
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 命令
  // -------------------------------------------------------------------------

  /**
   * 裁决一条命令。
   *
   * **座位以连接为准**：客户端 JSON 里的 seat 一律被覆盖，
   * 否则任何人改个数字就能替别人行动。
   */
  command(seat: number, cmd: Command, rid?: string): CommandOutcome {
    const reject = (reason: RejectReason | OfferRejectReason, detail?: string): CommandOutcome => {
      this.sendTo(seat, {
        t: 'REJECT', reason,
        ...(detail ? { detail } : {}),
        ...(rid ? { rid } : {}),
      });
      return { ok: false, reason, ...(detail ? { detail } : {}) };
    };
    if (!this.isSeated(seat)) return reject('NOT_SEATED');
    const game = this.game;
    if (!game) return reject('GAME_NOT_STARTED');

    // 座位以连接为准，客户端传什么都不算数
    // 骰子同样不许客户端指定 —— 否则「掷出想要的点数」只需改一行 JSON。
    // 只有显式打开 HEXFRONT_FAKE_DICE 的本地/验收环境才放行。
    const allowFakeDice = process.env.HEXFONT_FAKE_DICE === '1';
    const safe = allowFakeDice
      ? { ...cmd, seat }
      : { ...cmd, dice: undefined, seat };

    const result = applyCommand(this.board, game, safe as Command);
    if (!result.ok) return reject(result.reason, result.detail);

    this.game = result.state;
    this.seq += 1;

    // 指南 7.2 / 8.1：掷 7、回合结束、游戏结束时清空全部活跃报价。
    // 用权威状态里的点数判断，不信客户端传的 dice。
    const dice = this.game.dice;
    const rolledSeven = cmd.type === 'ROLL_DICE' && !!dice && dice[0] + dice[1] === 7;
    if (rolledSeven || cmd.type === 'END_TURN' || this.game.phase === 'ended') {
      this.clearOffers(
        rolledSeven ? 'ROLL_SEVEN' : (this.game.phase === 'ended' ? 'GAME_END' : 'END_TURN'),
      );
    }

    return { ok: true, seq: this.seq, events: result.events };
  }

  // -------------------------------------------------------------------------
  // 交易报价（指南 7：多条并存、唯一 ID、服务端时钟、一次同步处理内串行裁决）
  // -------------------------------------------------------------------------

  /** 当前恢复快照：顺带做懒清理，保证「到期即不可成交」不依赖定时器 */
  get offerSnapshot(): OfferSnapshot {
    return this.snapshot();
  }

  snapshot(): OfferSnapshot {
    this.pruneExpired();
    const t = this.now();
    const nextSendAt: Record<string, number> = {};
    for (const [seat, until] of this.cooldown) {
      if (until > t) nextSendAt[String(seat)] = until;
    }
    return {
      offers: this.offers
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt || a.order - b.order)
        .map((o) => ({
          id: o.id, from: o.from, to: o.to, give: o.give, get: o.get,
          createdAt: o.createdAt, expiresAt: o.expiresAt,
        })),
      version: this.offersVersion,
      serverTime: t,
      nextSendAt,
    };
  }

  /** 供心跳调用：闲置房间也能清掉过期报价并广播，客户端仍以 expiresAt 自己算倒计时 */
  purgeExpired(): void {
    if (this.pruneExpired().length > 0) this.broadcastOffers('EXPIRED');
  }

  private pruneExpired(): LiveOffer[] {
    const t = this.now();
    const expired = this.offers.filter((o) => o.expiresAt <= t);
    if (expired.length > 0) {
      this.offers = this.offers.filter((o) => o.expiresAt > t);
      this.offersVersion += 1;
      for (const o of expired) this.expiredIds.set(o.id, t);
    }
    // 有限期保留，避免房间跑一整局后这张表无限增长
    for (const [id, at] of this.expiredIds) {
      if (t - at > 60_000) this.expiredIds.delete(id);
    }
    return expired;
  }

  /** 区分「这条报价过期了」和「根本没有这条报价」，给客户端明确原因 */
  private missingReason(offerId: string): OfferRejectReason {
    return this.expiredIds.has(offerId) ? 'OFFER_EXPIRED' : 'OFFER_NOT_FOUND';
  }

  private broadcastOffers(reason: OfferEndReason, offerId?: string): void {
    this.sendAll({
      t: 'OFFERS',
      snapshot: this.snapshot(),
      reason,
      ...(offerId ? { offerId } : {}),
    });
  }

  private clearOffers(reason: OfferEndReason): void {
    this.pruneExpired();
    this.offers = [];
    this.offersVersion += 1;
    this.broadcastOffers(reason);
  }

  private rejectOfferRequest(
    seat: number, reason: OfferRejectReason, rid?: string, detail?: string,
  ): OfferOutcome {
    this.sendTo(seat, {
      t: 'REJECT', reason,
      ...(detail ? { detail } : {}),
      ...(rid ? { rid } : {}),
    });
    return { ok: false, reason, ...(detail ? { detail } : {}) };
  }

  /**
   * 挂一条报价。每位玩家最多一条有效报价，房间内可多条并存；重发替换本人旧报价。
   * 所有校验都在替换之前，新请求失败时旧报价保留；冷却只在成功发送后更新。
   */
  makeOffer(
    seat: number, to: number,
    rawGive: Partial<ResourceCount>, rawGet: Partial<ResourceCount>,
    rid?: string,
  ): OfferOutcome {
    const game = this.game;
    if (!game) return this.rejectOfferRequest(seat, 'GAME_NOT_STARTED', rid);
    if (!this.isSeated(seat)) return this.rejectOfferRequest(seat, 'NOT_SEATED', rid);
    if (!this.isSeated(to) || seat === to) return this.rejectOfferRequest(seat, 'BAD_OFFER', rid);
    if (game.phase === 'ended') return this.rejectOfferRequest(seat, 'GAME_ENDED', rid);
    if (Object.keys(game.pendingDiscards).length > 0) {
      return this.rejectOfferRequest(seat, 'DISCARD_PENDING', rid);
    }
    // 权限：当前玩家可报价任意人；非当前玩家只能报价当前玩家
    if (seat !== game.current && to !== game.current) {
      return this.rejectOfferRequest(seat, 'OFFER_FORBIDDEN', rid);
    }

    const give = sanitizeCount(rawGive);
    const get = sanitizeCount(rawGet);
    if (countOf(give) === 0 && countOf(get) === 0) {
      return this.rejectOfferRequest(seat, 'BAD_OFFER', rid, '交易内容为空');
    }

    const t = this.now();
    const until = this.cooldown.get(seat) ?? 0;
    if (t < until) {
      return this.rejectOfferRequest(
        seat, 'OFFER_COOLDOWN', rid, `请等待 ${Math.ceil((until - t) / 1000)} 秒后再发`,
      );
    }

    this.pruneExpired();
    const replaced = this.offers.some((o) => o.from === seat);
    this.offers = this.offers.filter((o) => o.from !== seat);
    const id = `o${++this.offerCounter}`;
    this.offers.push({
      id, from: seat, to, give, get,
      createdAt: t, expiresAt: t + OFFER_TTL_MS,
      order: this.offerCounter,
    });
    this.cooldown.set(seat, t + OFFER_SEND_COOLDOWN_MS);
    this.offersVersion += 1;
    this.broadcastOffers(replaced ? 'REPLACED' : 'CREATED', id);
    return { ok: true, offerId: id };
  }

  /**
   * 被报价方按 ID 接受。检查有效性 → 校验接收人 → 引擎结算 → 删除该报价 → 广播
   * 在一次同步处理里完成；JS 单线程保证不会有另一条消息插进来。
   * 资源不足时保留报价到到期并提示，不默默改变数量。
   */
  acceptOffer(seat: number, offerId: string, rid?: string): OfferOutcome {
    this.pruneExpired();
    const t = this.now();
    const offer = this.offers.find((o) => o.id === offerId);
    if (!offer) {
      const reason = this.missingReason(offerId);
      return this.rejectOfferRequest(
        seat, reason, rid,
        reason === 'OFFER_NOT_FOUND' ? '报价不存在或已被处理' : undefined,
      );
    }
    // 双保险：清理定时器还没跑，到期也不能成交
    if (offer.expiresAt <= t) {
      this.offers = this.offers.filter((o) => o.id !== offerId);
      this.offersVersion += 1;
      this.broadcastOffers('EXPIRED', offerId);
      return this.rejectOfferRequest(seat, 'OFFER_EXPIRED', rid);
    }
    if (offer.to !== seat) return this.rejectOfferRequest(seat, 'OFFER_NOT_FOR_YOU', rid);
    const game = this.game;
    if (!game || game.phase === 'ended') return this.rejectOfferRequest(seat, 'GAME_ENDED', rid);
    if (Object.keys(game.pendingDiscards).length > 0) {
      return this.rejectOfferRequest(seat, 'DISCARD_PENDING', rid);
    }

    const outcome = this.command(offer.from, {
      type: 'TRADE_PLAYER',
      seat: offer.from,
      withPlayer: offer.to,
      give: offer.give,
      get: offer.get,
    }, rid);
    if (!outcome.ok) {
      return {
        ok: false, reason: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      };
    }

    this.offers = this.offers.filter((o) => o.id !== offerId);  // 只删对应报价
    this.offersVersion += 1;
    this.broadcastOffers('ACCEPTED', offerId);
    return { ok: true, offerId, seq: outcome.seq, events: outcome.events };
  }

  /** 拒绝：只处理指向自己的、且仍有效的那一条；撤回不退还冷却 */
  rejectOffer(seat: number, offerId: string, rid?: string): OfferOutcome {
    this.pruneExpired();
    const offer = this.offers.find((o) => o.id === offerId);
    if (!offer) return this.rejectOfferRequest(seat, this.missingReason(offerId), rid);
    if (offer.expiresAt <= this.now()) return this.rejectOfferRequest(seat, 'OFFER_EXPIRED', rid);
    if (offer.to !== seat) return this.rejectOfferRequest(seat, 'OFFER_NOT_FOR_YOU', rid);
    this.offers = this.offers.filter((o) => o.id !== offerId);
    this.offersVersion += 1;
    this.broadcastOffers('REJECTED', offerId);
    return { ok: true, offerId };
  }

  /** 撤回：只能撤回本人发起的那一条，绝不动别人的报价 */
  cancelOffer(seat: number, offerId: string, rid?: string): OfferOutcome {
    this.pruneExpired();
    const offer = this.offers.find((o) => o.id === offerId);
    if (!offer) return this.rejectOfferRequest(seat, this.missingReason(offerId), rid);
    if (offer.from !== seat) return this.rejectOfferRequest(seat, 'OFFER_FORBIDDEN', rid);
    this.offers = this.offers.filter((o) => o.id !== offerId);
    this.offersVersion += 1;
    this.broadcastOffers('CANCELLED', offerId);
    return { ok: true, offerId };
  }

  // -------------------------------------------------------------------------
  // 广播
  // -------------------------------------------------------------------------

  /** 按座位裁剪视角后逐人推送。events 只用于让客户端播放动效，不参与状态还原。 */
  sync(events: GameEvent[] = []): void {
    const game = this.game;
    if (!game) {
      this.sendAll({
        t: 'LOBBY',
        roomId: this.id,
        capacity: this.capacity,
        players: this.lobbyPlayers(),
      });
      return;
    }
    for (const [seat, socket] of this.sockets) {
      const view = viewFor(this.board, game, seat);
      socket.send(encode({ t: 'STATE', seq: this.seq, events, view }));
    }
  }

  sendTo(seat: number, msg: ServerMessage): void {
    this.sockets.get(seat)?.send(encode(msg));
  }

  private sendAll(msg: ServerMessage): void {
    const payload = encode(msg);
    for (const socket of this.sockets.values()) socket.send(payload);
  }
}

// ---------------------------------------------------------------------------
// 房间登记表
// ---------------------------------------------------------------------------

const ROOM_ID_RE = /^[a-z0-9_-]{1,24}$/;

/** 房间号非法时返回 null，交给调用方决定回退（默认 'main'） */
export function normalizeRoomId(raw: string): string | null {
  const id = raw.trim().toLowerCase();
  return ROOM_ID_RE.test(id) ? id : null;
}

export class RoomRegistry {
  private rooms = new Map<string, Room>();
  private readonly capacity: number;
  private readonly maxRooms: number;
  private readonly board: Board | undefined;
  private readonly now: () => number;

  constructor(opts: { capacity?: number; maxRooms?: number; board?: Board; now?: () => number } = {}) {
    this.capacity = opts.capacity ?? 4;
    this.maxRooms = opts.maxRooms ?? 64;
    this.board = opts.board;
    this.now = opts.now ?? (() => Date.now());
  }

  get size(): number {
    return this.rooms.size;
  }

  getOrCreate(id: string): Room | null {
    const hit = this.rooms.get(id);
    if (hit) return hit;
    if (this.rooms.size >= this.maxRooms) return null;
    const room = new Room(id, { capacity: this.capacity, board: this.board, now: this.now });
    this.rooms.set(id, room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  list(): Room[] {
    return Array.from(this.rooms.values());
  }
}
