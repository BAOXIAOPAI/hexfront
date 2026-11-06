import { describe, it, expect } from 'vitest';
import {
  buildBoard, createGame, applyCommand, MAP_4P, viewFor, allViews,
  type Board, type GameState, type ResourceCount,
} from '../src/index.js';

const NAMES = ['你', '阿岚', '小满', '老周'];
const COLORS = ['red', 'blue', 'white', 'orange'] as const;

function setupGame(): { board: Board; state: GameState } {
  const board = buildBoard(MAP_4P);
  let state = createGame(board, NAMES, [...COLORS]);
  const geo = board.geo;

  while (state.phase === 'setup') {
    const seat = state.setup!.seat;
    let placed = false;
    for (const vk of geo.vertexKeys) {
      if (state.buildings[vk]) continue;
      const v = geo.vertices[vk]!;
      if (v.neighbors.some((nb) => state.buildings[nb])) continue;
      for (const ek of v.edges) {
        if (state.roads[ek] !== undefined) continue;
        const r = applyCommand(board, state, { type: 'PLACE_SETTLEMENT', seat, vertex: vk, edge: ek });
        if (r.ok) { state = r.state; placed = true; break; }
      }
      if (placed) break;
    }
    if (!placed) throw new Error('开局失败');
  }
  return { board, state };
}

function setOwn(state: GameState, seat: number, res: Partial<ResourceCount>): GameState {
  const next = structuredClone(state);
  next.players[seat]!.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0, ...res };
  return next;
}

describe('视角隔离', () => {
  it('能看到自己的资源明细', () => {
    const { board, state } = setupGame();
    const s = setOwn(state, 0, { wood: 3, ore: 1 });
    const view = viewFor(board, s, 0);
    expect(view.me.resources).toEqual({ wood: 3, brick: 0, sheep: 0, wheat: 0, ore: 1, });
  });

  it('看不到别人的资源明细，只能看到总数', () => {
    const { board, state } = setupGame();
    const s = setOwn(state, 1, { wood: 4, wheat: 2 });
    const view = viewFor(board, s, 0);

    const other = view.players[1]!;
    expect(other.handSize).toBe(6);
    // 视图里根本没有 resources 字段
    expect((other as unknown as Record<string, unknown>).resources).toBeUndefined();
  });

  it('看不到别人的发展卡内容', () => {
    const { board, state } = setupGame();
    const s = structuredClone(state);
    s.players[1]!.devCards.push({ card: 'monopoly', playable: true });
    s.players[1]!.devCards.push({ card: 'victory', playable: true });

    const view = viewFor(board, s, 0);
    expect(view.players[1]!.devCardCount).toBe(2);
    expect((view.players[1] as unknown as Record<string, unknown>).devCards).toBeUndefined();

    // 自己视角可以看到自己的卡
    const mine = viewFor(board, s, 1);
    expect(mine.me.devCards).toHaveLength(2);
    expect(mine.me.devCards[0]!.card).toBe('monopoly');
  });

  it('手牌数量是公开信息', () => {
    const { board, state } = setupGame();
    const s = setOwn(state, 2, { wood: 2, brick: 3, sheep: 1 });
    const view = viewFor(board, s, 0);
    expect(view.players[2]!.handSize).toBe(6);
  });

  it('分数对所有人可见', () => {
    const { board, state } = setupGame();
    const view = viewFor(board, state, 0);
    expect(view.scores).toHaveLength(4);
    expect(view.players.every((p) => typeof p.score === 'number')).toBe(true);
  });

  it('棋盘与建筑是公开的', () => {
    const { board, state } = setupGame();
    const view = viewFor(board, state, 0);
    expect(view.tiles).toHaveLength(19);
    expect(view.ports).toHaveLength(9);
    expect(Object.keys(view.buildings)).toHaveLength(8);
    expect(Object.keys(view.roads)).toHaveLength(8);
  });

  it('发展的牌堆剩余数量公开，但内容不公开', () => {
    const { board, state } = setupGame();
    const view = viewFor(board, state, 0);
    expect(view.devDeckCount).toBe(25);
    expect((view as unknown as Record<string, unknown>).devDeck).toBeUndefined();
  });

  it('每个玩家拿到的视角互不相同', () => {
    const { board, state } = setupGame();
    let s = setOwn(state, 0, { wood: 5 });
    s = setOwn(s, 1, { ore: 2 });
    s = setOwn(s, 2, {});
    const views = allViews(board, s);

    expect(views[0]!.me.resources.wood).toBe(5);
    expect(views[1]!.me.resources.ore).toBe(2);
    expect(views[2]!.me.resources).toEqual({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
  });

  it('视图是快照，修改它不影响真实状态', () => {
    const { board, state } = setupGame();
    const view = viewFor(board, state, 0);
    view.me.resources.wood = 999;
    expect(state.players[0]!.resources.wood).not.toBe(999);
  });
});
