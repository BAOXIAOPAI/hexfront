/**
 * 建造模式的候选位与资源检查。
 *
 * 和 placement.ts 一样，这里只算「界面上该亮哪里」，
 * 真正的裁决一律在服务端 applyCommand。规则若有不一致，
 * 表现是「点了被 REJECT」，不会出现「非法建造成功」。
 */

import { COSTS, type Geometry, type PlayerView, type Resource, type ResourceCount } from '@hexfront/engine';

export type BuildMode = 'road' | 'settlement' | 'city';

export const BUILD_ORDER: BuildMode[] = ['road', 'settlement', 'city'];

export const BUILD_LABEL: Record<BuildMode, string> = {
  road: '道路',
  settlement: '村庄',
  city: '城市',
};

/** 界面上展示成本的固定顺序，和手牌区一致 */
const COST_ORDER: Resource[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

export const RESOURCE_LABEL: Record<Resource, string> = {
  wood: '木',
  brick: '砖',
  sheep: '羊',
  wheat: '麦',
  ore: '矿',
};

/** 资源不足时缺哪几种 —— 用来在面板上说明「为什么点不了」 */
export function missingFor(hand: ResourceCount, mode: BuildMode): Resource[] {
  const cost = COSTS[mode];
  return COST_ORDER.filter((r) => (hand[r] ?? 0) < (cost[r] ?? 0));
}

export function canAfford(hand: ResourceCount, mode: BuildMode): boolean {
  return missingFor(hand, mode).length === 0;
}

/** 成本的可读写法，例如「木1 砖1」 */
export function costText(mode: BuildMode): string {
  const cost = COSTS[mode];
  return COST_ORDER.filter((r) => (cost[r] ?? 0) > 0)
    .map((r) => `${RESOURCE_LABEL[r]}${cost[r]}`)
    .join(' ');
}

export interface Candidates {
  vertices: string[];
  edges: string[];
}

const EMPTY: Candidates = { vertices: [], edges: [] };

/**
 * 某种建造模式下的合法位置。
 *
 * - 道路：空格子边，且与自己的建筑或已有道路相邻
 * - 村庄：空顶点、周围无建筑、并且挨着自己的一条路
 * - 城市：自己的村庄（未升级的）
 */
export function candidatesFor(view: PlayerView, geo: Geometry, mode: BuildMode): Candidates {
  const me = view.viewer;

  if (mode === 'road') {
    const edges = geo.edgeKeys.filter((ek) => {
      if (view.roads[ek] !== undefined) return false;
      const edge = geo.edges[ek];
      if (!edge) return false;
      return [edge.a, edge.b].some((vk) => {
        const building = view.buildings[vk];
        if (building && building.owner === me) return true;
        const vertex = geo.vertices[vk];
        return vertex ? vertex.edges.some((x) => x !== ek && view.roads[x] === me) : false;
      });
    });
    return { vertices: [], edges };
  }

  if (mode === 'settlement') {
    const vertices = geo.vertexKeys.filter((vk) => {
      if (view.buildings[vk]) return false;
      const vertex = geo.vertices[vk];
      if (!vertex) return false;
      if (vertex.neighbors.some((nb) => view.buildings[nb])) return false;
      return vertex.edges.some((ek) => view.roads[ek] === me);
    });
    return { vertices, edges: [] };
  }

  const vertices = geo.vertexKeys.filter((vk) => {
    const building = view.buildings[vk];
    return building !== undefined && building.owner === me && !building.city;
  });
  return { vertices, edges: [] };
}

/** 建造模式下棋盘该显示的覆盖层；没有候选就返回 undefined，避免空转 */
export function overlayFor(
  view: PlayerView,
  geo: Geometry,
  mode: BuildMode,
): { vertices: string[]; edges: string[]; picked: null } | undefined {
  const c = candidatesFor(view, geo, mode);
  if (c.vertices.length === 0 && c.edges.length === 0) return undefined;
  return { vertices: c.vertices, edges: c.edges, picked: null };
}

export { EMPTY as NO_CANDIDATES };
