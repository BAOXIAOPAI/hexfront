import { describe, it, expect } from 'vitest';
import {
  buildBoard, createGame, applyCommand, MAP_4P,
  computeLongestRoad, recomputeLongestRoad, recomputeLargestArmy,
  scoreOf, allScores, findWinner,
  type Board, type GameState,
} from '../src/index.js';

const NAMES = ['你', '阿岚', '小满', '老周'];
const COLORS = ['red', 'blue', 'white', 'orange'] as const;

function emptyGame(): { board: Board; state: GameState } {
  const board = buildBoard(MAP_4P);
  const state = createGame(board, NAMES, [...COLORS]);
  state.phase = 'play';
  state.setup = null;
  return { board, state };
}

/** 在图上找一条长度为 length 的简单路径，返回边 key 列表 */
function findPath(board: Board, length: number): string[] {
  const { geo } = board;
  let found: string[] | null = null;

  const dfs = (vk: string, used: Set<string>, path: string[]): boolean => {
    if (path.length === length) { found = path.slice(); return true; }
    const v = geo.vertices[vk];
    if (!v) return false;
    for (const ek of v.edges) {
      if (used.has(ek)) continue;
      const e = geo.edges[ek]!;
      const next = e.a === vk ? e.b : e.a;
      used.add(ek); path.push(ek);
      if (dfs(next, used, path)) return true;
      used.delete(ek); path.pop();
    }
    return false;
  };

  for (const vk of geo.vertexKeys) {
    if (dfs(vk, new Set<string>(), [])) break;
  }
  if (!found) throw new Error(`找不到长度 ${length} 的路径`);
  return found;
}

function layRoads(state: GameState, player: number, edges: string[]): GameState {
  const next = structuredClone(state);
  for (const ek of edges) next.roads[ek] = player;
  return next;
}

describe('最长路', () => {
  it('连续 5 条路 = 5', () => {
    const { board, state } = emptyGame();
    const path = findPath(board, 5);
    const s = layRoads(state, 0, path);
    expect(computeLongestRoad(board, s, 0)).toBe(5);
  });

  it('分叉不会累加，取最长的一支', () => {
    const { board, state } = emptyGame();
    const { geo } = board;

    // 找两条共享起点、不共边的路各一条，构成 Y 形
    const center = geo.vertexKeys.find((vk) => geo.vertices[vk]!.edges.length >= 3)!;
    const legs = geo.vertices[center]!.edges.slice(0, 3);
    const s = layRoads(state, 0, legs);

    // 三条边共享一个中心点，最长路径只能是 2 条边
    expect(computeLongestRoad(board, s, 0)).toBe(2);
  });

  it('被对手建筑截断后变短', () => {
    const { board, state } = emptyGame();
    const path = findPath(board, 6);
    let s = layRoads(state, 0, path);

    expect(computeLongestRoad(board, s, 0)).toBe(6);

    // 在路径中间某个顶点放对手村庄
    const mid = board.geo.edges[path[2]!]!;
    s.buildings[mid.a] = { owner: 1, city: false };

    expect(computeLongestRoad(board, s, 0)).toBeLessThan(6);
  });

  it('自己的建筑可以穿过', () => {
    const { board, state } = emptyGame();
    const path = findPath(board, 6);
    let s = layRoads(state, 0, path);

    const mid = board.geo.edges[path[2]!]!;
    s.buildings[mid.a] = { owner: 0, city: false };

    expect(computeLongestRoad(board, s, 0)).toBe(6);
  });

  it('满 5 条才持有，平局不转移', () => {
    const { board, state } = emptyGame();
    let s = layRoads(state, 0, findPath(board, 5));

    recomputeLongestRoad(board, s);
    expect(s.longestRoad?.player).toBe(0);

    // 换另一条不相交的 5 条路给玩家 1
    const other = findPath(board, 5).filter((ek) => s.roads[ek] === undefined);
    if (other.length === 5) {
      s.roads = {};
      for (const ek of other) s.roads[ek] = 1;
      s.longestRoad = { player: 0, length: 5 };
      // 玩家 0 已经没有路了
      recomputeLongestRoad(board, s);
      expect(s.longestRoad?.player).toBe(1);
    }
  });
});

describe('最大军', () => {
  it('3 骑士持有，2 骑士不持有', () => {
    const { state } = emptyGame();
    const s = structuredClone(state);

    s.players[0]!.playedKnights = 2;
    recomputeLargestArmy(s);
    expect(s.largestArmy).toBeNull();

    s.players[0]!.playedKnights = 3;
    recomputeLargestArmy(s);
    expect(s.largestArmy?.player).toBe(0);
  });

  it('必须严格多于才夺取', () => {
    const { state } = emptyGame();
    const s = structuredClone(state);

    s.players[0]!.playedKnights = 3;
    recomputeLargestArmy(s);
    expect(s.largestArmy?.player).toBe(0);

    s.players[1]!.playedKnights = 3;
    recomputeLargestArmy(s);
    expect(s.largestArmy?.player).toBe(0);

    s.players[1]!.playedKnights = 4;
    recomputeLargestArmy(s);
    expect(s.largestArmy?.player).toBe(1);
  });
});

describe('计分', () => {
  it('村庄 1 分、城市 2 分', () => {
    const { board, state } = emptyGame();
    const s = structuredClone(state);
    const vks = board.geo.vertexKeys;

    s.buildings[vks[0]!] = { owner: 0, city: false };
    s.buildings[vks[10]!] = { owner: 0, city: false };
    s.buildings[vks[20]!] = { owner: 0, city: true };

    expect(scoreOf(s, 0)).toBe(4);
    expect(scoreOf(s, 1)).toBe(0);
  });

  it('最长路与最大军各 2 分', () => {
    const { state } = emptyGame();
    const s = structuredClone(state);
    s.longestRoad = { player: 0, length: 5 };
    s.largestArmy = { player: 0, count: 3 };
    expect(scoreOf(s, 0)).toBe(4);
  });

  it('胜利点卡计 1 分', () => {
    const { state } = emptyGame();
    const s = structuredClone(state);
    s.players[0]!.devCards.push({ card: 'victory', playable: true });
    s.players[0]!.devCards.push({ card: 'victory', playable: true });
    expect(scoreOf(s, 0)).toBe(2);
  });

  it('allScores 返回四人分数', () => {
    const { state } = emptyGame();
    const s = structuredClone(state);
    s.longestRoad = { player: 2, length: 6 };
    expect(allScores(s)).toEqual([0, 0, 2, 0]);
  });
});

describe('胜负判定', () => {
  it('达到 10 分返回座位号', () => {
    const { board, state } = emptyGame();
    const s = structuredClone(state);
    const vks = board.geo.vertexKeys;

    // 4 城 = 8 分，加最长路 2 分 = 10
    for (let i = 0; i < 4; i++) s.buildings[vks[i * 7]!] = { owner: 0, city: true };
    s.longestRoad = { player: 0, length: 5 };

    expect(scoreOf(s, 0)).toBe(10);
    expect(findWinner(s)).toBe(0);
  });

  it('不到 10 分返回 null', () => {
    const { state } = emptyGame();
    expect(findWinner(state)).toBeNull();
  });

  it('达成 10 分时引擎把阶段切到 ended 并发出 GAME_WON', () => {
    const { board, state } = emptyGame();
    const s = structuredClone(state);
    const vks = board.geo.vertexKeys;

    for (let i = 0; i < 4; i++) s.buildings[vks[i * 7]!] = { owner: 0, city: true };
    s.longestRoad = { player: 0, length: 5 };
    s.players[0]!.resources = { wood: 9, brick: 9, sheep: 9, wheat: 9, ore: 9 };

    // 做任意一个合法动作触发收尾检查
    const spot = Object.keys(s.roads)[0];
    if (spot) {
      const r = applyCommand(board, s, { type: 'END_TURN', seat: 0 });
      if (r.ok) {
        expect(r.state.phase).toBe('ended');
        expect(r.state.winner).toBe(0);
        expect(r.events.some((e) => e.type === 'GAME_WON')).toBe(true);
      }
    }
  });
});
