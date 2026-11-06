/**
 * 掷出 7 之后的「弃牌」与「产出高亮」。
 *
 * 和 placement.ts 一样：这里算的只是界面上的提示与选择，
 * 真正的裁决（张数对不对、持有够不够）一律在服务端 applyCommand。
 * 之所以能在前端算，是因为「谁该弃几张」已经在视图里（pendingDiscards），
 * 属于公开信息；弃哪几张是玩家自己的选择，前端只负责把它凑成一张牌单。
 */

import type { PlayerView, Resource, ResourceCount } from '@hexfront/engine';

/** 面板里的固定顺序：与手牌区一致，玩家不用重新找 */
export const DISCARD_ORDER: Resource[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

export interface PendingSeat {
  seat: number;
  count: number;
}

export interface DiscardInfo {
  /** 我需要弃几张；0 表示我不用弃 */
  need: number;
  /** 是不是该我弃 */
  mine: boolean;
  /** 其他人里还没弃的（我不用管他们弃什么，只要等） */
  waiting: PendingSeat[];
  /** 全场还剩几个人要弃 */
  total: number;
}

/** 没有弃牌锁时返回 null —— 调用方据此彻底收起面板 */
export function discardInfo(view: PlayerView): DiscardInfo | null {
  const list = view.pendingDiscards;
  if (!list || list.length === 0) return null;

  const mineEntry = list.find((p) => p.player === view.viewer);
  const waiting = list
    .filter((p) => p.player !== view.viewer)
    .map((p) => ({ seat: p.player, count: p.count }));

  return {
    need: mineEntry?.count ?? 0,
    mine: mineEntry !== undefined,
    waiting,
    total: list.length,
  };
}

/** 待弃的牌单：资源 → 张数，没选的就是 0 */
export type Pick = Partial<Record<Resource, number>>;

export function emptyPick(): Pick {
  return {};
}

export function pickedTotal(pick: Pick): number {
  let sum = 0;
  for (const r of DISCARD_ORDER) sum += pick[r] ?? 0;
  return sum;
}

/** 是否恰好凑够 need 张，且每种都不超过手里的数量 */
export function canConfirm(pick: Pick, need: number, hand: ResourceCount): boolean {
  if (need <= 0) return false;
  if (pickedTotal(pick) !== need) return false;
  return DISCARD_ORDER.every((r) => (pick[r] ?? 0) <= (hand[r] ?? 0));
}

/**
 * 加减一张。两道闸：不能超过持有量，也不能让总数超过 need。
 * 返回新对象（不改传入的 pick），减到 0 的键直接删掉，牌单保持干净。
 */
export function adjustPick(
  pick: Pick,
  res: Resource,
  delta: number,
  hand: ResourceCount,
  need: number,
): Pick {
  const held = hand[res] ?? 0;
  const current = pick[res] ?? 0;
  const others = pickedTotal(pick) - current;

  let next = current + delta;
  if (next < 0) next = 0;
  if (next > held) next = held;
  // 剩余额度：别人已经占掉的部分不能再给这一种
  const room = Math.max(0, need - others);
  if (next > room) next = room;

  const out: Pick = { ...pick };
  if (next === 0) delete out[res];
  else out[res] = next;
  return out;
}

/** 还要再选几张（面板上的「已选 3 / 5」就是它） */
export function pickRemaining(pick: Pick, need: number): number {
  return Math.max(0, need - pickedTotal(pick));
}

/**
 * 本次掷骰真正产出资源的地块：点数对得上，且强盗不在上面。
 *
 * 这是公开信息（点数与强盗位置人人可见），所以可以前端算；
 * 谁收到了几张由服务端在 RESOURCES_GAINED 事件里说，不在这里推。
 */
export function productionTiles(view: PlayerView, sum: number): string[] {
  if (sum < 2 || sum > 12 || sum === 7) return [];
  return view.tiles.filter((t) => t.number === sum && !t.hasRobber).map((t) => t.key);
}

/** 视图里当前这次掷骰的高亮地块；还没掷过或掷出 7 时为空 */
export function rollHighlight(view: PlayerView): string[] {
  if (!view.dice) return [];
  return productionTiles(view, view.dice[0] + view.dice[1]);
}
