/**
 * 文档 23 L-4：开局排序（actionOrder）与身份隔离。
 * 重点：排序只改「行动次序」，不改玩家身份、私有视图、昵称、颜色与重连座位。
 */

import { describe, it, expect } from 'vitest';
import {
  buildBoard,
  createGame,
  applyCommand,
  MAP_4P,
  PLAYER_COLORS,
  setupSeatOrder,
  setupSequence,
  viewFor,
  allViews,
  type Board,
  type GameState,
} from '../src/index.js';

const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
const COLORS = PLAYER_COLORS.slice(0, 8);

function newGame(order?: number[], n = 4): { board: Board; state: GameState } {
  const board = buildBoard(MAP_4P);
  const state = createGame(board, NAMES.slice(0, n), [...COLORS.slice(0, n)], { actionOrder: order });
  return { board, state };
}

function autoPlace(board: Board, state: GameState): GameState {
  const seat = state.setup!.seat;
  for (const vk of board.geo.vertexKeys) {
    if (state.buildings[vk]) continue;
    const v = board.geo.vertices[vk]!;
    if (v.neighbors.some((nb) => state.buildings[nb])) continue;
    for (const ek of v.edges) {
      if (state.roads[ek] !== undefined) continue;
      const r = applyCommand(board, state, { type: 'PLACE_SETTLEMENT', seat, vertex: vk, edge: ek });
      if (r.ok) return r.state;
    }
  }
  throw new Error('没有合法摆位');
}

describe('颜色扩展到 8 种', () => {
  it('PLAYER_COLORS 有 8 个且互不重复', () => {
    expect(PLAYER_COLORS).toHaveLength(8);
    expect(new Set(PLAYER_COLORS).size).toBe(8);
  });
});

describe('蛇形顺序支持任意人数与自定义顺序', () => {
  it('4/5/6/8 人默认蛇形', () => {
    expect(setupSeatOrder(4)).toEqual([0, 1, 2, 3, 3, 2, 1, 0]);
    expect(setupSeatOrder(5)).toEqual([0, 1, 2, 3, 4, 4, 3, 2, 1, 0]);
    expect(setupSeatOrder(6)).toEqual([0, 1, 2, 3, 4, 5, 5, 4, 3, 2, 1, 0]);
    expect(setupSeatOrder(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('自定义 actionOrder 生成对应正序+逆序', () => {
    const order = [2, 0, 3, 1];
    expect(setupSeatOrder(4, order)).toEqual([2, 0, 3, 1, 1, 3, 0, 2]);
    expect(setupSequence(4, order)).toEqual([2, 0, 3, 1, 1, 3, 0, 2]);
  });

  it('末位连续两次放置仍是两个独立步骤', () => {
    const order = [2, 0, 3, 1];
    const seq = setupSeatOrder(4, order);
    expect(seq[3]).toBe(1);
    expect(seq[4]).toBe(1);
    expect(seq).toHaveLength(8);
  });
});

describe('createGame 的 actionOrder', () => {
  it('不传时退化为座位自然顺序，老行为不变', () => {
    const { state } = newGame();
    expect(state.actionOrder).toEqual([0, 1, 2, 3]);
    expect(state.setup!.seat).toBe(0);
    expect(state.current).toBe(0);
  });

  it('传入自定义顺序时，选地第一步与正常首回合都从第一人开始', () => {
    const order = [2, 0, 3, 1];
    const { state } = newGame(order);
    expect(state.actionOrder).toEqual(order);
    expect(state.setup!.seat).toBe(2);
    expect(state.current).toBe(2);
  });

  it('非法排列直接抛错，不静默降级', () => {
    const board = buildBoard(MAP_4P);
    expect(() => createGame(board, NAMES.slice(0, 4), [...COLORS.slice(0, 4)], { actionOrder: [0, 1, 1, 3] }))
      .toThrow();
    expect(() => createGame(board, NAMES.slice(0, 4), [...COLORS.slice(0, 4)], { actionOrder: [0, 1, 2] }))
      .toThrow();
    expect(() => createGame(board, NAMES.slice(0, 4), [...COLORS.slice(0, 4)], { actionOrder: [0, 1, 2, 9] }))
      .toThrow();
  });

  it('第 4 参数仍可为 boolean（老调用方零改动）', () => {
    const board = buildBoard(MAP_4P);
    const s = createGame(board, NAMES.slice(0, 4), [...COLORS.slice(0, 4)], false);
    expect(s.setupGrant).toBe(false);
    expect(s.actionOrder).toEqual([0, 1, 2, 3]);
  });
});

describe('排序不改身份 / 私有视图', () => {
  it('自定义顺序下，玩家数组、昵称、颜色仍按 seat 对齐', () => {
    const order = [3, 1, 0, 2];
    const { state } = newGame(order);
    expect(state.players.map((p) => p.index)).toEqual([0, 1, 2, 3]);
    expect(state.players.map((p) => p.name)).toEqual(['甲', '乙', '丙', '丁']);
    expect(state.players.map((p) => p.color)).toEqual(COLORS.slice(0, 4));
  });

  it('自定义顺序下，每个 seat 的私有视图仍只含自己的手牌', () => {
    const order = [3, 1, 0, 2];
    const { board, state } = newGame(order);
    state.players[0]!.resources.wood = 3;
    state.players[2]!.resources.ore = 2;
    for (const view of allViews(board, state)) {
      expect(view.viewer).toBe(view.me.index);
      expect(view.me.name).toBe(state.players[view.viewer]!.name);
      const others = view.players.filter((p) => p.index !== view.viewer);
      for (const p of others) {
        expect(Object.prototype.hasOwnProperty.call(p, 'resources')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(p, 'devCards')).toBe(false);
      }
    }
    expect(viewFor(board, state, 0).me.resources.wood).toBe(3);
    expect(viewFor(board, state, 2).me.resources.ore).toBe(2);
  });
});

describe('完整摆位与回合循环沿 actionOrder', () => {
  it('自定义顺序走完 8 次摆位，首回合是 actionOrder[0]', () => {
    const order = [2, 0, 3, 1];
    const { board, state } = newGame(order);
    const seq = setupSeatOrder(4, order);
    let s = state;
    for (let i = 0; i < seq.length; i++) {
      expect(s.setup!.seat).toBe(seq[i]);
      s = autoPlace(board, s);
    }
    expect(s.phase).toBe('play');
    expect(s.current).toBe(2);
    expect(s.setup).toBeNull();
    expect(Object.keys(s.buildings)).toHaveLength(8);
    for (let p = 0; p < 4; p++) {
      expect(Object.values(s.buildings).filter((b) => b.owner === p)).toHaveLength(2);
    }
  });

  it('结束回合沿 actionOrder 循环，而非 current+1 取模', () => {
    const order = [2, 0, 3, 1];
    const { board, state } = newGame(order);
    let s = state;
    while (s.phase === 'setup') s = autoPlace(board, s);
    expect(s.current).toBe(2);

    const roll = applyCommand(board, s, { type: 'ROLL_DICE', seat: 2, dice: [2, 3] });
    expect(roll.ok).toBe(true);
    if (!roll.ok) return;
    const end = applyCommand(board, roll.state, { type: 'END_TURN', seat: 2 });
    expect(end.ok).toBe(true);
    if (!end.ok) return;
    expect(end.state.current).toBe(0);

    const roll2 = applyCommand(board, end.state, { type: 'ROLL_DICE', seat: 0, dice: [2, 3] });
    const end2 = applyCommand(board, roll2.ok ? roll2.state : end.state, { type: 'END_TURN', seat: 0 });
    expect(end2.ok).toBe(true);
    if (end2.ok) expect(end2.state.current).toBe(3);
  });

  it('8 人局也能完整摆位 16 次且首回合正确', () => {
    const order = [7, 3, 0, 5, 1, 6, 2, 4];
    const { board, state } = newGame(order, 8);
    let s = state;
    const seq = setupSeatOrder(8, order);
    for (let i = 0; i < seq.length; i++) {
      expect(s.setup!.seat).toBe(seq[i]);
      s = autoPlace(board, s);
    }
    expect(s.phase).toBe('play');
    expect(s.current).toBe(7);
    expect(Object.keys(s.buildings)).toHaveLength(16);
  });
});
