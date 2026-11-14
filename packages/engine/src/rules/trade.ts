/**
 * 交易。
 *
 * 变体要点（V-3 / V-7 / V-5）：
 * - 任意玩家都可以主动与当前玩家交易；非当前玩家之间不能直接交易
 * - 允许零对价（一方给 0 张），这是存牌与赠予牌的前提
 * - 银行无限资源（V-5），不需要检查库存
 *
 * 文档 24（F5，覆盖历史相反设定）：
 * - 银行严格 4 张同类换 1 张指定资源，**不因玩家拥有港口自动降比例**。
 * - 港口兑换是独立动作：只认「港口边端点上的己方村庄/城市」判所有权，
 *   道路连接不算拥有。通用港任意混选 3 张、专用港对应资源 2:1。
 * - 删除「借港代换」PORT_TRANSFER：系统不自动扣别人资源、不保障返还。
 *   借港由玩家自行「交易给当前玩家 → 用自有港口兑换 → 再交易回去」完成，
 *   三步各自独立、自愿。
 * - 「收到资源」与「给出袋里的某资源同类」时：扣费前按**原始给出袋**逐项
 *   校验持有量足额，绝不允许用本次刚收到的那张抵扣本次成本（用户 2026-11-14
 *   确认的 F5 边界：严格足额、禁止同类抵扣）。
 */

import type { Board, GameState, PlayerState } from '../state.js';
import type { ApplyResult, Command } from '../command.js';
import type { GameEvent } from '../events.js';
import { RESOURCES, type Resource, type ResourceCount } from '../types.js';

type TradeCmd = Extract<Command, { type: 'TRADE_PLAYER' }>;
type BankCmd = Extract<Command, { type: 'TRADE_BANK' }>;
type PortCmd = Extract<Command, { type: 'TRADE_PORT' }>;

/** 文档 24：银行同类兑换比例，固定 4:1，不受港口影响 */
export const BANK_RATIO = 4;
/** 通用港 3:1（可混合任意资源） */
export const GENERIC_PORT_RATIO = 3;
/** 专用港 2:1（仅限对应资源） */
export const SPECIFIC_PORT_RATIO = 2;

function total(count: Partial<ResourceCount> | undefined): number {
  if (!count) return 0;
  let sum = 0;
  for (const r of RESOURCES) sum += count[r] ?? 0;
  return sum;
}

/** 客户端传来的资源袋不可信：只留五种资源、非负整数；负/小数/非法键一律拒绝 */
function cleanBag(raw: Partial<ResourceCount>): Partial<ResourceCount> | null {
  const out: Partial<ResourceCount> = {};
  for (const r of RESOURCES) {
    const n = raw[r];
    if (n === undefined || n === 0) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
    out[r] = n;
  }
  return out;
}

/**
 * 港口所有权：依据港口边两个端点上的**己方村庄或城市**判定。
 * 道路连接不算拥有（state.roads 完全不参与）。
 * 返回 port 定义；不属于操作者则返回 null。
 */
export function ownedPort(
  board: Board, state: GameState, player: number, portEdge: string,
): { kind: 'generic' } | { kind: 'specific'; resource: Resource } | null {
  const slot = state.ports.find((p) => p.edge === portEdge);
  if (!slot) return null;
  const edge = board.geo.edges[portEdge];
  if (!edge) return null;
  const ownsHere = [edge.a, edge.b].some((vk) => {
    const b = state.buildings[vk];
    return !!b && b.owner === player;   // 村庄或城市都算，道路不算
  });
  if (!ownsHere) return null;
  return slot.port.kind === 'generic'
    ? { kind: 'generic' }
    : { kind: 'specific', resource: slot.port.resource };
}

/** 玩家拥有的全部港口（供 UI 展示「我的港口」；最终仍由服务端裁决） */
export function ownedPorts(
  board: Board, state: GameState, player: number,
): { edge: string; port: { kind: 'generic' } | { kind: 'specific'; resource: Resource } }[] {
  const out: { edge: string; port: { kind: 'generic' } | { kind: 'specific'; resource: Resource } }[] = [];
  for (const slot of state.ports) {
    const p = ownedPort(board, state, player, slot.edge);
    if (p) out.push({ edge: slot.edge, port: p });
  }
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

/** 银行兑换。仅当前玩家、严格 4 张同类 → 1 张指定资源，不因港口降比例。 */
export function tradeBank(board: Board, state: GameState, cmd: BankCmd): ApplyResult {
  void board;   // 银行规则不读棋盘（不自动用港口比例）
  if (state.phase !== 'play') return { ok: false, reason: 'WRONG_PHASE' };
  if (cmd.seat !== state.current) return { ok: false, reason: 'NOT_YOUR_TURN' };
  if (cmd.give === cmd.get) return { ok: false, reason: 'SAME_TARGET' };
  if (!RESOURCES.includes(cmd.give) || !RESOURCES.includes(cmd.get)) {
    return { ok: false, reason: 'INVALID_TARGET' };
  }

  const player = state.players[cmd.seat];
  if (!player) return { ok: false, reason: 'INVALID_TARGET' };

  // 严格 4 张同类，由服务端按请求校验，不信前端数字
  if (player.resources[cmd.give] < BANK_RATIO) {
    return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };
  }

  const next = structuredClone(state);
  const p = next.players[cmd.seat]!;
  p.resources[cmd.give] -= BANK_RATIO;
  p.resources[cmd.get] += 1;

  const events: GameEvent[] = [
    { type: 'BANK_TRADED', player: cmd.seat, give: cmd.give, get: cmd.get, ratio: BANK_RATIO },
  ];
  return { ok: true, state: next, events };
}

/**
 * 自有港口兑换。仅当前玩家、仅弃牌期外可用（engine.ts 的前置锁统一保证）。
 *
 * - 通用港：give 任意组合恰好 3 张（可 1木1砖1羊 这类混合）。
 * - 专用港：give 只能是对应资源、恰好 2 张。
 * - 所有权：港口边端点上的己方村庄/城市，道路不算。
 * - 「收到资源与给出袋部分同类」：先按原始给出袋校验足额，再扣费、再入账；
 *   不允许用本次收到的资源抵扣本次成本。
 */
export function tradePort(board: Board, state: GameState, cmd: PortCmd): ApplyResult {
  if (state.phase !== 'play') return { ok: false, reason: 'WRONG_PHASE' };
  if (cmd.seat !== state.current) return { ok: false, reason: 'NOT_YOUR_TURN' };
  if (!RESOURCES.includes(cmd.get)) return { ok: false, reason: 'INVALID_TARGET' };

  const player = state.players[cmd.seat];
  if (!player) return { ok: false, reason: 'INVALID_TARGET' };

  const give = cleanBag(cmd.give ?? {});
  if (!give) return { ok: false, reason: 'BAD_PORT' };

  const port = ownedPort(board, state, cmd.seat, cmd.port);
  if (!port) return { ok: false, reason: 'NO_PORT' };

  const need = port.kind === 'generic' ? GENERIC_PORT_RATIO : SPECIFIC_PORT_RATIO;
  if (total(give) !== need) return { ok: false, reason: 'BAD_PORT' };
  if (port.kind === 'specific') {
    // 专用港：给出袋里只允许对应资源这一种
    const keys = RESOURCES.filter((r) => (give[r] ?? 0) > 0);
    if (keys.length !== 1 || keys[0] !== port.resource) return { ok: false, reason: 'BAD_PORT' };
  }

  // 扣费前按**原始给出袋**逐项校验持有量足额（禁止用本次收到的资源抵扣成本）
  for (const r of RESOURCES) {
    if (player.resources[r] < (give[r] ?? 0)) {
      return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };
    }
  }

  const next = structuredClone(state);
  const p = next.players[cmd.seat]!;
  for (const r of RESOURCES) p.resources[r] -= give[r] ?? 0;
  p.resources[cmd.get] += 1;

  const events: GameEvent[] = [
    {
      type: 'PORT_TRADED', player: cmd.seat, port: cmd.port,
      give, get: cmd.get, ratio: need,
    },
  ];
  return { ok: true, state: next, events };
}

/** 资源总量，供测试与统计使用 */
export function handSize(player: PlayerState): number {
  return RESOURCES.reduce((sum, r) => sum + player.resources[r], 0);
}
