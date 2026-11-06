/**
 * 建造：道路 / 村庄 / 城市。
 *
 * 变体要点：
 * - 掷骰之前也可以建造（V-1），因此这里不检查 hasRolled
 * - 资源扣除与放置是同一原子操作
 */

import type { Board, GameState, PlayerState } from '../state.js';
import { countBuildings } from '../state.js';
import type { ApplyResult, Command, RejectReason } from '../command.js';
import type { GameEvent } from '../events.js';
import type { Resource, ResourceCount } from '../types.js';

export const COSTS: Record<'road' | 'settlement' | 'city', Partial<ResourceCount>> = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { ore: 3, wheat: 2 },
};

export const LIMITS = { road: 15, settlement: 5, city: 4 };

type RoadCmd = Extract<Command, { type: 'BUILD_ROAD' }>;
type SettlementCmd = Extract<Command, { type: 'BUILD_SETTLEMENT' }>;
type CityCmd = Extract<Command, { type: 'BUILD_CITY' }>;

function guard(state: GameState, seat: number): Extract<ApplyResult, { ok: false }> | null {
  if (state.phase !== 'play') return { ok: false, reason: 'WRONG_PHASE' };
  if (seat !== state.current) return { ok: false, reason: 'NOT_YOUR_TURN' };
  return null;
}

export function canAfford(player: PlayerState, cost: Partial<ResourceCount>): boolean {
  for (const key of Object.keys(cost) as Resource[]) {
    if (player.resources[key] < (cost[key] ?? 0)) return false;
  }
  return true;
}

export function spend(player: PlayerState, cost: Partial<ResourceCount>): Partial<ResourceCount> {
  const spent: Partial<ResourceCount> = {};
  for (const key of Object.keys(cost) as Resource[]) {
    const amount = cost[key] ?? 0;
    player.resources[key] -= amount;
    if (amount > 0) spent[key] = amount;
  }
  return spent;
}

/** 新道路必须与自己的建筑或已有道路相连 */
export function roadConnected(board: Board, state: GameState, edgeKey: string, player: number): boolean {
  const { geo } = board;
  const edge = geo.edges[edgeKey];
  if (!edge) return false;

  for (const vk of [edge.a, edge.b]) {
    const building = state.buildings[vk];
    if (building && building.owner === player) return true;

    const vertex = geo.vertices[vk];
    if (!vertex) continue;
    for (const ek of vertex.edges) {
      if (ek !== edgeKey && state.roads[ek] === player) return true;
    }
  }
  return false;
}

/** 新村庄必须紧邻自己的一条道路 */
function settlementConnected(board: Board, state: GameState, vertexKey: string, player: number): boolean {
  const vertex = board.geo.vertices[vertexKey];
  if (!vertex) return false;
  return vertex.edges.some((ek) => state.roads[ek] === player);
}

export function buildRoad(board: Board, state: GameState, cmd: RoadCmd): ApplyResult {
  const bad = guard(state, cmd.seat);
  if (bad) return bad;

  const edge = board.geo.edges[cmd.edge];
  if (!edge) return { ok: false, reason: 'UNKNOWN_EDGE' };
  if (state.roads[cmd.edge] !== undefined) return { ok: false, reason: 'EDGE_TAKEN' };

  const counts = countBuildings(state, cmd.seat);
  if (counts.roads >= LIMITS.road) return { ok: false, reason: 'BUILD_LIMIT' };

  const player = state.players[cmd.seat]!;
  if (!canAfford(player, COSTS.road!)) return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };
  if (!roadConnected(board, state, cmd.edge, cmd.seat)) {
    return { ok: false, reason: 'NOT_CONNECTED' };
  }

  const next = structuredClone(state);
  const spent = spend(next.players[cmd.seat]!, COSTS.road!);
  next.roads[cmd.edge] = cmd.seat;

  const events: GameEvent[] = [
    { type: 'RESOURCES_SPENT', player: cmd.seat, resources: spent },
    { type: 'ROAD_BUILT', player: cmd.seat, edge: cmd.edge },
  ];
  return { ok: true, state: next, events };
}

export function buildSettlement(board: Board, state: GameState, cmd: SettlementCmd): ApplyResult {
  const bad = guard(state, cmd.seat);
  if (bad) return bad;

  const vertex = board.geo.vertices[cmd.vertex];
  if (!vertex) return { ok: false, reason: 'UNKNOWN_VERTEX' };
  if (state.buildings[cmd.vertex]) return { ok: false, reason: 'OCCUPIED' };

  for (const nb of vertex.neighbors) {
    if (state.buildings[nb]) return { ok: false, reason: 'TOO_CLOSE', detail: nb };
  }

  const counts = countBuildings(state, cmd.seat);
  if (counts.villages + counts.cities >= LIMITS.settlement) {
    return { ok: false, reason: 'BUILD_LIMIT' };
  }

  const player = state.players[cmd.seat]!;
  if (!canAfford(player, COSTS.settlement!)) {
    return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };
  }
  if (!settlementConnected(board, state, cmd.vertex, cmd.seat)) {
    return { ok: false, reason: 'NOT_CONNECTED' };
  }

  const next = structuredClone(state);
  const spent = spend(next.players[cmd.seat]!, COSTS.settlement!);
  next.buildings[cmd.vertex] = { owner: cmd.seat, city: false };

  const events: GameEvent[] = [
    { type: 'RESOURCES_SPENT', player: cmd.seat, resources: spent },
    { type: 'SETTLEMENT_BUILT', player: cmd.seat, vertex: cmd.vertex },
  ];
  return { ok: true, state: next, events };
}

export function buildCity(board: Board, state: GameState, cmd: CityCmd): ApplyResult {
  const bad = guard(state, cmd.seat);
  if (bad) return bad;

  const vertex = board.geo.vertices[cmd.vertex];
  if (!vertex) return { ok: false, reason: 'UNKNOWN_VERTEX' };

  const existing = state.buildings[cmd.vertex];
  if (!existing) return { ok: false, reason: 'NOT_A_VILLAGE' };
  if (existing.owner !== cmd.seat) return { ok: false, reason: 'NOT_YOUR_BUILDING' };
  if (existing.city) return { ok: false, reason: 'NOT_A_VILLAGE' };

  const counts = countBuildings(state, cmd.seat);
  if (counts.cities >= LIMITS.city) return { ok: false, reason: 'BUILD_LIMIT' };

  const player = state.players[cmd.seat]!;
  if (!canAfford(player, COSTS.city!)) return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };

  const next = structuredClone(state);
  const spent = spend(next.players[cmd.seat]!, COSTS.city!);
  next.buildings[cmd.vertex]!.city = true;

  const events: GameEvent[] = [
    { type: 'RESOURCES_SPENT', player: cmd.seat, resources: spent },
    { type: 'CITY_BUILT', player: cmd.seat, vertex: cmd.vertex },
  ];
  return { ok: true, state: next, events };
}
