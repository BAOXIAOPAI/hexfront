/**
 * 事件 → 人话。
 *
 * 事件是服务端裁决后的既成事实，这里只负责把它写成一行日志，
 * 不做任何规则推断（推断就意味着前端在替引擎思考）。
 */

import type { GameEvent, PlayerView, Resource, ResourceCount } from '@hexfront/engine';

const RES_NAME: Record<Resource, string> = { wood: '木', brick: '砖', sheep: '羊', wheat: '麦', ore: '矿' };

const DEV_NAME: Record<string, string> = {
  knight: '骑士',
  victory: '胜利点',
  monopoly: '垄断',
  plenty: '丰饶',
  roadbuilding: '筑路',
};

export function fmtResources(res: Partial<ResourceCount> | undefined): string {
  if (!res) return '';
  const parts: string[] = [];
  for (const key of ['wood', 'brick', 'sheep', 'wheat', 'ore'] as const) {
    const n = res[key] ?? 0;
    if (n > 0) parts.push(`${RES_NAME[key]}${n}`);
  }
  return parts.join(' ') || '无';
}

export function playerName(view: PlayerView, index: number): string {
  if (index === view.viewer) return '你';
  return view.players[index]?.name ?? `玩家 ${index + 1}`;
}

export function devCardName(card: string): string {
  return DEV_NAME[card] ?? card;
}

export function describeEvent(ev: GameEvent, view: PlayerView): string | null {
  switch (ev.type) {
    case 'GAME_STARTED':
      return `开局 · ${ev.players.map((p) => p.name).join('、')}`;
    case 'SETUP_PLACED':
      return `${playerName(view, ev.player)} 放下第 ${ev.round} 轮的村庄`;
    case 'SETUP_COMPLETED':
      return `摆位结束，${playerName(view, ev.firstPlayer)} 先手`;
    case 'TURN_BEGUN':
      return `第 ${ev.turn} 回合 · ${playerName(view, ev.player)}`;
    case 'DICE_ROLLED':
      return `${playerName(view, ev.player)} 掷出 ${ev.dice[0]}+${ev.dice[1]} = ${ev.sum}`;
    case 'RESOURCES_GAINED':
      return `${playerName(view, ev.player)} 收 ${fmtResources(ev.resources)}`;
    case 'SEVEN_ROLLED':
      return `${playerName(view, ev.player)} 掷出 7，强盗出动`;
    case 'DISCARD_REQUIRED':
      return `${ev.requirements.map((r) => `${playerName(view, r.player)} 弃 ${r.count}`).join('、')}`;
    case 'CARDS_DISCARDED':
      return `${playerName(view, ev.player)} 弃掉 ${ev.count} 张牌`;
    case 'ROAD_BUILT':
      return `${playerName(view, ev.player)} 修了一条路`;
    case 'SETTLEMENT_BUILT':
      return `${playerName(view, ev.player)} 建了村庄`;
    case 'CITY_BUILT':
      return `${playerName(view, ev.player)} 升级为城市`;
    case 'RESOURCES_SPENT':
      return `${playerName(view, ev.player)} 付出 ${fmtResources(ev.resources)}`;
    case 'ROBBER_MOVED':
      return `${playerName(view, ev.player)} 移动强盗`;
    case 'CARD_STOLEN':
      return `${playerName(view, ev.thief)} 从 ${playerName(view, ev.victim)} 手里抽走一张`;
    case 'DEV_CARD_BOUGHT':
      return `${playerName(view, ev.player)} 买了 ${ev.count} 张发展卡`;
    case 'DEV_CARD_PLAYED':
      return `${playerName(view, ev.player)} 打出 ${devCardName(ev.card)}`;
    case 'MONOPOLY_RESOLVED':
      return `${playerName(view, ev.player)} 垄断 ${RES_NAME[ev.resource]}`;
    case 'LONGEST_ROAD_CHANGED':
      return ev.player < 0 ? '最长路易主：无人持有' : `${playerName(view, ev.player)} 拿到最长路（${ev.length}）`;
    case 'LARGEST_ARMY_CHANGED':
      return ev.player < 0 ? '最大军易主：无人持有' : `${playerName(view, ev.player)} 拿到最大军（${ev.count}）`;
    case 'TRADE_COMPLETED':
      return `${playerName(view, ev.a)} 用 ${fmtResources(ev.aGives)} 换 ${playerName(view, ev.b)} 的 ${fmtResources(ev.bGives)}`;
    case 'BANK_TRADED':
      return `${playerName(view, ev.player)} 与银行 ${ev.ratio}:1 兑换`;
    case 'PORT_TRANSFERRED':
      return `${playerName(view, ev.executor)} 借港替 ${playerName(view, ev.beneficiary)} 兑换`;
    case 'GAME_WON':
      return `${playerName(view, ev.player)} 以 ${ev.score} 分获胜`;
    case 'TURN_ENDED':
      return null;
    default:
      return null;
  }
}
