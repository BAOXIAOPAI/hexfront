/**
 * 文档 23 L-2 / L-3：受约束随机棋盘生成。
 *
 * 铁律：
 * - 服务端唯一权威：同一 seed + 版本 + 配置必须复现同一张地图。
 * - 地形/数字/港口各自配比守恒，只打乱分布，不逐格独立抽样。
 * - 任意两个红色数字（6/8）不共边：含 6-6、8-8、6-8。
 * - 港口沿岸槽位固定，只洗牌港口类型。
 * - 地图 seed 只用于地图；骰子、洗发展卡、抽牌用独立随机源。
 * - 有搜索预算与失败反馈，失败不无上限循环。
 *
 * 本模块不依赖 Math.random，全部随机来自种子化 PRNG，便于复现与大量种子验收。
 */

import {
  buildGeometry,
  tilesAdjacent,
  type Geometry,
  type MapSpec,
  type MapTileDef,
} from './board.js';
import { boundaryEdges } from './board.js';
import type { Port, Resource, Terrain } from './types.js';

export const MAP_GENERATOR_VERSION = 1;

/** 每次生成的搜索预算：一次生成内最多重排次数，超过即明确失败 */
export const DEFAULT_SEARCH_BUDGET = 400;

export type BoardKind = 'base' | 'ext';

export interface MapGenConfig {
  kind: BoardKind;
  seed: string;
  generatorVersion?: number;
  searchBudget?: number;
}

export interface MapGenResult {
  ok: boolean;
  spec?: MapSpec;
  /** 失败原因（成功时为 undefined） */
  reason?: 'SEARCH_EXHAUSTED' | 'BAD_CONFIG';
  /** 实际消耗的重排次数，用于测试与诊断 */
  attempts?: number;
}

// ---------------------------------------------------------------------------
// 种子化 PRNG（mulberry32）：相同 seed 必得同一序列
// ---------------------------------------------------------------------------

function hashSeed(seed: string): number {
  // FNV-1a 32 位；空 seed 也能得到稳定值
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export type Rng = () => number;

export function makeRng(seed: string): Rng {
  let a = hashSeed(seed) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates，使用种子化 rng */
function shuffled<T>(input: readonly T[], rng: Rng): T[] {
  const out = input.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 配比常量（与官方标准盘 / 5–6 人扩展一致）
// ---------------------------------------------------------------------------

export interface BoardRecipe {
  id: string;
  label: string;
  rows: number[];
  terrains: Partial<Record<Terrain, number>>;
  /** 数字 → 张数；总和必须等于生产地块数（地块数 - 沙漠数） */
  numbers: Record<number, number>;
  /** 港口槽位数量与类型配比 */
  portCount: number;
  ports: Port[];
}

const SPECIFIC = (resource: Resource): Port => ({ kind: 'specific', resource });
const GENERIC: Port = { kind: 'generic' };

/** 标准 19 格：沿用现有 MAP_4P 的配比，9 港 = 4 通用 + 各专用 1 */
export const BASE_RECIPE: BoardRecipe = {
  id: 'base-4p',
  label: '标准盘 · 19 格',
  rows: [3, 4, 5, 4, 3],
  terrains: { wood: 4, brick: 3, sheep: 4, wheat: 4, ore: 3, desert: 1 },
  numbers: { 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 1 },
  portCount: 9,
  ports: [
    GENERIC, SPECIFIC('wood'), GENERIC, SPECIFIC('brick'), GENERIC,
    SPECIFIC('sheep'), GENERIC, SPECIFIC('wheat'), SPECIFIC('ore'),
  ],
};

/**
 * 扩展 30 格、2 沙漠（文档 23 L-0 冻结 A / A-附）：
 * - 地形木6 砖5 羊6 麦6 矿5 沙漠2（28 个生产地块）
 * - 数字袋：2/12 各 2，3/4/5/6/8/9/10/11 各 3（共 28，红点 6 个）
 * - 港口：官方 11 港 = 5 通用 + 6 专用（羊毛 2 个，其余各 1）
 */
export const EXT_RECIPE: BoardRecipe = {
  id: 'ext-6p',
  label: '扩展盘 · 30 格',
  rows: [3, 4, 5, 6, 5, 4, 3],
  terrains: { wood: 6, brick: 5, sheep: 6, wheat: 6, ore: 5, desert: 2 },
  numbers: { 2: 2, 3: 3, 4: 3, 5: 3, 6: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 2 },
  portCount: 11,
  ports: [
    GENERIC, GENERIC, GENERIC, GENERIC, GENERIC,
    SPECIFIC('wood'), SPECIFIC('brick'), SPECIFIC('sheep'), SPECIFIC('sheep'),
    SPECIFIC('wheat'), SPECIFIC('ore'),
  ],
};

export function recipeFor(kind: BoardKind): BoardRecipe {
  return kind === 'base' ? BASE_RECIPE : EXT_RECIPE;
}

// ---------------------------------------------------------------------------
// 港口槽位：几何推导，固定顺序，只洗牌类型
// ---------------------------------------------------------------------------

/** 与 state.computePorts 相同的角度排序，但接受外部 rng 且数量可配 */
export function fixedPortSlots(geo: Geometry, count: number): string[] {
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

  const slots: string[] = [];
  for (let k = 0; k < count; k++) {
    const pick = withAngle[Math.round((k * withAngle.length) / count) % withAngle.length]!;
    slots.push(pick.ek);
  }
  return slots;
}

// ---------------------------------------------------------------------------
// 数字分配：把红点（6/8）放到互不相邻的地块，其余数字随便填
// ---------------------------------------------------------------------------

const RED = new Set([6, 8]);

function expandBag(numbers: Record<number, number>): number[] {
  const out: number[] = [];
  for (const [num, c] of Object.entries(numbers)) {
    for (let i = 0; i < c; i++) out.push(Number(num));
  }
  return out;
}

/**
 * 给非沙漠地块分配数字，要求任意两个带红数字的地块不共边。
 * 做法：先为红点挑一组互不相邻的地块（回溯），再把剩余数字随机填入其余生产地块。
 * 返回 null 表示在预算内没找到解（调用方决定重试/失败）。
 */
function assignNumbers(
  geo: Geometry,
  productionTiles: string[],
  bag: number[],
  rng: Rng,
  budget: number,
): { assignment: Map<string, number>; attempts: number } | null {
  const reds = bag.filter((n) => RED.has(n));
  const others = bag.filter((n) => !RED.has(n));

  for (let attempt = 1; attempt <= budget; attempt++) {
    const pool = shuffled(productionTiles, rng);
    const chosen: string[] = [];
    let ok = true;

    // 贪心挑互不相邻的地块；挑不满就重排再来
    for (const tk of pool) {
      if (chosen.length === reds.length) break;
      if (chosen.every((c) => !tilesAdjacent(geo, tk, c))) chosen.push(tk);
    }
    if (chosen.length !== reds.length) {
      ok = false;
    }

    if (ok) {
      const assignment = new Map<string, number>();
      // 红数字随机分配到选中的地块
      const shuffledReds = shuffled(reds, rng);
      chosen.forEach((tk, i) => assignment.set(tk, shuffledReds[i]!));
      // 其余数字随机填到剩下的生产地块
      const rest = productionTiles.filter((tk) => !assignment.has(tk));
      const shuffledOthers = shuffled(others, rng);
      rest.forEach((tk, i) => assignment.set(tk, shuffledOthers[i]!));
      return { assignment, attempts: attempt };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function generateMap(config: MapGenConfig): MapGenResult {
  const recipe = recipeFor(config.kind);
  const budget = config.searchBudget ?? DEFAULT_SEARCH_BUDGET;
  const version = config.generatorVersion ?? MAP_GENERATOR_VERSION;
  const rng = makeRng(`${version}|${config.kind}|${config.seed}`);

  const geo = buildGeometry(recipe.rows);
  const tileKeys = geo.tileKeys;

  // 配比自检：守恒错误直接失败，不悄悄改图
  const terrainBag: Terrain[] = [];
  for (const [t, c] of Object.entries(recipe.terrains)) {
    for (let i = 0; i < c; i++) terrainBag.push(t as Terrain);
  }
  const numberBag = expandBag(recipe.numbers);
  const desertCount = recipe.terrains.desert ?? 0;
  if (terrainBag.length !== tileKeys.length) {
    return { ok: false, reason: 'BAD_CONFIG', attempts: 0 };
  }
  if (numberBag.length !== tileKeys.length - desertCount) {
    return { ok: false, reason: 'BAD_CONFIG', attempts: 0 };
  }
  if (recipe.ports.length !== recipe.portCount) {
    return { ok: false, reason: 'BAD_CONFIG', attempts: 0 };
  }

  // 地形洗牌 → 找出生产地块与沙漠
  const shuffledTerrains = shuffled(terrainBag, rng);
  const tiles: Record<string, MapTileDef> = {};
  const productionTiles: string[] = [];
  const deserts: string[] = [];
  tileKeys.forEach((tk, i) => {
    const terrain = shuffledTerrains[i]!;
    tiles[tk] = { terrain, number: null };
    if (terrain === 'desert') deserts.push(tk);
    else productionTiles.push(tk);
  });

  // 数字分配（含 6/8 不共边约束）
  const numbered = assignNumbers(geo, productionTiles, numberBag, rng, budget);
  if (!numbered) {
    return { ok: false, reason: 'SEARCH_EXHAUSTED', attempts: budget };
  }
  for (const [tk, num] of numbered.assignment) tiles[tk]!.number = num;

  // 港口：槽位固定，类型洗牌
  const slots = fixedPortSlots(geo, recipe.portCount);
  if (slots.length !== recipe.portCount) {
    return { ok: false, reason: 'BAD_CONFIG', attempts: numbered.attempts };
  }
  const portTypes = shuffled(recipe.ports, rng);
  const ports = slots.map((edge, i) => ({ edge, port: portTypes[i]! }));

  // 双沙漠强盗：按 seed 确定性选一个，写进快照（L-0 冻结 B）
  const robberTile = deserts.length > 0
    ? deserts[Math.floor(makeRng(`robber|${version}|${config.seed}`)() * deserts.length)]!
    : tileKeys[0]!;

  return {
    ok: true,
    attempts: numbered.attempts,
    spec: {
      id: recipe.id,
      label: recipe.label,
      rows: recipe.rows.slice(),
      tiles,
      ports,
      robberTile,
      seed: config.seed,
      generatorVersion: version,
    },
  };
}

/** 校验一份已生成地图的硬约束；用于测试与服务端开始前的兜底 */
export function validateMap(spec: MapSpec): { ok: boolean; problems: string[] } {
  const recipe = spec.id === EXT_RECIPE.id ? EXT_RECIPE : BASE_RECIPE;
  const geo = buildGeometry(spec.rows);
  const problems: string[] = [];

  if (geo.tileKeys.length !== Object.keys(spec.tiles).length) {
    problems.push('地块数量与几何不符');
  }
  const terrainCount = new Map<Terrain, number>();
  const numberCount = new Map<number, number>();
  for (const tk of geo.tileKeys) {
    const def = spec.tiles[tk];
    if (!def) { problems.push(`缺少地块 ${tk}`); continue; }
    terrainCount.set(def.terrain, (terrainCount.get(def.terrain) ?? 0) + 1);
    if (def.terrain === 'desert') {
      if (def.number !== null) problems.push(`沙漠 ${tk} 不应有数字`);
    } else {
      if (def.number === null) problems.push(`生产地块 ${tk} 缺少数字`);
      else numberCount.set(def.number, (numberCount.get(def.number) ?? 0) + 1);
    }
  }
  for (const [t, c] of Object.entries(recipe.terrains)) {
    if ((terrainCount.get(t as Terrain) ?? 0) !== c) {
      problems.push(`地形 ${t} 数量不符：期望 ${c}，实际 ${terrainCount.get(t as Terrain) ?? 0}`);
    }
  }
  for (const [n, c] of Object.entries(recipe.numbers)) {
    if ((numberCount.get(Number(n)) ?? 0) !== c) {
      problems.push(`数字 ${n} 数量不符：期望 ${c}，实际 ${numberCount.get(Number(n)) ?? 0}`);
    }
  }

  // 红点互不共边
  const redTiles = geo.tileKeys.filter((tk) => {
    const n = spec.tiles[tk]?.number;
    return n === 6 || n === 8;
  });
  for (let i = 0; i < redTiles.length; i++) {
    for (let j = i + 1; j < redTiles.length; j++) {
      if (tilesAdjacent(geo, redTiles[i]!, redTiles[j]!)) {
        problems.push(`红点相邻：${redTiles[i]} 与 ${redTiles[j]}`);
      }
    }
  }

  // 港口槽位与类型配比
  if (spec.ports) {
    const slots = fixedPortSlots(geo, recipe.portCount);
    const slotSet = new Set(slots);
    for (const p of spec.ports) {
      if (!slotSet.has(p.edge)) problems.push(`港口槽位非法：${p.edge}`);
    }
    if (spec.ports.length !== recipe.portCount) problems.push('港口数量不符');
    const generic = spec.ports.filter((p) => p.port.kind === 'generic').length;
    if (generic !== recipe.ports.filter((p) => p.kind === 'generic').length) {
      problems.push('通用港数量不符');
    }
  }

  if (spec.robberTile) {
    const def = spec.tiles[spec.robberTile];
    if (!def || def.terrain !== 'desert') problems.push('强盗起点不是当前地图的沙漠');
  }

  return { ok: problems.length === 0, problems };
}
