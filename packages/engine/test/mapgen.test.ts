/**
 * 文档 23 L-2 / L-3：随机棋盘生成约束与可复现验收。
 * 覆盖：数量守恒、6/8 不共边（含 6-6、8-8、6-8）、港口合法性、
 *      双沙漠强盗、seed 复现、搜索预算失败反馈、扩展盘 11 港配比。
 */

import { describe, it, expect } from 'vitest';
import {
  BASE_RECIPE,
  DEFAULT_SEARCH_BUDGET,
  EXT_RECIPE,
  MAP_GENERATOR_VERSION,
  buildBoard,
  createGame,
  generateMap,
  makeRng,
  recipeFor,
  validateMap,
  type MapSpec,
} from '../src/index.js';
import { buildGeometry, tilesAdjacent } from '../src/index.js';

function specOf(kind: 'base' | 'ext', seed: string): MapSpec {
  const r = generateMap({ kind, seed, generatorVersion: MAP_GENERATOR_VERSION });
  expect(r.ok).toBe(true);
  if (!r.ok || !r.spec) throw new Error(`生成失败: ${r.reason}`);
  return r.spec;
}

describe('受约束随机棋盘：基本守恒', () => {
  for (const kind of ['base', 'ext'] as const) {
    const recipe = recipeFor(kind);
    it(`${kind} 盘：地形/数字/港口数量守恒，沙漠无数字`, () => {
      const spec = specOf(kind, `counts-${kind}`);
      const v = validateMap(spec);
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);

      const geo = buildGeometry(spec.rows);
      expect(geo.tileKeys).toHaveLength(Object.keys(spec.tiles).length);
      expect(spec.ports).toHaveLength(recipe.portCount);
      const deserts = geo.tileKeys.filter((k) => spec.tiles[k]!.terrain === 'desert');
      expect(deserts).toHaveLength(kind === 'base' ? 1 : 2);
      for (const d of deserts) expect(spec.tiles[d]!.number).toBeNull();
    });
  }

  it('标准盘沿用 MAP_4P 的 9 港配比（4 通用 + 5 专用）', () => {
    expect(BASE_RECIPE.ports.filter((p) => p.kind === 'generic')).toHaveLength(4);
    expect(BASE_RECIPE.ports.filter((p) => p.kind === 'specific')).toHaveLength(5);
  });

  it('扩展盘为官方 11 港：5 通用 + 6 专用，羊毛 2 个', () => {
    expect(EXT_RECIPE.ports).toHaveLength(11);
    expect(EXT_RECIPE.ports.filter((p) => p.kind === 'generic')).toHaveLength(5);
    const sheep = EXT_RECIPE.ports.filter(
      (p) => p.kind === 'specific' && p.resource === 'sheep',
    );
    expect(sheep).toHaveLength(2);
  });

  it('扩展盘 28 个数字对应 28 个生产地块，红点 6 个', () => {
    const total = Object.values(EXT_RECIPE.numbers).reduce((a, b) => a + b, 0);
    expect(total).toBe(28);
    expect(EXT_RECIPE.numbers[6]! + EXT_RECIPE.numbers[8]!).toBe(6);
    expect(EXT_RECIPE.terrains.desert).toBe(2);
  });
});

describe('红点约束：任意两个 6/8 不共边', () => {
  for (const kind of ['base', 'ext'] as const) {
    it(`${kind} 盘 200 个种子全部无 6/8 相邻`, () => {
      for (let s = 0; s < 200; s++) {
        const spec = specOf(kind, `red-${kind}-${s}`);
        const geo = buildGeometry(spec.rows);
        const red = geo.tileKeys.filter((k) => {
          const n = spec.tiles[k]!.number;
          return n === 6 || n === 8;
        });
        // 明确检查三类：6-6、8-8、6-8
        for (let i = 0; i < red.length; i++) {
          for (let j = i + 1; j < red.length; j++) {
            expect(tilesAdjacent(geo, red[i]!, red[j]!)).toBe(false);
          }
        }
        expect(validateMap(spec).ok).toBe(true);
      }
    });
  }
});

describe('seed 可复现', () => {
  it('相同 seed + 版本 + 配置生成完全相同的地图', () => {
    const a = specOf('ext', 'repro-1');
    const b = specOf('ext', 'repro-1');
    expect(b).toEqual(a);
  });

  it('不同 seed 生成不同地图', () => {
    const a = specOf('base', 'repro-a');
    const b = specOf('base', 'repro-b');
    expect(b).not.toEqual(a);
  });

  it('makeRng 同种子同序列、不同种子不同序列', () => {
    const r1 = makeRng('x');
    const r2 = makeRng('x');
    const r3 = makeRng('y');
    const s1 = [r1(), r1(), r1()];
    const s2 = [r2(), r2(), r2()];
    const s3 = [r3(), r3(), r3()];
    expect(s2).toEqual(s1);
    expect(s3).not.toEqual(s1);
  });

  it('地图快照的 seed / 版本写入 spec，便于服务端广播', () => {
    const spec = specOf('base', 'meta-1');
    expect(spec.seed).toBe('meta-1');
    expect(spec.generatorVersion).toBe(MAP_GENERATOR_VERSION);
  });
});

describe('双沙漠强盗（L-0 冻结 B）', () => {
  it('强盗起点是当前地图的沙漠，且按 seed 确定性选定', () => {
    const a = specOf('ext', 'robber-1');
    const b = specOf('ext', 'robber-1');
    expect(a.robberTile).toBe(b.robberTile);
    expect(a.tiles[a.robberTile!]!.terrain).toBe('desert');
    expect(validateMap(a).ok).toBe(true);
  });

  it('createGame 使用快照指定的强盗起点，不另选沙漠', () => {
    const spec = specOf('ext', 'robber-2');
    const board = buildBoard(spec);
    const game = createGame(board, ['甲', '乙', '丙', '丁'], ['red', 'blue', 'white', 'orange']);
    expect(game.robberTile).toBe(spec.robberTile);
    expect(game.tiles[game.robberTile]!.terrain).toBe('desert');
  });

  it('createGame 使用快照的港口，不重新推导', () => {
    const spec = specOf('ext', 'ports-1');
    const board = buildBoard(spec);
    const game = createGame(board, ['甲', '乙', '丙', '丁'], ['red', 'blue', 'white', 'orange']);
    expect(game.ports).toEqual(spec.ports);
  });
});

describe('失败反馈与搜索预算', () => {
  it('搜索预算为 0 时明确失败，不无上限循环', () => {
    const r = generateMap({ kind: 'ext', seed: 'budget-0', searchBudget: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SEARCH_EXHAUSTED');
  });

  it('预算充足时正常生成并报告消耗次数', () => {
    const r = generateMap({ kind: 'base', seed: 'budget-ok', searchBudget: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attempts).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_SEARCH_BUDGET).toBeGreaterThan(0);
  });
});

describe('地图质量：全员同一份快照', () => {
  it('validateMap 对生成的盘全部通过，且 createGame 后地形/数字/港口与快照一致', () => {
    for (const kind of ['base', 'ext'] as const) {
      for (let s = 0; s < 20; s++) {
        const spec = specOf(kind, `snapshot-${kind}-${s}`);
        expect(validateMap(spec).problems).toEqual([]);
        const game = createGame(
          buildBoard(spec),
          ['甲', '乙', '丙', '丁'],
          ['red', 'blue', 'white', 'orange'],
        );
        for (const tk of Object.keys(spec.tiles)) {
          expect(game.tiles[tk]).toEqual({ key: tk, ...spec.tiles[tk] });
        }
        expect(game.ports).toEqual(spec.ports);
      }
    }
  });
});
