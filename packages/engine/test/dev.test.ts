import { describe, it, expect } from 'vitest';
import {
  buildBoard, createGame, applyCommand, MAP_4P, DEV_COST,
  type Board, type GameState, type DevCard, type ResourceCount,
} from '../src/index.js';
import { tileVertexKeys } from '../src/board.js';

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

function give(state: GameState, seat: number, n = 10): GameState {
  const next = structuredClone(state);
  next.players[seat]!.resources = { wood: n, brick: n, sheep: n, wheat: n, ore: n } as ResourceCount;
  return next;
}

function setDeckTop(state: GameState, card: DevCard): GameState {
  const next = structuredClone(state);
  next.devDeck = [card, ...next.devDeck.filter((c) => c !== card)];
  return next;
}

function makePlayable(state: GameState, seat: number, card: DevCard): GameState {
  const next = structuredClone(state);
  const entry = next.players[seat]!.devCards.find((e) => e.card === card);
  if (entry) entry.playable = true;
  return next;
}

describe('购买发展卡', () => {
  it('扣 羊1 麦1 矿1，且当回合不可打出', () => {
    const { board, state } = setupGame();
    const s = give(state, 0);
    const before = { ...s.players[0]!.resources };

    const r = applyCommand(board, s, { type: 'BUY_DEV_CARD', seat: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const after = r.state.players[0]!.resources;
    expect(after.sheep).toBe(before.sheep - 1);
    expect(after.wheat).toBe(before.wheat - 1);
    expect(after.ore).toBe(before.ore - 1);
    expect(after.wood).toBe(before.wood);

    expect(r.state.players[0]!.devCards).toHaveLength(1);
    expect(r.state.players[0]!.devCards[0]!.playable).toBe(false);
    expect(r.state.devDeck.length).toBe(24);
  });

  it('可以连续购买多张', () => {
    const { board, state } = setupGame();
    const s = give(state, 0);
    let cur = s;
    for (let i = 0; i < 3; i++) {
      const r = applyCommand(board, cur, { type: 'BUY_DEV_CARD', seat: 0 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      cur = r.state;
    }
    expect(cur.players[0]!.devCards).toHaveLength(3);
    expect(cur.devDeck.length).toBe(22);
  });

  it('资源不足被拒绝', () => {
    const { board, state } = setupGame();
    const poor = structuredClone(state);
    poor.players[0]!.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };

    const r = applyCommand(board, poor, { type: 'BUY_DEV_CARD', seat: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INSUFFICIENT_RESOURCES');
  });

  it('牌堆抽完后不能再买', () => {
    const { board, state } = setupGame();
    const s = give(state, 0, 40);
    const empty = structuredClone(s);
    empty.devDeck = [];

    const r = applyCommand(board, empty, { type: 'BUY_DEV_CARD', seat: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('DECK_EMPTY');
  });
});

describe('打出发展卡', () => {
  it('当回合买入的卡不能立刻打出', () => {
    const { board, state } = setupGame();
    const s = setDeckTop(give(state, 0), 'knight');

    const bought = applyCommand(board, s, { type: 'BUY_DEV_CARD', seat: 0 });
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const tile = Object.keys(bought.state.tiles).find((k) => k !== bought.state.robberTile)!;
    const r = applyCommand(board, bought.state, { type: 'PLAY_KNIGHT', seat: 0, tile });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('CARD_NOT_AVAILABLE');
  });

  it('每回合只能打出一张', () => {
    const { board, state } = setupGame();
    let s = setDeckTop(give(state, 0), 'knight');
    const b1 = applyCommand(board, s, { type: 'BUY_DEV_CARD', seat: 0 });
    if (!b1.ok) throw new Error('buy failed');
    s = makePlayable(b1.state, 0, 'knight');

    s = structuredClone(s);
    s.players[0]!.devCards.push({ card: 'monopoly', playable: true });

    const tile = Object.keys(s.tiles).find((k) => k !== s.robberTile)!;
    const r1 = applyCommand(board, s, { type: 'PLAY_KNIGHT', seat: 0, tile });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = applyCommand(board, r1.state, { type: 'PLAY_MONOPOLY', seat: 0, resource: 'wood' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('DEV_ALREADY_PLAYED');
  });

  it('骑士会移动强盗并计入最大军', () => {
    const { board, state } = setupGame();
    let s = structuredClone(give(state, 0));
    s.players[0]!.devCards.push({ card: 'knight', playable: true });

    const tile = Object.keys(s.tiles).find((k) => k !== s.robberTile)!;
    const r = applyCommand(board, s, { type: 'PLAY_KNIGHT', seat: 0, tile });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.state.robberTile).toBe(tile);
    expect(r.state.players[0]!.playedKnights).toBe(1);
    expect(r.events.some((e) => e.type === 'ROBBER_MOVED')).toBe(true);
  });

  it('强盗不能留在原地', () => {
    const { board, state } = setupGame();
    const s = structuredClone(give(state, 0));
    s.players[0]!.devCards.push({ card: 'knight', playable: true });

    const r = applyCommand(board, s, { type: 'PLAY_KNIGHT', seat: 0, tile: s.robberTile });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ROBBER_SAME_TILE');
  });

  it('骑士可以从相邻玩家抽一张牌，总资源守恒', () => {
    const { board, state } = setupGame();
    const s = structuredClone(give(state, 0));

    // 找一个地块，其相邻顶点上有玩家 1 的建筑
    const target = Object.keys(s.tiles).find((tileKey) => {
      if (tileKey === s.robberTile) return false;
      return tileVertexKeys(board.geo, tileKey).some((vk) => s.buildings[vk]?.owner === 1);
    });
    expect(target).toBeDefined();

    s.players[0]!.devCards.push({ card: 'knight', playable: true });
    s.players[1]!.resources = { wood: 3, brick: 0, sheep: 0, wheat: 0, ore: 0 };

    const totalBefore = (st: GameState) =>
      st.players.reduce((sum, p) => sum + p.resources.wood + p.resources.brick
        + p.resources.sheep + p.resources.wheat + p.resources.ore, 0);
    const before = totalBefore(s);

    const r = applyCommand(board, s, { type: 'PLAY_KNIGHT', seat: 0, tile: target!, stealFrom: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.state.players[1]!.resources.wood).toBe(2);
    expect(r.state.players[0]!.resources.wood).toBe(11);
    expect(totalBefore(r.state)).toBe(before);
  });

  it('垄断收走所有玩家的该资源', () => {
    const { board, state } = setupGame();
    const s = structuredClone(give(state, 0));
    s.players[0]!.resources.wood = 0;
    s.players[1]!.resources.wood = 3;
    s.players[2]!.resources.wood = 2;
    s.players[3]!.resources.wood = 1;
    s.players[0]!.devCards.push({ card: 'monopoly', playable: true });

    const r = applyCommand(board, s, { type: 'PLAY_MONOPOLY', seat: 0, resource: 'wood' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.state.players[0]!.resources.wood).toBe(6);
    for (let p = 1; p < 4; p++) expect(r.state.players[p]!.resources.wood).toBe(0);
  });

  it('丰饶取任意 2 张', () => {
    const { board, state } = setupGame();
    const s = structuredClone(give(state, 0));
    s.players[0]!.resources.wheat = 0;
    s.players[0]!.resources.ore = 0;
    s.players[0]!.devCards.push({ card: 'plenty', playable: true });

    const r = applyCommand(board, s, { type: 'PLAY_PLENTY', seat: 0, resources: ['wheat', 'ore'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.state.players[0]!.resources.wheat).toBe(1);
    expect(r.state.players[0]!.resources.ore).toBe(1);
  });

  it('筑路可以免费放置道路', () => {
    const { board, state } = setupGame();
    const s = structuredClone(give(state, 0));
    s.players[0]!.devCards.push({ card: 'roadbuilding', playable: true });

    const before = s.players[0]!.resources.wood;

    // 找一条与该玩家建筑相邻的空边
    let spot: string | null = null;
    for (const ek of board.geo.edgeKeys) {
      if (s.roads[ek] !== undefined) continue;
      const e = board.geo.edges[ek]!;
      const connected = [e.a, e.b].some((vk) => s.buildings[vk]?.owner === 0);
      if (connected) { spot = ek; break; }
    }
    expect(spot).not.toBeNull();

    const r = applyCommand(board, s, { type: 'PLAY_ROAD_BUILDING', seat: 0, edges: [spot!] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.state.players[0]!.resources.wood).toBe(before);
    expect(r.state.roads[spot!]).toBe(0);
    expect(r.events.some((e) => e.type === 'ROAD_BUILT')).toBe(true);
  });

  it('成本常量正确', () => {
    expect(DEV_COST).toEqual({ sheep: 1, wheat: 1, ore: 1 });
  });
});
