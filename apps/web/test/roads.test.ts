import { describe, expect, it } from 'vitest';
import { MAP_4P, buildGeometry } from '@hexfront/engine';
import { geometryForTileKeys } from '../src/geometry.js';
import { pointFromKey, roadEndpoints, roadMarkup } from '../src/scene.js';

describe('道路渲染：零宽/零高 bbox 的边不能被滤镜裁掉', () => {
  const geo = geometryForTileKeys(Object.keys(MAP_4P.tiles));

  it('pointy-top 六边形存在垂直边（两端 x 相同 → 几何 bbox 宽度为 0）', () => {
    const vertical = geo.edgeKeys.filter((k) => {
      const [a, b] = k.split('|') as [string, string];
      return a!.split(',')[0] === b!.split(',')[0];
    });
    // 这类边用 objectBoundingBox 滤镜会被整条裁掉，正是「偶发缺路」的元凶
    expect(vertical.length).toBeGreaterThan(0);
  });

  it('垂直边与斜边都不使用 filter（0 宽 bbox 会让滤镜区域退化为 0）', () => {
    const vertical = roadMarkup(0, -28, 0, 28, '#4A7FB5', false);
    const diag = roadMarkup(-48.5, -28, 0, -56, '#4A7FB5', false);
    for (const markup of [vertical, diag]) {
      expect(markup).not.toContain('filter=');
      expect((markup.match(/<line /g) ?? []).length).toBe(4);
    }
  });

  it('垂直边渲染出的主色线两端 x 相同（几何真的落到了画布上）', () => {
    const markup = roadMarkup(0, -28, 0, 28, '#4A7FB5', false);
    expect(markup).toMatch(/x1="0" y1="-28" x2="0" y2="28" stroke="#4A7FB5"/);
  });
});

describe('顶点/边 key 反解兜底', () => {
  const geo = buildGeometry(MAP_4P.rows);

  it('几何表里的 key 走正常路径', () => {
    const vk = geo.vertexKeys[0]!;
    expect(pointFromKey(vk, geo)).toEqual({ x: geo.vertices[vk]!.x, y: geo.vertices[vk]!.y });
    expect(roadEndpoints(geo.edgeKeys[0]!, geo)).not.toBeNull();
  });

  it('几何表里查不到的合法 key 也能反解坐标，绝不静默丢路', () => {
    const pts = roadEndpoints('12345,-19600|12345,-9600', geo);
    expect(pts).toEqual([
      { x: 123.45, y: -196 },
      { x: 123.45, y: -96 },
    ]);
    expect(pointFromKey('1000,2000', geo)).toEqual({ x: 10, y: 20 });
  });

  it('畸形 key 返回 null', () => {
    expect(roadEndpoints('garbage', geo)).toBeNull();
    expect(pointFromKey('x,y', geo)).toBeNull();
  });
});
