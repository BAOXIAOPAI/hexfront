/**
 * 事件：引擎裁决后的既成事实，一定合法。
 * 客户端只消费事件，不直接改状态。
 */

import type { DevCard, PlayerColor, Resource, ResourceCount } from './types.js';

export type GameEvent =
  | { type: 'GAME_STARTED'; mapId: string; players: { name: string; color: PlayerColor }[] }
  | { type: 'SETUP_PLACED'; player: number; vertex: string; edge: string; round: 1 | 2 }
  | { type: 'SETUP_COMPLETED'; firstPlayer: number }
  | { type: 'TURN_BEGUN'; player: number; turn: number }
  | { type: 'DICE_ROLLED'; player: number; dice: [number, number]; sum: number }
  | { type: 'RESOURCES_GAINED'; player: number; resources: Partial<ResourceCount> }
  | { type: 'SEVEN_ROLLED'; player: number }
  | { type: 'DISCARD_REQUIRED'; requirements: { player: number; count: number }[] }
  | { type: 'CARDS_DISCARDED'; player: number; count: number }
  | { type: 'ROAD_BUILT'; player: number; edge: string }
  | { type: 'SETTLEMENT_BUILT'; player: number; vertex: string }
  | { type: 'CITY_BUILT'; player: number; vertex: string }
  | { type: 'RESOURCES_SPENT'; player: number; resources: Partial<ResourceCount> }
  | { type: 'ROBBER_MOVED'; player: number; from: string; to: string }
  | { type: 'CARD_STOLEN'; thief: number; victim: number }
  | { type: 'DEV_CARD_BOUGHT'; player: number; count: number }
  | { type: 'DEV_CARD_PLAYED'; player: number; card: DevCard }
  | { type: 'MONOPOLY_RESOLVED'; player: number; resource: Resource; gains: { player: number; amount: number }[] }
  | { type: 'LONGEST_ROAD_CHANGED'; player: number; previous: number | null; length: number }
  | { type: 'LARGEST_ARMY_CHANGED'; player: number; previous: number | null; count: number }
  | { type: 'TRADE_COMPLETED'; a: number; b: number; aGives: Partial<ResourceCount>; bGives: Partial<ResourceCount> }
  | { type: 'BANK_TRADED'; player: number; give: Resource; get: Resource; ratio: number }
  /** F5：自有港口兑换；give 是资源袋（通用港可混合），不再有 executor/beneficiary 借港代换 */
  | { type: 'PORT_TRADED'; player: number; port: string; give: Partial<ResourceCount>; get: Resource; ratio: number }
  | { type: 'GAME_WON'; player: number; score: number }
  | { type: 'TURN_ENDED'; player: number };
