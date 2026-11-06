/**
 * 开局摆位。
 *
 * 规则要点：
 * - 蛇形顺序 0,1,2,3,3,2,1,0
 * - 每次放置 = 一个村庄 + 一条相邻道路，原子完成
 * - 距离规则：新村庄不能与任何已有建筑相邻（共享顶点）
 * - 第二轮放置时立即产出该村庄相邻地块的资源
 */

import type { Board, GameState } from '../state.js';
import { setupSeatOrder } from '../state.js';
import type { ApplyResult, Command } from '../command.js';
import type { GameEvent } from '../events.js';
import type { Resource, ResourceCount } from '../types.js';

type PlaceCmd = Extract<Command, { type: 'PLACE_SETTLEMENT' }>;

export function placeSettlement(board: Board, state: GameState, cmd: PlaceCmd): ApplyResult {
  if (state.phase !== 'setup' || !state.setup) {
    return { ok: false, reason: 'WRONG_PHASE' };
  }
  if (cmd.seat !== state.setup.seat) {
    return { ok: false, reason: 'NOT_YOUR_TURN' };
  }

  const { geo } = board;
  const vertex = geo.vertices[cmd.vertex];
  if (!vertex) return { ok: false, reason: 'UNKNOWN_VERTEX' };

  if (state.buildings[cmd.vertex]) return { ok: false, reason: 'OCCUPIED' };

  for (const nb of vertex.neighbors) {
    if (state.buildings[nb]) return { ok: false, reason: 'TOO_CLOSE', detail: nb };
  }

  const edge = geo.edges[cmd.edge];
  if (!edge) return { ok: false, reason: 'UNKNOWN_EDGE' };
  if (edge.a !== cmd.vertex && edge.b !== cmd.vertex) {
    return { ok: false, reason: 'EDGE_NOT_ADJACENT' };
  }
  if (state.roads[cmd.edge] !== undefined) return { ok: false, reason: 'EDGE_TAKEN' };

  const next = structuredClone(state);
  const order = setupSeatOrder(next.players.length);
  const round: 1 | 2 = next.setup!.step < next.players.length ? 1 : 2;

  next.buildings[cmd.vertex] = { owner: cmd.seat, city: false };
  next.roads[cmd.edge] = cmd.seat;

  const events: GameEvent[] = [
    { type: 'SETUP_PLACED', player: cmd.seat, vertex: cmd.vertex, edge: cmd.edge, round },
  ];

  // 房间设置可关掉「第二轮摆位立即发周围资源」，关掉则空手开局（V-选项）
  if (round === 2 && state.setupGrant) {
    const gains: Partial<ResourceCount> = {};
    for (const tileKey of vertex.tiles) {
      const tile = next.tiles[tileKey]!;
      if (tile.terrain === 'desert') continue;
      if (tileKey === next.robberTile) continue;
      const res = tile.terrain as Resource;
      gains[res] = (gains[res] ?? 0) + 1;
      next.players[cmd.seat]!.resources[res] += 1;
    }
    if (Object.keys(gains).length > 0) {
      events.push({ type: 'RESOURCES_GAINED', player: cmd.seat, resources: gains });
    }
  }

  next.setup!.step += 1;

  if (next.setup!.step >= order.length) {
    next.phase = 'play';
    next.setup = null;
    next.current = 0;
    next.hasRolled = false;
    events.push({ type: 'SETUP_COMPLETED', firstPlayer: 0 });
    events.push({ type: 'TURN_BEGUN', player: 0, turn: next.turn });
  } else {
    next.setup!.seat = order[next.setup!.step]!;
  }

  return { ok: true, state: next, events };
}

/** 开局摆位的完整座位序列，供 UI 提示下一步该谁 */
export function setupSequence(playerCount: number): number[] {
  return setupSeatOrder(playerCount);
}
