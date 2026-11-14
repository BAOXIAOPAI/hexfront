/**
 * 文档 23：大厅「六边形棋盘预览 + 资源质量提示」验收。
 *
 * 用引擎真实的生成结果构造 MapSnapshot，断言：
 *   - SVG 按真实 (u,row) 网格画出对应数量的六边形，不是一排方块
 *   - 6/8 红点、沙漠强盗、沿岸港口都落在几何正确位置
 *   - 资源质量分析按点数理论权重给出「可能缺 X」提示
 *   - 红点相邻时能独立检出并告警（生成器保证不会发生，这里是防御性核验）
 */

import { describe, expect, it } from 'vitest';
import {
  generateMap,
  MAP_GENERATOR_VERSION,
  validateMap,
  buildGeometry,
  boundaryEdges,
  HEX_SIZE,
  type MapSpec,
} from '@hexfront/engine';
import type { MapSnapshot, PortSnapshot } from '@hexfront/protocol';
import { analyzeMapQuality, renderMapSvg, mapSummary } from '../src/lobby.js';

/** 把引擎 MapSpec 转成协议 MapSnapshot（与服务端 snapshotOf 同构） */
function snapshotOf(spec: MapSpec, kind: 'base' | 'ext', boardVersion = 1): MapSnapshot {
  return {
    kind,
    rows: spec.rows.slice(),
    tiles: Object.entries(spec.tiles).map(([key, t]) => ({
      key, terrain: t.terrain, number: t.number,
    })),
    ports: (spec.ports ?? []).map((p): PortSnapshot => ({
      edge: p.edge,
      port: p.port.kind === 'generic'
        ? { kind: 'generic' }
        : { kind: 'specific', resource: p.port.resource },
    })),
    robberTile: spec.robberTile ?? '',
    seed: spec.seed ?? '',
    generatorVersion: spec.generatorVersion ?? MAP_GENERATOR_VERSION,
    boardVersion,
  };
}

function realMap(kind: 'base' | 'ext', seed: string): MapSnapshot {
  const r = generateMap({ kind, seed });
  expect(r.ok).toBe(true);
  if (!r.ok || !r.spec) throw new Error(`生成失败 ${r.reason}`);
  expect(validateMap(r.spec).problems).toEqual([]);
  return snapshotOf(r.spec, kind);
}

/** 手工构造一张「明显缺矿」的标准盘：矿只给最低点数，其余给高点数 */
function oreScarceMap(): MapSnapshot {
  const spec = generateMap({ kind: 'base', seed: 'scarce-source' });
  if (!spec.ok || !spec.spec) throw new Error('生成失败');
  const tiles: Record<string, { terrain: string; number: number | null }> = {};
  const order = ['wood', 'brick', 'sheep', 'wheat', 'ore'] as const;
  let i = 0;
  for (const [key, def] of Object.entries(spec.spec.tiles)) {
    if (def.terrain === 'desert') { tiles[key] = { terrain: 'desert', number: null }; continue; }
    // 让前四种资源拿 6/8，矿拿 2/12；其他点数错开避免红点相邻（这里只用于质量分析）
    const terrain = def.terrain;
    const rich = terrain !== 'ore';
    const num = rich ? (i % 2 === 0 ? 6 : 8) : (i % 2 === 0 ? 2 : 12);
    tiles[key] = { terrain, number: num };
    i++;
    void order;
  }
  const geo = buildGeometry(spec.spec.rows);
  const boundary = boundaryEdges(geo);
  const ports: PortSnapshot[] = boundary.slice(0, 9).map((edge, k) => ({
    edge,
    port: k % 2 === 0 ? { kind: 'generic' } : { kind: 'specific', resource: 'wood' },
  }));
  return {
    kind: 'base', rows: spec.spec.rows, tiles: Object.entries(tiles).map(([key, t]) => ({ key, ...t })),
    ports, robberTile: Object.keys(tiles).find((k) => tiles[k]!.terrain === 'desert') ?? '',
    seed: 'scarce', generatorVersion: 1, boardVersion: 1,
  };
}

describe('六边形棋盘预览 SVG', () => {
  it('标准盘画出 19 个六边形，扩展盘 30 个；不再是平铺方块', () => {
    const base = renderMapSvg(realMap('base', 'svg-base-1'));
    const ext = renderMapSvg(realMap('ext', 'svg-ext-1'));
    expect((base.match(/<polygon /g) ?? []).length).toBe(19);
    expect((ext.match(/<polygon /g) ?? []).length).toBe(30);
    expect(base).toContain('<svg class="lb-board"');
    expect(base).toContain('viewBox="0 0');
    expect(base).not.toContain('lb-tile');
  });

  it('六边形紧密拼接：相邻多边形共享边，不会出现「坐标一套比例、六边形另一套比例」的大缝隙', () => {
    const svg = renderMapSvg(realMap('base', 'svg-tight-1'));
    // 从每个 polygon 的 points 取中心（六顶点均值）
    const polys = [...svg.matchAll(/<polygon points="([^"]+)"/g)].map((m) => {
      const pts = m[1]!.trim().split(/\s+/).map((p) => {
        const [x, y] = p.split(',').map(Number);
        return { x: x!, y: y! };
      });
      return {
        cx: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        cy: pts.reduce((s, p) => s + p.y, 0) / pts.length,
        r: Math.hypot(pts[0]!.x - pts.reduce((s, p) => s + p.x, 0) / pts.length,
                      pts[0]!.y - pts.reduce((s, p) => s + p.y, 0) / pts.length),
      };
    });
    expect(polys).toHaveLength(19);
    const r = polys[0]!.r;
    // 半径必须等于引擎 HEX_SIZE（viewBox 缩放由 CSS 负责，坐标不另缩放）
    expect(r).toBeCloseTo(HEX_SIZE, 1);
    // 任意两个中心的最小距离 = 同行相邻 = R·√3（紧密蜂窝）
    let minD = Infinity;
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        const d = Math.hypot(polys[i]!.cx - polys[j]!.cx, polys[i]!.cy - polys[j]!.cy);
        if (d < minD) minD = d;
      }
    }
    expect(minD).toBeCloseTo(HEX_SIZE * Math.sqrt(3), 1);
    // 若半径被缩成 27 而中心仍按 56 排布，minD/r 会远大于 √3
    expect(minD / r).toBeCloseTo(Math.sqrt(3), 2);
  });

  it('6/8 是红色粗描边的高产点，数字与 pips 都在六边形中心', () => {
    const svg = renderMapSvg(realMap('base', 'svg-red-1'));
    expect(svg).toContain('lb-hex red');
    expect(svg).toContain('dominant-baseline="middle"');
    // 红点数量：标准盘 4 个（6/8 各 2）
    expect((svg.match(/lb-hex red/g) ?? []).length).toBe(4);
  });

  it('沙漠无数字、显示 ⌁；强盗起点落在当前地图的沙漠上', () => {
    const map = realMap('ext', 'svg-robber-1');
    const svg = renderMapSvg(map);
    expect(svg).toContain('⌁');
    expect(svg).toContain('>盗</text>');
    // 强盗图标出现两次（2 个沙漠里只有 1 个带盗字）
    expect((svg.match(/>盗<\/text>/g) ?? []).length).toBe(1);
    expect(map.tiles.find((t) => t.key === map.robberTile)?.terrain).toBe('desert');
  });

  it('港口标签贴在真实沿岸边的中点，而不是一排文字', () => {
    const map = realMap('base', 'svg-ports-1');
    const svg = renderMapSvg(map);
    expect((svg.match(/lb-port-pin/g) ?? []).length).toBe(9);
    expect(svg).toContain('>3:1</text>');
    expect(svg).toContain('>2:1');
    // 每个港口的 edge 都必须是几何边界边
    const geo = buildGeometry(map.rows);
    const boundary = new Set(boundaryEdges(geo));
    for (const p of map.ports) expect(boundary.has(p.edge)).toBe(true);
  });

  it('同一份快照渲染结果完全一致（全员看到同一张预览）', () => {
    const map = realMap('ext', 'svg-same-1');
    expect(renderMapSvg(map)).toBe(renderMapSvg(map));
  });

  it('地图摘要仍包含格数、港口、种子与版本', () => {
    const s = mapSummary(realMap('ext', 'svg-summary-1'));
    expect(s).toContain('30 格');
    expect(s).toContain('11 港');
    expect(s).toContain('v1');
  });
});

describe('资源质量提示（文档 23 §3）', () => {
  it('按点数理论权重统计，不按地块数量；总权重为正', () => {
    const q = analyzeMapQuality(realMap('base', 'quality-1'));
    expect(q.totalWeight).toBeGreaterThan(0);
    for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
      expect(typeof q.weights[r]).toBe('number');
    }
    expect(q.redCount).toBe(4);
    expect(q.redAdjacent).toBe(false);   // 生成器保证 6/8 不共边
  });

  it('明显缺矿的地图给出「可能缺矿」提示', () => {
    const q = analyzeMapQuality(oreScarceMap());
    expect(q.scarce).toContain('矿');
    expect(q.hint).toContain('可能缺矿');
    expect(q.hint).toContain('理论产出权重');
    expect(q.balanced).toBe(false);
  });

  it('产出均衡的地图给出「较均衡」提示，不误报稀缺', () => {
    const map = realMap('base', 'quality-balanced-source');
    // 构造五类资源权重完全相等：每类 2 格，点数权重均为 5/5
    const keys = map.tiles.map((t) => t.key);
    const terrains = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
    const tiles = keys.map((key, i) => ({
      key,
      terrain: i === 0 ? 'desert' : terrains[(i - 1) % 5]!,
      number: i === 0 ? null : (i % 2 === 0 ? 6 : 8),
    }));
    const q = analyzeMapQuality({ ...map, tiles, robberTile: keys[0]! });
    expect(q.balanced).toBe(true);
    expect(q.hint).toContain('较均衡');
    expect(q.scarce).toEqual([]);
  });

  it('红点相邻时独立检出并给出重抽告警', () => {
    const map = realMap('base', 'quality-adj-source');
    // 强行把两个相邻地块都设成 6（几何上 (-2,0) 与 (0,0) 同行 u 差 2 = 共边）
    const tiles = map.tiles.map((t) => ({ ...t }));
    const a = tiles.find((t) => t.key === '-2,0')!;
    const b = tiles.find((t) => t.key === '0,0')!;
    a.terrain = 'wood'; a.number = 6;
    b.terrain = 'brick'; b.number = 6;
    const q = analyzeMapQuality({ ...map, tiles });
    expect(q.redAdjacent).toBe(true);
    expect(q.hint).toContain('6/8 相邻');
    expect(q.hint).toContain('重抽');
  });

  it('质量提示不承诺胜率、不保证实际掷骰结果', () => {
    const q = analyzeMapQuality(realMap('ext', 'quality-disclaimer'));
    expect(q.hint).not.toMatch(/保证|必胜|一定/);
  });
});
