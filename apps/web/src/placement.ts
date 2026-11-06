/**
 * 开局摆位的「可用性提示」。
 *
 * 铁律：这里算出来的东西**不是**规则裁决，只是让玩家知道该点哪里。
 * 真正的合法性一律由服务端 applyCommand 判定，被拒绝就回 REJECT。
 * 之所以敢在前端算一遍，是因为视图里已经有 buildings / roads，
 * 距离规则与占用规则都能从视图直接读出来，不需要知道手牌等隐藏信息。
 */

import { setupSequence, type Geometry, type PlayerView } from '@hexfront/engine';

export type SetupRound = 1 | 2;

export interface SetupInfo {
  /** 是不是该我摆 */
  active: boolean;
  /** 该谁摆 */
  seat: number;
  /** 已完成的放置次数（0 起） */
  step: number;
  /** 总共要放几次 = 人数 × 2 */
  total: number;
  /** 第几轮：每人第一圈 / 第二圈 */
  round: SetupRound;
}

/** 当前是否处于摆位阶段；不是则返回 null */
export function setupInfo(view: PlayerView): SetupInfo | null {
  if (view.phase !== 'setup' || !view.setup) return null;
  const total = view.players.length * 2;
  const step = Math.min(view.setup.step, total);
  return {
    active: view.setup.seat === view.viewer,
    seat: view.setup.seat,
    step,
    total,
    round: step < view.players.length ? 1 : 2,
  };
}

/**
 * 逐步的座位序列，用于画摆位进度条。
 * 直接复用引擎的蛇形顺序，前端不再复制一份 0,1,2,3,3,2,1,0 的推导。
 */
export function setupSeats(view: PlayerView): number[] {
  const n = view.players.length;
  return n > 0 ? setupSequence(n) : [];
}

/** 该路口是否还能落村：空着，且不与任何已有建筑相邻（含自己的） */
export function spotOpen(view: PlayerView, geo: Geometry, vertexKey: string): boolean {
  const vertex = geo.vertices[vertexKey];
  if (!vertex) return false;
  if (view.buildings[vertexKey]) return false;
  return !vertex.neighbors.some((nb) => view.buildings[nb]);
}

/** 本轮可点的路口。不是我摆位就返回空数组 —— 没得点，也不用画热区 */
export function candidateVertices(view: PlayerView, geo: Geometry): string[] {
  const info = setupInfo(view);
  if (!info?.active) return [];
  return geo.vertexKeys.filter((vk) => spotOpen(view, geo, vk));
}

/** 选定村庄后，可放的相邻边（引擎要求路必须挨着刚建的村庄） */
export function candidateEdges(view: PlayerView, geo: Geometry, vertexKey: string | null): string[] {
  if (!vertexKey) return [];
  const info = setupInfo(view);
  if (!info?.active) return [];
  const vertex = geo.vertices[vertexKey];
  if (!vertex) return [];
  return vertex.edges.filter((ek) => view.roads[ek] === undefined);
}
