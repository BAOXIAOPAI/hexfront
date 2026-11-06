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
  encode,
  type LobbyPlayer,
  type RoomSettings,
  type ServerMessage,
  type TradeOfferView,
} from './protocol.js';

export interface SocketLike {
  send(data: string): void;
}

export interface RoomOptions {
  board?: Board;
  /** 座位上限 2..4，默认 4 */
  capacity?: number;
}

export type JoinResult =
  | { ok: true; seat: number; view: PlayerView | null; reclaimed: boolean }
  | { ok: false; reason: 'ROOM_FULL' | 'IN_PROGRESS' | 'SEAT_TAKEN' };

export type StartResult =
  | { ok: true }
  | { ok: false; reason: 'NEED_MORE_PLAYERS' | 'ALREADY_STARTED' | 'NOT_SEATED' };

export type CommandOutcome =
  | { ok: true; seq: number; events: GameEvent[] }
  | { ok: false; reason: RejectReason | 'GAME_NOT_STARTED' | 'NOT_SEATED' | 'BAD_OFFER' };

interface Member {
  seat: number;
  name: string;
  connected: boolean;
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
  /** 桌面上挂着的报价；同一时间只允许一条，避免桌面变成拍卖行 */
  private offer: TradeOfferView | null = null;
  /** 房间级规则设置：只在开局前可改，开局后锁定到整局结束 */
  private settings: RoomSettings = { ...DEFAULT_SETTINGS };

  constructor(id: string, opts: RoomOptions = {}) {
    this.id = id;
    this.board = opts.board ?? buildBoard(MAP_4P);
    const cap = opts.capacity ?? 4;
    this.capacity = Math.max(2, Math.min(PLAYER_COLORS.length, Math.floor(cap)));
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
  command(seat: number, cmd: Command): CommandOutcome {
    if (!this.isSeated(seat)) {
      this.sendTo(seat, { t: 'REJECT', reason: 'NOT_SEATED' });
      return { ok: false, reason: 'NOT_SEATED' };
    }
    const game = this.game;
    if (!game) {
      this.sendTo(seat, { t: 'REJECT', reason: 'GAME_NOT_STARTED' });
      return { ok: false, reason: 'GAME_NOT_STARTED' };
    }

    // 座位以连接为准，客户端传什么都不算数
    // 骰子同样不许客户端指定 —— 否则「掷出想要的点数」只需改一行 JSON。
    // 只有显式打开 HEXFRONT_FAKE_DICE 的本地/验收环境才放行。
    const allowFakeDice = process.env.HEXFONT_FAKE_DICE === '1';
    const safe = allowFakeDice
      ? { ...cmd, seat }
      : { ...cmd, dice: undefined, seat };

    const result = applyCommand(this.board, game, safe as Command);
    if (!result.ok) {
      this.sendTo(seat, { t: 'REJECT', reason: result.reason, detail: result.detail });
      return { ok: false, reason: result.reason };
    }

    this.game = result.state;
    this.seq += 1;

    // 回合结束，桌上挂着的报价作废（不能跨回合讨价还价）
    if (cmd.type === 'END_TURN' && this.offer) {
      this.offer = null;
      this.broadcastOffer();
    }

    return { ok: true, seq: this.seq, events: result.events };
  }

  // -------------------------------------------------------------------------
  // 交易报价
  // -------------------------------------------------------------------------

  get currentOffer(): TradeOfferView | null {
    return this.offer;
  }

  /**
   * 挂一条报价。
   * 同一时间只允许一条 —— 桌上只有一个人说话，多挂几条会变成拍卖行。
   */
  makeOffer(seat: number, to: number, rawGive: Partial<ResourceCount>, rawGet: Partial<ResourceCount>): boolean {
    if (!this.game || !this.isSeated(seat) || !this.isSeated(to) || seat === to) {
      this.sendTo(seat, { t: 'REJECT', reason: 'BAD_OFFER' });
      return false;
    }

    const give = sanitizeCount(rawGive);
    const get = sanitizeCount(rawGet);
    if (countOf(give) === 0 && countOf(get) === 0) {
      this.sendTo(seat, { t: 'REJECT', reason: 'BAD_OFFER', detail: '交易内容为空' });
      return false;
    }

    this.offer = { from: seat, to, give, get };
    this.broadcastOffer();
    return true;
  }

  /** 被报价方接受：交给引擎执行，资源够不够由引擎裁决 */
  acceptOffer(seat: number): CommandOutcome {
    const offer = this.offer;
    if (!offer || offer.to !== seat) {
      this.sendTo(seat, { t: 'REJECT', reason: 'BAD_OFFER', detail: '没有指向你的报价' });
      return { ok: false, reason: 'BAD_OFFER' };
    }

    const outcome = this.command(offer.from, {
      type: 'TRADE_PLAYER',
      seat: offer.from,
      withPlayer: offer.to,
      give: offer.give,
      get: offer.get,
    });
    if (!outcome.ok) return outcome;

    this.offer = null;
    this.broadcastOffer();
    return outcome;
  }

  rejectOffer(seat: number): void {
    if (!this.offer || this.offer.to !== seat) return;
    this.offer = null;
    this.broadcastOffer();
  }

  cancelOffer(seat: number): void {
    if (!this.offer || this.offer.from !== seat) return;
    this.offer = null;
    this.broadcastOffer();
  }

  private broadcastOffer(): void {
    this.sendAll({ t: 'OFFER', offer: this.offer });
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

  constructor(opts: { capacity?: number; maxRooms?: number; board?: Board } = {}) {
    this.capacity = opts.capacity ?? 4;
    this.maxRooms = opts.maxRooms ?? 64;
    this.board = opts.board;
  }

  get size(): number {
    return this.rooms.size;
  }

  getOrCreate(id: string): Room | null {
    const hit = this.rooms.get(id);
    if (hit) return hit;
    if (this.rooms.size >= this.maxRooms) return null;
    const room = new Room(id, { capacity: this.capacity, board: this.board });
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
