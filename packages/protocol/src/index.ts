/**
 * 客户端 ↔ 服务端消息契约。
 *
 * 铁律：客户端只能「请求」，不能「告知结果」。
 * 所有状态变更都必须是一句话的命令，由服务端用引擎裁决后再广播。
 *
 * 放在独立包里，是因为服务端与前端必须共用同一份契约 —— 各写一份必然漂移。
 *
 * v2（重构阶段 C）：报价从「单条覆盖」改为「多条并存 + ID + 服务端时钟」。
 * v3（文档 23）：房间人数/地图/准备/排序/计时。JOIN 版本校验继续保留。
 * v4（文档 24 线上实测修复）：
 *   - F1：CREATE 显式创建房间（原子、创建者即房主）；JOIN 仅查找已存在房间，
 *     不存在返回 ROOM_NOT_FOUND，创建重名返回 ROOM_EXISTS。
 *   - F2：人数设置与手动选图分成不同意图（targetPlayers / board 二选一）。
 *   - F5：删除 PORT_TRANSFER 借港代换；TRADE_BANK 严格 4:1；新增 TRADE_PORT
 *     自有港口兑换（通用港任意 3 张混合 / 专用港对应 2:1）。
 *   旧版客户端会被服务端以 PROTOCOL_MISMATCH 明确拒绝（前后端同批构建）。
 */

import type { Command, GameEvent, PlayerView, RejectReason, ResourceCount } from '@hexfront/engine';

/** 协议版本：客户端与服务端不匹配时直接拒绝，避免半夜里静默错位 */
export const PROTOCOL_VERSION = 4;

/** 指南第 1 / 7.2 节：报价寿命与发送冷却由服务端权威判定 */
export const OFFER_TTL_MS = 10_000;
export const OFFER_SEND_COOLDOWN_MS = 3_000;
export const MAX_LIVE_OFFERS_PER_PLAYER = 1;

/** 文档 23：每次「村庄＋相邻道路」独立 180 秒 */
export const SETUP_STEP_MS = 180_000;
/** 房主断线后保留身份、锁定开始按钮的时长；超时移交给最早入房且在线者 */
export const HOST_GRACE_MS = 60_000;
/** 正式开局最少人数与目标人数上下限 */
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 8;

export type BoardKind = 'base' | 'ext';

export interface LobbyPlayer {
  seat: number;
  name: string;
  connected: boolean;
  ready: boolean;
}

/**
 * 桌面上的报价。桌游里人人听得见，所以是公开信息，
 * 但对局外的人看不到（他们不在房间里）。
 * id / createdAt / expiresAt 一律由服务端分配，客户端不得指定。
 */
export interface OfferView {
  id: string;
  from: number;
  to: number;
  /** 发起方付出的 */
  give: Partial<ResourceCount>;
  /** 发起方想要的 */
  get: Partial<ResourceCount>;
  createdAt: number;
  expiresAt: number;
}

/** 报价列表快照：WELCOME 与每次变动都推同一份结构 */
export interface OfferSnapshot {
  /** 按创建时间排序的活跃报价 */
  offers: OfferView[];
  /** 列表版本，客户端据此识别旧快照 */
  version: number;
  /** 服务端时间（毫秒），客户端用时间差估算倒计时 */
  serverTime: number;
  /** 座位号字符串 → 该玩家下次允许发送报价的服务端时间 */
  nextSendAt: Record<string, number>;
}

/** 报价终止原因，用于客户端给出贴近操作的解释 */
export type OfferEndReason =
  | 'CREATED' | 'REPLACED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED'
  | 'EXPIRED' | 'ROLL_SEVEN' | 'END_TURN' | 'GAME_END';

/**
 * 房间级规则设置。只在开局前可改，开局后锁定到整局结束。
 * 由服务端权威保存，客户端只发「想改成什么」，不能告知结果。
 */
export interface RoomSettings {
  /** 第二轮摆位时，村庄相邻地块各发 1 张资源；关掉则空手开局 */
  setupGrant: boolean;
}

export const DEFAULT_SETTINGS: RoomSettings = { setupGrant: true };

/** 文档 23 L-2：地图公开快照，全员看到同一份，客户端不得自行生成 */
export interface MapTileSnapshot {
  key: string;
  terrain: string;
  number: number | null;
}
export interface PortSnapshot {
  edge: string;
  port: { kind: 'generic' } | { kind: 'specific'; resource: string };
}
export interface MapSnapshot {
  kind: BoardKind;
  rows: number[];
  tiles: MapTileSnapshot[];
  ports: PortSnapshot[];
  robberTile: string;
  /** 公开种子：仅用于地图，绝不复用为骰子/发展卡随机源 */
  seed: string;
  generatorVersion: number;
  boardVersion: number;
}

/**
 * 文档 23 L-1/L-4：大厅权威配置快照。
 * 任何配置变化都递增 configVersion 并清空全员准备；客户端只展示。
 */
export interface LobbyConfig {
  /** 房主 seat；断线宽限或主动离房后按服务端规则移交 */
  hostSeat: number;
  /** 房主开局前设定的目标人数（4–8），也是本局容量 */
  targetPlayers: number;
  /** 地图类型；boardChoice 标记是否由房主手动改选 */
  board: BoardKind;
  boardChoice: 'auto' | 'manual';
  /** 按目标人数推荐的地图，用于「自定义/拥挤」提示 */
  recommendedBoard: BoardKind;
  /** 配置版本：START 必须携带一致版本，拒绝并发旧版本开始 */
  configVersion: number;
  /** 稳定的行动顺序（seat 排列），开局后锁定 */
  actionOrder: number[];
  ready: boolean[];
  /** 最近一次配置变更的操作者 seat 与原因，供「谁改的」展示 */
  changedBy: number;
  changeReason: string;
  /** 全员在线且准备、人数达标时才为 true（服务端计算，客户端不自行推断） */
  canStart: boolean;
  /** 不能开始时的原因（服务端权威） */
  startBlockReason: string | null;
}

/** 文档 23 L-4：当前选地步骤的权威计时 */
export interface SetupTimer {
  /** 当前放置序号，与 GameState.setup.step 一致 */
  step: number;
  /** 该谁的 seat */
  seat: number;
  /** 服务端绝对截止时刻（毫秒）；刷新/重连不能重置 */
  deadline: number;
  /** 该步骤起始时刻，供客户端展示进度 */
  startedAt: number;
  serverTime: number;
}

/** 报价层拒绝原因（不是引擎规则原因，服务端协商层自己的校验） */
export type OfferRejectReason =
  | 'BAD_OFFER'
  | 'OFFER_EXPIRED'
  | 'OFFER_NOT_FOUND'
  | 'OFFER_NOT_FOR_YOU'
  | 'OFFER_COOLDOWN'
  | 'OFFER_FORBIDDEN'
  | 'OFFER_REPLACED'
  | 'DISCARD_PENDING'
  | 'GAME_ENDED'
  | 'NOT_SEATED'
  | 'GAME_NOT_STARTED'
  /** 传输层滥发限制，与业务冷却分开计算 */
  | 'RATE_LIMITED';

/** 文档 23：房间/大厅层拒绝原因 */
export type LobbyRejectReason =
  | 'NOT_HOST'
  | 'GAME_ALREADY_STARTED'
  | 'NOT_ALL_READY'
  | 'NOT_ENOUGH_PLAYERS'
  | 'PLAYERS_OFFLINE'
  | 'CONFIG_VERSION_MISMATCH'
  | 'BAD_PLAYER_COUNT'
  | 'BAD_BOARD'
  | 'BAD_ORDER'
  | 'BOARD_NOT_READY'
  | 'SETUP_TIMEOUT_REJECTED'
  | 'NO_LEGAL_PLACEMENT';

export type RejectCode = RejectReason | OfferRejectReason | LobbyRejectReason;

export type ClientMessage =
  /**
   * F1：显式创建房间。服务端原子创建并把创建者设为房主；房间不存在时才允许。
   * 与 JOIN 严格分开 —— JOIN 绝不隐式创建房间，也不带人数。
   */
  | {
      t: 'CREATE'; roomId: string; name: string; v?: number;
      /** 文档 23 L-0 E：创建者设定的目标人数（4–8） */
      players?: number;
    }
  /** F1：加入已存在的房间；不存在由服务端回 ROOM_NOT_FOUND */
  | { t: 'JOIN'; roomId: string; name: string; v?: number }
  | { t: 'SET_SETTINGS'; setupGrant?: boolean }
  /** F2：人数设置（自动按推荐换盘）与手动选地图分成两个独立意图，绝不一起提交 */
  | { t: 'SET_PLAYER_COUNT'; targetPlayers: number; configVersion?: number }
  | { t: 'SET_BOARD'; board: BoardKind; configVersion?: number }
  | { t: 'REROLL_MAP'; configVersion?: number }
  | { t: 'READY'; ready: boolean }
  | { t: 'SET_ORDER'; order: number[]; configVersion?: number }
  | { t: 'RANDOMIZE_ORDER'; configVersion?: number }
  | { t: 'START'; configVersion?: number }
  /** rid 为可选的命令关联标识，服务端在 REJECT 中回显 */
  | { t: 'COMMAND'; cmd: Command; rid?: string }
  | { t: 'OFFER'; to: number; give: Partial<ResourceCount>; get: Partial<ResourceCount>; rid?: string }
  | { t: 'OFFER_ACCEPT'; offerId: string; rid?: string }
  | { t: 'OFFER_REJECT'; offerId: string; rid?: string }
  | { t: 'OFFER_CANCEL'; offerId: string; rid?: string }
  | { t: 'PING'; id?: number };

export type JoinFailReason =
  | 'ROOM_FULL' | 'IN_PROGRESS' | 'SEAT_TAKEN' | 'ROOM_LIMIT' | 'BAD_MESSAGE'
  | 'PROTOCOL_MISMATCH'
  /** F1：JOIN 找不到房间 / CREATE 撞上重名 */
  | 'ROOM_NOT_FOUND' | 'ROOM_EXISTS';

export type ServerMessage =
  | {
      t: 'WELCOME';
      roomId: string;
      seat: number;
      capacity: number;
      players: LobbyPlayer[];
      /** 已开局时附带本座位的完整视角 */
      view: PlayerView | null;
      /** 恢复快照：未过期报价、列表版本、服务端时间、每人冷却 */
      snapshot: OfferSnapshot;
      /** 当前权威状态版本，用于拒绝旧更新 */
      stateSeq: number;
      /** 文档 23：大厅/地图/计时权威快照 */
      lobby: LobbyConfig | null;
      map: MapSnapshot | null;
      timer: SetupTimer | null;
      settings: RoomSettings;
    }
  | {
      t: 'LOBBY';
      roomId: string;
      capacity: number;
      players: LobbyPlayer[];
      lobby: LobbyConfig;
      map: MapSnapshot;
    }
  | { t: 'LOBBY_CONFIG'; lobby: LobbyConfig; map: MapSnapshot; changedBy: number; reason: string }
  | { t: 'SETTINGS'; settings: RoomSettings; locked: boolean }
  | { t: 'STATE'; seq: number; events: GameEvent[]; view: PlayerView; timer: SetupTimer | null }
  | { t: 'SETUP_TIMER'; timer: SetupTimer }
  | { t: 'SETUP_AUTO_PLACED'; seat: number; step: number; vertex: string; edge: string; reason: 'TIMEOUT' }
  | { t: 'OFFERS'; snapshot: OfferSnapshot; reason: OfferEndReason; offerId?: string }
  | { t: 'REJECT'; reason: RejectCode; detail?: string; rid?: string }
  | { t: 'JOIN_FAILED'; reason: JoinFailReason }
  | { t: 'PONG'; id?: number };

export function encode(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function encodeClient(msg: ClientMessage): string {
  return JSON.stringify(msg);
}

function optionalRid(raw: Record<string, unknown>): { rid?: string } {
  return typeof raw.rid === 'string' && raw.rid.length > 0 && raw.rid.length <= 64
    ? { rid: raw.rid }
    : {};
}

function optionalConfigVersion(raw: Record<string, unknown>): { configVersion?: number } {
  const v = raw.configVersion;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? { configVersion: Math.floor(v) } : {};
}

/** 解析客户端消息，畸形数据一律返回 null（不抛异常，避免一条脏消息打断整个连接） */
export function decodeClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const t = obj.t;
  // F1：CREATE 与 JOIN 是两条独立消息；JOIN 绝不带人数、绝不隐式创建房间。
  if (t === 'CREATE') {
    const roomId = obj.roomId;
    const name = obj.name;
    // v 必须保留：服务端靠它拒绝错位客户端（指南 10.3）
    const v = typeof obj.v === 'number' ? obj.v : undefined;
    const p = obj.players;
    return {
      t: 'CREATE',
      roomId: typeof roomId === 'string' ? roomId : 'main',
      name: typeof name === 'string' ? name : '',
      ...(v === undefined ? {} : { v }),
      ...(typeof p === 'number' && Number.isFinite(p) ? { players: Math.floor(p) } : {}),
    };
  }
  if (t === 'JOIN') {
    const roomId = obj.roomId;
    const name = obj.name;
    const v = typeof obj.v === 'number' ? obj.v : undefined;
    return {
      t: 'JOIN',
      roomId: typeof roomId === 'string' ? roomId : 'main',
      name: typeof name === 'string' ? name : '',
      ...(v === undefined ? {} : { v }),
    };
  }
  if (t === 'SET_SETTINGS') {
    const setupGrant = obj.setupGrant;
    if (typeof setupGrant !== 'boolean') return null;
    return { t: 'SET_SETTINGS', setupGrant };
  }
  // F2：人数与手动选图分成两个意图；一条消息只做一件事，杜绝「顺手把当前盘当手动选」。
  if (t === 'SET_PLAYER_COUNT') {
    const n = obj.targetPlayers;
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    return { t: 'SET_PLAYER_COUNT', targetPlayers: Math.floor(n), ...optionalConfigVersion(obj) };
  }
  if (t === 'SET_BOARD') {
    if (obj.board !== 'base' && obj.board !== 'ext') return null;
    return { t: 'SET_BOARD', board: obj.board, ...optionalConfigVersion(obj) };
  }
  // 旧 SET_ROOM_CONFIG / PORT_TRANSFER 等命令一律不解析（返回 null → BAD_MESSAGE），
  // 不留下隐藏命令绕过新规则。
  if (t === 'REROLL_MAP') return { t: 'REROLL_MAP', ...optionalConfigVersion(obj) };
  if (t === 'READY') return typeof obj.ready === 'boolean' ? { t: 'READY', ready: obj.ready } : null;
  if (t === 'SET_ORDER') {
    if (!Array.isArray(obj.order) || !obj.order.every((x) => typeof x === 'number' && Number.isInteger(x))) {
      return null;
    }
    return { t: 'SET_ORDER', order: obj.order as number[], ...optionalConfigVersion(obj) };
  }
  if (t === 'RANDOMIZE_ORDER') return { t: 'RANDOMIZE_ORDER', ...optionalConfigVersion(obj) };
  if (t === 'START') return { t: 'START', ...optionalConfigVersion(obj) };
  if (t === 'COMMAND') {
    const cmd = obj.cmd;
    if (typeof cmd !== 'object' || cmd === null) return null;
    if (typeof (cmd as { type?: unknown }).type !== 'string') return null;
    return { t: 'COMMAND', cmd: cmd as Command, ...optionalRid(obj) };
  }
  if (t === 'PING') {
    const id = obj.id;
    return typeof id === 'number' ? { t: 'PING', id } : { t: 'PING' };
  }
  if (t === 'OFFER') {
    const { to, give, get } = obj;
    if (typeof to !== 'number' || typeof give !== 'object' || give === null
        || typeof get !== 'object' || get === null) {
      return null;
    }
    return {
      t: 'OFFER', to,
      give: give as Partial<ResourceCount>,
      get: get as Partial<ResourceCount>,
      ...optionalRid(obj),
    };
  }
  // 接受/拒绝/撤回必须携带报价 ID：没有 ID 的请求一律视为畸形，绝不「按当前那条」处理
  for (const kind of ['OFFER_ACCEPT', 'OFFER_REJECT', 'OFFER_CANCEL'] as const) {
    if (t === kind) {
      const offerId = obj.offerId;
      if (typeof offerId !== 'string' || offerId.length === 0 || offerId.length > 64) return null;
      return { t: kind, offerId, ...optionalRid(obj) };
    }
  }
  return null;
}

/**
 * 解析服务端推送。前端拿到脏数据时应当忽略而不是崩掉整个界面，
 * 因此这里同样返回 null 而不是抛异常。
 */
export function decodeServerMessage(raw: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const t = (parsed as { t?: unknown }).t;
  switch (t) {
    case 'WELCOME':
    case 'LOBBY':
    case 'LOBBY_CONFIG':
    case 'SETTINGS':
    case 'STATE':
    case 'SETUP_TIMER':
    case 'SETUP_AUTO_PLACED':
    case 'OFFERS':
    case 'REJECT':
    case 'JOIN_FAILED':
    case 'PONG':
      return parsed as ServerMessage;
    default:
      return null;
  }
}
