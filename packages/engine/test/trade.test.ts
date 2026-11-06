import { describe, it, expect } from 'vitest';
import {
  buildBoard, createGame, applyCommand, MAP_4P,
  portRatioFor, bestPortRatios,
  type Board, type GameState, type Resource, type ResourceCount,
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

function setRes(state: GameState, seat: number, res: Partial<ResourceCount>): GameState {
  const next = structuredClone(state);
  next.players[seat]!.resources = {
    wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0, ...res,
  };
  return next;
}

/** 清空某玩家的所有建筑 —— 开局摆位可能恰好占住港口端点，测试需要干净起点 */
function clearOf(state: GameState, player: number): GameState {
  const next = structuredClone(state);
  for (const vk of Object.keys(next.buildings)) {
    if (next.buildings[vk]!.owner === player) delete next.buildings[vk];
  }
  return next;
}

/** 把某玩家的建筑放到指定类型港口的端点上 */
function withPort(board: Board, state: GameState, player: number, want: 'generic' | Resource): GameState {
  const next = structuredClone(state);
  const slot = next.ports.find((s) =>
    want === 'generic'
      ? s.port.kind === 'generic'
      : s.port.kind === 'specific' && s.port.resource === want,
  );
  if (!slot) throw new Error('找不到该港口');

  const edge = board.geo.edges[slot.edge]!;
  delete next.buildings[edge.a];
  delete next.buildings[edge.b];
  next.buildings[edge.a] = { owner: player, city: false };
  return next;
}

describe('玩家间交易', () => {
  it('双向转移资源', () => {
    const { board, state } = setupGame();
    let s = setRes(state, 0, { wood: 2 });
    s = setRes(s, 1, { wheat: 3 });

    const r = applyCommand(board, s, {
      type: 'TRADE_PLAYER', seat: 0, withPlayer: 1,
      give: { wood: 2 }, get: { wheat: 3 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.state.players[0]!.resources.wood).toBe(0);
    expect(r.state.players[0]!.resources.wheat).toBe(3);
    expect(r.state.players[1]!.resources.wheat).toBe(0);
    expect(r.state.players[1]!.resources.wood).toBe(2);
    expect(r.events.some((e) => e.type === 'TRADE_COMPLETED')).toBe(true);
  });

  it('允许零对价：存牌场景', () => {
    const { board, state } = setupGame();
    const s = setRes(state, 0, { wood: 5 });
    const beforeB = s.players[1]!.resources.wood;

    // 当前玩家 0 把 5 张木白给玩家 1
    const r = applyCommand(board, s, {
      type: 'TRADE_PLAYER', seat: 0, withPlayer: 1,
      give: { wood: 5 }, get: {},
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.state.players[0]!.resources.wood).toBe(0);
    expect(r.state.players[1]!.resources.wood).toBe(beforeB + 5);
  });

  it('允许以少换多', () => {
    const { board, state } = setupGame();
    let s = setRes(state, 0, { ore: 1 });
    s = setRes(s, 1, { wood: 3 });

    const r = applyCommand(board, s, {
      type: 'TRADE_PLAYER', seat: 0, withPlayer: 1,
      give: { ore: 1 }, get: { wood: 3 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[0]!.resources.wood).toBe(3);
  });

  it('非当前玩家之间不能直接交易', () => {
    const { board, state } = setupGame();
    let s = setRes(state, 1, { wood: 2 });
    s = setRes(s, 2, { wheat: 2 });

    // 当前玩家是 0，1 和 2 之间交易应被拒绝
    const r = applyCommand(board, s, {
      type: 'TRADE_PLAYER', seat: 1, withPlayer: 2,
      give: { wood: 2 }, get: { wheat: 2 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_INVOLVED');
  });

  it('非当前玩家可以主动与当前玩家交易', () => {
    const { board, state } = setupGame();
    let s = setRes(state, 1, { wood: 2 });
    s = setRes(s, 0, { wheat: 1 });

    const r = applyCommand(board, s, {
      type: 'TRADE_PLAYER', seat: 1, withPlayer: 0,
      give: { wood: 2 }, get: { wheat: 1 },
    });
    expect(r.ok).toBe(true);
  });

  it('资源不足被拒绝', () => {
    const { board, state } = setupGame();
    let s = setRes(state, 0, { wood: 1 });
    s = setRes(s, 1, { wheat: 5 });

    const r = applyCommand(board, s, {
      type: 'TRADE_PLAYER', seat: 0, withPlayer: 1,
      give: { wood: 3 }, get: { wheat: 1 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INSUFFICIENT_RESOURCES');
  });

  it('不能与自己交易', () => {
    const { board, state } = setupGame();
    const r = applyCommand(board, state, {
      type: 'TRADE_PLAYER', seat: 0, withPlayer: 0,
      give: { wood: 1 }, get: { wheat: 1 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SAME_TARGET');
  });

  it('空交易被拒绝', () => {
    const { board, state } = setupGame();
    const r = applyCommand(board, state, {
      type: 'TRADE_PLAYER', seat: 0, withPlayer: 1,
      give: {}, get: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('EMPTY_TRADE');
  });
});

describe('银行与港口兑换', () => {
  it('无港口时 4:1', () => {
    const { board, state } = setupGame();
    const s = setRes(clearOf(state, 0), 0, { wood: 4 });

    expect(portRatioFor(board, s, 0, 'wood')).toBe(4);

    const r = applyCommand(board, s, { type: 'TRADE_BANK', seat: 0, give: 'wood', get: 'ore' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.state.players[0]!.resources.wood).toBe(0);
    expect(r.state.players[0]!.resources.ore).toBe(1);
  });

  it('拥有通用港时 3:1', () => {
    const { board, state } = setupGame();
    const s = withPort(board, setRes(clearOf(state, 0), 0, { wood: 3 }), 0, 'generic');

    expect(portRatioFor(board, s, 0, 'wood')).toBe(3);

    const r = applyCommand(board, s, { type: 'TRADE_BANK', seat: 0, give: 'wood', get: 'ore' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[0]!.resources.wood).toBe(0);
  });

  it('拥有对应专用港时 2:1，且只对该资源生效', () => {
    const { board, state } = setupGame();
    const s = withPort(board, setRes(clearOf(state, 0), 0, { wood: 2, brick: 4 }), 0, 'wood');

    expect(portRatioFor(board, s, 0, 'wood')).toBe(2);
    expect(portRatioFor(board, s, 0, 'brick')).toBe(4);

    const r = applyCommand(board, s, { type: 'TRADE_BANK', seat: 0, give: 'wood', get: 'ore' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[0]!.resources.wood).toBe(0);
  });

  it('资源不足时拒绝', () => {
    const { board, state } = setupGame();
    const s = setRes(clearOf(state, 0), 0, { wood: 3 });

    const r = applyCommand(board, s, { type: 'TRADE_BANK', seat: 0, give: 'wood', get: 'ore' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INSUFFICIENT_RESOURCES');
  });

  it('非当前玩家不能做银行交易', () => {
    const { board, state } = setupGame();
    const s = setRes(state, 1, { wood: 4 });

    const r = applyCommand(board, s, { type: 'TRADE_BANK', seat: 1, give: 'wood', get: 'ore' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_YOUR_TURN');
  });

  it('bestPortRatios 返回五种资源各自的比例', () => {
    const { board, state } = setupGame();
    const s = withPort(board, setRes(state, 0, {}), 0, 'generic');
    const ratios = bestPortRatios(board, s, 0);
    expect(ratios.wood).toBe(3);
    expect(ratios.ore).toBe(3);
  });
});

describe('借港代换（V-4）', () => {
  it('当前玩家替他人用港口兑换，资源从借用者进出', () => {
    const { board, state } = setupGame();
    let s = withPort(board, setRes(state, 0, {}), 0, 'sheep');
    s = setRes(s, 1, { sheep: 3 });

    const r = applyCommand(board, s, {
      type: 'PORT_TRANSFER', seat: 0, beneficiary: 1, give: 'sheep', get: 'ore',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.state.players[1]!.resources.sheep).toBe(1);
    expect(r.state.players[1]!.resources.ore).toBe(1);
    // 港口主人不参与资源流转
    expect(r.state.players[0]!.resources.sheep).toBe(0);
    expect(r.state.players[0]!.resources.ore).toBe(0);
    expect(r.events.some((e) => e.type === 'PORT_TRANSFERRED')).toBe(true);
  });

  it('没有对应港口时拒绝', () => {
    const { board, state } = setupGame();
    const s = setRes(clearOf(state, 0), 1, { wood: 4 });

    const r = applyCommand(board, s, {
      type: 'PORT_TRANSFER', seat: 0, beneficiary: 1, give: 'wood', get: 'ore',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NO_PORT');
  });

  it('非当前玩家不能发起代换', () => {
    const { board, state } = setupGame();
    const s = withPort(board, setRes(state, 1, { sheep: 2 }), 1, 'sheep');

    const r = applyCommand(board, s, {
      type: 'PORT_TRANSFER', seat: 1, beneficiary: 1, give: 'sheep', get: 'ore',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_YOUR_TURN');
  });

  it('不能给自己代换', () => {
    const { board, state } = setupGame();
    const s = withPort(board, setRes(state, 0, { sheep: 2 }), 0, 'sheep');

    const r = applyCommand(board, s, {
      type: 'PORT_TRANSFER', seat: 0, beneficiary: 0, give: 'sheep', get: 'ore',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INVALID_TARGET');
  });
});
