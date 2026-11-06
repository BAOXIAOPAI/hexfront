import { describe, it, expect } from 'vitest';
import {
  buildBoard,
  createGame,
  applyCommand,
  MAP_4P,
  countBuildings,
  COSTS,
  LIMITS,
  type Board,
  type GameState,
  type ResourceCount,
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
        if (r.ok) {
          state = r.state;
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) throw new Error('开局摆位失败');
  }
  return { board, state };
}

function withResources(state: GameState, seat: number, amount = 10): GameState {
  const next = structuredClone(state);
  next.players[seat]!.resources = {
    wood: amount, brick: amount, sheep: amount, wheat: amount, ore: amount,
  } as ResourceCount;
  return next;
}

function findRoadSpot(board: Board, state: GameState, player: number): string | null {
  for (const ek of board.geo.edgeKeys) {
    if (state.roads[ek] !== undefined) continue;
    const e = board.geo.edges[ek]!;
    const connected = [e.a, e.b].some((vk) => {
      const b = state.buildings[vk];
      if (b && b.owner === player) return true;
      const v = board.geo.vertices[vk]!;
      return v.edges.some((x) => x !== ek && state.roads[x] === player);
    });
    if (connected) return ek;
  }
  return null;
}

function findSettlementSpot(board: Board, state: GameState, player: number): string | null {
  for (const vk of board.geo.vertexKeys) {
    if (state.buildings[vk]) continue;
    const v = board.geo.vertices[vk]!;
    if (v.neighbors.some((nb) => state.buildings[nb])) continue;
    if (!v.edges.some((ek) => state.roads[ek] === player)) continue;
    return vk;
  }
  return null;
}

describe('建造道路', () => {
  it('资源不足时被拒绝', () => {
    const { board, state } = setupGame();
    const poor = structuredClone(state);
    poor.players[0]!.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };

    const spot = findRoadSpot(board, poor, 0);
    expect(spot).not.toBeNull();
    const r = applyCommand(board, poor, { type: 'BUILD_ROAD', seat: 0, edge: spot! });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INSUFFICIENT_RESOURCES');
  });

  it('不连通的位置被拒绝', () => {
    const { board, state } = setupGame();
    const rich = withResources(state, 0);

    const isolated = board.geo.edgeKeys.find((ek) => {
      if (rich.roads[ek] !== undefined) return false;
      const e = board.geo.edges[ek]!;
      return ![e.a, e.b].some((vk) => {
        const b = rich.buildings[vk];
        if (b && b.owner === 0) return true;
        const v = board.geo.vertices[vk]!;
        return v.edges.some((x) => x !== ek && rich.roads[x] === 0);
      });
    });

    expect(isolated).toBeDefined();
    const r = applyCommand(board, rich, { type: 'BUILD_ROAD', seat: 0, edge: isolated! });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_CONNECTED');
  });

  it('已有道路的边不能重复建', () => {
    const { board, state } = setupGame();
    const rich = withResources(state, 0);
    const existing = Object.keys(rich.roads)[0]!;
    const r = applyCommand(board, rich, { type: 'BUILD_ROAD', seat: 0, edge: existing });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('EDGE_TAKEN');
  });

  it('建造成功会扣除 木1 砖1 并放上路', () => {
    const { board, state } = setupGame();
    const rich = withResources(state, 0);
    const spot = findRoadSpot(board, rich, 0)!;
    const before = { ...rich.players[0]!.resources };

    const r = applyCommand(board, rich, { type: 'BUILD_ROAD', seat: 0, edge: spot });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.state.roads[spot]).toBe(0);
    expect(r.state.players[0]!.resources.wood).toBe(before.wood - 1);
    expect(r.state.players[0]!.resources.brick).toBe(before.brick - 1);
    expect(r.state.players[0]!.resources.wheat).toBe(before.wheat);
    expect(r.events.some((e) => e.type === 'ROAD_BUILT')).toBe(true);
  });

  it('达到 15 条上限后被拒绝', () => {
    const { board, state } = setupGame();
    const rich = withResources(state, 0);
    const patched = structuredClone(rich);

    const free = board.geo.edgeKeys.filter((ek) => patched.roads[ek] === undefined);
    for (let i = 0; i < LIMITS.road - 2; i++) patched.roads[free[i]!] = 0;

    expect(countBuildings(patched, 0).roads).toBe(LIMITS.road);

    const spot = findRoadSpot(board, patched, 0);
    if (spot) {
      const r = applyCommand(board, patched, { type: 'BUILD_ROAD', seat: 0, edge: spot });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('BUILD_LIMIT');
    }
  });
});

describe('建造村庄', () => {
  it('必须与自己的道路相邻', () => {
    const { board, state } = setupGame();
    const rich = withResources(state, 0);

    const disconnected = board.geo.vertexKeys.find((vk) => {
      if (rich.buildings[vk]) return false;
      const v = board.geo.vertices[vk]!;
      if (v.neighbors.some((nb) => rich.buildings[nb])) return false;
      return !v.edges.some((ek) => rich.roads[ek] === 0);
    });
    expect(disconnected).toBeDefined();

    const r = applyCommand(board, rich, { type: 'BUILD_SETTLEMENT', seat: 0, vertex: disconnected! });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_CONNECTED');
  });

  it('距离规则：不能与已有建筑相邻', () => {
    const { board, state } = setupGame();
    const rich = withResources(state, 0);

    const mine = Object.keys(rich.buildings).find((vk) => rich.buildings[vk]!.owner === 0)!;
    const neighbor = board.geo.vertices[mine]!.neighbors[0]!;

    const r = applyCommand(board, rich, { type: 'BUILD_SETTLEMENT', seat: 0, vertex: neighbor });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('TOO_CLOSE');
  });

  it('合法位置建造成功，扣四种资源', () => {
    const { board, state } = setupGame();
    const s = withResources(state, 0, 20);

    // 手动构造：找一个空旷顶点，先给它接一条自己的路（模拟路已修到此处）
    const vk = board.geo.vertexKeys.find((k) => {
      if (s.buildings[k]) return false;
      const v = board.geo.vertices[k]!;
      return !v.neighbors.some((nb) => s.buildings[nb]);
    });
    expect(vk).toBeDefined();

    const vertex = board.geo.vertices[vk!]!;
    const ek = vertex.edges.find((e) => s.roads[e] === undefined);
    expect(ek).toBeDefined();
    s.roads[ek!] = 0;

    const before = { ...s.players[0]!.resources };
    const r = applyCommand(board, s, { type: 'BUILD_SETTLEMENT', seat: 0, vertex: vk! });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const after = r.state.players[0]!.resources;
    expect(after.wood).toBe(before.wood - 1);
    expect(after.brick).toBe(before.brick - 1);
    expect(after.sheep).toBe(before.sheep - 1);
    expect(after.wheat).toBe(before.wheat - 1);
    expect(after.ore).toBe(before.ore);
    expect(r.state.buildings[vk!]).toEqual({ owner: 0, city: false });
  });
});

describe('升级城市', () => {
  it('只能升级自己的村庄', () => {
    const { board, state } = setupGame();
    const others = Object.keys(state.buildings).find((vk) => state.buildings[vk]!.owner === 1)!;
    const rich = withResources(state, 0);

    const r = applyCommand(board, rich, { type: 'BUILD_CITY', seat: 0, vertex: others });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_YOUR_BUILDING');
  });

  it('空地不能直接建城', () => {
    const { board, state } = setupGame();
    const rich = withResources(state, 0);
    const empty = board.geo.vertexKeys.find((vk) => !rich.buildings[vk])!;

    const r = applyCommand(board, rich, { type: 'BUILD_CITY', seat: 0, vertex: empty });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_A_VILLAGE');
  });

  it('升级成功：扣 矿3 麦2，村庄变城市', () => {
    const { board, state } = setupGame();
    const rich = withResources(state, 0);
    const mine = Object.keys(rich.buildings).find((vk) => rich.buildings[vk]!.owner === 0)!;

    const before = { ...rich.players[0]!.resources };
    const r = applyCommand(board, rich, { type: 'BUILD_CITY', seat: 0, vertex: mine });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const after = r.state.players[0]!.resources;
    expect(after.ore).toBe(before.ore - 3);
    expect(after.wheat).toBe(before.wheat - 2);
    expect(r.state.buildings[mine]!.city).toBe(true);
    expect(r.state.buildings[mine]!.owner).toBe(0);
  });

  it('已经是城市不能再升级', () => {
    const { board, state } = setupGame();
    const rich = withResources(state, 0);
    const mine = Object.keys(rich.buildings).find((vk) => rich.buildings[vk]!.owner === 0)!;

    const r1 = applyCommand(board, rich, { type: 'BUILD_CITY', seat: 0, vertex: mine });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = applyCommand(board, r1.state, { type: 'BUILD_CITY', seat: 0, vertex: mine });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('NOT_A_VILLAGE');
  });
});

describe('变体规则', () => {
  it('掷骰之前也能建造（V-1）', () => {
    const { board, state } = setupGame();
    const rich = withResources(state, 0);
    expect(rich.hasRolled).toBe(false);

    const spot = findRoadSpot(board, rich, 0)!;
    const r = applyCommand(board, rich, { type: 'BUILD_ROAD', seat: 0, edge: spot });
    expect(r.ok).toBe(true);
  });

  it('非当前玩家不能建造', () => {
    const { board, state } = setupGame();
    const rich = withResources(state, 1);
    const spot = findRoadSpot(board, rich, 1);

    if (spot) {
      const r = applyCommand(board, rich, { type: 'BUILD_ROAD', seat: 1, edge: spot });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('NOT_YOUR_TURN');
    }
  });

  it('成本常量与规则书一致', () => {
    expect(COSTS.road).toEqual({ wood: 1, brick: 1 });
    expect(COSTS.settlement).toEqual({ wood: 1, brick: 1, sheep: 1, wheat: 1 });
    expect(COSTS.city).toEqual({ ore: 3, wheat: 2 });
  });
});
