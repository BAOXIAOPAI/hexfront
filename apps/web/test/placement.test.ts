import { describe, expect, it } from 'vitest';
import {
  MAP_4P,
  applyCommand,
  buildBoard,
  createGame,
  viewFor,
  type Board,
  type GameState,
  type PlayerColor,
} from '@hexfront/engine';
import {
  candidateEdges,
  candidateVertices,
  setupInfo,
  setupSeats,
  spotOpen,
} from '../src/placement.js';

const COLORS: PlayerColor[] = ['red', 'blue', 'white', 'orange'];

function newGame(players = 2): { board: Board; state: GameState } {
  const board = buildBoard(MAP_4P);
  const names = ['甲', '乙', '丙', '丁'].slice(0, players);
  return { board, state: createGame(board, names, COLORS.slice(0, players)) };
}

/** 按引擎接受的第一个位置摆一次，用来把局面推进到「摆了几手」 */
function placeOnce(board: Board, state: GameState): GameState {
  const geo = board.geo;
  const seat = state.setup!.seat;
  for (const vk of geo.vertexKeys) {
    const v = geo.vertices[vk]!;
    if (state.buildings[vk] || v.neighbors.some((nb) => state.buildings[nb])) continue;
    for (const ek of v.edges) {
      if (state.roads[ek] !== undefined) continue;
      const r = applyCommand(board, state, { type: 'PLACE_SETTLEMENT', seat, vertex: vk, edge: ek });
      if (r.ok) return r.state;
    }
  }
  throw new Error('没有合法摆位');
}

describe('摆位进度', () => {
  it('刚开局时 0 号位先摆，进度 0/4（两人局）', () => {
    const { board, state } = newGame(2);
    const info = setupInfo(viewFor(board, state, 0));
    expect(info).toEqual({ active: true, seat: 0, step: 0, total: 4, round: 1 });
  });

  it('不是自己摆位的玩家拿到 active=false', () => {
    const { board, state } = newGame(2);
    expect(setupInfo(viewFor(board, state, 1))?.active).toBe(false);
  });

  it('每人第一圈过了就进入第 2 轮', () => {
    const { board } = newGame(2);
    let { state } = newGame(2);
    state = placeOnce(board, state);
    state = placeOnce(board, state);
    expect(state.setup!.step).toBe(2);
    const info = setupInfo(viewFor(board, state, 1))!;
    expect(info.round).toBe(2);
    expect(info.seat).toBe(1);
    expect(info.active).toBe(true);
  });

  it('摆完之后不再有摆位信息', () => {
    const { board } = newGame(2);
    let { state } = newGame(2);
    while (state.phase === 'setup') state = placeOnce(board, state);
    expect(setupInfo(viewFor(board, state, 0))).toBeNull();
  });

  it('进度条的座位顺序与引擎蛇形一致', () => {
    const { board, state } = newGame(2);
    expect(setupSeats(viewFor(board, state, 0))).toEqual([0, 1, 1, 0]);

    const four = newGame(4);
    expect(setupSeats(viewFor(four.board, four.state, 0))).toEqual([0, 1, 2, 3, 3, 2, 1, 0]);
  });
});

describe('候选位置（只是提示，不是裁决）', () => {
  it('空棋盘 54 个路口全都可选', () => {
    const { board, state } = newGame(2);
    const view = viewFor(board, state, 0);
    expect(candidateVertices(view, board.geo)).toHaveLength(54);
  });

  it('落下一村后，本村与三个相邻路口都不再可选', () => {
    const { board } = newGame(2);
    let { state } = newGame(2);
    state = placeOnce(board, state);
    // 换人了，要以「现在该摆的人」的视角看
    const view = viewFor(board, state, state.setup!.seat);

    const built = Object.keys(view.buildings)[0]!;
    const near = [built, ...board.geo.vertices[built]!.neighbors];
    const list = candidateVertices(view, board.geo);

    for (const vk of near) expect(list).not.toContain(vk);
    expect(list).toHaveLength(54 - near.length);
  });

  it('不是我摆位时一个候选都不给', () => {
    const { board, state } = newGame(2);
    const view = viewFor(board, state, 1);
    expect(candidateVertices(view, board.geo)).toEqual([]);
    expect(candidateEdges(view, board.geo, board.geo.vertexKeys[0]!)).toEqual([]);
  });

  it('选好村庄后，候选边是它的邻边且排除已占用的路', () => {
    const { board } = newGame(2);
    let { state } = newGame(2);
    state = placeOnce(board, state);

    const view = viewFor(board, state, 1);
    const vertexKey = candidateVertices(view, board.geo)[0]!;
    const vertex = board.geo.vertices[vertexKey]!;
    const edges = candidateEdges(view, board.geo, vertexKey);

    expect(edges.length).toBeGreaterThan(0);
    for (const ek of edges) {
      expect(vertex.edges).toContain(ek);
      expect(view.roads[ek]).toBeUndefined();
      expect(board.geo.edges[ek]!.a === vertexKey || board.geo.edges[ek]!.b === vertexKey).toBe(true);
    }
    // 已占用的那条路不在候选里
    const used = Object.keys(state.roads);
    for (const ek of used) expect(edges).not.toContain(ek);
  });

  it('未选村庄时不给边', () => {
    const { board, state } = newGame(2);
    const view = viewFor(board, state, 0);
    expect(candidateEdges(view, board.geo, null)).toEqual([]);
  });

  it('spotOpen 认得出被邻居挤压的路口', () => {
    const { board } = newGame(2);
    let { state } = newGame(2);
    state = placeOnce(board, state);
    const view = viewFor(board, state, 0);
    const built = Object.keys(view.buildings)[0]!;
    expect(spotOpen(view, board.geo, built)).toBe(false);
    expect(spotOpen(view, board.geo, board.geo.vertices[built]!.neighbors[0]!)).toBe(false);
  });
});

describe('提示与引擎裁决一致（防止前端骗人）', () => {
  it('提示给出的每个路口 + 首条候选边，引擎都真的接受', () => {
    const { board } = newGame(3);
    let { state } = newGame(3);
    // 推进两轮，让局面上既有自己的村也有别人的村
    state = placeOnce(board, state);
    state = placeOnce(board, state);
    state = placeOnce(board, state);

    const seat = state.setup!.seat;
    const view = viewFor(board, state, seat);
    const vertices = candidateVertices(view, board.geo);
    expect(vertices.length).toBeGreaterThan(0);

    for (const vk of vertices) {
      const edges = candidateEdges(view, board.geo, vk);
      expect(edges.length).toBeGreaterThan(0);
      const r = applyCommand(board, state, {
        type: 'PLACE_SETTLEMENT',
        seat,
        vertex: vk,
        edge: edges[0]!,
      });
      expect(r.ok, `路口 ${vk} 被前端标为可用但引擎拒绝`).toBe(true);
    }
  });
});
