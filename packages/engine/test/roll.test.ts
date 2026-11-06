import { describe, it, expect } from 'vitest';
import {
  buildBoard,
  createGame,
  applyCommand,
  MAP_4P,
  RESOURCES,
  type Board,
  type GameState,
} from '../src/index.js';

const NAMES = ['你', '阿岚', '小满', '老周'];
const COLORS = ['red', 'blue', 'white', 'orange'] as const;

interface Placement {
  seat: number;
  vertex: string;
  round: 1 | 2;
}

function setupGame(): { board: Board; state: GameState; placements: Placement[] } {
  const board = buildBoard(MAP_4P);
  let state = createGame(board, NAMES, [...COLORS]);
  const placements: Placement[] = [];
  const geo = board.geo;

  while (state.phase === 'setup') {
    const seat = state.setup!.seat;
    const round: 1 | 2 = state.setup!.step < 4 ? 1 : 2;
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
          placements.push({ seat, vertex: vk, round });
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) throw new Error('无法完成开局摆位');
  }

  return { board, state, placements };
}

describe('掷骰', () => {
  it('setup 阶段不能掷骰', () => {
    const board = buildBoard(MAP_4P);
    const state = createGame(board, NAMES, [...COLORS]);
    const r = applyCommand(board, state, { type: 'ROLL_DICE', seat: 0, dice: [1, 1] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('WRONG_PHASE');
  });

  it('不是自己的回合不能掷骰', () => {
    const { board, state } = setupGame();
    const r = applyCommand(board, state, { type: 'ROLL_DICE', seat: 2, dice: [1, 1] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_YOUR_TURN');
  });

  it('同一回合不能掷两次', () => {
    const { board, state } = setupGame();
    const r1 = applyCommand(board, state, { type: 'ROLL_DICE', seat: 0, dice: [2, 3] });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = applyCommand(board, r1.state, { type: 'ROLL_DICE', seat: 0, dice: [2, 3] });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('ALREADY_ROLLED');
  });

  it('非法骰子被拒绝', () => {
    const { board, state } = setupGame();
    const r = applyCommand(board, state, { type: 'ROLL_DICE', seat: 0, dice: [7, 1] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_DICE');
  });

  it('掷出 7 不产资源，只触发强盗事件', () => {
    const { board, state } = setupGame();
    const before = state.players.map((p) => ({ ...p.resources }));

    const r = applyCommand(board, state, { type: 'ROLL_DICE', seat: 0, dice: [3, 4] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.events.some((e) => e.type === 'SEVEN_ROLLED')).toBe(true);
    expect(r.events.some((e) => e.type === 'RESOURCES_GAINED')).toBe(false);
    expect(r.state.players.map((p) => p.resources)).toEqual(before);
  });

  it('非 7 点数按相邻地块产出，村庄 1 张', () => {
    const { board, state, placements } = setupGame();

    // 找 0 号玩家第二轮的村庄，取它相邻的一个有数字的地块
    const mine = placements.filter((p) => p.seat === 0).pop()!;
    const vertex = board.geo.vertices[mine.vertex]!;
    const tile = vertex.tiles
      .map((k) => state.tiles[k]!)
      .find((t) => t.terrain !== 'desert' && t.number !== null)!;

    const sum = tile.number!;
    const d1 = Math.floor(sum / 2);
    const d2 = sum - d1;

    const before = state.players[0]!.resources[tile.terrain as 'wood'];
    const r = applyCommand(board, state, { type: 'ROLL_DICE', seat: 0, dice: [d1, d2] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const after = r.state.players[0]!.resources[tile.terrain as 'wood'];
    expect(after).toBeGreaterThanOrEqual(before + 1);
  });

  it('城市按 2 张结算', () => {
    const { board, state, placements } = setupGame();

    // 把 0 号玩家的一个村庄直接升级为城市，验证产出翻倍
    const mine = placements.filter((p) => p.seat === 0).pop()!;
    const patched: GameState = structuredClone(state);
    patched.buildings[mine.vertex]!.city = true;

    const vertex = board.geo.vertices[mine.vertex]!;
    const tile = vertex.tiles
      .map((k) => patched.tiles[k]!)
      .find((t) => t.terrain !== 'desert' && t.number !== null)!;

    const sum = tile.number!;
    const d1 = Math.floor(sum / 2);
    const d2 = sum - d1;

    const before = patched.players[0]!.resources[tile.terrain as 'wood'];
    const r = applyCommand(board, patched, { type: 'ROLL_DICE', seat: 0, dice: [d1, d2] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const after = r.state.players[0]!.resources[tile.terrain as 'wood'];
    expect(after).toBeGreaterThanOrEqual(before + 2);
  });

  it('强盗所在地块不产出', () => {
    const { board, state, placements } = setupGame();

    const mine = placements.filter((p) => p.seat === 0).pop()!;
    const vertex = board.geo.vertices[mine.vertex]!;
    const tile = vertex.tiles
      .map((k) => state.tiles[k]!)
      .find((t) => t.terrain !== 'desert' && t.number !== null)!;

    const patched: GameState = structuredClone(state);
    patched.robberTile = tile.key;

    const sum = tile.number!;
    const d1 = Math.floor(sum / 2);
    const d2 = sum - d1;

    const r = applyCommand(board, patched, { type: 'ROLL_DICE', seat: 0, dice: [d1, d2] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const gained = r.events
      .filter((e) => e.type === 'RESOURCES_GAINED' && e.player === 0)
      .flatMap((e) => (e.type === 'RESOURCES_GAINED' ? [e.resources] : []));
    for (const g of gained) {
      expect(g[tile.terrain as 'wood'] ?? 0).toBe(0);
    }
  });
});

describe('回合流转', () => {
  it('未掷骰不能结束回合', () => {
    const { board, state } = setupGame();
    const r = applyCommand(board, state, { type: 'END_TURN', seat: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_YET_ROLLED');
  });

  it('掷骰后可以结束回合，轮到下一位', () => {
    const { board, state } = setupGame();
    const r1 = applyCommand(board, state, { type: 'ROLL_DICE', seat: 0, dice: [2, 3] });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = applyCommand(board, r1.state, { type: 'END_TURN', seat: 0 });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.state.current).toBe(1);
    expect(r2.state.hasRolled).toBe(false);
    expect(r2.state.turn).toBe(2);
  });
});
