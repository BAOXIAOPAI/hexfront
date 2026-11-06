import type { GameState } from './state.js';
import type { GameEvent } from './events.js';
import type { Resource, ResourceCount } from './types.js';

/** 玩家意图。可能非法，需经引擎裁决。 */
export type Command =
  | { type: 'PLACE_SETTLEMENT'; seat: number; vertex: string; edge: string }
  | { type: 'ROLL_DICE'; seat: number; dice?: [number, number] }
  | { type: 'BUILD_ROAD'; seat: number; edge: string }
  | { type: 'BUILD_SETTLEMENT'; seat: number; vertex: string }
  | { type: 'BUILD_CITY'; seat: number; vertex: string }
  | { type: 'BUY_DEV_CARD'; seat: number }
  | { type: 'PLAY_KNIGHT'; seat: number; tile: string; stealFrom?: number }
  | { type: 'PLAY_MONOPOLY'; seat: number; resource: Resource }
  | { type: 'PLAY_PLENTY'; seat: number; resources: [Resource, Resource] }
  | { type: 'PLAY_ROAD_BUILDING'; seat: number; edges: [string, string?] }
  | { type: 'TRADE_PLAYER'; seat: number; withPlayer: number; give: Partial<ResourceCount>; get: Partial<ResourceCount> }
  | { type: 'TRADE_BANK'; seat: number; give: Resource; get: Resource }
  | { type: 'PORT_TRANSFER'; seat: number; beneficiary: number; give: Resource; get: Resource }
  | { type: 'DISCARD'; seat: number; resources: Partial<ResourceCount> }
  | { type: 'MOVE_ROBBER'; seat: number; tile: string; stealFrom?: number }
  | { type: 'END_TURN'; seat: number };

export type RejectReason =
  | 'WRONG_PHASE'
  | 'NOT_YOUR_TURN'
  | 'UNKNOWN_VERTEX'
  | 'UNKNOWN_EDGE'
  | 'UNKNOWN_TILE'
  | 'OCCUPIED'
  | 'TOO_CLOSE'
  | 'EDGE_TAKEN'
  | 'EDGE_NOT_ADJACENT'
  | 'ALREADY_ROLLED'
  | 'NOT_YET_ROLLED'
  | 'BAD_DICE'
  | 'INSUFFICIENT_RESOURCES'
  | 'BUILD_LIMIT'
  | 'NOT_CONNECTED'
  | 'NOT_YOUR_BUILDING'
  | 'NOT_A_VILLAGE'
  | 'CARD_NOT_AVAILABLE'
  | 'DEV_ALREADY_PLAYED'
  | 'DECK_EMPTY'
  | 'INVALID_TARGET'
  | 'ROBBER_SAME_TILE'
  | 'NOT_INVOLVED'
  | 'EMPTY_TRADE'
  | 'SAME_TARGET'
  | 'NO_PORT'
  | 'NOTHING_TO_DISCARD'
  | 'WRONG_DISCARD_COUNT'
  | 'DISCARD_PENDING'
  | 'ROBBER_PENDING'
  | 'ROBBER_NOT_PENDING'
  | 'UNKNOWN_COMMAND';

export type ApplyResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; reason: RejectReason; detail?: string };
