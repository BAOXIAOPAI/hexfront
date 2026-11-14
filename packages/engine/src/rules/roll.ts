/**
 * 掷骰与资源产出。
 *
 * 变体说明：
 * - 银行无限资源（V-5），因此不存在「库存不足全有或全无」的裁决
 * - 掷骰时机自由（V-1），这里只校验「本回合尚未掷过」
 */

import type { Board, GameState } from '../state.js';
import { discardCount, handSize } from '../state.js';
import type { ApplyResult, Command } from '../command.js';
import type { GameEvent } from '../events.js';
import { RESOURCES, type Resource, type ResourceCount } from '../types.js';
import { canAfford } from './build.js';

type RollCmd = Extract<Command, { type: 'ROLL_DICE' }>;
type DiscardCmd = Extract<Command, { type: 'DISCARD' }>;

export function randomDice(): [number, number] {
  const d = () => 1 + Math.floor(Math.random() * 6);
  return [d(), d()];
}

export function rollDice(board: Board, state: GameState, cmd: RollCmd): ApplyResult {
  if (state.phase !== 'play') return { ok: false, reason: 'WRONG_PHASE' };
  if (cmd.seat !== state.current) return { ok: false, reason: 'NOT_YOUR_TURN' };
  if (state.hasRolled) return { ok: false, reason: 'ALREADY_ROLLED' };

  const dice = cmd.dice ?? randomDice();
  if (dice[0] < 1 || dice[0] > 6 || dice[1] < 1 || dice[1] > 6) {
    return { ok: false, reason: 'BAD_DICE' };
  }

  const next = structuredClone(state);
  const [d1, d2] = dice;
  const sum = d1 + d2;

  next.hasRolled = true;
  next.dice = [d1, d2];

  const events: GameEvent[] = [{ type: 'DICE_ROLLED', player: cmd.seat, dice: [d1, d2], sum }];

  if (sum === 7) {
    const requirements: { player: number; count: number }[] = [];
    const pending: Record<number, number> = {};

    for (const p of next.players) {
      const count = discardCount(handSize(p));
      if (count > 0) {
        pending[p.index] = count;
        requirements.push({ player: p.index, count });
      }
    }
    next.pendingDiscards = pending;
    // R-42：弃牌全员完成后，掷骰者必须移动强盗（R-47 无人需弃牌则直接进入此步）
    next.pendingRobber = true;

    events.push({ type: 'SEVEN_ROLLED', player: cmd.seat });
    if (requirements.length > 0) {
      events.push({ type: 'DISCARD_REQUIRED', requirements });
    }
    return { ok: true, state: next, events };
  }

  const grants = new Map<number, Partial<ResourceCount>>();

  for (const vertexKey of Object.keys(next.buildings)) {
    const building = next.buildings[vertexKey]!;
    const vertex = board.geo.vertices[vertexKey];
    if (!vertex) continue;

    for (const tileKey of vertex.tiles) {
      const tile = next.tiles[tileKey]!;
      if (tile.number !== sum) continue;
      if (tileKey === next.robberTile) continue;

      const res = tile.terrain as Resource;
      const amount = building.city ? 2 : 1;

      const player = next.players[building.owner]!;
      player.resources[res] += amount;

      const g = grants.get(building.owner) ?? {};
      g[res] = (g[res] ?? 0) + amount;
      grants.set(building.owner, g);
    }
  }

  for (const [owner, resources] of grants) {
    events.push({ type: 'RESOURCES_GAINED', player: owner, resources });
  }

  return { ok: true, state: next, events };
}

/**
 * 掷出 7 后弃牌。
 * 张数必须正好等于要求值（一半向上取整），弃哪几种由玩家自选（V-9）。
 */
export function discardCards(board: Board, state: GameState, cmd: DiscardCmd): ApplyResult {
  if (state.phase !== 'play') return { ok: false, reason: 'WRONG_PHASE' };

  const need = state.pendingDiscards[cmd.seat];
  if (need === undefined) return { ok: false, reason: 'NOTHING_TO_DISCARD' };

  let given = 0;
  for (const r of RESOURCES) given += cmd.resources[r] ?? 0;

  if (given !== need) {
    return { ok: false, reason: 'WRONG_DISCARD_COUNT', detail: `需要 ${need} 张，提交了 ${given} 张` };
  }

  const player = state.players[cmd.seat];
  if (!player) return { ok: false, reason: 'INVALID_TARGET' };
  if (!canAfford(player, cmd.resources)) return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };

  const next = structuredClone(state);
  const p = next.players[cmd.seat]!;
  for (const r of RESOURCES) p.resources[r] -= cmd.resources[r] ?? 0;
  delete next.pendingDiscards[cmd.seat];

  return {
    ok: true,
    state: next,
    events: [{ type: 'CARDS_DISCARDED', player: cmd.seat, count: given }],
  };
}

/** 结束回合。变体允许任意时刻掷骰，但结束回合前必须已经掷过。 */export function endTurn(state: GameState, seat: number): ApplyResult {
  if (state.phase !== 'play') return { ok: false, reason: 'WRONG_PHASE' };
  if (seat !== state.current) return { ok: false, reason: 'NOT_YOUR_TURN' };
  if (!state.hasRolled) return { ok: false, reason: 'NOT_YET_ROLLED' };

  const next = structuredClone(state);
  const ending = next.current;

  // 文档 23 L-4：正常回合沿 actionOrder 循环，而不是 current+1 取模。
  // actionOrder 缺失时退化为座位自然顺序，保持老行为。
  const order = next.actionOrder.length === next.players.length
    ? next.actionOrder
    : Array.from({ length: next.players.length }, (_, i) => i);
  const pos = order.indexOf(ending);
  next.current = order[(pos + 1) % order.length] ?? order[0] ?? 0;
  next.hasRolled = false;
  next.dice = null;
  next.turn += 1;

  // 回合结束：本回合买入的卡下回合起可用
  for (const p of next.players) {
    p.devPlayedThisTurn = false;
    for (const entry of p.devCards) entry.playable = true;
  }

  return {
    ok: true,
    state: next,
    events: [
      { type: 'TURN_ENDED', player: ending },
      { type: 'TURN_BEGUN', player: next.current, turn: next.turn },
    ],
  };
}
