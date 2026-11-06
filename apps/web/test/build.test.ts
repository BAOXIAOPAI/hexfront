import { describe, expect, it } from 'vitest';
import {
  buildBoard,
  createGame,
  viewFor,
  MAP_4P,
  type Board,
  type GameState,
  type PlayerView,
} from '@hexfront/engine';
import { canAfford, candidatesFor, costText, missingFor, overlayFor } from '../src/build.js';

function scene(): { board: Board; state: GameState; view: PlayerView } {
  const board = buildBoard(MAP_4P);
  const state = createGame(board, ['甲', '乙'], ['red', 'blue']);
  state.phase = 'play';
  state.setup = null;
  state.players[0]!.resources = { wood: 3, brick: 2, sheep: 1, wheat: 1, ore: 0 };
  return { board, state, view: viewFor(board, state, 0) };
}

describe('资源检查', () => {
  it('够的时候没有缺失项', () => {
    const { view } = scene();
    expect(missingFor(view.me.resources, 'road')).toEqual([]);
    expect(canAfford(view.me.resources, 'road')).toBe(true);
  });

  it('缺什么就报什么', () => {
    const { view } = scene();
    // 城市要 矿3 麦2，手里麦只有 1、矿为 0
    expect(missingFor(view.me.resources, 'city')).toEqual(['wheat', 'ore']);
    expect(canAfford(view.me.resources, 'city')).toBe(false);
  });

  it('成本文案按固定顺序', () => {
    expect(costText('road')).toBe('木1 砖1');
    expect(costText('settlement')).toBe('木1 砖1 羊1 麦1');
    expect(costText('city')).toBe('麦2 矿3');
  });
});

describe('候选位', () => {
  it('没有建筑时，道路没有候选', () => {
    const { board, view } = scene();
    expect(candidatesFor(view, board.geo, 'road').edges).toHaveLength(0);
  });

  it('放下村庄后，相邻空边成为道路候选', () => {
    const { board, state } = scene();
    const vk = board.geo.vertexKeys[0]!;
    state.buildings[vk] = { owner: 0, city: false };
    const view = viewFor(board, state, 0);

    const { edges } = candidatesFor(view, board.geo, 'road');
    expect(edges.length).toBe(3);
    for (const ek of edges) {
      const e = board.geo.edges[ek]!;
      expect(e.a === vk || e.b === vk).toBe(true);
    }
  });

  it('道路候选不会包含已占用的边', () => {
    const { board, state } = scene();
    const vk = board.geo.vertexKeys[0]!;
    state.buildings[vk] = { owner: 0, city: false };
    const used = board.geo.vertices[vk]!.edges[0]!;
    state.roads[used] = 0;
    const view = viewFor(board, state, 0);

    expect(candidatesFor(view, board.geo, 'road').edges).not.toContain(used);
  });

  it('村庄候选必须挨着自己的路，且不与已有建筑相邻', () => {
    const { board, state } = scene();
    const vk = board.geo.vertexKeys[0]!;
    state.buildings[vk] = { owner: 0, city: false };
    const e1 = board.geo.vertices[vk]!.edges[0]!;
    state.roads[e1] = 0;

    // 只铺一条路时，路另一端正好紧挨自己的村庄，按距离规则不能建
    expect(candidatesFor(viewFor(board, state, 0), board.geo, 'settlement').vertices).toHaveLength(0);

    // 再往外铺一条，末端那格就合法了
    const edge1 = board.geo.edges[e1]!;
    const far = edge1.a === vk ? edge1.b : edge1.a;
    const e2 = board.geo.vertices[far]!.edges.find((x) => x !== e1)!;
    state.roads[e2] = 0;

    const view = viewFor(board, state, 0);
    const { vertices } = candidatesFor(view, board.geo, 'settlement');
    expect(vertices.length).toBeGreaterThan(0);
    for (const key of vertices) {
      const v = board.geo.vertices[key]!;
      expect(v.edges.some((ek) => view.roads[ek] === 0)).toBe(true);
      expect(v.neighbors.some((nb) => view.buildings[nb])).toBe(false);
    }
  });

  it('城市候选只含自己的村庄，不含别人的、也不含已升级的', () => {
    const { board, state } = scene();
    const keys = board.geo.vertexKeys;
    state.buildings[keys[0]!] = { owner: 0, city: false };
    state.buildings[keys[10]!] = { owner: 0, city: true };
    state.buildings[keys[20]!] = { owner: 1, city: false };
    const view = viewFor(board, state, 0);

    const { vertices } = candidatesFor(view, board.geo, 'city');
    expect(vertices).toEqual([keys[0]!]);
  });

  it('没有候选时 overlay 返回 undefined', () => {
    const { board, view } = scene();
    expect(overlayFor(view, board.geo, 'road')).toBeUndefined();
  });

  it('有候选时 overlay 带出候选列表且 picked 为空', () => {
    const { board, state } = scene();
    const vk = board.geo.vertexKeys[0]!;
    state.buildings[vk] = { owner: 0, city: false };
    const view = viewFor(board, state, 0);

    const overlay = overlayFor(view, board.geo, 'road');
    expect(overlay).toBeDefined();
    expect(overlay!.edges.length).toBe(3);
    expect(overlay!.picked).toBeNull();
  });
});
