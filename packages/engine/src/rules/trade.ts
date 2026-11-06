/**
 * 交易。
 *
 * 变体要点（V-3 / V-7 / V-4）：
 * - 任意玩家都可以主动与当前玩家交易；非当前玩家之间不能直接交易
 * - 允许零对价（一方给 0 张），这是存牌与赠予牌的前提
 * - 港口可由当前玩家代他人使用（借港），资源从借用者账户进出
 * - 银行无限资源（V-5），不需要检查库存
 */

import type { Board, GameState, PlayerState } from '../state.js';
import type { ApplyResult, Command } from '../command.js';
import type { GameEvent } from '../events.js';
import { RESOURCES, type Resource, type ResourceCount } from '../types.js';

type TradeCmd = Extract<Command, { type: 'TRADE_PLAYER' }>;
type BankCmd = Extract<Command, { type: 'TRADE_BANK' }>;
type PortCmd = Extract<Command, { type: 'PORT_TRANSFER' }>;

function total(count: Partial<ResourceCount> | undefined): number {
  if (!count) return 0;
  let sum = 0;
  for (const r of RESOURCES) sum += count[r] ?? 0;
  return sum;
}

/**
 * 某玩家对某种资源的最优兑换比例。
 * 拥有通用港 3:1，拥有对应专用港 2:1，都没有则 4:1。
 */
export function portRatioFor(board: Board, state: GameState, player: number, resource: Resource): number {
  let ratio = 4;

  for (const slot of state.ports) {
    const edge = board.geo.edges[slot.edge];
    if (!edge) continue;

    const ownsHere =
      state.buildings[edge.a]?.owner === player ||
      state.buildings[edge.b]?.owner === player;
    if (!ownsHere) continue;

    if (slot.port.kind === 'generic') {
      ratio = Math.min(ratio, 3);
    } else if (slot.port.resource === resource) {
      ratio = Math.min(ratio, 2);
    }
  }

  return ratio;
}

/** 玩家当前可用的最优港口比例（用于 UI 提示） */
export function bestPortRatios(board: Board, state: GameState, player: number): Record<Resource, number> {
  const out = {} as Record<Resource, number>;
  for (const r of RESOURCES) out[r] = portRatioFor(board, state, player, r);
  return out;
}

/**
 * 玩家之间交易。
 *
 * `give` 是发起方付出的，`get` 是发起方收到的。
 * 允许任意一方为空 —— 存牌和赠予牌都是零对价。
 */
export function tradePlayer(board: Board, state: GameState, cmd: TradeCmd): ApplyResult {
  if (state.phase !== 'play') return { ok: false, reason: 'WRONG_PHASE' };

  if (cmd.seat === cmd.withPlayer) return { ok: false, reason: 'SAME_TARGET' };

  // 至少有一方必须是当前玩家
  if (cmd.seat !== state.current && cmd.withPlayer !== state.current) {
    return { ok: false, reason: 'NOT_INVOLVED' };
  }

  const a = state.players[cmd.seat];
  const b = state.players[cmd.withPlayer];
  if (!a || !b) return { ok: false, reason: 'INVALID_TARGET' };

  if (total(cmd.give) === 0 && total(cmd.get) === 0) {
    return { ok: false, reason: 'EMPTY_TRADE' };
  }

  // 用净额校验，避免同一资源既收又给时出现中间负数
  for (const r of RESOURCES) {
    const deltaA = (cmd.get[r] ?? 0) - (cmd.give[r] ?? 0);
    const deltaB = -deltaA;
    if (a.resources[r] + deltaA < 0) return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };
    if (b.resources[r] + deltaB < 0) return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };
  }

  const next = structuredClone(state);
  const na = next.players[cmd.seat]!;
  const nb = next.players[cmd.withPlayer]!;

  for (const r of RESOURCES) {
    const deltaA = (cmd.get[r] ?? 0) - (cmd.give[r] ?? 0);
    na.resources[r] += deltaA;
    nb.resources[r] -= deltaA;
  }

  const events: GameEvent[] = [
    {
      type: 'TRADE_COMPLETED',
      a: cmd.seat,
      b: cmd.withPlayer,
      aGives: cmd.give,
      bGives: cmd.get,
    },
  ];

  return { ok: true, state: next, events };
}

/** 银行 / 港口兑换。仅当前玩家可执行。 */
export function tradeBank(board: Board, state: GameState, cmd: BankCmd): ApplyResult {
  if (state.phase !== 'play') return { ok: false, reason: 'WRONG_PHASE' };
  if (cmd.seat !== state.current) return { ok: false, reason: 'NOT_YOUR_TURN' };
  if (cmd.give === cmd.get) return { ok: false, reason: 'SAME_TARGET' };

  const player = state.players[cmd.seat];
  if (!player) return { ok: false, reason: 'INVALID_TARGET' };

  const ratio = portRatioFor(board, state, cmd.seat, cmd.give);
  if (player.resources[cmd.give] < ratio) {
    return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };
  }

  const next = structuredClone(state);
  const p = next.players[cmd.seat]!;
  p.resources[cmd.give] -= ratio;
  p.resources[cmd.get] += 1;

  const events: GameEvent[] = [
    { type: 'BANK_TRADED', player: cmd.seat, give: cmd.give, get: cmd.get, ratio },
  ];
  return { ok: true, state: next, events };
}

/**
 * 借港代换（V-4）。
 *
 * 当前玩家用自己的港口比例，替另一位玩家兑换。
 * 资源从借用者账户扣除、产物进借用者账户，港口主人不参与资源流转。
 * 租金由玩家在语音里自行协商，系统不介入。
 */
export function portTransfer(board: Board, state: GameState, cmd: PortCmd): ApplyResult {
  if (state.phase !== 'play') return { ok: false, reason: 'WRONG_PHASE' };
  if (cmd.seat !== state.current) return { ok: false, reason: 'NOT_YOUR_TURN' };
  if (cmd.give === cmd.get) return { ok: false, reason: 'SAME_TARGET' };

  const beneficiary = state.players[cmd.beneficiary];
  if (!beneficiary || cmd.beneficiary === cmd.seat) {
    return { ok: false, reason: 'INVALID_TARGET' };
  }

  const ratio = portRatioFor(board, state, cmd.seat, cmd.give);
  if (ratio === 4) return { ok: false, reason: 'NO_PORT' };

  if (beneficiary.resources[cmd.give] < ratio) {
    return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };
  }

  const next = structuredClone(state);
  const ben = next.players[cmd.beneficiary]!;
  ben.resources[cmd.give] -= ratio;
  ben.resources[cmd.get] += 1;

  const events: GameEvent[] = [
    {
      type: 'PORT_TRANSFERRED',
      executor: cmd.seat,
      beneficiary: cmd.beneficiary,
      give: cmd.give,
      get: cmd.get,
      ratio,
    },
  ];
  return { ok: true, state: next, events };
}

/** 资源总量，供测试与统计使用 */
export function handSize(player: PlayerState): number {
  return RESOURCES.reduce((sum, r) => sum + player.resources[r], 0);
}
