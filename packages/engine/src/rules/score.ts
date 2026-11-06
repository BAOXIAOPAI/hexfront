/**
 * 最长路、最大军、计分与胜负。
 *
 * 最长路的关键：求「最长简单路径」，不能数路的总条数，也不能穿过对手建筑。
 */

import type { Board, GameState } from '../state.js';

export interface LongestRoadState {
  player: number;
  length: number;
}

export interface LargestArmyState {
  player: number;
  count: number;
}

const MIN_LONGEST_ROAD = 5;
const MIN_ARMY = 3;
const WIN_SCORE = 10;

/**
 * 计算某个玩家的最长连续道路长度。
 * 被对手村庄/城市占据的顶点视为不可通行；自己的建筑可以穿过。
 */
export function computeLongestRoad(board: Board, state: GameState, player: number): number {
  const { geo } = board;

  const myEdges: string[] = [];
  for (const ek of Object.keys(state.roads)) {
    if (state.roads[ek] === player) myEdges.push(ek);
  }
  if (myEdges.length === 0) return 0;

  const adj = new Map<string, string[]>();
  for (const ek of myEdges) {
    const e = geo.edges[ek];
    if (!e) continue;
    for (const vk of [e.a, e.b]) {
      const list = adj.get(vk);
      if (list) list.push(ek);
      else adj.set(vk, [ek]);
    }
  }

  const blocked = (vk: string): boolean => {
    const b = state.buildings[vk];
    return b !== undefined && b.owner !== player;
  };

  let best = 0;

  const walk = (vk: string, used: Set<string>, count: number): void => {
    if (count > best) best = count;
    const list = adj.get(vk);
    if (!list) return;
    for (const ek of list) {
      if (used.has(ek)) continue;
      const e = geo.edges[ek]!;
      const next = e.a === vk ? e.b : e.a;
      if (blocked(next)) continue;
      used.add(ek);
      walk(next, used, count + 1);
      used.delete(ek);
    }
  };

  for (const start of adj.keys()) {
    if (blocked(start)) continue;
    walk(start, new Set<string>(), 0);
  }

  return best;
}

/** 重新裁决最长路持有者（就地修改） */
export function recomputeLongestRoad(board: Board, state: GameState): void {
  const lengths = state.players.map((p) => computeLongestRoad(board, state, p.index));
  const current = state.longestRoad;

  if (current) {
    const ownLength = lengths[current.player] ?? 0;
    if (ownLength < MIN_LONGEST_ROAD) {
      state.longestRoad = null;
    } else {
      const challenger = state.players.findIndex(
        (p) => p.index !== current.player && (lengths[p.index] ?? 0) > ownLength,
      );
      if (challenger >= 0) {
        state.longestRoad = { player: challenger, length: lengths[challenger] ?? 0 };
      } else {
        state.longestRoad = { player: current.player, length: ownLength };
      }
      return;
    }
  }

  if (state.longestRoad === null) {
    const idx = lengths.findIndex((len) => len >= MIN_LONGEST_ROAD);
    if (idx >= 0) state.longestRoad = { player: idx, length: lengths[idx] ?? 0 };
  }
}

/** 重新裁决最大军持有者（就地修改） */
export function recomputeLargestArmy(state: GameState): void {
  const current = state.largestArmy;

  if (current) {
    const ownCount = state.players[current.player]?.playedKnights ?? 0;
    if (ownCount < MIN_ARMY) {
      state.largestArmy = null;
    } else {
      const challenger = state.players.findIndex(
        (p) => p.index !== current.player && p.playedKnights > ownCount,
      );
      if (challenger >= 0) {
        state.largestArmy = { player: challenger, count: state.players[challenger]!.playedKnights };
      } else {
        state.largestArmy = { player: current.player, count: ownCount };
      }
      return;
    }
  }

  if (state.largestArmy === null) {
    let bestIdx = -1;
    let bestCount = 0;
    for (const p of state.players) {
      if (p.playedKnights > bestCount) {
        bestCount = p.playedKnights;
        bestIdx = p.index;
      }
    }
    if (bestCount >= MIN_ARMY) state.largestArmy = { player: bestIdx, count: bestCount };
  }
}

/** 某玩家当前分数 */
export function scoreOf(state: GameState, player: number): number {
  let total = 0;

  for (const b of Object.values(state.buildings)) {
    if (b.owner !== player) continue;
    total += b.city ? 2 : 1;
  }

  if (state.longestRoad?.player === player) total += 2;
  if (state.largestArmy?.player === player) total += 2;

  const p = state.players[player];
  if (p) {
    for (const entry of p.devCards) {
      if (entry.card === 'victory') total += 1;
    }
  }

  return total;
}

export function allScores(state: GameState): number[] {
  return state.players.map((p) => scoreOf(state, p.index));
}

/** 若有人达到 10 分，返回其座位号；否则 null */
export function findWinner(state: GameState): number | null {
  for (const p of state.players) {
    if (scoreOf(state, p.index) >= WIN_SCORE) return p.index;
  }
  return null;
}
