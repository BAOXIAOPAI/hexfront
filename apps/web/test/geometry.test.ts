import { describe, expect, it } from 'vitest';
import { MAP_4P, buildGeometry } from '@hexfront/engine';
import { FALLBACK_ROWS, geometryForTileKeys, rowsFromTileKeys } from '../src/geometry.js';

describe('地块 key 反推行数', () => {
  it('从 4 人局 key 还原出 3-4-5-4-3', () => {
    const keys = Object.keys(MAP_4P.tiles);
    expect(rowsFromTileKeys(keys)).toEqual([3, 4, 5, 4, 3]);
  });

  it('还原结果与引擎几何完全一致（顶点 key 与边 key 都能对上）', () => {
    const keys = Object.keys(MAP_4P.tiles);
    const mine = geometryForTileKeys(keys);
    const ref = buildGeometry(MAP_4P.rows);
    expect(mine.vertexKeys.slice().sort()).toEqual(ref.vertexKeys.slice().sort());
    expect(mine.edgeKeys.slice().sort()).toEqual(ref.edgeKeys.slice().sort());
    expect(mine.vertexKeys.length).toBe(54);
    expect(mine.edgeKeys.length).toBe(72);
  });

  it('空输入退回默认行数', () => {
    expect(rowsFromTileKeys([])).toEqual(FALLBACK_ROWS);
  });

  it('畸形 key 退回默认行数', () => {
    expect(rowsFromTileKeys(['a,b', '0,0'])).toEqual(FALLBACK_ROWS);
  });

  it('行号断档（有 0、2 行却没有 1 行）视为畸形', () => {
    expect(rowsFromTileKeys(['0,0', '0,2'])).toEqual(FALLBACK_ROWS);
  });
});
