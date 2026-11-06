/**
 * 客户端 ↔ 服务端消息契约。
 *
 * 铁律：客户端只能「请求」，不能「告知结果」。
 * 所有状态变更都必须是一句话的命令，由服务端用引擎裁决后再广播。
 *
 * 放在独立包里，是因为服务端与前端必须共用同一份契约 —— 各写一份必然漂移。
 *
 * v2（重构阶段 C）：报价从「单条覆盖」改为「多条并存 + ID + 服务端时钟」。
 * 这是不兼容升级：PROTOCOL_VERSION 提升，JOIN 必须带 v，服务端会拒绝错位客户端。
 */

import type { Command, GameEvent, PlayerView, RejectReason, ResourceCount } from '@hexfront/engine';

/** 协议版本：客户端与服务端不匹配时直接拒绝，避免半夜里静默错位 */
export const PROTOCOL_VERSION = 2;

/** 指南第 1 / 7.2 节：报价寿命与发送冷却由服务端权威判定 */
export const OFFER_TTL_MS = 10_000;
export const OFFER_SEND_COOLDOWN_MS = 3_000;
export const MAX_LIVE_OFFERS_PER_PLAYER = 1;

export interface LobbyPlayer {
  seat: number;
  name: string;
  connected: boolean;
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

export type RejectCode = RejectReason | OfferRejectReason;

export type ClientMessage =
  | { t: 'JOIN'; roomId: string; name: string; v?: number }
  | { t: 'SET_SETTINGS'; setupGrant?: boolean }
  | { t: 'START' }
  /** rid 为可选的命令关联标识，服务端在 REJECT 中回显 */
  | { t: 'COMMAND'; cmd: Command; rid?: string }
  | { t: 'OFFER'; to: number; give: Partial<ResourceCount>; get: Partial<ResourceCount>; rid?: string }
  | { t: 'OFFER_ACCEPT'; offerId: string; rid?: string }
  | { t: 'OFFER_REJECT'; offerId: string; rid?: string }
  | { t: 'OFFER_CANCEL'; offerId: string; rid?: string }
  | { t: 'PING'; id?: number };

export type JoinFailReason =
  | 'ROOM_FULL' | 'IN_PROGRESS' | 'SEAT_TAKEN' | 'ROOM_LIMIT' | 'BAD_MESSAGE'
  | 'PROTOCOL_MISMATCH';

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
    }
  | { t: 'LOBBY'; roomId: string; capacity: number; players: LobbyPlayer[] }
  | { t: 'SETTINGS'; settings: RoomSettings; locked: boolean }
  | { t: 'STATE'; seq: number; events: GameEvent[]; view: PlayerView }
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
  if (t === 'JOIN') {
    const roomId = obj.roomId;
    const name = obj.name;
    // v 必须保留：服务端靠它拒绝错位客户端（指南 10.3）
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
  if (t === 'START') return { t: 'START' };
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
    case 'SETTINGS':
    case 'STATE':
    case 'OFFERS':
    case 'REJECT':
    case 'JOIN_FAILED':
    case 'PONG':
      return parsed as ServerMessage;
    default:
      return null;
  }
}
