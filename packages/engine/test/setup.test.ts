import { describe, it, expect } from 'vitest';
import {
  buildBoard,
  createGame,
  applyCommand,
  MAP_4P,
  setupSeatOrder,
  type Board,
  type GameState,
} from '../src/index.js';

const NAMES = ['你', '阿岚', '小满', '老周'];
const COLORS = ['red', 'blue', 'white', 'orange'] as const;

function newGame(): { board: Board; state: GameState } {
  const board = buildBoard(MAP_4P);
  const state = createGame(board, NAMES, [...COLORS]);
  return { board, state };
}

/** 自动找一个合法顶点放下，返回新状态 */
function autoPlace(board: Board, state: GameState): GameState {
  const geo = board.geo;
  const seat = state.setup!.seat;
  for (const vk of geo.vertexKeys) {
    if (state.buildings[vk]) continue;
    const v = geo.vertices[vk]!;
    if (v.neighbors.some((nb) => state.buildings[nb])) continue;
    for (const ek of v.edges) {
      if (state.roads[ek] !== undefined) continue;
      const r = applyCommand(board, state, { type: 'PLACE_SETTLEMENT', seat, vertex: vk, edge: ek });
      if (r.ok) return r.state;
    }
  }
  throw new Error('没有合法摆位可用');
}

function completeSetup(board: Board, state: GameState): GameState {
  let s = state;
  while (s.phase === 'setup') s = autoPlace(board, s);
  return s;
}

describe('开局摆位', () => {
  it('蛇形顺序为 0,1,2,3,3,2,1,0', () => {
    expect(setupSeatOrder(4)).toEqual([0, 1, 2, 3, 3, 2, 1, 0]);
  });

  it('初始由 0 号位先放', () => {
    const { state } = newGame();
    expect(state.phase).toBe('setup');
    expect(state.setup!.seat).toBe(0);
  });

  it('不是自己的回合会被拒绝', () => {
    const { board, state } = newGame();
    const vk = board.geo.vertexKeys[0]!;
    const ek = board.geo.vertices[vk]!.edges[0]!;
    const r = applyCommand(board, state, { type: 'PLACE_SETTLEMENT', seat: 1, vertex: vk, edge: ek });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_YOUR_TURN');
  });

  it('完整摆完 8 次后进入 play 阶段，每人 2 村 2 路', () => {
    const { board, state } = newGame();
    const s = completeSetup(board, state);

    expect(s.phase).toBe('play');
    expect(s.setup).toBeNull();
    expect(Object.keys(s.buildings)).toHaveLength(8);
    expect(Object.keys(s.roads)).toHaveLength(8);

    for (let p = 0; p < 4; p++) {
      const owned = Object.values(s.buildings).filter((b) => b.owner === p);
      expect(owned).toHaveLength(2);
      const roads = Object.values(s.roads).filter((o) => o === p);
      expect(roads).toHaveLength(2);
    }
  });

  it('第二轮放置立即获得相邻地块资源', () => {
    const { board, state } = newGame();
    let s = state;

    // 前四次为第一轮，不产资源
    for (let i = 0; i < 4; i++) {
      const before = JSON.stringify(s.players.map((p) => p.resources));
      s = autoPlace(board, s);
      expect(JSON.stringify(s.players.map((p) => p.resources))).toBe(before);
    }

    // 进入第二轮，每次放置应产生资源
    const before2 = s.players.map((p) => ({ ...p.resources }));
    s = autoPlace(board, s);
    const gained = s.players.some((p, i) => {
      const b = before2[i]!;
      return (['wood', 'brick', 'sheep', 'wheat', 'ore'] as const).some((r) => p.resources[r] > b[r]);
    });
    expect(gained).toBe(true);
  });

  it('距离规则：不能与已有建筑相邻', () => {
    const { board, state } = newGame();
    const geo = board.geo;

    const first = geo.tiles['0,2']!; // 沙漠，中心位置
    const vk = Object.keys(geo.vertices).find((k) => {
      const v = geo.vertices[k]!;
      return Math.hypot(v.x - first.x, v.y - first.y) < 60;
    })!;
    const ek = geo.vertices[vk]!.edges[0]!;

    const r1 = applyCommand(board, state, { type: 'PLACE_SETTLEMENT', seat: 0, vertex: vk, edge: ek });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // 0 号位已经放了，现在轮到 1 号位
    const neighbor = geo.vertices[vk]!.neighbors[0]!;
    const nek = geo.vertices[neighbor]!.edges.find((e) => e !== ek)!;
    const r2 = applyCommand(board, r1.state, { type: 'PLACE_SETTLEMENT', seat: 1, vertex: neighbor, edge: nek });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('TOO_CLOSE');
  });

  it('同一个顶点不能放两次', () => {
    const { board, state } = newGame();
    const vk = board.geo.vertexKeys[0]!;
    const ek = board.geo.vertices[vk]!.edges[0]!;

    const r1 = applyCommand(board, state, { type: 'PLACE_SETTLEMENT', seat: 0, vertex: vk, edge: ek });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // 走完 0~3 号位后回到 3 号位（第二轮），尝试复用同一顶点
    let s = r1.state;
    s = autoPlace(board, s); // seat 1
    s = autoPlace(board, s); // seat 2
    s = autoPlace(board, s); // seat 3

    const r2 = applyCommand(board, s, { type: 'PLACE_SETTLEMENT', seat: 3, vertex: vk, edge: ek });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('OCCUPIED');
  });

  it('道路必须与新建村庄相邻', () => {
    const { board, state } = newGame();
    const geo = board.geo;
    const vk = geo.vertexKeys[0]!;
    const farEdge = geo.edgeKeys.find((ek) => {
      const e = geo.edges[ek]!;
      return e.a !== vk && e.b !== vk;
    })!;

    const r = applyCommand(board, state, { type: 'PLACE_SETTLEMENT', seat: 0, vertex: vk, edge: farEdge });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('EDGE_NOT_ADJACENT');
  });
});

// ---------------------------------------------------------------------------
// 房间设置：开局自动发牌开关（默认开启，关闭后空手开局）
// ---------------------------------------------------------------------------

function handOf(state: GameState, seat: number): number {
  return Object.values(state.players[seat]!.resources).reduce((a, b) => a + b, 0);
}

describe('开局发牌开关', () => {
  it('不传参数时默认开启，摆完第二轮能拿到起始资源', () => {
    const { board, state } = newGame();
    expect(state.setupGrant).toBe(true);
    const done = completeSetup(board, state);
    expect(done.phase).toBe('play');
    expect(done.players.reduce((n, _p, i) => n + handOf(done, i), 0)).toBeGreaterThan(0);
  });

  it('关闭后完整摆位结束仍是空手，且 phase 正常推进', () => {
    const board = buildBoard(MAP_4P);
    const state = createGame(board, NAMES, [...COLORS], false);
    expect(state.setupGrant).toBe(false);
    const done = completeSetup(board, state);
    expect(done.phase).toBe('play');
    expect(Object.keys(done.buildings)).toHaveLength(8);
    expect(Object.keys(done.roads)).toHaveLength(8);
    for (let i = 0; i < NAMES.length; i++) expect(handOf(done, i)).toBe(0);
  });
});
