/**
 * 前端几何：服务端只推地块 key（形如 "-2,1"），
 * 客户端据此重建与引擎完全一致的几何，从而能用同一套 vertex/edge key 查建筑与道路。
 *
 * 这样做的好处：地图尺寸由数据决定，将来加 30 格 / 37 格不用改前端。
 */

import { buildGeometry, type Geometry } from '@hexfront/engine';

export const FALLBACK_ROWS = [3, 4, 5, 4, 3];

const TILE_KEY_RE = /^(-?\d+),(-?\d+)$/;

/**
 * 从地块 key 反推「每行几格」。
 * 任何一格不符合 (u,row) 规则就判定为异常，退回 4 人局默认行数。
 */
export function rowsFromTileKeys(keys: readonly string[]): number[] {
  if (keys.length === 0) return FALLBACK_ROWS.slice();

  const counts = new Map<number, number>();
  let maxRow = -1;
  for (const key of keys) {
    const m = TILE_KEY_RE.exec(key);
    if (!m) return FALLBACK_ROWS.slice();
    const row = Number(m[2]);
    if (!Number.isInteger(row) || row < 0) return FALLBACK_ROWS.slice();
    counts.set(row, (counts.get(row) ?? 0) + 1);
    if (row > maxRow) maxRow = row;
  }

  const rows: number[] = [];
  for (let r = 0; r <= maxRow; r++) {
    const c = counts.get(r);
    if (!c) return FALLBACK_ROWS.slice();
    rows.push(c);
  }
  return rows;
}

/** 用视图里的地块列表重建几何 */
export function geometryForTileKeys(keys: readonly string[]): Geometry {
  return buildGeometry(rowsFromTileKeys(keys));
}

/** 多边形点串，scale>1 时从中心向外扩展（用于浅滩与沙滩层） */
export function polygonPoints(points: readonly { x: number; y: number }[], cx: number, cy: number, scale = 1): string {
  return points
    .map((p) => `${round(cx + (p.x - cx) * scale)},${round(cy + (p.y - cy) * scale)}`)
    .join(' ');
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
