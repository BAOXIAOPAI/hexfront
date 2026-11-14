/**
 * 房间：内存里持有唯一真相（GameState）。
 *
 * 职责边界：
 * - 只管「谁能坐哪个位」「命令如何被裁决」「裁决后推给谁」
 * - 不做任何规则判断（全部交给 @hexfront/engine）
 * - 不用知道 WebSocket 是什么（SocketLike 只要求 send），方便单测与以后换传输层
 *
 * 文档 23（L-1/L-2/L-4）新增：
 * - 房主、目标人数 4–8、准备态、全员准备后手动开始（取消满员自动开局）
 * - 服务端权威的受约束随机地图快照，全员同一份预览，开始时原子锁定
 * - 开局前可调整的 actionOrder，排序不改身份/私有视图
 * - 每次「村庄＋道路」独立 180 秒，超时由系统随机合法代放
 *
 * 广播时机由调用方（server）控制：join/start/leave 只改内存，调用 sync() 才推。
 * 这样 WELCOME 一定先于第一条 STATE 到达客户端。
 */

import {
  applyCommand,
  buildBoard,
  createGame,
  generateMap,
  MAP_GENERATOR_VERSION,
  MAP_4P,
  PLAYER_COLORS,
  RESOURCES,
  validateMap,
  viewFor,
  type Board,
  type Command,
  type GameEvent,
  type GameState,
  type MapSpec,
  type PlayerColor,
  type PlayerView,
  type RejectReason,
  type ResourceCount,
} from '@hexfront/engine';
import {
  DEFAULT_SETTINGS,
  HOST_GRACE_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  OFFER_SEND_COOLDOWN_MS,
  OFFER_TTL_MS,
  SETUP_STEP_MS,
  encode,
  type BoardKind,
  type LobbyConfig,
  type LobbyPlayer,
  type LobbyRejectReason,
  type MapSnapshot,
  type OfferEndReason,
  type OfferRejectReason,
  type OfferSnapshot,
  type OfferView,
  type RoomSettings,
  type ServerMessage,
  type SetupTimer,
} from './protocol.js';

export interface SocketLike {
  send(data: string): void;
}

export interface RoomOptions {
  /** 旧测试夹具：直接注入棋盘。产品路径由生成器按 seed 构造 */
  board?: Board;
  /** 座位上限（初始目标人数）；产品为 4–8，测试夹具可低至 2 */
  capacity?: number;
  /** 可控时钟（毫秒）：测试用来推进 10 秒期限 / 3 秒冷却 / 180 秒选地，避免真实等待 */
  now?: () => number;
  /** 内部测试夹具：满员自动开局。产品默认 false（文档 23 取消满员自动开局） */
  autoStartOnFull?: boolean;
  /** 内部测试夹具：最少开局人数。产品默认 MIN_PLAYERS = 4 */
  minPlayers?: number;
  /** 内部测试夹具：开始时不要求全员准备。产品默认要求准备 */
  skipReadyCheck?: boolean;
  /** 内部测试夹具：固定初始地图 seed，便于断言复现 */
  seed?: string;
  /**
   * F2 测试夹具：替换「生成一张地图」的工厂，用来注入生成失败并验证完整回滚。
   * 产品路径恒为 null（使用真实 generateMap）。
   */
  mapFactory?: ((kind: BoardKind, version: number, reason: string) => { board: Board; snapshot: MapSnapshot } | null) | null;
}

export type JoinResult =
  | { ok: true; seat: number; view: PlayerView | null; reclaimed: boolean }
  | { ok: false; reason: 'ROOM_FULL' | 'IN_PROGRESS' | 'SEAT_TAKEN' };

export type StartResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'NEED_MORE_PLAYERS' | 'ALREADY_STARTED' | 'NOT_SEATED' | 'NOT_HOST'
        | 'NOT_ALL_READY' | 'PLAYERS_OFFLINE' | 'CONFIG_VERSION_MISMATCH'
        | 'BOARD_NOT_READY' | 'BAD_PLAYER_COUNT';
    };

export type ConfigResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'NOT_HOST' | 'GAME_ALREADY_STARTED' | 'BAD_PLAYER_COUNT' | 'BAD_BOARD'
        | 'BAD_ORDER' | 'CONFIG_VERSION_MISMATCH' | 'NOT_SEATED' | 'BOARD_NOT_READY';
    };

export type CommandOutcome =
  | { ok: true; seq: number; events: GameEvent[] }
  | { ok: false; reason: RejectReason | OfferRejectReason | LobbyRejectReason; detail?: string };

export type OfferOutcome =
  | { ok: true; offerId: string; seq?: number; events?: GameEvent[] }
  | { ok: false; reason: RejectReason | OfferRejectReason | LobbyRejectReason; detail?: string };

interface Member {
  seat: number;
  name: string;
  connected: boolean;
  ready: boolean;
  /** 入房时刻（可控时钟），用于房主移交时选「最早入房且在线者」 */
  joinedAt: number;
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

/** 文档 23 §4：按目标人数推荐地图；6–8 人推荐扩展盘 */
export function recommendedBoard(players: number): BoardKind {
  return players <= 5 ? 'base' : 'ext';
}

/** 把 MapSpec 转成对外快照（公开信息，不含任何隐藏结果） */
function snapshotOf(spec: MapSpec, kind: BoardKind, boardVersion: number): MapSnapshot {
  return {
    kind,
    rows: spec.rows.slice(),
    tiles: Object.entries(spec.tiles).map(([key, t]) => ({
      key, terrain: t.terrain, number: t.number,
    })),
    ports: (spec.ports ?? []).map((p) => ({
      edge: p.edge,
      port: p.port.kind === 'generic'
        ? { kind: 'generic' as const }
        : { kind: 'specific' as const, resource: p.port.resource },
    })),
    robberTile: spec.robberTile ?? '',
    seed: spec.seed ?? '',
    generatorVersion: spec.generatorVersion ?? MAP_GENERATOR_VERSION,
    boardVersion,
  };
}

export class Room {
  readonly id: string;

  /** 当前棋盘；产品路径由地图生成器构造，开局后锁定 */
  board: Board;

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

  // ---- 文档 23 新增状态 ----
  private readonly minPlayers: number;
  private readonly autoStartOnFull: boolean;
  private readonly skipReadyCheck: boolean;
  private readonly fixtureSeed: string | undefined;
  /** F2 测试夹具：注入地图生成失败；产品为 null */
  private readonly mapFactory: NonNullable<RoomOptions['mapFactory']> | null;
  private targetPlayers: number;
  private boardKind: BoardKind;
  private boardChoice: 'auto' | 'manual' = 'auto';
  private hostSeat: number | null = null;
  private configVersion = 1;
  private actionOrder: number[] = [];
  private changedBy = -1;
  private changeReason = 'INIT';
  private mapSnapshot: MapSnapshot;
  /** 房主断线时刻；null 表示房主在线或尚未有房主 */
  private hostDisconnectedAt: number | null = null;
  /** 当前选地步骤的权威截止时间；null 表示不在 setup 阶段 */
  private setupDeadline: SetupTimer | null = null;
  /** 房间级规则设置：只在开局前可改，开局后锁定到整局结束 */
  private settings: RoomSettings = { ...DEFAULT_SETTINGS };

  constructor(id: string, opts: RoomOptions = {}) {
    this.id = id;
    this.minPlayers = opts.minPlayers ?? MIN_PLAYERS;
    this.autoStartOnFull = opts.autoStartOnFull ?? false;
    this.skipReadyCheck = opts.skipReadyCheck ?? false;
    this.fixtureSeed = opts.seed;
    this.mapFactory = opts.mapFactory ?? null;
    this.now = opts.now ?? (() => Date.now());

    const cap = opts.capacity ?? MIN_PLAYERS;
    this.targetPlayers = Math.max(2, Math.min(MAX_PLAYERS, Math.floor(cap)));
    this.boardKind = opts.board ? 'base' : recommendedBoard(this.targetPlayers);

    if (opts.board) {
      // 旧测试夹具：注入固定棋盘，快照仍按同一份数据构造，保证视图一致
      this.board = opts.board;
      const spec: MapSpec = {
        ...opts.board.spec,
        seed: opts.board.spec.seed ?? `fixture-${id}`,
        generatorVersion: opts.board.spec.generatorVersion ?? MAP_GENERATOR_VERSION,
        robberTile: opts.board.spec.robberTile,
        ports: opts.board.spec.ports,
      };
      this.mapSnapshot = snapshotOf(spec, 'base', this.configVersion);
    } else {
      const seed = this.fixtureSeed ?? `${id}:${this.configVersion}:${Math.floor(this.now())}`;
      const generated = generateMap({ kind: this.boardKind, seed });
      if (!generated.ok || !generated.spec) {
        // 极端情况（预算耗尽）回退到固定的合法标准盘，保证房间始终可用
        const fallback: MapSpec = {
          ...MAP_4P, seed: `fallback-${id}`, generatorVersion: MAP_GENERATOR_VERSION,
        };
        this.board = buildBoard(fallback);
        this.mapSnapshot = snapshotOf(fallback, 'base', this.configVersion);
      } else {
        this.board = buildBoard(generated.spec);
        this.mapSnapshot = snapshotOf(generated.spec, this.boardKind, this.configVersion);
      }
    }
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

  /** 目标人数即本局容量（文档 23 L-0 E：房主开局前一次性设定） */
  get capacity(): number {
    return this.targetPlayers;
  }

  get roomSettings(): RoomSettings {
    return { ...this.settings };
  }

  get settingsLocked(): boolean {
    return this.game !== null;
  }

  get map(): MapSnapshot {
    return this.mapSnapshot;
  }

  get currentTimer(): SetupTimer | null {
    return this.setupDeadline ? { ...this.setupDeadline, serverTime: this.now() } : null;
  }

  /** 供 WELCOME 使用的大厅权威配置 */
  lobbyConfig(): LobbyConfig {
    return {
      hostSeat: this.hostSeat ?? -1,
      targetPlayers: this.targetPlayers,
      board: this.boardKind,
      boardChoice: this.boardChoice,
      recommendedBoard: recommendedBoard(this.targetPlayers),
      configVersion: this.configVersion,
      actionOrder: this.actionOrder.slice(),
      ready: this.members.map((m) => m.ready),
      changedBy: this.changedBy,
      changeReason: this.changeReason,
      canStart: this.startBlockReason() === null,
      startBlockReason: this.startBlockReason(),
    };
  }

  /** 服务端权威判断：为什么现在不能开始 */
  private startBlockReason(): string | null {
    if (this.game) return 'GAME_ALREADY_STARTED';
    if (this.targetPlayers < this.minPlayers) return 'NOT_ENOUGH_PLAYERS';
    if (this.members.length !== this.targetPlayers) return 'NOT_ENOUGH_PLAYERS';
    for (const m of this.members) {
      if (!m.connected) return 'PLAYERS_OFFLINE';
    }
    if (!this.skipReadyCheck) {
      for (const m of this.members) {
        if (!m.ready) return 'NOT_ALL_READY';
      }
    }
    if (this.mapSnapshot.tiles.length === 0) return 'BOARD_NOT_READY';
    return null;
  }

  /** 开局前改设置；已开局一律拒绝，避免打一半改规则 */
  setSettings(patch: Partial<RoomSettings>, seat?: number): boolean {
    if (this.settingsLocked) return false;
    if (seat !== undefined && seat !== this.hostSeat) return false;
    if (typeof patch.setupGrant === 'boolean') this.settings.setupGrant = patch.setupGrant;
    return true;
  }

  /** 把权威设置推给房间内所有人，客户端只负责显示 */
  broadcastSettings(): void {
    this.sendAll({ t: 'SETTINGS', settings: this.roomSettings, locked: this.settingsLocked });
  }

  lobbyPlayers(): LobbyPlayer[] {
    return this.members.map((m) => ({
      seat: m.seat, name: m.name, connected: m.connected, ready: m.ready,
    }));
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
  // 配置：房主权限、版本、清准备
  // -------------------------------------------------------------------------

  private isHost(seat: number): boolean {
    return this.hostSeat === seat && this.isSeated(seat);
  }

  private rejectTo(seat: number, reason: LobbyRejectReason, detail?: string): void {
    this.sendTo(seat, { t: 'REJECT', reason, ...(detail ? { detail } : {}) });
  }

  private versionMatches(expected?: number): boolean {
    return expected === undefined || expected === this.configVersion;
  }

  /** 任何配置变化：递增版本、清空全员准备、记录操作者，并广播权威快照 */
  private bumpConfig(seat: number, reason: string): void {
    this.configVersion += 1;
    this.changedBy = seat;
    this.changeReason = reason;
    for (const m of this.members) m.ready = false;
    this.mapSnapshot = { ...this.mapSnapshot, boardVersion: this.configVersion };
  }

  /**
   * F2：尝试生成一张合法地图，返回待提交的 (board, snapshot)。
   * 纯「先算后提交」：失败时调用方可以完全不碰状态，绝不留下
   * 「配置是扩展盘、实际棋盘还是标准盘」的半提交状态。
   * 测试可替换本方法注入生成失败，验证完整回滚。
   */
  private tryGenerateMap(
    kind: BoardKind, version: number, reason: string,
  ): { board: Board; snapshot: MapSnapshot } | null {
    if (this.mapFactory) return this.mapFactory(kind, version, reason);
    const seed = `${this.id}:${version}:${Math.floor(this.now())}:${reason}`;
    const generated = generateMap({ kind, seed });
    if (!generated.ok || !generated.spec) return null;
    const check = validateMap(generated.spec);
    if (!check.ok) return null;
    return {
      board: buildBoard(generated.spec),
      snapshot: snapshotOf(generated.spec, kind, version),
    };
  }

  /**
   * F2：原子提交一次配置变更。
   * 先把地图算好（可能失败），成功后才一次性写入 targetPlayers / boardKind /
   * boardChoice / configVersion / ready / board / mapSnapshot / actionOrder，
   * 最后广播同一份权威 lobby+map 快照。任何一步失败都不修改任何状态。
   */
  private commitConfig(opts: {
    seat: number;
    reason: string;
    targetPlayers?: number;
    boardKind?: BoardKind;
    boardChoice?: 'auto' | 'manual';
    regenerate: boolean;
  }): ConfigResult {
    const nextPlayers = opts.targetPlayers ?? this.targetPlayers;
    const nextKind = opts.boardKind ?? this.boardKind;
    const nextChoice = opts.boardChoice ?? this.boardChoice;
    const nextVersion = this.configVersion + 1;

    // ① 先把地图算好；失败则整体不提交（完整回滚）
    let board = this.board;
    let snapshot: MapSnapshot;
    if (opts.regenerate) {
      const made = this.tryGenerateMap(nextKind, nextVersion, opts.reason);
      if (!made) return { ok: false, reason: 'BOARD_NOT_READY' };
      board = made.board;
      snapshot = made.snapshot;
    } else {
      snapshot = { ...this.mapSnapshot, boardVersion: nextVersion };
    }

    // ② 一次性提交，配置与棋盘/快照始终一致
    this.targetPlayers = nextPlayers;
    this.boardKind = nextKind;
    this.boardChoice = nextChoice;
    this.configVersion = nextVersion;
    this.changedBy = opts.seat;
    this.changeReason = opts.reason;
    for (const m of this.members) m.ready = false;
    this.board = board;
    this.mapSnapshot = snapshot;
    this.syncOrderToSeats();
    this.broadcastLobbyConfig(opts.reason);
    return { ok: true };
  }

  private checkConfigAuthority(seat: number, configVersion?: number): ConfigResult | null {
    if (this.settingsLocked) return { ok: false, reason: 'GAME_ALREADY_STARTED' };
    if (!this.isHost(seat)) return { ok: false, reason: 'NOT_HOST' };
    if (!this.versionMatches(configVersion)) return { ok: false, reason: 'CONFIG_VERSION_MISMATCH' };
    return null;
  }

  /**
   * F2 意图一：设定目标人数。
   * - 人数改变先应用推荐地图（6–8 扩展 / 4–5 标准），并把 boardChoice 重置为 auto；
   *   房主随后仍可用 applyBoard 明确改选（"保留手动改选权"）。
   * - 仅重新提交相同人数：不递增版本、不洗地图、不清准备（不无故洗牌）。
   * - 地图生成失败：返回 BOARD_NOT_READY，配置与地图完整回滚。
   */
  applyPlayerCount(seat: number, targetPlayers: number, configVersion?: number): ConfigResult {
    const denied = this.checkConfigAuthority(seat, configVersion);
    if (denied) return denied;
    if (!Number.isInteger(targetPlayers) || targetPlayers < this.minPlayers || targetPlayers > MAX_PLAYERS) {
      return { ok: false, reason: 'BAD_PLAYER_COUNT' };
    }
    // 不能把目标人数降到少于已入座人数（不静默踢人）
    if (targetPlayers < this.members.length) return { ok: false, reason: 'BAD_PLAYER_COUNT' };
    if (targetPlayers === this.targetPlayers) return { ok: true };   // 重复保存不洗地图

    const nextKind = recommendedBoard(targetPlayers);
    return this.commitConfig({
      seat,
      reason: 'SET_PLAYER_COUNT',
      targetPlayers,
      boardKind: nextKind,
      boardChoice: 'auto',
      // 推荐盘变化时必须重抽，保证「配置是扩展盘、实际也是扩展盘」
      regenerate: nextKind !== this.boardKind,
    });
  }

  /** F2 意图二：房主明确手选地图（标记 manual，之后人数改变会重新应用推荐） */
  applyBoard(seat: number, board: BoardKind, configVersion?: number): ConfigResult {
    const denied = this.checkConfigAuthority(seat, configVersion);
    if (denied) return denied;
    if (board !== 'base' && board !== 'ext') return { ok: false, reason: 'BAD_BOARD' };
    return this.commitConfig({
      seat,
      reason: 'SET_BOARD',
      boardKind: board,
      boardChoice: 'manual',
      regenerate: board !== this.boardKind,
    });
  }

  /**
   * 兼容旧测试夹具的内部包装：产品协议已把人数与地图拆成两条消息，
   * 这里按「谁有值」转发到新意图，避免旧断言大面积改写。
   */
  configure(
    seat: number,
    patch: { targetPlayers?: number; board?: BoardKind },
    configVersion?: number,
  ): ConfigResult {
    if (patch.board !== undefined) return this.applyBoard(seat, patch.board, configVersion);
    if (patch.targetPlayers !== undefined) return this.applyPlayerCount(seat, patch.targetPlayers, configVersion);
    return { ok: true };
  }

  /** 房主重抽地图：槽位固定、类型洗牌、seed 变化，全员看到同一份；失败完整回滚 */
  rerollMap(seat: number, configVersion?: number): ConfigResult {
    const denied = this.checkConfigAuthority(seat, configVersion);
    if (denied) return denied;
    return this.commitConfig({ seat, reason: 'REROLL_MAP', regenerate: true });
  }

  /** 玩家设置自己的准备态；昵称/在线状态更新不会无故清准备 */
  setReady(seat: number, ready: boolean): ConfigResult {
    if (this.settingsLocked) return { ok: false, reason: 'GAME_ALREADY_STARTED' };
    const m = this.members.find((x) => x.seat === seat);
    if (!m) return { ok: false, reason: 'NOT_SEATED' };
    m.ready = ready;
    // 准备态变化不是「配置变更」，不清别人的准备、不递增 configVersion
    this.broadcastLobbyConfig('READY');
    return { ok: true };
  }

  /** 房主手动调整完整蛇形顺序（seat 的排列） */
  setOrder(seat: number, order: number[], configVersion?: number): ConfigResult {
    if (this.settingsLocked) return { ok: false, reason: 'GAME_ALREADY_STARTED' };
    if (!this.isHost(seat)) return { ok: false, reason: 'NOT_HOST' };
    if (!this.versionMatches(configVersion)) return { ok: false, reason: 'CONFIG_VERSION_MISMATCH' };
    const seats = this.members.map((m) => m.seat);
    if (order.length !== seats.length || new Set(order).size !== order.length
        || !order.every((s) => seats.includes(s))) {
      return { ok: false, reason: 'BAD_ORDER' };
    }
    this.actionOrder = order.slice();
    this.bumpConfig(seat, 'SET_ORDER');
    this.broadcastLobbyConfig('SET_ORDER');
    return { ok: true };
  }

  /** 房主点击随机顺序；用独立随机源，不复用地图 seed */
  randomizeOrder(seat: number, configVersion?: number): ConfigResult {
    if (this.settingsLocked) return { ok: false, reason: 'GAME_ALREADY_STARTED' };
    if (!this.isHost(seat)) return { ok: false, reason: 'NOT_HOST' };
    if (!this.versionMatches(configVersion)) return { ok: false, reason: 'CONFIG_VERSION_MISMATCH' };
    const order = this.members.map((m) => m.seat);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    this.actionOrder = order;
    this.bumpConfig(seat, 'RANDOMIZE_ORDER');
    this.broadcastLobbyConfig('RANDOMIZE_ORDER');
    return { ok: true };
  }

  /** 把新入座/目标人数变化补进 actionOrder，保持「当前 seat 的一个排列」 */
  private syncOrderToSeats(): void {
    const seats = this.members.map((m) => m.seat);
    const kept = this.actionOrder.filter((s) => seats.includes(s));
    for (const s of seats) if (!kept.includes(s)) kept.push(s);
    this.actionOrder = kept;
  }

  // -------------------------------------------------------------------------
  // 入座
  // -------------------------------------------------------------------------

  /**
   * 入座规则（宁可简单可预测）：
   * 1. 同名且原座位没人连着 → 视为重连，回到原座位（T7 的地基）
   * 2. 同名但座位有人连着 → SEAT_TAKEN，防止顶号
   * 3. 未开局 → 按入座顺序分配下一个空位；首位创建者成为房主
   * 4. 已开局 → 不再加人（观战留到后面）
   *
   * 文档 23：**取消满员自动开局**；满员只影响「可以开始」的判定。
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
      // 房主重连：恢复身份、清除断线计时
      if (existing.seat === this.hostSeat) this.hostDisconnectedAt = null;
      return { ok: true, seat: existing.seat, view: this.viewOf(existing.seat), reclaimed: true };
    }

    // 已开局优先返回 IN_PROGRESS：明确告诉客户端「中途不能加人」，
    // 而不是含糊地说房间满了（文档 23 §4「已开始不能加参赛者」）。
    if (this.game) return { ok: false, reason: 'IN_PROGRESS' };
    if (this.members.length >= this.targetPlayers) return { ok: false, reason: 'ROOM_FULL' };

    const seat = this.members.length;
    const finalName = normalizeName(rawName, seat);
    this.members.push({ seat, name: finalName, connected: true, ready: false, joinedAt: this.now() });
    this.sockets.set(seat, socket);
    if (this.hostSeat === null) {
      this.hostSeat = seat;
      this.changedBy = seat;
      this.changeReason = 'INIT';
    }
    this.syncOrderToSeats();

    // 仅内部测试夹具保留满员自动开局；产品路径绝不自动开局
    if (this.autoStartOnFull && this.members.length === this.targetPlayers) {
      this.start(this.hostSeat ?? seat, this.configVersion);
    }
    return { ok: true, seat, view: this.viewOf(seat), reclaimed: false };
  }

  reconnect(seat: number, socket: SocketLike): void {
    const member = this.members.find((m) => m.seat === seat);
    if (!member) return;
    this.sockets.set(seat, socket);
    member.connected = true;
    if (seat === this.hostSeat) this.hostDisconnectedAt = null;
  }

  /** 断线不释放座位：可原座重连（T7）。房主断线开始按钮锁定，60 秒后移交。 */
  leave(seat: number): void {
    const member = this.members.find((m) => m.seat === seat);
    if (!member) return;
    this.sockets.delete(seat);
    member.connected = false;
    if (seat === this.hostSeat && !this.game) {
      this.hostDisconnectedAt = this.now();
    }
  }

  /** 心跳驱动：房主断线宽限到期后移交给最早入房且在线者；原房主回来不夺回 */
  private maybeTransferHost(t: number): void {
    if (this.game || this.hostDisconnectedAt === null) return;
    if (t - this.hostDisconnectedAt < HOST_GRACE_MS) return;
    const host = this.members.find((m) => m.seat === this.hostSeat);
    if (host?.connected) { this.hostDisconnectedAt = null; return; }
    const next = this.members
      .filter((m) => m.connected && m.seat !== this.hostSeat)
      .sort((a, b) => a.joinedAt - b.joinedAt || a.seat - b.seat)[0];
    if (!next) return;
    this.hostSeat = next.seat;
    this.hostDisconnectedAt = null;
    this.bumpConfig(next.seat, 'HOST_TRANSFER');
    this.broadcastLobbyConfig('HOST_TRANSFER');
  }

  // -------------------------------------------------------------------------
  // 开局
  // -------------------------------------------------------------------------

  /**
   * 房主手动开始。产品路径：满目标人数、全员在线且准备、配置版本一致才放行。
   * seat / configVersion 省略时视为内部测试夹具调用（server.ts 一定显式传入）。
   */
  start(seat?: number, configVersion?: number): StartResult {
    if (this.game) return { ok: false, reason: 'ALREADY_STARTED' };
    if (seat !== undefined && !this.isHost(seat)) return { ok: false, reason: 'NOT_HOST' };
    if (!this.versionMatches(configVersion)) return { ok: false, reason: 'CONFIG_VERSION_MISMATCH' };

    const block = this.startBlockReason();
    if (block) {
      return { ok: false, reason: block as StartResult extends { ok: false; reason: infer R } ? R : never };
    }

    const ordered = this.members.slice().sort((a, b) => a.seat - b.seat);
    const names = ordered.map((m) => m.name);
    const colors: PlayerColor[] = Array.from(PLAYER_COLORS).slice(0, names.length);

    // actionOrder 必须是当前 seats 的完整排列；否则退化为座位自然顺序（防御）
    const seats = ordered.map((m) => m.seat);
    const validOrder = this.actionOrder.length === seats.length
      && new Set(this.actionOrder).size === seats.length
      && this.actionOrder.every((s) => seats.includes(s));
    const order = validOrder ? this.actionOrder.slice() : seats;

    this.game = createGame(this.board, names, colors, {
      setupGrant: this.settings.setupGrant,
      actionOrder: order,
    });
    this.seq += 1;
    this.armSetupTimer();
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 选地计时与超时合法随机代放（文档 23 §7）
  // -------------------------------------------------------------------------

  /** 每个选地步骤独立 180 秒；进入新步骤时重新起算，上一步剩余不累积 */
  private armSetupTimer(): void {
    const game = this.game;
    if (!game || game.phase !== 'setup' || !game.setup) {
      this.setupDeadline = null;
      return;
    }
    const t = this.now();
    this.setupDeadline = {
      step: game.setup.step,
      seat: game.setup.seat,
      startedAt: t,
      deadline: t + SETUP_STEP_MS,
      serverTime: t,
    };
    this.sendAll({ t: 'SETUP_TIMER', timer: { ...this.setupDeadline } });
  }

  /**
   * 由心跳/消息处理驱动：deadline 到达则代放。
   * 用 gameId + setupStep + version 防止重复计时器、多次代放、同一回合两个放置。
   */
  advanceClock(t: number = this.now()): boolean {
    this.maybeTransferHost(t);
    const game = this.game;
    const timer = this.setupDeadline;
    if (!game || game.phase !== 'setup' || !game.setup || !timer) return false;
    if (t < timer.deadline) return false;
    // 代放前再次核对步骤，避免重复代放
    if (timer.step !== game.setup.step || timer.seat !== game.setup.seat) {
      this.armSetupTimer();
      return false;
    }
    return this.autoPlace(timer.seat);
  }

  /** 枚举合法 (村庄, 道路)，先均匀选村庄、再在其合法道路中均匀选一条 */
  private legalPlacements(): { vertex: string; edge: string }[] {
    const game = this.game;
    if (!game) return [];
    const { geo } = this.board;
    const out: { vertex: string; edge: string }[] = [];
    for (const vk of geo.vertexKeys) {
      if (game.buildings[vk]) continue;
      const v = geo.vertices[vk]!;
      if (v.neighbors.some((nb) => game.buildings[nb])) continue;
      for (const ek of v.edges) {
        if (game.roads[ek] !== undefined) continue;
        out.push({ vertex: vk, edge: ek });
      }
    }
    return out;
  }

  /** 系统代放：走与手动完全相同的规则入口，不跳过距离/连接限制 */
  private autoPlace(seat: number): boolean {
    const combos = this.legalPlacements();
    if (combos.length === 0) {
      // 无合法候选：暂停开局并广播明确错误，不空转、不跳过、不伪造建筑
      this.setupDeadline = null;
      this.sendAll({ t: 'REJECT', reason: 'NO_LEGAL_PLACEMENT', detail: '选地超时但已无合法摆放点，开局已暂停' });
      return false;
    }
    const byVertex = new Map<string, string[]>();
    for (const c of combos) {
      const list = byVertex.get(c.vertex) ?? [];
      list.push(c.edge);
      byVertex.set(c.vertex, list);
    }
    const vertices = Array.from(byVertex.keys());
    const vertex = vertices[Math.floor(Math.random() * vertices.length)]!;
    const edges = byVertex.get(vertex)!;
    const edge = edges[Math.floor(Math.random() * edges.length)]!;

    const step = this.game!.setup!.step;
    // 走同一规则入口（applyCommand），但标记为内部代放，避免超时检查递归
    const outcome = this.command(seat, { type: 'PLACE_SETTLEMENT', seat, vertex, edge }, undefined, true);
    if (!outcome.ok) {
      this.setupDeadline = null;
      this.sendAll({ t: 'REJECT', reason: 'NO_LEGAL_PLACEMENT', detail: `系统代放被拒绝：${outcome.reason}` });
      return false;
    }
    this.sendAll({
      t: 'SETUP_AUTO_PLACED', seat, step, vertex, edge, reason: 'TIMEOUT',
    });
    this.sync(outcome.events);
    return true;
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
  command(seat: number, cmd: Command, rid?: string, internal = false): CommandOutcome {
    const reject = (
      reason: RejectReason | OfferRejectReason | LobbyRejectReason, detail?: string,
    ): CommandOutcome => {
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

    // 文档 23 §7：deadline 到达后的迟到提交必须被拒绝，并返回最新状态。
    // 先用权威时钟结算超时（可能已代放），再裁决这条迟到命令。
    // internal=true 是系统代放入口：它本身就是在结算超时，不能再次触发超时检查，
    // 否则 advanceClock → autoPlace → command → advanceClock 会无限递归。
    if (!internal && game.phase === 'setup' && this.setupDeadline && this.now() >= this.setupDeadline.deadline) {
      const autoPlaced = this.advanceClock();
      if (autoPlaced) {
        this.sendTo(seat, { t: 'STATE', seq: this.seq, events: [], view: viewFor(this.board, this.game!, seat), timer: this.currentTimer });
        return reject('SETUP_TIMEOUT_REJECTED', '已超时，系统完成代放；请按最新状态操作');
      }
      return reject('SETUP_TIMEOUT_REJECTED', '已超时，请等待最新状态');
    }

    // 座位以连接为准，客户端传什么都不算数
    // 骰子同样不许客户端指定 —— 否则「掷出想要的点数」只需改一行 JSON。
    // 只有显式打开 HEXFRONT_FAKE_DICE 的本地/验收环境才放行。
    const allowFakeDice = process.env.HEXFONT_FAKE_DICE === '1';
    const safe = allowFakeDice
      ? { ...cmd, seat }
      : { ...cmd, dice: undefined, seat };

    const wasSetup = game.phase === 'setup';
    const result = applyCommand(this.board, game, safe as Command);
    if (!result.ok) return reject(result.reason, result.detail);

    this.game = result.state;
    this.seq += 1;

    // 文档 23 §7：一次合法提交进入下一步骤，重新获得完整 180 秒；
    // 末位连续两次也各是一份独立预算。动画/广播不推迟计时。
    if (wasSetup && cmd.type === 'PLACE_SETTLEMENT') {
      this.armSetupTimer();
    }

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
    this.advanceClock();
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

  /** 全员同一份地图/大厅快照；地图重新随机显示操作者与版本 */
  broadcastLobbyConfig(reason: string): void {
    this.sendAll({
      t: 'LOBBY_CONFIG',
      lobby: this.lobbyConfig(),
      map: this.mapSnapshot,
      changedBy: this.changedBy,
      reason,
    });
  }

  /** 按座位裁剪视角后逐人推送。events 只用于让客户端播放动效，不参与状态还原。 */
  sync(events: GameEvent[] = []): void {
    const game = this.game;
    if (!game) {
      this.sendAll({
        t: 'LOBBY',
        roomId: this.id,
        capacity: this.capacity,
        players: this.lobbyPlayers(),
        lobby: this.lobbyConfig(),
        map: this.mapSnapshot,
      });
      return;
    }
    const timer = this.currentTimer;
    for (const [seat, socket] of this.sockets) {
      const view = viewFor(this.board, game, seat);
      socket.send(encode({ t: 'STATE', seq: this.seq, events, view, timer }));
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
  private readonly autoStartOnFull: boolean;
  private readonly minPlayers: number;
  private readonly skipReadyCheck: boolean;
  private readonly seed: string | undefined;
  private readonly mapFactory: NonNullable<RoomOptions['mapFactory']> | null;

  constructor(opts: {
    capacity?: number; maxRooms?: number; board?: Board; now?: () => number;
    autoStartOnFull?: boolean; minPlayers?: number; skipReadyCheck?: boolean; seed?: string;
    mapFactory?: RoomOptions['mapFactory'];
  } = {}) {
    this.capacity = opts.capacity ?? MIN_PLAYERS;
    this.maxRooms = opts.maxRooms ?? 64;
    this.board = opts.board;
    this.now = opts.now ?? (() => Date.now());
    this.autoStartOnFull = opts.autoStartOnFull ?? false;
    this.minPlayers = opts.minPlayers ?? MIN_PLAYERS;
    this.skipReadyCheck = opts.skipReadyCheck ?? false;
    this.seed = opts.seed;
    this.mapFactory = opts.mapFactory ?? null;
  }

  get size(): number {
    return this.rooms.size;
  }

  /** 构造房间的公共实现（create / getOrCreate 共用） */
  private makeRoom(id: string, players?: number): Room {
    const target = typeof players === 'number' && Number.isFinite(players)
      ? Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.floor(players)))
      : this.capacity;
    return new Room(id, {
      capacity: target,
      board: this.board,
      now: this.now,
      autoStartOnFull: this.autoStartOnFull,
      minPlayers: this.minPlayers,
      skipReadyCheck: this.skipReadyCheck,
      seed: this.seed,
      mapFactory: this.mapFactory,
    });
  }

  /**
   * F1：显式、原子地创建房间。已存在返回 ROOM_EXISTS；达到房间数上限返回 ROOM_LIMIT。
   * 创建与登记在同一同步块内完成 —— 两人并发 CREATE 同名房间只有一人成功。
   * 创建者随后以 JOIN 入座并被授予房主（见 Room.join 的 hostSeat 初始化）。
   */
  create(
    id: string, players?: number,
  ): { ok: true; room: Room } | { ok: false; reason: 'ROOM_EXISTS' | 'ROOM_LIMIT' } {
    if (this.rooms.has(id)) return { ok: false, reason: 'ROOM_EXISTS' };
    if (this.rooms.size >= this.maxRooms) return { ok: false, reason: 'ROOM_LIMIT' };
    const room = this.makeRoom(id, players);
    this.rooms.set(id, room);
    return { ok: true, room };
  }

  /**
   * 内部测试夹具保留：查找或创建（旧 2–3 人 WS 集成测试依赖「首个 JOIN 即建房间」）。
   * 产品路径已改为 server.ts 的 CREATE → JOIN 两段；JOIN 绝不隐式创建。
   */
  getOrCreate(id: string, players?: number): Room | null {
    const hit = this.rooms.get(id);
    if (hit) return hit;
    if (this.rooms.size >= this.maxRooms) return null;
    const room = this.makeRoom(id, players);
    this.rooms.set(id, room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  /** F1：CREATE 后紧接入座失败时撤掉刚建的空房间，避免留下孤儿房间 */
  delete(id: string): boolean {
    return this.rooms.delete(id);
  }

  list(): Room[] {
    return Array.from(this.rooms.values());
  }
}
