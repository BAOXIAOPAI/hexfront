/**
 * 棋盘 SVG 渲染。
 *
 * 只消费 PlayerView：不知道规则，也不保存状态。
 * 每次收到 STATE 就整块重画 —— 19~37 个地块的量级，重画比做 diff 便宜得多。
 */

import {
  cornersOf,
  HEX_SIZE,
  type Edge,
  type Geometry,
  type PlayerView,
  type PublicTile,
  type Terrain,
  type Vertex,
} from '@hexfront/engine';
import { terrainDecor } from './decor.js';
import { polygonPoints } from './geometry.js';
import { INK_DEEP, isLight, PIPS, PLAYER_HEX, TERRAIN_COLOR } from './theme.js';

const PAD = 92;

/** vertexKey / edgeKey 是「×100 取整后的坐标」拼出来的，本身就能反解出位置 */
export interface ScenePoint {
  x: number;
  y: number;
}

/**
 * 顶点坐标：先查几何表，查不到就从 key 反解。
 *
 * 几何表由前端按 view.tiles 重建，理论上与服务端一致；但只要有一处浮点取整
 * 或 key 排序差异，旧代码 `if (!vertex) continue` 就会**静默丢掉**一个建筑/一条路。
 * 这里保证任何合法的 key 都能落到棋盘上（误差 ≤0.01px，肉眼不可见）。
 */
export function pointFromKey(key: string, geo: Geometry): ScenePoint | null {
  const v = geo.vertices[key];
  if (v) return { x: v.x, y: v.y };
  const m = /^(-?\d+),(-?\d+)$/.exec(key);
  return m ? { x: Number(m[1]) / 100, y: Number(m[2]) / 100 } : null;
}

/** 道路两端：优先查几何表，查不到就拆 edgeKey（`x1,y1|x2,y2`）反解 */
export function roadEndpoints(key: string, geo: Geometry): [ScenePoint, ScenePoint] | null {
  const edge = geo.edges[key];
  if (edge) {
    const a = pointFromKey(edge.a, geo);
    const b = pointFromKey(edge.b, geo);
    if (a && b) return [a, b];
  }
  const parts = key.split('|');
  if (parts.length !== 2) return null;
  const a = pointFromKey(parts[0]!, geo);
  const b = pointFromKey(parts[1]!, geo);
  return a && b ? [a, b] : null;
}

export interface SceneHandle {
  /** 画布当前使用的 viewBox，测试与调试用 */
  readonly box: { x: number; y: number; width: number; height: number };
}

/**
 * 摆位热区。只是「可以点这里」的视觉提示，点击后照旧发 COMMAND 给服务端裁决。
 * 空 overlay 与 undefined 等价 —— 不画任何可点元素。
 */
export interface BoardOverlay {
  /** 可落村的路口 */
  vertices: string[];
  /** 选定村庄后可放路的边 */
  edges: string[];
  /** 已经点下去、等待选边的那个村庄 */
  picked: string | null;
  /** 掷 7 结算时可放置强盗的地块（R-44） */
  tiles?: string[];
  /** 已选中、正等挑一位玩家抽牌的地块 */
  pickedTile?: string | null;
}

function waveLine(x1: number, x2: number, y: number, amp: number, seg: number): string {
  let d = `M${x1},${y}`;
  let x = x1;
  let up = true;
  while (x < x2) {
    d += ` q${seg / 2},${up ? -amp : amp} ${seg},0`;
    up = !up;
    x += seg;
  }
  return d;
}

function house(x: number, y: number, hex: string, light: boolean, city: boolean): string {
  const stroke = light ? '#4A3325' : '#3A2418';
  const w = city ? 28 : 21;
  const h = city ? 21 : 15;
  const roofH = city ? 14 : 10.5;
  let g = `<g transform="translate(${x},${y})" filter="url(#soft)">`;

  if (city) {
    // 城：在主楼上方添一座塔楼，一眼能和村庄区分
    g += `<rect x="${-w / 2 + 7}" y="${-h - roofH - 6}" width="8" height="${roofH + 8}" rx="1.5" fill="${hex}" stroke="${stroke}" stroke-width="1.8"/>`;
    g += `<path d="M${-w / 2 + 6} ${-h - roofH - 6} L${-w / 2 + 11} ${-h - roofH - 12} L${-w / 2 + 16} ${-h - roofH - 6} Z" fill="${hex}" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round"/>`;
  }
  g += `<rect x="${-w / 2}" y="${-h}" width="${w}" height="${h}" rx="2" fill="${hex}" stroke="${stroke}" stroke-width="1.9"/>`;
  g += `<path d="M${-w / 2 - 2} ${-h} L0 ${-h - roofH} L${w / 2 + 2} ${-h} Z" fill="${hex}" stroke="${stroke}" stroke-width="1.9" stroke-linejoin="round"/>`;
  g += `<rect x="-2.5" y="${-h / 2 - 1}" width="5" height="${h / 2 + 1}" rx="1" fill="${light ? '#C9B79B' : '#FFF1DC'}" opacity=".85"/>`;
  return `${g}</g>`;
}

/**
 * 画一条路。**这里绝对不能用 filter**：水平边（y1 === y2）的 <line> 几何 bbox 高度为 0，
 * objectBoundingBox 的滤镜区域会退化成 0，整条路被裁掉不显示 —— 表现为「偶发某条路没落上棋盘」。
 * 阴影改成一条下移的深色线，视觉几乎一致且没有裁剪风险。
 */
export function roadMarkup(x1: number, y1: number, x2: number, y2: number, hex: string, light: boolean): string {
  const stroke = light ? '#4A3325' : '#3A2418';
  return `<g>
    <line x1="${x1}" y1="${y1 + 2.5}" x2="${x2}" y2="${y2 + 2.5}" stroke="#3A2418" stroke-width="7" stroke-linecap="round" opacity=".26"/>
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="7" stroke-linecap="round" opacity=".85"/>
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${hex}" stroke-width="4.6" stroke-linecap="round"/>
    <line x1="${x1}" y1="${y1 - 0.8}" x2="${x2}" y2="${y2 - 0.8}" stroke="#fff" stroke-width="1.1" stroke-linecap="round" opacity=".22"/>
  </g>`;
}

const road = roadMarkup;

function robber(x: number, y: number): string {
  return `<g transform="translate(${x},${y + 2}) scale(1.15)" filter="url(#soft)">
    <ellipse cx="0" cy="16" rx="11" ry="3" fill="#2A1A0E" opacity=".3"/>
    <path d="M-10,14 L-8.5,-1 Q-7.5,-7 -3.5,-8 L-2.8,-11 A4.8,4.8 0 1 1 2.8,-11 L3.5,-8 Q7.5,-7 8.5,-1 L10,14 Z" fill="#241C17" stroke="#0F0A07" stroke-width="1.2" stroke-linejoin="round"/>
    <ellipse cx="0" cy="-15" rx="8.4" ry="2.4" fill="#15100C"/>
    <circle cx="-2.1" cy="-11.6" r="1.05" fill="#C8503F"/>
    <circle cx="2.1" cy="-11.6" r="1.05" fill="#C8503F"/>
  </g>`;
}

function tileMarkup(tile: PublicTile, geo: Geometry, glow: boolean): string {
  const t = geo.tiles[tile.key];
  if (!t) return '';

  const corners = cornersOf(t.x, t.y);
  const pts = polygonPoints(corners, t.x, t.y);
  const delay = Math.round(Math.hypot(t.x, t.y) * 0.55);
  const fill = TERRAIN_COLOR[tile.terrain as Terrain] ?? '#9C8574';

  let g = `<g class="tile${glow ? ' prod' : ''}" data-key="${tile.key}" data-terrain="${tile.terrain}" style="animation-delay:${delay}ms">`;
  g += `<polygon points="${pts}" fill="${fill}" stroke="${INK_DEEP}" stroke-width="2.2" stroke-linejoin="round"/>`;
  g += `<polygon points="${pts}" fill="url(#grain)"/>`;
  g += `<polygon points="${pts}" fill="url(#vignette)"/>`;
  g += terrainDecor(tile.terrain as Terrain, t.x, t.y - 4);

  // 产出高亮：叠一层暖白光 + 描边脉冲，压在数字与装饰之上、道路与建筑之下
  if (glow) {
    g += `<polygon class="prod-fill" points="${pts}" fill="#FFF3CE" opacity="0"/>`;
    g += `<polygon class="prod-ring" points="${pts}" fill="none" stroke="#FFF6DC" stroke-width="4.5" stroke-linejoin="round" opacity="0"/>`;
  }

  if (tile.number !== null) {
    const hot = tile.number === 6 || tile.number === 8;
    const ink = hot ? '#C8503F' : '#3A2418';
    g += `<g filter="url(#soft)"><circle cx="${t.x}" cy="${t.y + 3}" r="18.4" fill="#FFF9F0" stroke="#3A2418" stroke-width="2"/></g>`;
    g += `<text x="${t.x}" y="${t.y + 1}" font-size="19" font-weight="700" fill="${ink}" text-anchor="middle" dominant-baseline="central" font-family="Georgia,serif">${tile.number}</text>`;
    const n = PIPS[tile.number] ?? 0;
    const gap = 4.4;
    const tw = (n - 1) * gap;
    for (let i = 0; i < n; i++) {
      g += `<circle cx="${t.x - tw / 2 + i * gap}" cy="${t.y + 14.5}" r="1.35" fill="${hot ? '#C8503F' : '#5A4033'}"/>`;
    }
  }
  return `${g}</g>`;
}

function portMarkup(edge: Edge, port: PlayerView['ports'][number]['port'], geo: Geometry): string {
  const va = geo.vertices[edge.a];
  const vb = geo.vertices[edge.b];
  if (!va || !vb) return '';

  const mx = (va.x + vb.x) / 2;
  const my = (va.y + vb.y) / 2;
  const len = Math.hypot(mx, my) || 1;
  const nx = mx / len;
  const ny = my / len;
  const hx = -ny;
  const hy = nx;
  const px = mx + nx * 38;
  const py = my + ny * 38;

  let g = `<path d="M${mx + nx * 6 + hx * 11},${my + ny * 6 + hy * 11} L${mx + nx * 24},${my + ny * 24} L${mx + nx * 6 - hx * 11},${my + ny * 6 - hy * 11}" fill="none" stroke="#7A5A34" stroke-width="4" stroke-linecap="round"/>`;
  g += `<g filter="url(#soft)"><rect x="${px - 27}" y="${py - 13}" width="54" height="26" rx="7" fill="#FFF6E4" stroke="#3A2418" stroke-width="2"/></g>`;

  if (port.kind === 'specific') {
    const color = TERRAIN_COLOR[port.resource];
    g += `<rect x="${px - 22}" y="${py - 7}" width="14" height="14" rx="4" fill="${color}" stroke="#3A2418" stroke-width="1.6"/>`;
    g += `<text x="${px + 7}" y="${py}" font-size="13" font-weight="700" fill="#3A2418" text-anchor="middle" dominant-baseline="central" font-family="Georgia,serif">2:1</text>`;
  } else {
    g += `<text x="${px}" y="${py}" font-size="13" font-weight="700" fill="#3A2418" text-anchor="middle" dominant-baseline="central" font-family="Georgia,serif">3:1</text>`;
  }
  return g;
}

/**
 * 摆位热区。刻意画得「软」：半透明白底 + 金色虚线，
 * 一眼看得出是提示而不是已经落下的建筑。
 */
function overlayMarkup(overlay: BoardOverlay, geo: Geometry): string {
  const parts: string[] = ['<g data-layer="hits">'];

  // 强盗放置热区：整块地半透明高亮，选中的那块加深描边
  for (const tk of overlay.tiles ?? []) {
    const t = geo.tiles[tk];
    if (!t) continue;
    const picked = tk === overlay.pickedTile;
    const pts = polygonPoints(cornersOf(t.x, t.y), t.x, t.y, 0.91);
    parts.push(`<g class="hit hit-tile${picked ? ' picked' : ''}" data-tile="${tk}">
      <polygon points="${pts}" fill="${picked ? '#E8B45A' : '#FFF0C0'}" fill-opacity="${picked ? '.30' : '.14'}" stroke="#C8503F" stroke-width="${picked ? 4 : 2.4}" stroke-dasharray="9 6"/>
    </g>`);
  }

  for (const ek of overlay.edges) {
    const edge = geo.edges[ek];
    if (!edge) continue;
    const va = geo.vertices[edge.a];
    const vb = geo.vertices[edge.b];
    if (!va || !vb) continue;
    parts.push(`<g class="hit hit-edge" data-edge="${ek}">
      <line x1="${va.x}" y1="${va.y}" x2="${vb.x}" y2="${vb.y}" stroke="#FFF9F0" stroke-width="15" stroke-linecap="round" opacity=".62"/>
      <line class="hit-line" x1="${va.x}" y1="${va.y}" x2="${vb.x}" y2="${vb.y}" stroke="#A9661A" stroke-width="3.6" stroke-linecap="round" stroke-dasharray="8 6"/>
    </g>`);
  }

  for (const vk of overlay.vertices) {
    const v = geo.vertices[vk];
    if (!v) continue;
    const picked = vk === overlay.picked;
    parts.push(`<g class="hit hit-vertex${picked ? ' picked' : ''}" data-vertex="${vk}">
      <circle cx="${v.x}" cy="${v.y}" r="${picked ? 17 : 12.5}" fill="${picked ? '#E8B45A' : '#FFF9F0'}" fill-opacity="${picked ? '.92' : '.5'}" stroke="#B07A2A" stroke-width="2"/>
      <circle class="hit-pulse" cx="${v.x}" cy="${v.y}" r="${picked ? 21 : 16}" fill="none" stroke="#D99A3C" stroke-width="1.6" opacity=".7"/>
    </g>`);
  }

  parts.push('</g>');
  return parts.join('');
}

export function renderBoard(
  svg: SVGSVGElement,
  view: PlayerView,
  geo: Geometry,
  overlay?: BoardOverlay,
  highlight?: ReadonlySet<string>,
): SceneHandle {
  const verts: Vertex[] = geo.vertexKeys.map((k) => geo.vertices[k]!).filter(Boolean);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  if (!Number.isFinite(minX)) {
    minX = -HEX_SIZE * 3;
    minY = -HEX_SIZE * 3;
    maxX = HEX_SIZE * 3;
    maxY = HEX_SIZE * 3;
  }

  const box = {
    x: minX - PAD,
    y: minY - PAD,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2,
  };
  svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);

  const host = svg.parentElement;
  svg.setAttribute('width', String(host?.clientWidth || 900));
  svg.setAttribute('height', String(host?.clientHeight || 600));

  const icx = (minX + maxX) / 2;
  const icy = (minY + maxY) / 2;
  const o: string[] = [];

  o.push(`<defs>
    <filter id="soft" x="-80%" y="-80%" width="260%" height="260%">
      <feDropShadow dx="0" dy="2.5" stdDeviation="2.2" flood-color="#3A2418" flood-opacity=".34"/>
    </filter>
    <filter id="island" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="13" stdDeviation="15" flood-color="#04141C" flood-opacity=".58"/>
    </filter>
    <filter id="softblur"><feGaussianBlur stdDeviation="7"/></filter>
    <radialGradient id="vignette" cx="50%" cy="50%" r="62%">
      <stop offset="52%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity=".24"/>
    </radialGradient>
    <pattern id="grain" width="9" height="9" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="3" r="1" fill="#000" opacity=".055"/>
      <circle cx="6.5" cy="7" r=".8" fill="#fff" opacity=".075"/>
    </pattern>
  </defs>`);

  // 海面：波纹 + 岛屿外圈水波
  const wx1 = minX - PAD * 3;
  const wx2 = maxX + PAD * 3;
  const wy1 = minY - PAD * 3;
  const wy2 = maxY + PAD * 3;
  o.push('<g>');
  o.push(`<ellipse cx="${icx}" cy="${wy1 + 90}" rx="${(wx2 - wx1) * 0.34}" ry="96" fill="#CFEFFA" opacity=".045"/>`);
  for (let i = 0; i < 18; i++) {
    const wy = wy1 + ((wy2 - wy1) * (i + 0.5)) / 18;
    const amp = 2.6 + (i % 3) * 1.5;
    const seg = 42 + (i % 2) * 18;
    o.push(
      `<path d="${waveLine(wx1, wx2, wy, amp, seg)}" fill="none" stroke="#D2F0FB" stroke-width="1.6" opacity="${(0.085 + (i % 3) * 0.032).toFixed(3)}"/>`,
    );
  }
  const irx = (maxX - minX) / 2 + 22;
  const iry = (maxY - minY) / 2 + 22;
  for (let k = 0; k < 4; k++) {
    o.push(
      `<ellipse cx="${icx}" cy="${icy}" rx="${irx + k * 26}" ry="${iry + k * 20}" fill="none" stroke="#DCF4FC" stroke-width="1.6" opacity="${(0.22 - k * 0.048).toFixed(3)}" stroke-dasharray="${10 + k * 5} ${16 + k * 6}"/>`,
    );
  }
  o.push('</g>');

  // 浅滩
  o.push('<g opacity=".40" filter="url(#softblur)">');
  for (const key of geo.tileKeys) {
    const t = geo.tiles[key]!;
    const pts = polygonPoints(cornersOf(t.x, t.y), t.x, t.y, 1.36);
    o.push(`<polygon points="${pts}" fill="#63BAD0"/>`);
  }
  o.push('</g>');

  // 沙滩层
  o.push('<g filter="url(#island)">');
  for (const key of geo.tileKeys) {
    const t = geo.tiles[key]!;
    const pts = polygonPoints(cornersOf(t.x, t.y), t.x, t.y, 1.16);
    o.push(`<polygon points="${pts}" fill="#E6D3A8"/>`);
  }
  o.push('</g>');

  // 地块
  o.push('<g>');
  for (const tile of view.tiles) {
    o.push(tileMarkup(tile, geo, highlight?.has(tile.key) ?? false));
  }
  o.push('</g>');

  // 港口
  o.push('<g>');
  for (const slot of view.ports) {
    const edge = geo.edges[slot.edge];
    if (edge) o.push(portMarkup(edge, slot.port, geo));
  }
  o.push('</g>');

  // 道路（先画路，再画房子，房子压住路口）
  // key 反解兜底：绝不允许「数据在 view.roads 里、棋盘上却没有」的情况静默发生
  o.push('<g data-layer="roads">');
  let drawnRoads = 0;
  for (const [edgeKey, owner] of Object.entries(view.roads)) {
    const pts = roadEndpoints(edgeKey, geo);
    const player = view.players[owner];
    if (!pts || !player) {
      console.warn('[hexfront] 道路无法定位，已跳过:', edgeKey, 'player=', owner);
      continue;
    }
    const [a, b] = pts;
    o.push(road(a.x, a.y, b.x, b.y, PLAYER_HEX[player.color], isLight(player.color)));
    drawnRoads += 1;
  }
  o.push('</g>');
  if (drawnRoads !== Object.keys(view.roads).length) {
    console.warn(`[hexfront] 道路对账不符：视图 ${Object.keys(view.roads).length} 条，画出 ${drawnRoads} 条`);
  }

  // 建筑
  o.push('<g data-layer="buildings">');
  for (const [vertexKey, building] of Object.entries(view.buildings)) {
    const p = pointFromKey(vertexKey, geo);
    const player = view.players[building.owner];
    if (!p || !player) continue;
    o.push(house(p.x, p.y, PLAYER_HEX[player.color], isLight(player.color), building.city));
  }
  o.push('</g>');

  // 强盗
  const robberTile = geo.tiles[view.robberTile];
  if (robberTile) o.push(robber(robberTile.x, robberTile.y));

  // 摆位热区永远画在最上层，否则会被建筑和数字盖住点不到
  if (overlay && (overlay.vertices.length > 0 || overlay.edges.length > 0 || (overlay.tiles?.length ?? 0) > 0)) {
    o.push(overlayMarkup(overlay, geo));
  }

  svg.innerHTML = o.join('');
  return { box };
}
