/**
 * 基础类型与枚举。
 * 顺序一旦确定不得重排 —— 序列化、存档、事件流都依赖它。
 */

export const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'] as const;
export type Resource = (typeof RESOURCES)[number];

export const TERRAINS = [...RESOURCES, 'desert'] as const;
export type Terrain = (typeof TERRAINS)[number];

export const DEV_CARDS = ['knight', 'victory', 'monopoly', 'plenty', 'roadbuilding'] as const;
export type DevCard = (typeof DEV_CARDS)[number];

export const PLAYER_COLORS = ['red', 'blue', 'white', 'orange'] as const;
export type PlayerColor = (typeof PLAYER_COLORS)[number];

/** 港口：3:1 通用，或 2:1 指定资源 */
export type Port =
  | { kind: 'generic' }
  | { kind: 'specific'; resource: Resource };

export type ResourceCount = Record<Resource, number>;

export function emptyResources(): ResourceCount {
  return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
}

export function totalCards(r: ResourceCount): number {
  return RESOURCES.reduce((sum, k) => sum + r[k], 0);
}

export interface Point {
  x: number;
  y: number;
}

/** 建造物 */
export interface Building {
  owner: number;
  city: boolean;
}
