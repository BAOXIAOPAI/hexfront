import type { Board, GameState } from './state.js';
import type { ApplyResult, Command } from './command.js';
import type { GameEvent } from './events.js';
import { placeSettlement } from './rules/setup.js';
import { rollDice, endTurn, discardCards } from './rules/roll.js';
import { buildRoad, buildSettlement, buildCity } from './rules/build.js';
import {
  buyDevCard, playKnight, playMonopoly, playPlenty, playRoadBuilding, moveRobber,
} from './rules/dev.js';
import { recomputeLongestRoad, recomputeLargestArmy, findWinner, scoreOf } from './rules/score.js';
import { tradePlayer, tradeBank, tradePort } from './rules/trade.js';

function dispatch(board: Board, state: GameState, cmd: Command): ApplyResult {
  switch (cmd.type) {
    case 'PLACE_SETTLEMENT':
      return placeSettlement(board, state, cmd);
    case 'ROLL_DICE':
      return rollDice(board, state, cmd);
    case 'BUILD_ROAD':
      return buildRoad(board, state, cmd);
    case 'BUILD_SETTLEMENT':
      return buildSettlement(board, state, cmd);
    case 'BUILD_CITY':
      return buildCity(board, state, cmd);
    case 'BUY_DEV_CARD':
      return buyDevCard(board, state, cmd);
    case 'PLAY_KNIGHT':
      return playKnight(board, state, cmd);
    case 'PLAY_MONOPOLY':
      return playMonopoly(board, state, cmd);
    case 'PLAY_PLENTY':
      return playPlenty(board, state, cmd);
    case 'PLAY_ROAD_BUILDING':
      return playRoadBuilding(board, state, cmd);
    case 'TRADE_PLAYER':
      return tradePlayer(board, state, cmd);
    case 'TRADE_BANK':
      return tradeBank(board, state, cmd);
    case 'TRADE_PORT':
      return tradePort(board, state, cmd);
    case 'DISCARD':
      return discardCards(board, state, cmd);
    case 'MOVE_ROBBER':
      return moveRobber(board, state, cmd.seat, cmd.tile, cmd.stealFrom);
    case 'END_TURN':
      return endTurn(state, cmd.seat);
    default:
      return { ok: false, reason: 'UNKNOWN_COMMAND' };
  }
}

const ROAD_AFFECTING: ReadonlySet<Command['type']> = new Set([
  'BUILD_ROAD', 'BUILD_SETTLEMENT', 'BUILD_CITY', 'PLAY_ROAD_BUILDING',
]);

/** 强盗待移动时仍然禁止的命令；其余（建造/兑换/交易/移动强盗）放行 */
const ROBBER_BLOCKED: ReadonlySet<Command['type']> = new Set([
  'BUY_DEV_CARD',
  'PLAY_KNIGHT',
  'PLAY_MONOPOLY',
  'PLAY_PLENTY',
  'PLAY_ROAD_BUILDING',
  'END_TURN',
]);

/**
 * 引擎唯一入口。纯函数：不修改传入的 state，返回新 state 与事件。
 *
 * 所有命令执行后统一收尾：重算最长路、重算最大军、判定胜负。
 */
export function applyCommand(board: Board, state: GameState, cmd: Command): ApplyResult {
  const discarding = Object.keys(state.pendingDiscards).length > 0;
  // ① 弃牌阶段（R-42 顺序不可颠倒）：全员弃完之前，只接受 DISCARD
  if (discarding && cmd.type !== 'DISCARD') {
    return { ok: false, reason: 'DISCARD_PENDING' };
  }
  // ② 强盗待移动阶段（指南 8.2 已确认的行动矩阵）：
  //    全员弃完后恢复建造 / 银行 / 港口 / 玩家交易，只有发展卡与结束回合继续禁用。
  //    发展卡禁用是为了避免骑士二次移动及其他结算冲突；结束回合仍需完成强盗结算。
  //    这里由引擎裁决，服务端不能只靠前端禁用按钮。
  if (!discarding && state.pendingRobber && ROBBER_BLOCKED.has(cmd.type)) {
    return { ok: false, reason: 'ROBBER_PENDING' };
  }

  const result = dispatch(board, state, cmd);
  if (!result.ok) return result;

  const next = result.state;
  const events = result.events;

  if (ROAD_AFFECTING.has(cmd.type)) {
    const previous = next.longestRoad?.player ?? null;
    recomputeLongestRoad(board, next);
    const holder = next.longestRoad?.player ?? null;
    if (holder !== previous) {
      events.push({
        type: 'LONGEST_ROAD_CHANGED',
        player: holder ?? -1,
        previous,
        length: next.longestRoad?.length ?? 0,
      });
    }
  }

  if (cmd.type === 'PLAY_KNIGHT') {
    const previous = next.largestArmy?.player ?? null;
    recomputeLargestArmy(next);
    const holder = next.largestArmy?.player ?? null;
    if (holder !== previous) {
      events.push({
        type: 'LARGEST_ARMY_CHANGED',
        player: holder ?? -1,
        previous,
        count: next.largestArmy?.count ?? 0,
      });
    }
  }

  if (next.phase === 'play') {
    const winner = findWinner(next);
    if (winner !== null) {
      next.phase = 'ended';
      next.winner = winner;
      events.push({ type: 'GAME_WON', player: winner, score: scoreOf(next, winner) });
    }
  }

  return { ok: true, state: next, events: events as GameEvent[] };
}

export { moveRobber };
