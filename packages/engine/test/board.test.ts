import { describe, it, expect } from 'vitest';
import {
  buildGeometry,
  MAP_4P,
  tileNeighbors,
  tilesAdjacent,
  boundaryEdges,
  vertexKey,
  edgeKey,
} from '../src/board.js';

const geo = buildGeometry(MAP_4P.rows);

describe('几何基础', () => {
  it('19 个地块、54 个顶点、72 条边', () => {
    expect(geo.tileKeys.length).toBe(19);
    expect(geo.vertexKeys.length).toBe(54);
    expect(geo.edgeKeys.length).toBe(72);
  });

  it('满足欧拉公式 V - E + F = 2', () => {
    expect(geo.vertexKeys.length - geo.edgeKeys.length + (geo.tileKeys.length + 1)).toBe(2);
  });

  it('边界边为 30 条', () => {
    expect(boundaryEdges(geo).length).toBe(30);
  });

  it('每条边恰好属于 1 或 2 个地块', () => {
    for (const ek of geo.edgeKeys) {
      const n = geo.edges[ek]!.tiles.length;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(2);
    }
  });

  it('每个顶点属于 1 到 3 个地块', () => {
    for (const vk of geo.vertexKeys) {
      const n = geo.vertices[vk]!.tiles.length;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(3);
    }
  });
});

describe('邻接关系', () => {
  it('中心地块有 6 个邻居', () => {
    expect(tileNeighbors(geo, '0,2').length).toBe(6);
  });

  it('角落地块有 3 个邻居', () => {
    expect(tileNeighbors(geo, '-2,0').length).toBe(3);
  });

  it('邻接是对称的', () => {
    for (const tk of geo.tileKeys) {
      for (const nb of tileNeighbors(geo, tk)) {
        expect(tilesAdjacent(geo, tk, nb)).toBe(true);
        expect(tilesAdjacent(geo, nb, tk)).toBe(true);
        expect(tileNeighbors(geo, nb)).toContain(tk);
      }
    }
  });

  it('内部顶点有 3 个相邻顶点', () => {
    const inner = geo.vertexKeys.filter((k) => geo.vertices[k]!.tiles.length === 3);
    expect(inner.length).toBeGreaterThan(0);
    for (const vk of inner) {
      expect(geo.vertices[vk]!.neighbors.length).toBe(3);
    }
  });

  it('每条边的两个端点互为邻居', () => {
    for (const ek of geo.edgeKeys) {
      const e = geo.edges[ek]!;
      expect(geo.vertices[e.a]!.neighbors).toContain(e.b);
      expect(geo.vertices[e.b]!.neighbors).toContain(e.a);
    }
  });
});

describe('地图数据', () => {
  it('资源配比为 木4 砖3 羊4 麦4 矿3 沙漠1', () => {
    const count: Record<string, number> = {};
    for (const tk of geo.tileKeys) {
      const t = MAP_4P.tiles[tk];
      expect(t, `缺少地块数据: ${tk}`).toBeDefined();
      count[t!.terrain] = (count[t!.terrain] ?? 0) + 1;
    }
    expect(count).toEqual({ wood: 4, brick: 3, sheep: 4, wheat: 4, ore: 3, desert: 1 });
  });

  it('数字片为 2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12', () => {
    const nums = geo.tileKeys
      .map((tk) => MAP_4P.tiles[tk]!.number)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    expect(nums).toEqual([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);
  });

  it('只有沙漠没有数字', () => {
    for (const tk of geo.tileKeys) {
      const t = MAP_4P.tiles[tk]!;
      if (t.terrain === 'desert') expect(t.number).toBeNull();
      else expect(t.number).not.toBeNull();
    }
  });
});

describe('key 稳定性', () => {
  it('同一坐标重复计算得到相同顶点 key', () => {
    const v = Object.values(geo.vertices)[0]!;
    expect(vertexKey(v.x, v.y)).toBe(v.key);
  });

  it('边的 key 与端点顺序无关', () => {
    const e = Object.values(geo.edges)[0]!;
    expect(edgeKey(e.a, e.b)).toBe(edgeKey(e.b, e.a));
    expect(edgeKey(e.a, e.b)).toBe(e.key);
  });
});
