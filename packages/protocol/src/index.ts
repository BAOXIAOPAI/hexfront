/**
 * 客户端 ↔ 服务端消息契约。
 *
 * 铁律：客户端只能「请求」，不能「告知结果」。
 * 所有状态变更都必须是一句话的命令，由服务端用引擎裁决后再广播。
 *
 * 放在独立包里，是因为服务端与前端必须共用同一份契约 —— 各写一份必然漂移。
 */

import type { Command, GameEvent, PlayerView, RejectReason, ResourceCount } from '@hexfront/engine';

/** 协议版本：客户端与服务端不匹配时直接拒绝，避免半夜里静默错位 */
export const PROTOCOL_VERSION = 1;

export interface LobbyPlayer {
  seat: number;
  name: string;
  connected: boolean;
}

/**
 * 桌面上的报价。桌游里人人听得见，所以是公开信息，
 * 但对局外的人看不到（他们不在房间里）。
 */
export interface TradeOfferView {
  from: number;
  to: number;
  /** 发起方付出的 */
  give: Partial<ResourceCount>;
  /** 发起方想要的 */
  get: Partial<ResourceCount>;
}

/**
 * 房间级规则设置。只在开局前可改，开局后锁定到整局结束。
 * 由服务端权威保存，客户端只发「想改成什么」，不能告知结果。
 */
export interface RoomSettings {
  /** 第二轮摆位时，村庄相邻地块各发 1 张资源；关掉则空手开局 */
  setupGrant: boolean;
}

export const DEFAULT_SETTINGS: RoomSettings = { setupGrant: true };

export type ClientMessage =
  | { t: 'JOIN'; roomId: string; name: string; v?: number }
  | { t: 'SET_SETTINGS'; setupGrant?: boolean }
  | { t: 'START' }
  | { t: 'COMMAND'; cmd: Command }
  | { t: 'OFFER'; to: number; give: Partial<ResourceCount>; get: Partial<ResourceCount> }
  | { t: 'OFFER_ACCEPT' }
  | { t: 'OFFER_REJECT' }
  | { t: 'OFFER_CANCEL' }
  | { t: 'PING'; id?: number };

export type JoinFailReason = 'ROOM_FULL' | 'IN_PROGRESS' | 'SEAT_TAKEN' | 'ROOM_LIMIT' | 'BAD_MESSAGE';

export type ServerMessage =
  | {
      t: 'WELCOME';
      roomId: string;
      seat: number;
      capacity: number;
      players: LobbyPlayer[];
      /** 已开局时附带本座位的完整视角 */
      view: PlayerView | null;
      /** 房间里正挂着的报价（重连回来也能看到） */
      offer: TradeOfferView | null;
    }
  | { t: 'LOBBY'; roomId: string; capacity: number; players: LobbyPlayer[] }
  | { t: 'SETTINGS'; settings: RoomSettings; locked: boolean }
  | { t: 'STATE'; seq: number; events: GameEvent[]; view: PlayerView }
  | { t: 'OFFER'; offer: TradeOfferView | null }
  | { t: 'REJECT'; reason: RejectReason | 'GAME_NOT_STARTED' | 'NOT_SEATED' | 'BAD_OFFER'; detail?: string }
  | { t: 'JOIN_FAILED'; reason: JoinFailReason }
  | { t: 'PONG'; id?: number };

export function encode(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

/** 客户端发消息：多带一个协议版本，服务端可据此拒绝错位的老客户端 */
export function encodeClient(msg: ClientMessage): string {
  return JSON.stringify(msg);
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
  const t = (parsed as { t?: unknown }).t;
  if (t === 'JOIN') {
    const roomId = (parsed as { roomId?: unknown }).roomId;
    const name = (parsed as { name?: unknown }).name;
    return {
      t: 'JOIN',
      roomId: typeof roomId === 'string' ? roomId : 'main',
      name: typeof name === 'string' ? name : '',
    };
  }
  if (t === 'SET_SETTINGS') {
    const setupGrant = (parsed as { setupGrant?: unknown }).setupGrant;
    if (typeof setupGrant !== 'boolean') return null;
    return { t: 'SET_SETTINGS', setupGrant };
  }
  if (t === 'START') return { t: 'START' };
  if (t === 'COMMAND') {
    const cmd = (parsed as { cmd?: unknown }).cmd;
    if (typeof cmd !== 'object' || cmd === null) return null;
    if (typeof (cmd as { type?: unknown }).type !== 'string') return null;
    return { t: 'COMMAND', cmd: cmd as Command };
  }
  if (t === 'PING') {
    const id = (parsed as { id?: unknown }).id;
    return typeof id === 'number' ? { t: 'PING', id } : { t: 'PING' };
  }
  if (t === 'OFFER') {
    const { to, give, get } = parsed as { to?: unknown; give?: unknown; get?: unknown };
    if (typeof to !== 'number' || typeof give !== 'object' || give === null || typeof get !== 'object' || get === null) {
      return null;
    }
    return { t: 'OFFER', to, give: give as Partial<ResourceCount>, get: get as Partial<ResourceCount> };
  }
  if (t === 'OFFER_ACCEPT') return { t: 'OFFER_ACCEPT' };
  if (t === 'OFFER_REJECT') return { t: 'OFFER_REJECT' };
  if (t === 'OFFER_CANCEL') return { t: 'OFFER_CANCEL' };
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
    case 'OFFER':
    case 'REJECT':
    case 'JOIN_FAILED':
    case 'PONG':
      return parsed as ServerMessage;
    default:
      return null;
  }
}
