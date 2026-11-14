/**
 * 六边形棋盘几何。
 *
 * 坐标采用 (u, row) 网格：行内相邻格 u 差 2，相邻行 u 差 1。
 * 这样每行天然形成半格错位，且任意行数（19 / 30 / 37 格）都能用同一套逻辑。
 *
 * 顶点与边以像素坐标的定点整数作为 key，避免浮点误差导致的重复。
 */

import type { Point, Terrain, Port } from './types.js';

export const HEX_SIZE = 56;
const SQRT3 = Math.sqrt(3);
const PRECISION = 100;

export interface Tile {
  key: string;
  u: number;
  row: number;
  x: number;
  y: number;
}

export interface Vertex {
  key: string;
  x: number;
  y: number;
  tiles: string[];
  edges: string[];
  neighbors: string[];
}

export interface Edge {
  key: string;
  a: string;
  b: string;
  tiles: string[];
}

export interface Geometry {
  tiles: Record<string, Tile>;
  tileKeys: string[];
  vertices: Record<string, Vertex>;
  vertexKeys: string[];
  edges: Record<string, Edge>;
  edgeKeys: string[];
}

const TILE_DIRS: ReadonlyArray<readonly [number, number]> = [
  [2, 0],
  [-2, 0],
  [1, -1],
  [-1, -1],
  [1, 1],
  [-1, 1],
];

export function cornersOf(cx: number, cy: number, size = HEX_SIZE): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i - 30);
    out.push({ x: cx + size * Math.cos(ang), y: cy + size * Math.sin(ang) });
  }
  return out;
}

export function vertexKey(x: number, y: number): string {
  return `${Math.round(x * PRECISION)},${Math.round(y * PRECISION)}`;
}

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function buildGeometry(rows: number[]): Geometry {
  const center = (rows.length - 1) / 2;

  const tiles: Record<string, Tile> = {};
  const tileKeys: string[] = [];

  rows.forEach((count, row) => {
    const u0 = 1 - count;
    for (let i = 0; i < count; i++) {
      const u = u0 + i * 2;
      const key = `${u},${row}`;
      tiles[key] = {
        key,
        u,
        row,
        x: (HEX_SIZE * SQRT3 * u) / 2,
        y: HEX_SIZE * 1.5 * (row - center),
      };
      tileKeys.push(key);
    }
  });

  const vertices: Record<string, Vertex> = {};
  const vertexKeys: string[] = [];
  const edges: Record<string, Edge> = {};
  const edgeKeys: string[] = [];

  const ensureVertex = (x: number, y: number): string => {
    const k = vertexKey(x, y);
    let v = vertices[k];
    if (!v) {
      v = { key: k, x, y, tiles: [], edges: [], neighbors: [] };
      vertices[k] = v;
      vertexKeys.push(k);
    }
    return k;
  };

  for (const tileKey of tileKeys) {
    const t = tiles[tileKey]!;
    const pts = cornersOf(t.x, t.y);
    const vks = pts.map((p) => ensureVertex(p.x, p.y));

    for (const vk of vks) {
      const v = vertices[vk]!;
      if (!v.tiles.includes(tileKey)) v.tiles.push(tileKey);
    }

    for (let i = 0; i < 6; i++) {
      const a = vks[i]!;
      const b = vks[(i + 1) % 6]!;
      const ek = edgeKey(a, b);

      let e = edges[ek];
      if (!e) {
        e = { key: ek, a, b, tiles: [] };
        edges[ek] = e;
        edgeKeys.push(ek);
      }
      if (!e.tiles.includes(tileKey)) e.tiles.push(tileKey);

      const va = vertices[a]!;
      const vb = vertices[b]!;
      if (!va.edges.includes(ek)) va.edges.push(ek);
      if (!vb.edges.includes(ek)) vb.edges.push(ek);
      if (!va.neighbors.includes(b)) va.neighbors.push(b);
      if (!vb.neighbors.includes(a)) vb.neighbors.push(a);
    }
  }

  return { tiles, tileKeys, vertices, vertexKeys, edges, edgeKeys };
}

/** 两个地块是否相邻 */
export function tilesAdjacent(geo: Geometry, a: string, b: string): boolean {
  const ta = geo.tiles[a];
  const tb = geo.tiles[b];
  if (!ta || !tb) return false;
  const du = Math.abs(ta.u - tb.u);
  const dr = Math.abs(ta.row - tb.row);
  if (dr === 0) return du === 2;
  if (dr === 1) return du === 1;
  return false;
}

/** 某地块的相邻地块 key 列表 */
export function tileNeighbors(geo: Geometry, tileKey: string): string[] {
  const t = geo.tiles[tileKey];
  if (!t) return [];
  const out: string[] = [];
  for (const [du, dr] of TILE_DIRS) {
    const k = `${t.u + du},${t.row + dr}`;
    if (geo.tiles[k]) out.push(k);
  }
  return out;
}

/** 只属于一个地块的边 —— 即地图边界，用于摆放港口 */
export function boundaryEdges(geo: Geometry): string[] {
  return geo.edgeKeys.filter((k) => geo.edges[k]!.tiles.length === 1);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 某个地块的 6 个顶点 key */
export function tileVertexKeys(geo: Geometry, tileKey: string): string[] {
  const t = geo.tiles[tileKey];
  if (!t) return [];
  return cornersOf(t.x, t.y).map((p) => vertexKey(p.x, p.y));
}

// ---------------------------------------------------------------------------
// 地图数据
// ---------------------------------------------------------------------------

export interface MapTileDef {
  terrain: Terrain;
  number: number | null;
}

export interface MapSpec {
  id: string;
  label: string;
  rows: number[];
  tiles: Record<string, MapTileDef>;
  /** 港口槽位由生成器固定；不传时 createGame 走 computePorts 的默认推导（标准盘） */
  ports?: { edge: string; port: Port }[];
  /** 强盗初始地块（沙漠）；不传时 createGame 取第一个沙漠 */
  robberTile?: string;
  /** 地图种子与生成器版本，仅用于地图，绝不复用为骰子/发展卡随机源 */
  seed?: string;
  generatorVersion?: number;
}

/**
 * 标准 4 人局，19 格。
 * 配比：木4 砖3 羊4 麦4 矿3 沙漠1；数字 2~12 除 7。
 */
export const MAP_4P: MapSpec = {
  id: 'base-4p',
  label: '4 人 · 19 格',
  rows: [3, 4, 5, 4, 3],
  tiles: {
    '-2,0': { terrain: 'sheep', number: 3 },
    '0,0': { terrain: 'ore', number: 10 },
    '2,0': { terrain: 'wood', number: 2 },

    '-3,1': { terrain: 'brick', number: 9 },
    '-1,1': { terrain: 'wheat', number: 12 },
    '1,1': { terrain: 'wheat', number: 6 },
    '3,1': { terrain: 'sheep', number: 4 },

    '-4,2': { terrain: 'wood', number: 5 },
    '-2,2': { terrain: 'ore', number: 11 },
    '0,2': { terrain: 'desert', number: null },
    '2,2': { terrain: 'brick', number: 5 },
    '4,2': { terrain: 'sheep', number: 9 },

    '-3,3': { terrain: 'wood', number: 8 },
    '-1,3': { terrain: 'wheat', number: 10 },
    '1,3': { terrain: 'brick', number: 8 },
    '3,3': { terrain: 'ore', number: 4 },

    '-2,4': { terrain: 'sheep', number: 11 },
    '0,4': { terrain: 'wood', number: 6 },
    '2,4': { terrain: 'wheat', number: 3 },
  },
};
