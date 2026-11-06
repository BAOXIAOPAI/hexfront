import { describe, expect, it } from 'vitest';
import {
  MAP_4P,
  applyCommand,
  buildBoard,
  createGame,
  viewFor,
  type Board,
  type GameState,
} from '@hexfront/engine';
import { robberTiles, stealCandidates } from '../src/robber.js';

function playPhase(): { board: Board; state: GameState } {
  const board = buildBoard(MAP_4P);
  let state = createGame(board, ['甲', '乙'], ['red', 'blue']);
  const geo = board.geo;
  while (state.phase === 'setup') {
    const seat = state.setup!.seat;
    let placed = false;
    for (const vk of geo.vertexKeys) {
      if (state.buildings[vk]) continue;
      const v = geo.vertices[vk]!;
      if (v.neighbors.some((nb) => state.buildings[nb])) continue;
      const ek = v.edges.find((e) => state.roads[e] === undefined);
      if (!ek) continue;
      const r = applyCommand(board, state, { type: 'PLACE_SETTLEMENT', seat, vertex: vk, edge: ek });
      if (r.ok) { state = r.state; placed = true; break; }
    }
    if (!placed) throw new Error('摆位失败');
  }
  return { board, state };
}

/** 找一个挨着指定玩家建筑、且不是强盗所在的地块 */
function tileNear(board: Board, state: GameState, owner: number): string {
  for (const [vk, b] of Object.entries(state.buildings)) {
    if (b.owner !== owner) continue;
    const tk = board.geo.vertices[vk]!.tiles.find((t) => t !== state.robberTile);
    if (tk) return tk;
  }
  throw new Error('找不到相邻地块');
}

describe('掷 7 结算的可用性提示', () => {
  it('R-44：所有其他地块都能放强盗，唯独不能留原地', () => {
    const { board, state } = playPhase();
    const view = viewFor(board, state, 0);
    const tiles = robberTiles(view, board.geo);
    expect(tiles).toHaveLength(board.geo.tileKeys.length - 1);
    expect(tiles).toHaveLength(18);
    expect(tiles).not.toContain(view.robberTile);
  });

  it('R-45：只列出相邻有建筑、手里有牌、且不是自己的玩家', () => {
    const { board, state } = playPhase();
    const withHands = structuredClone(state);
    for (const p of withHands.players) {
      p.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
    }
    withHands.players[0]!.resources.wood = 2;
    withHands.players[1]!.resources.brick = 3;
    const view = viewFor(board, withHands, 0);
    const tile = tileNear(board, withHands, 1);

    const list = stealCandidates(view, board.geo, tile);
    expect(list.some((c) => c.seat === 1)).toBe(true);
    expect(list.find((c) => c.seat === 1)?.handSize).toBe(3);
    expect(list.every((c) => c.seat !== view.viewer)).toBe(true);
  });

  it('R-46：相邻玩家没手牌时不给抽牌对象', () => {
    const { board, state } = playPhase();
    const view = viewFor(board, state, 0); // 双方摆位后手牌来自开局发牌，先全部清零
    const empty = structuredClone(state);
    for (const p of empty.players) {
      p.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
    }
    const tile = tileNear(board, empty, 1);
    expect(stealCandidates(viewFor(board, empty, 0), board.geo, tile)).toEqual([]);
    expect(view.viewer).toBe(0);
  });
});
