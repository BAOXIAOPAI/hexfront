import { describe, it, expect } from 'vitest';
import {
  buildBoard, createGame, applyCommand, MAP_4P, discardCount, handSize, viewFor,
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

function setAll(state: GameState, res: Partial<ResourceCount>[]): GameState {
  const next = structuredClone(state);
  res.forEach((r, i) => {
    next.players[i]!.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0, ...r };
  });
  return next;
}

describe('弃牌取整规则（V-9）', () => {
  it('7 张以下不弃', () => {
    expect(discardCount(7)).toBe(0);
  });

  it('8 张弃 4 张', () => {
    expect(discardCount(8)).toBe(4);
  });

  it('9 张弃 5 张（向上取整，官方是 4 张）', () => {
    expect(discardCount(9)).toBe(5);
  });

  it('10 张弃 5 张', () => {
    expect(discardCount(10)).toBe(5);
  });

  it('11 张弃 6 张', () => {
    expect(discardCount(11)).toBe(6);
  });

  it('12 张弃 6 张', () => {
    expect(discardCount(12)).toBe(6);
  });
});

describe('掷出 7 的弃牌流程', () => {
  function rollSeven(board: Board, state: GameState): GameState {
    const r = applyCommand(board, state, { type: 'ROLL_DICE', seat: 0, dice: [3, 4] });
    if (!r.ok) throw new Error('掷骰失败');
    return r.state;
  }

  it('只要求手牌 8 张以上的人弃牌', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [
      { wood: 5, brick: 4 },        // 9 张 → 弃 5
      { wood: 3 },                  // 3 张 → 不弃
      { wood: 4, brick: 4 },        // 8 张 → 弃 4
      { wood: 7 },                  // 7 张 → 不弃
    ]);

    const after = rollSeven(board, s);
    expect(after.pendingDiscards[0]).toBe(5);
    expect(after.pendingDiscards[1]).toBeUndefined();
    expect(after.pendingDiscards[2]).toBe(4);
    expect(after.pendingDiscards[3]).toBeUndefined();
  });

  it('数量不对会被拒绝', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [{ wood: 9 }]);
    const after = rollSeven(board, s);

    const r = applyCommand(board, after, {
      type: 'DISCARD', seat: 0, resources: { wood: 3 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('WRONG_DISCARD_COUNT');
  });

  it('可以自选弃哪几种资源', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [{ wood: 4, brick: 3, sheep: 2 }]);  // 9 张 → 弃 5
    const after = rollSeven(board, s);

    // 全弃砖和羊（3+2=5），保住木头
    const r = applyCommand(board, after, {
      type: 'DISCARD', seat: 0, resources: { brick: 3, sheep: 2 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.state.players[0]!.resources.wood).toBe(4);
    expect(r.state.players[0]!.resources.brick).toBe(0);
    expect(r.state.players[0]!.resources.sheep).toBe(0);
    expect(handSize(r.state.players[0]!)).toBe(4);
  });

  it('弃牌期间其他操作会被挡住', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [{ wood: 9 }]);
    const after = rollSeven(board, s);

    const r = applyCommand(board, after, { type: 'END_TURN', seat: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('DISCARD_PENDING');
  });

  it('所有人都弃完后进入「移动强盗」阶段，结束回合仍被锁', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [{ wood: 9 }, { brick: 9 }]);
    let after = rollSeven(board, s);

    expect(Object.keys(after.pendingDiscards)).toHaveLength(2);

    const d0 = applyCommand(board, after, { type: 'DISCARD', seat: 0, resources: { wood: 5 } });
    expect(d0.ok).toBe(true);
    if (!d0.ok) return;
    after = d0.state;
    expect(Object.keys(after.pendingDiscards)).toHaveLength(1);

    const d1 = applyCommand(board, after, { type: 'DISCARD', seat: 1, resources: { brick: 5 } });
    expect(d1.ok).toBe(true);
    if (!d1.ok) return;
    after = d1.state;

    expect(Object.keys(after.pendingDiscards)).toHaveLength(0);
    // R-42：弃牌不是终点，掷骰者还必须挪强盗
    expect(after.pendingRobber).toBe(true);

    const end = applyCommand(board, after, { type: 'END_TURN', seat: 0 });
    expect(end.ok).toBe(false);
    if (!end.ok) expect(end.reason).toBe('ROBBER_PENDING');

    // 挪完强盗才真正解锁
    const tile = board.geo.tileKeys.find((k) => k !== after.robberTile)!;
    const moved = applyCommand(board, after, { type: 'MOVE_ROBBER', seat: 0, tile });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.state.pendingRobber).toBe(false);
    expect(applyCommand(board, moved.state, { type: 'END_TURN', seat: 0 }).ok).toBe(true);
  });

  it('没有该弃牌的人提交弃牌会被拒绝', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [{ wood: 9 }]);
    const after = rollSeven(board, s);

    const r = applyCommand(board, after, {
      type: 'DISCARD', seat: 1, resources: { wood: 1 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOTHING_TO_DISCARD');
  });

  it('弃不起的牌会被拒绝', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [{ wood: 9 }]);
    const after = rollSeven(board, s);

    const r = applyCommand(board, after, {
      type: 'DISCARD', seat: 0, resources: { ore: 5 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INSUFFICIENT_RESOURCES');
  });

  it('没人需要弃牌时跳过弃牌，直接进入移动强盗（R-47）', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [{ wood: 2 }, { wood: 3 }, { wood: 1 }, { wood: 0 }]);
    const after = rollSeven(board, s);

    expect(Object.keys(after.pendingDiscards)).toHaveLength(0);
    expect(after.pendingRobber).toBe(true);

    const r = applyCommand(board, after, { type: 'END_TURN', seat: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ROBBER_PENDING');
  });

  it('弃牌完成后可以移动强盗', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [{ wood: 9 }]);
    let after = rollSeven(board, s);

    // 未弃牌时不能移强盗
    const blocked = applyCommand(board, after, { type: 'MOVE_ROBBER', seat: 0, tile: '0,0' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('DISCARD_PENDING');

    const d = applyCommand(board, after, { type: 'DISCARD', seat: 0, resources: { wood: 5 } });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    after = d.state;

    const target = Object.keys(after.tiles).find((k) => k !== after.robberTile)!;
    const moved = applyCommand(board, after, { type: 'MOVE_ROBBER', seat: 0, tile: target });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.state.robberTile).toBe(target);
  });
});

describe('弃牌状态在视图里的呈现', () => {
  function rollSeven(board: Board, state: GameState): GameState {
    const r = applyCommand(board, state, { type: 'ROLL_DICE', seat: 0, dice: [3, 4] });
    if (!r.ok) throw new Error('掷骰失败');
    return r.state;
  }

  it('平时是空数组', () => {
    const { board, state } = setupGame();
    expect(viewFor(board, state, 0).pendingDiscards).toEqual([]);
  });

  it('掷出 7 后每个视角都能看到「谁还欠几张」', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [{ wood: 5, brick: 4 }, {}, { wood: 4, brick: 4 }, {}]);
    const after = rollSeven(board, s);

    const expected = [{ player: 0, count: 5 }, { player: 2, count: 4 }];
    // 四个人的视角看到的弃牌名单必须完全一致 —— 这是公开信息
    for (const seat of [0, 1, 2, 3]) {
      expect(viewFor(board, after, seat).pendingDiscards).toEqual(expected);
    }
  });

  it('不会带出「弃了哪几种」，只说张数', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [{ wood: 9 }]);
    const view = viewFor(board, rollSeven(board, s), 1);
    const entry = view.pendingDiscards[0]!;
    expect(entry.count).toBe(5);
    expect((entry as unknown as Record<string, unknown>).resources).toBeUndefined();
    expect(Object.keys(entry).sort()).toEqual(['count', 'player']);
  });

  it('有人弃完后名单变短，全弃完变空', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [{ wood: 9 }, { brick: 9 }]);
    let after = rollSeven(board, s);
    expect(viewFor(board, after, 0).pendingDiscards).toHaveLength(2);

    const d0 = applyCommand(board, after, { type: 'DISCARD', seat: 0, resources: { wood: 5 } });
    expect(d0.ok).toBe(true);
    if (!d0.ok) return;
    after = d0.state;

    expect(viewFor(board, after, 0).pendingDiscards).toEqual([{ player: 1, count: 5 }]);

    const d1 = applyCommand(board, after, { type: 'DISCARD', seat: 1, resources: { brick: 5 } });
    expect(d1.ok).toBe(true);
    if (!d1.ok) return;
    expect(viewFor(board, d1.state, 0).pendingDiscards).toEqual([]);
  });

  it('掷出非 7 时不会产生弃牌锁', () => {
    const { board, state } = setupGame();
    const s = setAll(state, [{ wood: 9 }, { brick: 9 }]);
    const r = applyCommand(board, s, { type: 'ROLL_DICE', seat: 0, dice: [6, 5] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(viewFor(board, r.state, 0).pendingDiscards).toEqual([]);
  });
});
