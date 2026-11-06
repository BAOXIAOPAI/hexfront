/**
 * 视角投影：把完整状态裁剪成某个玩家能看到的样子。
 *
 * 铁律：别人的手牌内容、发展卡内容，永远不进入视图对象。
 * 需要显示时只给数量，由引擎计算好。
 */

import type { Board, GameState, PortSlot } from '../state.js';
import type { Building, PlayerColor, ResourceCount } from '../types.js';
import type { DevCardEntry } from '../state.js';
import { scoreOf, allScores } from './score.js';
import { RESOURCES } from '../types.js';

export interface PublicTile {
  key: string;
  terrain: string;
  number: number | null;
  hasRobber: boolean;
}

export interface PublicPlayer {
  index: number;
  name: string;
  color: PlayerColor;
  /** 手牌张数 —— 可见 */
  handSize: number;
  /** 发展卡张数 —— 可见 */
  devCardCount: number;
  playedKnights: number;
  score: number;
}

export interface PrivatePlayer extends PublicPlayer {
  resources: ResourceCount;
  devCards: DevCardEntry[];
}

/**
 * 掷出 7 后还没弃牌的人。
 *
 * 这是公开信息：弃几张由手牌总数决定，而手牌总数本来就摆在所有人面前；
 * 具体弃掉哪几张则不进视图（那才是隐私）。
 */
export interface PendingDiscard {
  player: number;
  count: number;
}

export interface PlayerView {
  viewer: number;
  phase: GameState['phase'];
  current: number;
  turn: number;
  hasRolled: boolean;
  dice: [number, number] | null;
  winner: number | null;

  tiles: PublicTile[];
  ports: PortSlot[];
  buildings: Record<string, Building>;
  roads: Record<string, number>;
  robberTile: string;

  players: PublicPlayer[];
  me: PrivatePlayer;
  scores: number[];

  longestRoad: { player: number; length: number } | null;
  largestArmy: { player: number; count: number } | null;

  devDeckCount: number;
  setup: GameState['setup'];
  /** 还没弃牌的玩家（掷出 7 后），空数组表示没有弃牌锁 */
  pendingDiscards: PendingDiscard[];
  /** 掷出 7、且全员弃牌已完成，正等掷骰者移动强盗 */
  pendingRobber: boolean;
}

function handSize(res: ResourceCount): number {
  return RESOURCES.reduce((sum, r) => sum + res[r], 0);
}

export function viewFor(board: Board, state: GameState, viewer: number): PlayerView {
  const tiles: PublicTile[] = board.geo.tileKeys.map((key) => {
    const t = state.tiles[key]!;
    return {
      key,
      terrain: t.terrain,
      number: t.number,
      hasRobber: key === state.robberTile,
    };
  });

  const players: PublicPlayer[] = state.players.map((p) => ({
    index: p.index,
    name: p.name,
    color: p.color,
    handSize: handSize(p.resources),
    devCardCount: p.devCards.length,
    playedKnights: p.playedKnights,
    score: scoreOf(state, p.index),
  }));

  const subject = state.players[viewer];
  if (!subject) throw new Error(`无效的观察者: ${viewer}`);

  const me: PrivatePlayer = {
    index: subject.index,
    name: subject.name,
    color: subject.color,
    handSize: handSize(subject.resources),
    devCardCount: subject.devCards.length,
    playedKnights: subject.playedKnights,
    score: scoreOf(state, viewer),
    resources: { ...subject.resources },
    devCards: subject.devCards.map((e) => ({ ...e })),
  };

  return {
    viewer,
    phase: state.phase,
    current: state.current,
    turn: state.turn,
    hasRolled: state.hasRolled,
    dice: state.dice ? [state.dice[0], state.dice[1]] : null,
    winner: state.winner,

    tiles,
    ports: state.ports.map((p) => ({ ...p, port: { ...p.port } })),
    buildings: structuredClone(state.buildings),
    roads: { ...state.roads },
    robberTile: state.robberTile,

    players,
    me,
    scores: allScores(state),

    longestRoad: state.longestRoad ? { ...state.longestRoad } : null,
    largestArmy: state.largestArmy ? { ...state.largestArmy } : null,

    devDeckCount: state.devDeck.length,
    setup: state.setup ? { ...state.setup } : null,
    // 只把「谁还欠几张」带出去，弃了哪几种资源不进视图
    pendingDiscards: Object.entries(state.pendingDiscards)
      .map(([seat, count]) => ({ player: Number(seat), count }))
      .sort((a, b) => a.player - b.player),
    pendingRobber: state.pendingRobber,
  };
}

/** 依次生成所有玩家的视角，用于测试隔离性 */
export function allViews(board: Board, state: GameState): PlayerView[] {
  return state.players.map((p) => viewFor(board, state, p.index));
}
