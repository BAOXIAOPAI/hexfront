/**
 * L-0 规格核对用的可复跑实证脚本（只读，不改应用代码）。
 *
 * 回答三个问题：
 *  1. 现有几何在距离规则下最多能放多少个互不相邻的村庄（容量上界）
 *  2. 随机贪心摆位过程中，会不会出现「还有步骤但已无合法顶点」的局部死局；
 *     以及「落子后仍能完成剩余摆位」这一额外约束是否真的会被触发
 *  3. 「任意 6/8 不共边」约束在标准盘 / 扩展盘的数字袋上是否总有解
 *
 * 跑法（仓库根目录）：
 *   node node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/cli.mjs probe/l0-board-feasibility.mts
 */

import { buildGeometry, tilesAdjacent, type Geometry } from '../packages/engine/src/board.ts';

const ROWS_BASE = [3, 4, 5, 4, 3];
const ROWS_EXT = [3, 4, 5, 6, 5, 4, 3];

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function vertexAdjacency(g: Geometry): number[][] {
  const idx = new Map(g.vertexKeys.map((k, i) => [k, i]));
  return g.vertexKeys.map((k) => g.vertices[k]!.neighbors.map((nb) => idx.get(nb)!));
}

// ---------------------------------------------------------------------------
// 最大独立集
// ---------------------------------------------------------------------------

/** 精确解：补图上 Bron–Kerbosch 求最大团（贪心染色剪枝） */
function maxIndependentSetExact(adj: number[][], allowed: bigint): number {
  const n = adj.length;
  const all = (1n << BigInt(n)) - 1n;
  const comp = adj.map((ns, i) => {
    let m = 0n;
    for (const j of ns) m |= 1n << BigInt(j);
    return (~m) & all & ~(1n << BigInt(i));
  });

  let best = 0;
  function expand(size: number, P: bigint): void {
    if (P === 0n) {
      if (size > best) best = size;
      return;
    }
    const verts: number[] = [];
    for (let i = 0; i < n; i++) if ((P >> BigInt(i)) & 1n) verts.push(i);

    const classes: bigint[] = [];
    const colorOf = new Map<number, number>();
    for (const v of verts) {
      let c = 0;
      while (c < classes.length && (classes[c]! & comp[v]!) !== 0n) c++;
      if (c === classes.length) classes.push(0n);
      classes[c] |= 1n << BigInt(v);
      colorOf.set(v, c + 1);
    }
    const sorted = verts.slice().sort((a, b) => colorOf.get(a)! - colorOf.get(b)!);

    let PP = P;
    for (let k = sorted.length - 1; k >= 0; k--) {
      const v = sorted[k]!;
      if (size + colorOf.get(v)! <= best) return;
      expand(size + 1, PP & comp[v]!);
      PP &= ~(1n << BigInt(v));
      if (PP === 0n) return;
    }
  }
  expand(0, allowed);
  return best;
}

/** 快速下界：随机顺序贪心取多次，返回最好结果；用于逐落子的前瞻检查 */
function maxIndependentSetLowerBound(adj: number[][], allowed: bigint, rnd: () => number, tries = 32): number {
  const n = adj.length;
  const verts: number[] = [];
  for (let i = 0; i < n; i++) if ((allowed >> BigInt(i)) & 1n) verts.push(i);
  let best = 0;
  for (let t = 0; t < tries; t++) {
    for (let i = verts.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [verts[i], verts[j]] = [verts[j]!, verts[i]!];
    }
    const taken = new Set<number>();
    let count = 0;
    for (const v of verts) {
      if (adj[v]!.some((nb) => taken.has(nb))) continue;
      taken.add(v);
      count++;
    }
    if (count > best) best = count;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 1. 容量上界
// ---------------------------------------------------------------------------

console.log('== 1. 距离规则下的村庄容量上界（精确最大独立集） ==');
const geoBase = buildGeometry(ROWS_BASE);
const geoExt = buildGeometry(ROWS_EXT);
const adjBase = vertexAdjacency(geoBase);
const adjExt = vertexAdjacency(geoExt);
const allBase = (1n << BigInt(geoBase.vertexKeys.length)) - 1n;
const allExt = (1n << BigInt(geoExt.vertexKeys.length)) - 1n;
console.log(
  `标准盘 rows=${ROWS_BASE.join(',')} tiles=${geoBase.tileKeys.length}` +
  ` vertices=${geoBase.vertexKeys.length} edges=${geoBase.edgeKeys.length}` +
  ` maxIS=${maxIndependentSetExact(adjBase, allBase)}`,
);
console.log(
  `扩展盘 rows=${ROWS_EXT.join(',')} tiles=${geoExt.tileKeys.length}` +
  ` vertices=${geoExt.vertexKeys.length} edges=${geoExt.edgeKeys.length}` +
  ` maxIS=${maxIndependentSetExact(adjExt, allExt)}`,
);
for (const p of [4, 5, 6, 7, 8]) {
  console.log(`  ${p} 人需 ${p * 2} 座初始村庄`);
}

// ---------------------------------------------------------------------------
// 2. 随机贪心摆位：局部死局与前瞻约束
// ---------------------------------------------------------------------------

interface SimResult {
  trials: number;
  deadlocks: number;
  /** naive 落子后，剩余图容量（下界）已不足以容纳剩余步骤的次数 */
  riskyMoves: number;
}

function simulate(adj: number[][], playerCount: number, trials: number, seed: number): SimResult {
  const n = adj.length;
  const all = (1n << BigInt(n)) - 1n;
  const steps = playerCount * 2;
  const rnd = makeRng(seed);
  let deadlocks = 0;
  let riskyMoves = 0;

  for (let t = 0; t < trials; t++) {
    let allowed = all;
    for (let step = 0; step < steps; step++) {
      const candidates: number[] = [];
      for (let i = 0; i < n; i++) if ((allowed >> BigInt(i)) & 1n) candidates.push(i);
      if (candidates.length === 0) {
        deadlocks++;
        break;
      }
      const pick = candidates[Math.floor(rnd() * candidates.length)]!;

      let after = allowed & ~(1n << BigInt(pick));
      for (const nb of adj[pick]!) after &= ~(1n << BigInt(nb));
      const remainingSteps = steps - step - 1;
      if (maxIndependentSetLowerBound(adj, after, rnd) < remainingSteps) riskyMoves++;
      allowed = after;
    }
  }
  return { trials, deadlocks, riskyMoves };
}

console.log('\n== 2. 随机贪心摆位 2000 局 / 每种组合（naive：随便挑一个合法点） ==');
for (const [label, adj] of [['标准盘', adjBase], ['扩展盘', adjExt]] as const) {
  for (const p of [4, 5, 6, 7, 8]) {
    const r = simulate(adj, p, 2000, 20261112 + p * 100 + (label === '标准盘' ? 0 : 1));
    console.log(
      `${label} ${p} 人 (${p * 2} 次放置): 死局 ${r.deadlocks}/${r.trials}` +
      ` | 前瞻标记为「可能耗尽摆位空间」的落子 ${r.riskyMoves}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. 6/8 不相邻约束的可解性
// ---------------------------------------------------------------------------

/** 数字袋：标准盘 18 个；扩展盘 28 个（官方 5–6 人扩展：2/12 各 2，其余各 3） */
function numberBag(kind: 'base' | 'ext'): number[] {
  const counts = kind === 'base'
    ? { 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 1 }
    : { 2: 2, 3: 3, 4: 3, 5: 3, 6: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 2 };
  const out: number[] = [];
  for (const [num, c] of Object.entries(counts)) {
    for (let i = 0; i < c; i++) out.push(Number(num));
  }
  return out;
}

const RED = new Set([6, 8]);

/**
 * 为每个红色数字找一个地块，要求任意两个红点地块不共边。
 * 用「随机顺序 + 贪心挑互不相邻地块」构造；失败则重排。其余数字随便填即可。
 * 搜索预算 = maxRestarts，避免无上限循环。
 */
function canPlaceRedTokens(g: Geometry, redCount: number, rnd: () => number, maxRestarts = 200): boolean {
  const keys = g.tileKeys;
  for (let attempt = 0; attempt < maxRestarts; attempt++) {
    const pool = keys.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const chosen: string[] = [];
    for (const tk of pool) {
      if (chosen.length === redCount) break;
      if (chosen.every((c) => !tilesAdjacent(g, tk, c))) chosen.push(tk);
    }
    if (chosen.length === redCount) return true;
  }
  return false;
}

console.log('\n== 3. 「任意 6/8 不共边」构造成功率（5000 个种子 / 每种盘） ==');
for (const [label, g, bag] of [
  ['标准盘', geoBase, numberBag('base')],
  ['扩展盘', geoExt, numberBag('ext')],
] as const) {
  const redCount = bag.filter((n) => RED.has(n)).length;
  let failures = 0;
  for (let s = 0; s < 5000; s++) {
    if (!canPlaceRedTokens(g, redCount, makeRng(9000 + s))) failures++;
  }
  console.log(
    `${label}: 数字 ${bag.length} 个 / 地块 ${g.tileKeys.length} 个` +
    ` / 红点 ${redCount} 个 / 失败 ${failures}/5000（含沙漠，属保守估计）`,
  );
}
// ---------------------------------------------------------------------------
// 4. 完整「村庄 + 相邻道路」模拟：把 EDGE_TAKEN 也算进去
// ---------------------------------------------------------------------------

console.log('\n== 4. 完整摆位模拟（村庄 + 一条相邻且未被占用的道路） ==');

function simulateWithRoads(g: Geometry, adj: number[][], playerCount: number, trials: number, seed: number): void {
  const vKeys = g.vertexKeys;
  const steps = playerCount * 2;
  const rnd = makeRng(seed);
  let deadlocks = 0;
  let roadExhausted = 0;

  for (let t = 0; t < trials; t++) {
    let allowed = (1n << BigInt(vKeys.length)) - 1n;
    const usedEdges = new Set<string>();
    for (let step = 0; step < steps; step++) {
      // 合法 (顶点, 边) 组合：顶点可用，且至少有一条未占用的相邻边
      const combos: Array<{ v: number; e: string }> = [];
      for (let i = 0; i < vKeys.length; i++) {
        if (!((allowed >> BigInt(i)) & 1n)) continue;
        for (const ek of g.vertices[vKeys[i]!]!.edges) {
          if (!usedEdges.has(ek)) combos.push({ v: i, e: ek });
        }
      }
      if (combos.length === 0) {
        deadlocks++;
        // 区分：是顶点没了，还是顶点有但边都被占
        let vertsLeft = 0;
        for (let i = 0; i < vKeys.length; i++) if ((allowed >> BigInt(i)) & 1n) vertsLeft++;
        if (vertsLeft > 0) roadExhausted++;
        break;
      }
      const pick = combos[Math.floor(rnd() * combos.length)]!;
      let after = allowed & ~(1n << BigInt(pick.v));
      for (const nb of adj[pick.v]!) after &= ~(1n << BigInt(nb));
      allowed = after;
      usedEdges.add(pick.e);
    }
  }
  console.log(
    `${g.tileKeys.length === 19 ? '标准盘' : '扩展盘'} ${playerCount} 人 (${steps} 次放置):` +
    ` 死局 ${deadlocks}/${trials}（其中「顶点还在但道路用尽」${roadExhausted}）`,
  );
}

for (const g of [geoBase, geoExt]) {
  const adj = vertexAdjacency(g);
  for (const p of [4, 6, 8]) simulateWithRoads(g, adj, p, 2000, 777 + p * 31);
}

console.log('\n注：标准盘有 1 个沙漠、扩展盘有 2 个沙漠，数字只放在非沙漠地块上；');
console.log('    上面的地块池包含沙漠，属于保守估计（真实可用地块更多，只会更容易）。');
