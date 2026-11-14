/**
 * 游戏状态。
 *
 * 约定：state 是纯数据（可直接 structuredClone），
 * 几何与地图定义放在 Board 里，作为常量随调用传入，避免每次克隆。
 */

import { buildGeometry, boundaryEdges, type Edge, type Geometry, type MapSpec, type Tile, type Vertex } from './board.js';
import {
  emptyResources,
  RESOURCES,
  type Building,
  type DevCard,
  type PlayerColor,
  type Port,
  type ResourceCount,
  type Terrain,
} from './types.js';

export interface TileState {
  key: string;
  terrain: Terrain;
  number: number | null;
}

export interface DevCardEntry {
  card: DevCard;
  /** 当回合买入的卡为 false，下回合起可用 */
  playable: boolean;
}

export interface PlayerState {
  index: number;
  name: string;
  color: PlayerColor;
  resources: ResourceCount;
  /** 未打出的发展卡（含胜利点） */
  devCards: DevCardEntry[];
  playedKnights: number;
  /** 本回合是否已打出过发展卡（每回合限 1 张） */
  devPlayedThisTurn: boolean;
}

export interface PortSlot {
  edge: string;
  port: Port;
}

export interface SetupProgress {
  /** 已完成的放置次数 0..(players*2-1) */
  step: number;
  /** 当前该谁放 */
  seat: number;
}

export type Phase = 'setup' | 'play' | 'ended';

export interface GameState {
  mapId: string;
  tiles: Record<string, TileState>;
  ports: PortSlot[];
  buildings: Record<string, Building>;
  /** edgeKey -> 玩家序号 */
  roads: Record<string, number>;
  robberTile: string;

  players: PlayerState[];
  current: number;
  phase: Phase;
  hasRolled: boolean;
  dice: [number, number] | null;
  devDeck: DevCard[];
  turn: number;
  setup: SetupProgress | null;
  winner: number | null;
  longestRoad: { player: number; length: number } | null;
  largestArmy: { player: number; count: number } | null;
  /** 掷出 7 后待弃牌的玩家 -> 需弃张数。全部清空后才能移动强盗 */
  pendingDiscards: Record<number, number>;
  /**
   * 掷出 7 后「尚未移动强盗」的结算锁（R-42：弃牌 → 移动强盗 → 抽牌）。
   * 为 true 时只放行 MOVE_ROBBER，MOVE_ROBBER 成功后清除；结束回合前必须清掉。
   */
  pendingRobber: boolean;
  /** 房间级规则：第二轮摆位时是否发相邻地块的起始资源。默认开启 */
  setupGrant: boolean;
  /**
   * 文档 23 L-4：开局前房主确认的行动顺序，数组元素是稳定的 seat。
   * 选地 = actionOrder + reverse(actionOrder)；正常回合沿此顺序循环。
   * 不传时退化为 [0,1,...,n-1]，老调用方零改动。
   */
  actionOrder: number[];
}

export interface Board {
  spec: MapSpec;
  geo: Geometry;
}

// ---------------------------------------------------------------------------
// 港口
// ---------------------------------------------------------------------------

/** 固定顺序：通用港与专用港交替，与视觉稿一致 */
const PORT_PATTERN: Port[] = [
  { kind: 'generic' },
  { kind: 'specific', resource: 'wood' },
  { kind: 'generic' },
  { kind: 'specific', resource: 'brick' },
  { kind: 'generic' },
  { kind: 'specific', resource: 'sheep' },
  { kind: 'generic' },
  { kind: 'specific', resource: 'wheat' },
  { kind: 'specific', resource: 'ore' },
];

/**
 * 沿地图外圈均匀取 9 条边界边作为港口位。
 * 纯几何推导，不硬编码，因此在 19 / 30 / 37 格上都能自适应。
 */
export function computePorts(geo: Geometry, count = 9): PortSlot[] {
  const boundary = boundaryEdges(geo);
  const withAngle = boundary.map((ek) => {
    const e = geo.edges[ek]!;
    const va = geo.vertices[e.a]!;
    const vb = geo.vertices[e.b]!;
    const mx = (va.x + vb.x) / 2;
    const my = (va.y + vb.y) / 2;
    return { ek, angle: Math.atan2(my, mx) };
  });
  withAngle.sort((p, q) => p.angle - q.angle);

  const slots: PortSlot[] = [];
  for (let k = 0; k < count; k++) {
    const pick = withAngle[Math.round((k * withAngle.length) / count) % withAngle.length]!;
    slots.push({ edge: pick.ek, port: PORT_PATTERN[k % PORT_PATTERN.length]! });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

export function buildBoard(spec: MapSpec): Board {
  return { spec, geo: buildGeometry(spec.rows) };
}

export interface CreateGameOptions {
  /** 第二轮摆位时是否发相邻地块的起始资源，默认开启 */
  setupGrant?: boolean;
  /**
   * 行动顺序（seat 的排列）。不传时按座位自然顺序。
   * 必须是不重不漏的 0..n-1 排列，否则抛错（避免静默串座）。
   */
  actionOrder?: number[];
}

/**
 * 开局创建。老调用方 `createGame(board, names, colors, setupGrant)` 零改动：
 * 第 4 参数仍可为 boolean，等价于 `{ setupGrant }`。
 */
export function createGame(
  board: Board,
  playerNames: string[],
  colors: PlayerColor[],
  setupGrantOrOptions: boolean | CreateGameOptions = true,
): GameState {
  const opts: CreateGameOptions = typeof setupGrantOrOptions === 'boolean'
    ? { setupGrant: setupGrantOrOptions }
    : setupGrantOrOptions;
  const setupGrant = opts.setupGrant ?? true;
  const n = playerNames.length;
  const actionOrder = opts.actionOrder
    ? validateActionOrder(opts.actionOrder, n)
    : Array.from({ length: n }, (_, i) => i);
  const { geo, spec } = board;

  const tiles: Record<string, TileState> = {};
  for (const tk of geo.tileKeys) {
    const def = spec.tiles[tk];
    if (!def) throw new Error(`地图缺少地块定义: ${tk}`);
    tiles[tk] = { key: tk, terrain: def.terrain, number: def.number };
  }

  const desert = geo.tileKeys.find((tk) => tiles[tk]!.terrain === 'desert');
  // 生成器/快照可指定港口与强盗起点（文档 23 L-2/L-0 B）；不指定则沿用默认推导。
  // 强盗起点必须来自当前地图的沙漠，否则回退，绝不落到生产地块上。
  const specifiedRobber = spec.robberTile && tiles[spec.robberTile]?.terrain === 'desert'
    ? spec.robberTile
    : undefined;

  return {
    mapId: spec.id,
    tiles,
    ports: spec.ports ? spec.ports.map((p) => ({ ...p, port: { ...p.port } })) : computePorts(geo),
    buildings: {},
    roads: {},
    robberTile: specifiedRobber ?? desert ?? geo.tileKeys[0]!,

    players: playerNames.map((name, i) => ({
      index: i,
      name,
      color: colors[i] ?? 'red',
      resources: emptyResources(),
      devCards: [],
      playedKnights: 0,
      devPlayedThisTurn: false,
    })),
    current: actionOrder[0] ?? 0,
    phase: 'setup',
    hasRolled: false,
    dice: null,
    devDeck: shuffle(makeDevDeck()),
    turn: 1,
    // 选地第一步由 actionOrder 的第一人开始（文档 23 L-4）
    setup: { step: 0, seat: actionOrder[0] ?? 0 },
    winner: null,
    longestRoad: null,
    largestArmy: null,
    pendingDiscards: {},
    pendingRobber: false,
    setupGrant,
    actionOrder: actionOrder.slice(),
  };
}

/** 校验行动顺序是 0..n-1 的一个排列；非法直接抛错，不静默降级 */
function validateActionOrder(order: number[], n: number): number[] {
  if (order.length !== n) throw new Error('actionOrder 长度与玩家数不符');
  const seen = new Set<number>();
  for (const seat of order) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= n || seen.has(seat)) {
      throw new Error('actionOrder 必须是 0..n-1 的不重复排列');
    }
    seen.add(seat);
  }
  return order.slice();
}

export function shuffle<T>(input: T[]): T[] {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/** 25 张：骑士 14、胜利点 5、垄断 2、丰饶 2、筑路 2 */
export function makeDevDeck(): DevCard[] {
  const deck: DevCard[] = [];
  for (let i = 0; i < 14; i++) deck.push('knight');
  for (let i = 0; i < 5; i++) deck.push('victory');
  for (let i = 0; i < 2; i++) deck.push('monopoly');
  for (let i = 0; i < 2; i++) deck.push('plenty');
  for (let i = 0; i < 2; i++) deck.push('roadbuilding');
  return deck;
}

/**
 * 开局蛇形放置顺序：默认 0,1,2,3,3,2,1,0。
 * 传入 actionOrder 时按其排列生成（文档 23 L-4：正序 + 逆序，末位连续两次）。
 */
export function setupSeatOrder(playerCount: number, actionOrder?: readonly number[]): number[] {
  const forward = actionOrder
    ? Array.from(actionOrder)
    : Array.from({ length: playerCount }, (_, i) => i);
  return [...forward, ...forward.slice().reverse()];
}

/** 手牌总张数 */
export function handSize(player: PlayerState): number {
  return RESOURCES.reduce((sum, r) => sum + player.resources[r], 0);
}

/** 掷出 7 时需要弃掉的张数：一半向上取整（变体 V-9） */
export function discardCount(hand: number): number {
  if (hand < 8) return 0;
  return Math.ceil(hand / 2);
}

export function countBuildings(state: GameState, player: number): { villages: number; cities: number; roads: number } {  let villages = 0;
  let cities = 0;
  for (const b of Object.values(state.buildings)) {
    if (b.owner !== player) continue;
    if (b.city) cities++;
    else villages++;
  }
  let roads = 0;
  for (const owner of Object.values(state.roads)) {
    if (owner === player) roads++;
  }
  return { villages, cities, roads };
}

export type { Edge, Vertex, Tile };
