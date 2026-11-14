import { describe, it, expect } from 'vitest';
import {
  buildBoard, createGame, applyCommand, MAP_4P,
  ownedPort, ownedPorts, BANK_RATIO, GENERIC_PORT_RATIO, SPECIFIC_PORT_RATIO,
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

describe('F5 · 银行严格 4:1（不因港口自动降比例）', () => {
  it('固定比例常量', () => {
    expect(BANK_RATIO).toBe(4);
    expect(GENERIC_PORT_RATIO).toBe(3);
    expect(SPECIFIC_PORT_RATIO).toBe(2);
  });

  it('4 张同类换 1 张指定资源，扣 4 得 1', () => {
    const { board, state } = setupGame();
    const s = setRes(clearOf(state, 0), 0, { wood: 4 });
    const r = applyCommand(board, s, { type: 'TRADE_BANK', seat: 0, give: 'wood', get: 'ore' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[0]!.resources.wood).toBe(0);
    expect(r.state.players[0]!.resources.ore).toBe(1);
    expect(r.events.some((e) => e.type === 'BANK_TRADED' && e.ratio === 4)).toBe(true);
  });

  it('拥有港口也绝不降比例：仍需 4 张，3 张被拒', () => {
    const { board, state } = setupGame();
    const owned = withPort(board, setRes(clearOf(state, 0), 0, { wood: 3 }), 0, 'generic');
    const r = applyCommand(board, owned, { type: 'TRADE_BANK', seat: 0, give: 'wood', get: 'ore' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INSUFFICIENT_RESOURCES');
  });

  it('资源不足 / 同种兑换 / 缺资源种类 / 非自己回合均被拒绝', () => {
    const { board, state } = setupGame();
    expect(applyCommand(board, setRes(clearOf(state, 0), 0, { wood: 3 }),
      { type: 'TRADE_BANK', seat: 0, give: 'wood', get: 'ore' }).ok).toBe(false);
    expect(applyCommand(board, setRes(state, 0, { wood: 4 }),
      { type: 'TRADE_BANK', seat: 0, give: 'wood', get: 'wood' })).toMatchObject({ ok: false, reason: 'SAME_TARGET' });
    expect(applyCommand(board, setRes(state, 1, { wood: 4 }),
      { type: 'TRADE_BANK', seat: 1, give: 'wood', get: 'ore' })).toMatchObject({ ok: false, reason: 'NOT_YOUR_TURN' });
  });
});

describe('F5 · 自有港口：所有权与比例', () => {
  it('ownedPort 只认港口边端点的己方村庄/城市，道路连接不算拥有', () => {
    const { board, state } = setupGame();
    const clean = clearOf(state, 0);
    const slot = clean.ports.find((s) => s.port.kind === 'generic')!;
    const edge = board.geo.edges[slot.edge]!;

    // 只在端点旁的另一条边铺一条自己的路 → 不算拥有
    const roadOnly = structuredClone(clean);
    roadOnly.roads[edge.a] = 0;   // 用端点 key 当占位，仅验证 roads 不参与所有权
    expect(ownedPort(board, roadOnly, 0, slot.edge)).toBeNull();

    // 端点放自己的村庄 → 拥有
    const withBuilding = structuredClone(clean);
    withBuilding.buildings[edge.a] = { owner: 0, city: false };
    expect(ownedPort(board, withBuilding, 0, slot.edge)).toEqual({ kind: 'generic' });
    // 城市也算拥有
    withBuilding.buildings[edge.a] = { owner: 0, city: true };
    expect(ownedPort(board, withBuilding, 0, slot.edge)).toEqual({ kind: 'generic' });
    // 别人的建筑不算
    withBuilding.buildings[edge.a] = { owner: 1, city: false };
    expect(ownedPort(board, withBuilding, 0, slot.edge)).toBeNull();
    expect(ownedPort(board, withBuilding, 1, slot.edge)).toEqual({ kind: 'generic' });
  });

  it('ownedPorts 只列出「我的港口」', () => {
    const { board, state } = setupGame();
    const s = withPort(board, clearOf(state, 0), 0, 'sheep');
    const mine = ownedPorts(board, s, 0);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((p) => ownedPort(board, s, 0, p.edge) !== null)).toBe(true);
  });

  it('通用港：1木+1砖+1羊 混合 3 张 → 1 矿成功', () => {
    const { board, state } = setupGame();
    const owned = withPort(board, setRes(clearOf(state, 0), 0, { wood: 1, brick: 1, sheep: 1 }), 0, 'generic');
    const edge = ownedPorts(board, owned, 0).find((p) => p.port.kind === 'generic')!.edge;
    const r = applyCommand(board, owned, {
      type: 'TRADE_PORT', seat: 0, port: edge,
      give: { wood: 1, brick: 1, sheep: 1 }, get: 'ore',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[0]!.resources.wood).toBe(0);
    expect(r.state.players[0]!.resources.brick).toBe(0);
    expect(r.state.players[0]!.resources.sheep).toBe(0);
    expect(r.state.players[0]!.resources.ore).toBe(1);
    expect(r.events.some((e) => e.type === 'PORT_TRADED' && e.ratio === 3)).toBe(true);
  });

  it('通用港总数不是 3 / 负数 / 小数一律拒绝', () => {
    const { board, state } = setupGame();
    const owned = withPort(board, setRes(clearOf(state, 0), 0, { wood: 5, brick: 5, sheep: 5 }), 0, 'generic');
    const edge = ownedPorts(board, owned, 0).find((p) => p.port.kind === 'generic')!.edge;
    const bad = (give: Partial<ResourceCount>, reason: string) => {
      const r = applyCommand(board, owned, { type: 'TRADE_PORT', seat: 0, port: edge, give, get: 'ore' });
      expect(r, reason).toMatchObject({ ok: false });
    };
    bad({ wood: 2 }, '总数不是 3');
    bad({ wood: 4 }, '总数不是 3');
    bad({ wood: -1, brick: 2, sheep: 2 } as unknown as Partial<ResourceCount>, '负数');
    bad({ wood: 1.5, brick: 1, sheep: 1 } as unknown as Partial<ResourceCount>, '小数');
    // 缺资源：给 3 张矿但手里没有矿（即使总数恰好 3 也必须拒绝）
    bad({ ore: 3 }, '缺资源足额校验');
  });

  it('专用港：只有对应资源 2 张可换；非对应资源拒绝', () => {
    const { board, state } = setupGame();
    const owned = withPort(board, setRes(clearOf(state, 0), 0, { sheep: 3, wood: 3 }), 0, 'sheep');
    const edge = ownedPorts(board, owned, 0).find((p) => p.port.kind === 'specific')!.edge;
    expect(applyCommand(board, owned, {
      type: 'TRADE_PORT', seat: 0, port: edge, give: { sheep: 2 }, get: 'ore',
    }).ok).toBe(true);
    expect(applyCommand(board, owned, {
      type: 'TRADE_PORT', seat: 0, port: edge, give: { wood: 2 }, get: 'ore',
    })).toMatchObject({ ok: false, reason: 'BAD_PORT' });
    expect(applyCommand(board, owned, {
      type: 'TRADE_PORT', seat: 0, port: edge, give: { sheep: 1, wood: 1 }, get: 'ore',
    })).toMatchObject({ ok: false, reason: 'BAD_PORT' });
  });

  it('无港拒绝；港口不存在 / 不归自己拒绝', () => {
    const { board, state } = setupGame();
    const clean = clearOf(state, 0);
    const r = applyCommand(board, setRes(clean, 0, { wood: 3 }), {
      type: 'TRADE_PORT', seat: 0, port: clean.ports[0]!.edge,
      give: { wood: 3 }, get: 'ore',
    });
    expect(r).toMatchObject({ ok: false, reason: 'NO_PORT' });
    expect(applyCommand(board, setRes(clean, 0, { wood: 3 }), {
      type: 'TRADE_PORT', seat: 0, port: 'nope|edge',
      give: { wood: 3 }, get: 'ore',
    })).toMatchObject({ ok: false, reason: 'NO_PORT' });
  });

  it('非自己回合 / 缺资源拒绝', () => {
    const { board, state } = setupGame();
    const owned = withPort(board, clearOf(state, 0), 0, 'generic');
    const edge = ownedPorts(board, owned, 0)[0]!.edge;
    expect(applyCommand(board, setRes(owned, 1, { wood: 3 }), {
      type: 'TRADE_PORT', seat: 1, port: edge, give: { wood: 3 }, get: 'ore',
    })).toMatchObject({ ok: false, reason: 'NOT_YOUR_TURN' });
    expect(applyCommand(board, owned, {
      type: 'TRADE_PORT', seat: 0, port: edge, give: { wood: 3 }, get: 'ore',
    })).toMatchObject({ ok: false, reason: 'INSUFFICIENT_RESOURCES' });
  });

  it('严格足额、禁止同类抵扣：给袋含收到资源时按原始持有量校验', () => {
    const { board, state } = setupGame();
    const owned = withPort(board, setRes(clearOf(state, 0), 0, { wood: 1, brick: 1, sheep: 1 }), 0, 'generic');
    const edge = ownedPorts(board, owned, 0).find((p) => p.port.kind === 'generic')!.edge;
    // 给 1木1砖1羊、收到 1木：原始持有量足额 → 成功；结算后木 = 1-1+1 = 1
    const r = applyCommand(board, owned, {
      type: 'TRADE_PORT', seat: 0, port: edge,
      give: { wood: 1, brick: 1, sheep: 1 }, get: 'wood',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[0]!.resources.wood).toBe(1);
    expect(r.state.players[0]!.resources.brick).toBe(0);
    expect(r.state.players[0]!.resources.sheep).toBe(0);

    // 原始只有 0 木却想给 1 木（指望刚收到的木抵扣）→ 必须拒绝
    const short = withPort(board, setRes(clearOf(state, 0), 0, { brick: 1, sheep: 2 }), 0, 'generic');
    const shortEdge = ownedPorts(board, short, 0).find((p) => p.port.kind === 'generic')!.edge;
    expect(applyCommand(board, short, {
      type: 'TRADE_PORT', seat: 0, port: shortEdge,
      give: { wood: 1, brick: 1, sheep: 1 }, get: 'wood',
    })).toMatchObject({ ok: false, reason: 'INSUFFICIENT_RESOURCES' });
  });
});

describe('F5 · 借港代换已移除', () => {
  it('旧 PORT_TRANSFER 命令类型不再存在，运行时被当作未知命令拒绝', () => {
    const { board, state } = setupGame();
    const legacy = { type: 'PORT_TRANSFER', seat: 0, beneficiary: 1, give: 'wood', get: 'ore' };
    const r = applyCommand(board, state, legacy as unknown as Parameters<typeof applyCommand>[2]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('UNKNOWN_COMMAND');
  });
});
