/**
 * 发展卡：购买与打出。
 *
 * 规则要点：
 * - 成本 羊1 麦1 矿1
 * - 同回合可买多张
 * - 当回合买入的卡不可当回合打出（Entry.playable = false）
 * - 每回合只能打出 1 张非胜利点卡
 * - 牌堆 25 张，抽完不补
 */

import type { Board, GameState, PlayerState } from '../state.js';
import { countBuildings } from '../state.js';
import type { ApplyResult, Command } from '../command.js';
import type { GameEvent } from '../events.js';
import { RESOURCES, type DevCard, type Resource, type ResourceCount } from '../types.js';
import { canAfford, spend, roadConnected, LIMITS } from './build.js';
import { tileVertexKeys } from '../board.js';

export const DEV_COST: Partial<ResourceCount> = { sheep: 1, wheat: 1, ore: 1 };

type BuyCmd = Extract<Command, { type: 'BUY_DEV_CARD' }>;
type KnightCmd = Extract<Command, { type: 'PLAY_KNIGHT' }>;
type MonopolyCmd = Extract<Command, { type: 'PLAY_MONOPOLY' }>;
type PlentyCmd = Extract<Command, { type: 'PLAY_PLENTY' }>;
type RoadBuildingCmd = Extract<Command, { type: 'PLAY_ROAD_BUILDING' }>;

function guard(state: GameState, seat: number): Extract<ApplyResult, { ok: false }> | null {
  if (state.phase !== 'play') return { ok: false, reason: 'WRONG_PHASE' };
  if (seat !== state.current) return { ok: false, reason: 'NOT_YOUR_TURN' };
  return null;
}

function findPlayable(player: PlayerState, card: DevCard): number {
  return player.devCards.findIndex((e) => e.card === card && e.playable);
}

function assertCanPlay(state: GameState, seat: number, card: DevCard): Extract<ApplyResult, { ok: false }> | null {
  const player = state.players[seat]!;
  if (player.devPlayedThisTurn) return { ok: false, reason: 'DEV_ALREADY_PLAYED' };
  if (findPlayable(player, card) < 0) return { ok: false, reason: 'CARD_NOT_AVAILABLE' };
  return null;
}

/** 从受害者手牌里随机抽一张（按资源张数加权） */
function stealRandom(victim: PlayerState): Resource | null {
  const pool: Resource[] = [];
  for (const r of RESOURCES) {
    for (let i = 0; i < victim.resources[r]; i++) pool.push(r);
  }
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

function hasBuildingAdjacent(board: Board, state: GameState, tileKey: string, player: number): boolean {
  for (const vk of tileVertexKeys(board.geo, tileKey)) {
    const b = state.buildings[vk];
    if (b && b.owner === player) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------

export function buyDevCard(board: Board, state: GameState, cmd: BuyCmd): ApplyResult {
  const bad = guard(state, cmd.seat);
  if (bad) return bad;

  if (state.devDeck.length === 0) return { ok: false, reason: 'DECK_EMPTY' };

  const player = state.players[cmd.seat]!;
  if (!canAfford(player, DEV_COST)) return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };

  const next = structuredClone(state);
  const card = next.devDeck.shift()!;
  const spent = spend(next.players[cmd.seat]!, DEV_COST);
  next.players[cmd.seat]!.devCards.push({ card, playable: false });

  const events: GameEvent[] = [
    { type: 'RESOURCES_SPENT', player: cmd.seat, resources: spent },
    { type: 'DEV_CARD_BOUGHT', player: cmd.seat, count: 1 },
  ];
  return { ok: true, state: next, events };
}

export function playKnight(board: Board, state: GameState, cmd: KnightCmd): ApplyResult {
  const bad = guard(state, cmd.seat);
  if (bad) return bad;

  const early = assertCanPlay(state, cmd.seat, 'knight');
  if (early) return early;

  if (!board.geo.tiles[cmd.tile]) return { ok: false, reason: 'UNKNOWN_TILE' };
  if (cmd.tile === state.robberTile) return { ok: false, reason: 'ROBBER_SAME_TILE' };

  const next = structuredClone(state);
  const player = next.players[cmd.seat]!;
  const from = next.robberTile;

  next.robberTile = cmd.tile;
  player.devCards.splice(findPlayable(player, 'knight'), 1);
  player.playedKnights += 1;
  player.devPlayedThisTurn = true;

  const events: GameEvent[] = [
    { type: 'DEV_CARD_PLAYED', player: cmd.seat, card: 'knight' },
    { type: 'ROBBER_MOVED', player: cmd.seat, from, to: cmd.tile },
  ];

  if (cmd.stealFrom !== undefined && cmd.stealFrom !== cmd.seat) {
    const victim = next.players[cmd.stealFrom];
    if (victim && hasBuildingAdjacent(board, next, cmd.tile, cmd.stealFrom)) {
      const gained = stealRandom(victim);
      if (gained) {
        victim.resources[gained] -= 1;
        player.resources[gained] += 1;
        events.push({ type: 'CARD_STOLEN', thief: cmd.seat, victim: cmd.stealFrom });
      }
    }
  }

  return { ok: true, state: next, events };
}

export function playMonopoly(board: Board, state: GameState, cmd: MonopolyCmd): ApplyResult {
  const bad = guard(state, cmd.seat);
  if (bad) return bad;

  const early = assertCanPlay(state, cmd.seat, 'monopoly');
  if (early) return early;

  const next = structuredClone(state);
  const player = next.players[cmd.seat]!;
  player.devCards.splice(findPlayable(player, 'monopoly'), 1);
  player.devPlayedThisTurn = true;

  const gains: { player: number; amount: number }[] = [];
  for (const other of next.players) {
    if (other.index === cmd.seat) continue;
    const amount = other.resources[cmd.resource];
    if (amount <= 0) continue;
    other.resources[cmd.resource] = 0;
    player.resources[cmd.resource] += amount;
    gains.push({ player: other.index, amount });
  }

  const events: GameEvent[] = [
    { type: 'DEV_CARD_PLAYED', player: cmd.seat, card: 'monopoly' },
    { type: 'MONOPOLY_RESOLVED', player: cmd.seat, resource: cmd.resource, gains },
  ];
  return { ok: true, state: next, events };
}

export function playPlenty(board: Board, state: GameState, cmd: PlentyCmd): ApplyResult {
  const bad = guard(state, cmd.seat);
  if (bad) return bad;

  const early = assertCanPlay(state, cmd.seat, 'plenty');
  if (early) return early;

  const next = structuredClone(state);
  const player = next.players[cmd.seat]!;
  player.devCards.splice(findPlayable(player, 'plenty'), 1);
  player.devPlayedThisTurn = true;

  const gained: Partial<ResourceCount> = {};
  for (const r of cmd.resources) {
    player.resources[r] += 1;
    gained[r] = (gained[r] ?? 0) + 1;
  }

  const events: GameEvent[] = [
    { type: 'DEV_CARD_PLAYED', player: cmd.seat, card: 'plenty' },
    { type: 'RESOURCES_GAINED', player: cmd.seat, resources: gained },
  ];
  return { ok: true, state: next, events };
}

export function playRoadBuilding(board: Board, state: GameState, cmd: RoadBuildingCmd): ApplyResult {
  const bad = guard(state, cmd.seat);
  if (bad) return bad;

  const early = assertCanPlay(state, cmd.seat, 'roadbuilding');
  if (early) return early;

  const wanted = cmd.edges.filter((e): e is string => typeof e === 'string');
  if (wanted.length === 0) return { ok: false, reason: 'INVALID_TARGET' };

  const next = structuredClone(state);
  const player0 = next.players[cmd.seat]!;
  player0.devCards.splice(findPlayable(player0, 'roadbuilding'), 1);
  player0.devPlayedThisTurn = true;

  const events: GameEvent[] = [{ type: 'DEV_CARD_PLAYED', player: cmd.seat, card: 'roadbuilding' }];

  for (const ek of wanted) {
    if (!board.geo.edges[ek]) continue;
    if (next.roads[ek] !== undefined) continue;
    if (countBuildings(next, cmd.seat).roads >= LIMITS.road) continue;
    if (!roadConnected(board, next, ek, cmd.seat)) continue;

    next.roads[ek] = cmd.seat;
    events.push({ type: 'ROAD_BUILT', player: cmd.seat, edge: ek });
  }

  return { ok: true, state: next, events };
}

/** 掷出 7 后移动强盗（掷骰者执行，不消耗发展卡） */
export function moveRobber(board: Board, state: GameState, seat: number, tile: string, stealFrom?: number): ApplyResult {
  if (state.phase !== 'play') return { ok: false, reason: 'WRONG_PHASE' };
  if (seat !== state.current) return { ok: false, reason: 'NOT_YOUR_TURN' };
  // 这条命令只服务于「掷 7 结算」：平时移强盗必须打骑士卡，不能凭空移动并偷牌
  if (!state.pendingRobber) return { ok: false, reason: 'ROBBER_NOT_PENDING' };
  if (Object.keys(state.pendingDiscards).length > 0) return { ok: false, reason: 'DISCARD_PENDING' };
  if (!board.geo.tiles[tile]) return { ok: false, reason: 'UNKNOWN_TILE' };
  if (tile === state.robberTile) return { ok: false, reason: 'ROBBER_SAME_TILE' };

  const next = structuredClone(state);
  const from = next.robberTile;
  next.robberTile = tile;
  next.pendingRobber = false;

  const events: GameEvent[] = [{ type: 'ROBBER_MOVED', player: seat, from, to: tile }];

  if (stealFrom !== undefined && stealFrom !== seat) {
    const victim = next.players[stealFrom];
    if (victim && hasBuildingAdjacent(board, next, tile, stealFrom)) {
      const gained = stealRandom(victim);
      if (gained) {
        victim.resources[gained] -= 1;
        next.players[seat]!.resources[gained] += 1;
        events.push({ type: 'CARD_STOLEN', thief: seat, victim: stealFrom });
      }
    }
  }

  return { ok: true, state: next, events };
}
