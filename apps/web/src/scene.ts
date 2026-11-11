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
import type { PlayerColor } from '@hexfront/engine';
import { INK_DEEP, isLight, PIPS, PLAYER_HEX, TERRAIN_COLOR, TERRAIN_DEEP, TERRAIN_LIGHT, PLAYER_MARK, ROAD_DASH, PAPER, ACCENT, HOT } from './theme.js';

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

function house(x: number, y: number, hex: string, light: boolean, city: boolean, mark: string): string {
  // 晴湾纸雕：厚木块棋子。奶油高光边 + 深墨纸边 + 屋顶名字首字（玩家身份第二通道）。
  const stroke = INK_DEEP;
  const w = city ? 30 : 22;
  const h = city ? 22 : 15;
  const roofH = city ? 15 : 11;
  let g = `<g transform="translate(${x},${y})" filter="url(#soft)">`;
  // 底部实色投影（纸片厚度）
  g += `<rect x="${-w / 2 - 1}" y="${-h + 2.5}" width="${w + 2}" height="${h + 1}" rx="2.5" fill="${INK_DEEP}" opacity=".35"/>`;

  if (city) {
    // 城：加高塔楼 + 小旗，一眼与村庄区分（不是单纯放大）
    g += `<rect x="${-w / 2 + 6}" y="${-h - roofH - 8}" width="9" height="${roofH + 10}" rx="1.5" fill="${hex}" stroke="${stroke}" stroke-width="1.9"/>`;
    g += `<path d="M${-w / 2 + 5} ${-h - roofH - 8} L${-w / 2 + 10.5} ${-h - roofH - 15} L${-w / 2 + 16} ${-h - roofH - 8} Z" fill="${hex}" stroke="${stroke}" stroke-width="1.9" stroke-linejoin="round"/>`;
    g += `<path d="M${-w / 2 + 10.5} ${-h - roofH - 15} l7 2.2 -7 2.2 Z" fill="${ACCENT}" stroke="${stroke}" stroke-width="1"/>`;
  }
  g += `<rect x="${-w / 2}" y="${-h}" width="${w}" height="${h}" rx="2.5" fill="${hex}" stroke="${stroke}" stroke-width="2"/>`;
  g += `<path d="M${-w / 2 - 2.5} ${-h} L0 ${-h - roofH} L${w / 2 + 2.5} ${-h} Z" fill="${hex}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>`;
  // 奶油纸高光（顶部 1px）
  g += `<path d="M${-w / 2 + 1} ${-h + 1} L0 ${-h - roofH + 2} L${w / 2 - 1} ${-h + 1}" fill="none" stroke="${PAPER}" stroke-width="1.4" opacity=".7"/>`;
  // 门洞
  g += `<rect x="-2.8" y="${-h / 2 - 1}" width="5.6" height="${h / 2 + 1}" rx="1" fill="${light ? '#C9B79B' : PAPER}" opacity=".92" stroke="${stroke}" stroke-width=".8"/>`;
  // 屋顶玩家首字（不只靠颜色区分）
  g += `<text x="0" y="${-h - roofH / 2 - 1}" font-size="8.5" font-weight="800" fill="${PAPER}" text-anchor="middle" dominant-baseline="central" stroke="${INK_DEEP}" stroke-width=".6" paint-order="stroke">${mark}</text>`;
  return `${g}</g>`;
}

/**
 * 画一条路。**这里绝对不能用 filter**：水平边（y1 === y2）的 <line> 几何 bbox 高度为 0，
 * objectBoundingBox 的滤镜区域会退化成 0，整条路被裁掉不显示 —— 表现为「偶发某条路没落上棋盘」。
 * 阴影改成一条下移的深色线，视觉几乎一致且没有裁剪风险。
 */
export function roadMarkup(x1: number, y1: number, x2: number, y2: number, hex: string, light: boolean): string {
  // 晴湾纸雕：墨底 + 奶油纸边 + 玩家色芯 + 高光，强描边让黄色道路在麦田上仍可辨。
  // 仍是 4 条 <line>、不含 filter（roads.test.ts 契约：垂直边 bbox 宽 0 不能被滤镜裁掉）。
  const ink = INK_DEEP;
  return `<g>
    <line x1="${x1}" y1="${y1 + 2.5}" x2="${x2}" y2="${y2 + 2.5}" stroke="${ink}" stroke-width="9.5" stroke-linecap="round" opacity=".30"/>
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ink}" stroke-width="8.2" stroke-linecap="round"/>
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${PAPER}" stroke-width="6.2" stroke-linecap="round" opacity=".95"/>
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${hex}" stroke-width="4.4" stroke-linecap="round"/>
  </g>`;
}

const road = roadMarkup;

function robber(x: number, y: number): string {
  // 纸雕强盗 pawn：深墨绿 + 珊瑚围巾 + 奶油高光，不挡住中心数字（画在数字片之上会遮，故置于建筑之后、数字之前）。
  return `<g transform="translate(${x},${y + 2}) scale(1.15)" filter="url(#soft)">
    <ellipse cx="0" cy="16" rx="11" ry="3" fill="${INK_DEEP}" opacity=".3"/>
    <path d="M-10,14 L-8.5,-1 Q-7.5,-7 -3.5,-8 L-2.8,-11 A4.8,4.8 0 1 1 2.8,-11 L3.5,-8 Q7.5,-7 8.5,-1 L10,14 Z" fill="#2A4036" stroke="#16261E" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M-8.5,0 Q0,4 8.5,0 L8.5,3 Q0,7 -8.5,3 Z" fill="${HOT}" stroke="#7E3626" stroke-width=".8"/>
    <ellipse cx="0" cy="-15" rx="8.4" ry="2.4" fill="#16261E"/>
    <circle cx="-2.1" cy="-11.6" r="1.05" fill="${ACCENT}"/>
    <circle cx="2.1" cy="-11.6" r="1.05" fill="${ACCENT}"/>
  </g>`;
}

function tileMarkup(tile: PublicTile, geo: Geometry, glow: boolean): string {
  const t = geo.tiles[tile.key];
  if (!t) return '';

  const corners = cornersOf(t.x, t.y);
  const pts = polygonPoints(corners, t.x, t.y);
  const delay = Math.round(Math.hypot(t.x, t.y) * 0.55);
  const terrain = tile.terrain as Terrain;
  const fill = TERRAIN_COLOR[terrain] ?? '#9C8574';
  const deep = TERRAIN_DEEP[terrain] ?? '#7A6A4F';
  const lite = TERRAIN_LIGHT[terrain] ?? '#E8D9B5';

  let g = `<g class="tile${glow ? ' prod' : ''}" data-key="${tile.key}" data-terrain="${tile.terrain}" style="animation-delay:${delay}ms">`;
  // 纸雕：底部深色纸片（厚度）+ 主色地块 + 左上奶油高光 + 深墨纸边
  g += `<polygon points="${polygonPoints(corners, t.x, t.y + 3.5, 1.02)}" fill="${deep}" stroke="${INK_DEEP}" stroke-width="2.4" stroke-linejoin="round" opacity=".9"/>`;
  g += `<polygon points="${pts}" fill="${fill}" stroke="${INK_DEEP}" stroke-width="2.6" stroke-linejoin="round"/>`;
  g += `<polygon points="${pts}" fill="url(#grain)"/>`;
  g += `<polygon points="${polygonPoints(corners, t.x, t.y, 0.965)}" fill="none" stroke="${lite}" stroke-width="1.6" stroke-linejoin="round" opacity=".55"/>`;
  g += terrainDecor(terrain, t.x, t.y - 4);

  // 产出高亮：叠一层暖白光 + 描边脉冲，压在数字与装饰之上、道路与建筑之下
  if (glow) {
    g += `<polygon class="prod-fill" points="${pts}" fill="#FFF3CE" opacity="0"/>`;
    g += `<polygon class="prod-ring" points="${pts}" fill="none" stroke="${ACCENT}" stroke-width="4.5" stroke-linejoin="round" opacity="0"/>`;
  }

  if (tile.number !== null) {
    const hot = tile.number === 6 || tile.number === 8;
    const ink = hot ? HOT : INK_DEEP;
    // 数字圆片：奶油纸 + 深墨纸边 + 内圈细线，中心干净；6/8 珊瑚红。
    g += `<g filter="url(#soft)"><circle cx="${t.x}" cy="${t.y + 3}" r="18.4" fill="${PAPER}" stroke="${INK_DEEP}" stroke-width="2.2"/></g>`;
    g += `<circle cx="${t.x}" cy="${t.y}" r="15.4" fill="none" stroke="${hot ? HOT : INK_DEEP}" stroke-width="1" opacity=".5"/>`;
    if (hot) g += `<circle cx="${t.x}" cy="${t.y}" r="18.4" fill="none" stroke="${HOT}" stroke-width="2" opacity=".55"/>`;
    g += `<text x="${t.x}" y="${t.y + 1}" font-size="19" font-weight="800" fill="${ink}" text-anchor="middle" dominant-baseline="central" font-family="Georgia,serif">${tile.number}</text>`;
    const n = PIPS[tile.number] ?? 0;
    const gap = 4.4;
    const tw = (n - 1) * gap;
    for (let i = 0; i < n; i++) {
      g += `<circle cx="${t.x - tw / 2 + i * gap}" cy="${t.y + 14.5}" r="1.35" fill="${ink}"/>`;
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

  // 纸雕港口牌：奶油纸 + 顶部木条 + 深墨描边；2:1/3:1 由代码文字渲染（不烘焙）。
  let g = `<path d="M${mx + nx * 6 + hx * 11},${my + ny * 6 + hy * 11} L${mx + nx * 24},${my + ny * 24} L${mx + nx * 6 - hx * 11},${my + ny * 6 - hy * 11}" fill="none" stroke="${INK_DEEP}" stroke-width="4.5" stroke-linecap="round"/>`;
  g += `<g filter="url(#soft)"><rect x="${px - 27}" y="${py - 13}" width="54" height="26" rx="7" fill="${PAPER}" stroke="${INK_DEEP}" stroke-width="2"/>`;
  g += `<rect x="${px - 26}" y="${py - 13}" width="52" height="5" rx="2" fill="${ACCENT}" stroke="${INK_DEEP}" stroke-width="1"/></g>`;

  if (port.kind === 'specific') {
    const color = TERRAIN_COLOR[port.resource];
    g += `<rect x="${px - 22}" y="${py - 5}" width="14" height="14" rx="4" fill="${color}" stroke="${INK_DEEP}" stroke-width="1.6"/>`;
    g += `<text x="${px + 8}" y="${py + 1}" font-size="13" font-weight="800" fill="${INK_DEEP}" text-anchor="middle" dominant-baseline="central" font-family="Georgia,serif">2:1</text>`;
  } else {
    g += `<text x="${px}" y="${py + 1}" font-size="13" font-weight="800" fill="${INK_DEEP}" text-anchor="middle" dominant-baseline="central" font-family="Georgia,serif">3:1</text>`;
  }
  return g;
}

/**
 * 摆位热区。刻意画得「软」：半透明白底 + 金色虚线，
 * 一眼看得出是提示而不是已经落下的建筑。
 */
function overlayMarkup(overlay: BoardOverlay, geo: Geometry): string {
  const parts: string[] = ['<g data-layer="hits">'];

  // 强盗放置热区：珊瑚虚线六边形 + 金色地图钉（当前强盗地块不会出现在候选里）
  for (const tk of overlay.tiles ?? []) {
    const t = geo.tiles[tk];
    if (!t) continue;
    const picked = tk === overlay.pickedTile;
    const pts = polygonPoints(cornersOf(t.x, t.y), t.x, t.y, 0.91);
    parts.push(`<g class="hit hit-tile${picked ? ' picked' : ''}" data-tile="${tk}">
      <polygon points="${pts}" fill="${picked ? ACCENT : PAPER}" fill-opacity="${picked ? '.30' : '.14'}" stroke="${HOT}" stroke-width="${picked ? 4 : 2.4}" stroke-dasharray="9 6"/>
      <g transform="translate(${t.x + 26},${t.y - 30})"><path d="M0,0 C-9,-10 -7,-22 0,-22 C7,-22 9,-10 0,0 Z" fill="${ACCENT}" stroke="${INK_DEEP}" stroke-width="1.6"/><circle cx="0" cy="-14" r="3.2" fill="${PAPER}"/></g>
    </g>`);
  }

  // 建造边：墨底 7.5 + 奶油 9 + 黄虚线 4.6 + 中点「+」徽章；命中层 15px 大于线宽
  for (const ek of overlay.edges) {
    const edge = geo.edges[ek];
    if (!edge) continue;
    const va = geo.vertices[edge.a];
    const vb = geo.vertices[edge.b];
    if (!va || !vb) continue;
    const mx = (va.x + vb.x) / 2;
    const my = (va.y + vb.y) / 2;
    parts.push(`<g class="hit hit-edge" data-edge="${ek}">
      <line x1="${va.x}" y1="${va.y}" x2="${vb.x}" y2="${vb.y}" stroke="${PAPER}" stroke-width="15" stroke-linecap="round" opacity=".62"/>
      <line x1="${va.x}" y1="${va.y}" x2="${vb.x}" y2="${vb.y}" stroke="${INK_DEEP}" stroke-width="9" stroke-linecap="round" opacity=".85"/>
      <line x1="${va.x}" y1="${va.y}" x2="${vb.x}" y2="${vb.y}" stroke="${PAPER}" stroke-width="7" stroke-linecap="round"/>
      <line class="hit-line" x1="${va.x}" y1="${va.y}" x2="${vb.x}" y2="${vb.y}" stroke="${ACCENT}" stroke-width="4.6" stroke-linecap="round" stroke-dasharray="8 6"/>
      <g transform="translate(${mx},${my})"><circle r="9" fill="${ACCENT}" stroke="${INK_DEEP}" stroke-width="2"/><path d="M-4,0 H4 M0,-4 V4" stroke="${INK_DEEP}" stroke-width="2" stroke-linecap="round"/></g>
    </g>`);
  }

  // 建造点：奶油圆 + 黄环 + 「+」；选中后「✓」。命中层 28px。
  for (const vk of overlay.vertices) {
    const v = geo.vertices[vk];
    if (!v) continue;
    const picked = vk === overlay.picked;
    parts.push(`<g class="hit hit-vertex${picked ? ' picked' : ''}" data-vertex="${vk}">
      <circle cx="${v.x}" cy="${v.y}" r="${picked ? 17 : 13}" fill="${picked ? ACCENT : PAPER}" fill-opacity=".96" stroke="${INK_DEEP}" stroke-width="2.4"/>
      <circle class="hit-pulse" cx="${v.x}" cy="${v.y}" r="${picked ? 21 : 17}" fill="none" stroke="${ACCENT}" stroke-width="2" opacity=".8"/>
      <path d="M-5,0 H5 M0,-5 V5" stroke="${INK_DEEP}" stroke-width="2.2" stroke-linecap="round"/>
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
      <feDropShadow dx="0" dy="2.5" stdDeviation="2.2" flood-color="#1A3B34" flood-opacity=".34"/>
    </filter>
    <filter id="island" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="13" stdDeviation="15" flood-color="#0D3A3E" flood-opacity=".58"/>
    </filter>
    <filter id="softblur"><feGaussianBlur stdDeviation="7"/></filter>
    <radialGradient id="vignette" cx="50%" cy="50%" r="62%">
      <stop offset="52%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity=".16"/>
    </radialGradient>
    <radialGradient id="sea" cx="50%" cy="42%" r="72%">
      <stop offset="0%" stop-color="#7AC8BF"/>
      <stop offset="38%" stop-color="#44A0A0"/>
      <stop offset="72%" stop-color="#2B7E84"/>
      <stop offset="100%" stop-color="#1D6971"/>
    </radialGradient>
    <pattern id="grain" width="9" height="9" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="3" r="1" fill="#000" opacity=".055"/>
      <circle cx="6.5" cy="7" r=".8" fill="#fff" opacity=".075"/>
    </pattern>
  </defs>`);

  // 丝网印海面：径向青绿渐变铺满画布（不烘焙文字，波纹为代码矢量）
  const wx1 = minX - PAD * 3;
  const wx2 = maxX + PAD * 3;
  const wy1 = minY - PAD * 3;
  const wy2 = maxY + PAD * 3;
  o.push(`<rect x="${wx1}" y="${wy1}" width="${wx2 - wx1}" height="${wy2 - wy1}" fill="url(#sea)"/>`);
  o.push('<g>');
  o.push(`<ellipse cx="${icx}" cy="${wy1 + 90}" rx="${(wx2 - wx1) * 0.34}" ry="96" fill="#EAF7EA" opacity=".05"/>`);
  // 纸雕太阳（右上空白海域，落在真实 viewBox 内：box.x+box.width-90）
  const sunX = box.x + box.width - 96;
  const sunY = box.y + 110;
  o.push(`<g transform="translate(${sunX},${sunY})" opacity=".9">
    <circle r="52" fill="#F7E2A8" stroke="#E9C877" stroke-width="2" opacity=".5"/>
    <circle r="40" fill="#FBF0CE" stroke="#E9C877" stroke-width="2"/>
    <g stroke="#E9C877" stroke-width="3" stroke-linecap="round">
      <path d="M0,-58 V-48 M0,48 V58 M-58,0 H-48 M48,0 H58 M-41,-41 l7,7 M41,41 l-7,-7 M41,-41 l-7,7 M-41,41 l7,-7"/>
    </g></g>`);
  for (let i = 0; i < 18; i++) {
    const wy = wy1 + ((wy2 - wy1) * (i + 0.5)) / 18;
    const amp = 2.6 + (i % 3) * 1.5;
    const seg = 42 + (i % 2) * 18;
    o.push(
      `<path d="${waveLine(wx1, wx2, wy, amp, seg)}" fill="none" stroke="#DFF2E6" stroke-width="1.6" opacity="${(0.085 + (i % 3) * 0.032).toFixed(3)}"/>`,
    );
  }
  const irx = (maxX - minX) / 2 + 22;
  const iry = (maxY - minY) / 2 + 22;
  for (let k = 0; k < 4; k++) {
    o.push(
      `<ellipse cx="${icx}" cy="${icy}" rx="${irx + k * 26}" ry="${iry + k * 20}" fill="none" stroke="#DFF2E6" stroke-width="1.6" opacity="${(0.22 - k * 0.048).toFixed(3)}" stroke-dasharray="${10 + k * 5} ${16 + k * 6}"/>`,
    );
  }
  // 右下帆船（纸雕剪影，落在真实 viewBox 内：box 右下海域）
  const boatX = box.x + box.width - 130;
  const boatY = box.y + box.height - 96;
  o.push(`<g transform="translate(${boatX},${boatY})" opacity=".82">
    <path d="M-26,12 L26,12 L18,22 L-18,22 Z" fill="${PAPER}" stroke="${INK_DEEP}" stroke-width="1.8"/>
    <path d="M0,10 L0,-26 L22,10 Z" fill="${PAPER}" stroke="${INK_DEEP}" stroke-width="1.8"/>
    <path d="M-2,8 L-2,-22 L-20,8 Z" fill="${ACCENT}" stroke="${INK_DEEP}" stroke-width="1.6"/>
    <path d="M0,-26 l9,4 -9,4" fill="${HOT}" stroke="${INK_DEEP}" stroke-width="1"/></g>`);
  o.push('</g>');

  // 浅滩
  o.push('<g opacity=".40" filter="url(#softblur)">');
  for (const key of geo.tileKeys) {
    const t = geo.tiles[key]!;
    const pts = polygonPoints(cornersOf(t.x, t.y), t.x, t.y, 1.36);
    o.push(`<polygon points="${pts}" fill="#9BDED3"/>`);
  }
  o.push('</g>');

  // 沙滩层（沙色底盘）
  o.push('<g filter="url(#island)">');
  for (const key of geo.tileKeys) {
    const t = geo.tiles[key]!;
    const pts = polygonPoints(cornersOf(t.x, t.y), t.x, t.y, 1.16);
    o.push(`<polygon points="${pts}" fill="#F2DCA9" stroke="#C39A56" stroke-width="2"/>`);
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
    // 玩家身份第二通道：道路中心虚线纹理（A 实线 / B 3 4 / C .5 4 / D 6 3）。
    // roadMarkup 本身仍是 4 条线（roads.test.ts 契约），这条纹理作为额外叠加。
    const dash = ROAD_DASH[player.color as PlayerColor];
    const center = dash && dash !== 'none'
      ? `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${PAPER}" stroke-width="1.3" stroke-linecap="round" stroke-dasharray="${dash}" opacity=".85"/>`
      : '';
    o.push(`<g>${road(a.x, a.y, b.x, b.y, PLAYER_HEX[player.color], isLight(player.color))}${center}</g>`);
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
    o.push(house(p.x, p.y, PLAYER_HEX[player.color], isLight(player.color), building.city, PLAYER_MARK[player.color as PlayerColor] ?? (player.name ?? '·').slice(0, 1)));
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
