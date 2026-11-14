/**
 * F4：棋盘选中文字与圆片对齐。
 *
 * 断言 scene.ts 通过 renderBoard 产出的 SVG 字符串行为：
 *  - 数字圆片统一以 (t.x, t.y) 为共同中心；纸雕阴影独立绘制（下移 3px）。
 *  - 装饰/数字被 pointer-events="none" 的组包裹，但外层 tile 组仍可命中。
 *  - 单/双位数字都 text-anchor=middle + dominant-baseline=central，不给两位数偏移。
 *  - PIPS 表、6/8 红色外环与加粗保持；沙漠分支不变。
 *  - styles.css 有 #board 的 user-select:none，且无全局 * 规则、不波及输入/可复制信息。
 *
 * renderBoard 需要一个 svg 元素：用 test/fixtures/mini-dom.ts 的 MiniDocument，
 * 与 phase-d-fix-panels.test.ts 的用法一致（不引入 jsdom，不新增依赖）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_4P, buildBoard, createGame, viewFor } from '@hexfront/engine';
import { renderBoard } from '../src/scene.js';
import { PIPS, HOT, INK_DEEP, PAPER } from '../src/theme.js';
import { MiniDocument } from './fixtures/mini-dom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 渲染一次真实棋盘，拿到 SVG 字符串（此后所有断言都针对这个字符串）
// ---------------------------------------------------------------------------

const board = buildBoard(MAP_4P);
const geo = board.geo;
const state = createGame(board, ['甲', '乙', '丙', '丁'], ['red', 'blue', 'white', 'orange']);
const view = viewFor(board, state, 0);

const doc = new MiniDocument('<html><body><div><svg id="board"></svg></div></body></html>');
const svgEl = doc.getElementById('board')!;
renderBoard(svgEl as unknown as Parameters<typeof renderBoard>[0], view, geo);
const svg = svgEl.innerHTML;

// ---------------------------------------------------------------------------
// 工具：解析一个标签上的 key="value" 属性；取某地块的几何中心字符串。
// 坐标字符串必须与 scene.ts 完全一致（scene.ts 用同一个 geo.tiles[key]，
// 用 `${t.x}` / `${t.y}` 拼进 SVG），所以从同一个 geo 取值即可逐字对齐。
// ---------------------------------------------------------------------------

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

function circles(inner: string): Record<string, string>[] {
  return [...inner.matchAll(/<circle[^>]*>/g)].map((m) => attrs(m[0]!));
}

function texts(inner: string): Record<string, string>[] {
  return [...inner.matchAll(/<text[^>]*>[^<]*<\/text>/g)].map((m) => attrs(m[0]!));
}

function coords(key: string) {
  const t = geo.tiles[key]!;
  return {
    key,
    x: t.x,
    y: t.y,
    tx: `${t.x}`,
    ty: `${t.y}`,
    tyShadow: `${t.y + 3}`,
    tyPips: `${t.y + 14.5}`,
  };
}

/** 找到某个数字圆片的 <g pointer-events="none">…</g>（其内部仅有一个嵌套阴影 <g>）。 */
function discFor(num: number, c: ReturnType<typeof coords>): { full: string; inner: string } {
  const re = /<g pointer-events="none">([\s\S]*?)<\/g><\/g>/g;
  for (const m of svg.matchAll(re)) {
    const full = m[0]!;
    const inner = m[1]!;
    if (inner.includes(`<text x="${c.tx}" y="${c.ty}"`) && inner.includes(`>${num}</text>`)) {
      return { full, inner };
    }
  }
  throw new Error(`未找到数字 ${num}（${c.key}）的数字圆片`);
}

/** 代表性地块：单/双位、6/8 高产点、普通点。 */
const TILES = [
  { key: '2,0', num: 2, hot: false },   // 单位数 · 非红
  { key: '0,0', num: 10, hot: false },  // 双位数 · 非红
  { key: '-1,1', num: 12, hot: false }, // 双位数 · 非红
  { key: '1,1', num: 6, hot: true },    // 单位数 · 6/8 红环
  { key: '-3,3', num: 8, hot: true },   // 单位数 · 6/8 红环
];

// ---------------------------------------------------------------------------

describe('F4 · 数字圆片：共同中心 (t.x, t.y)', () => {
  it('主圆 / 内圈 / 数字 text / 6-8 红环的 cy、y 都等于同一个 t.y', () => {
    for (const t of TILES) {
      const c = coords(t.key);
      const { inner } = discFor(t.num, c);
      const cs = circles(inner);
      const ts = texts(inner);

      const r184 = cs.filter((a) => a.r === '18.4');
      const main = r184.find((a) => a.fill === PAPER && a.stroke === INK_DEEP && !a.opacity)!;
      const innerRing = cs.find((a) => a.r === '15.4')!;
      const text = ts[0]!;
      const ring = r184.find((a) => a.fill === 'none' && a.stroke === HOT);

      // 收集所有「本应同心」的中心，必须恰好是同一个 t.y（不是 y+1、不是 y+3）。
      const centers = [main.cy!, innerRing.cy!, text.y!, ...(ring ? [ring.cy!] : [])];
      expect(new Set(centers), `地块 ${t.key} 数字 ${t.num}`).toEqual(new Set([c.ty]));

      // 明确排除旧缺陷里的 y+1 文字偏移与 y+3 外圈偏移。
      expect(inner, `地块 ${t.key} 不应再有 y+1 数字偏移`).not.toContain(`y="${c.y + 1}"`);
      expect(main.cy, `地块 ${t.key} 主圆须在 t.y`).toBe(c.ty);
    }
  });

  it('纸雕阴影是独立绘制元素，下移 3px（与主圆不同 cy）', () => {
    const c = coords('0,0');
    const { inner } = discFor(10, c);

    // 阴影单独装在自己的 <g filter="url(#soft)"> 里，且 cy = t.y + 3。
    const shadowGroup = /<g filter="url\(#soft\)">(<circle[^>]*>)<\/g>/.exec(inner);
    expect(shadowGroup).not.toBeNull();
    const shadow = attrs(shadowGroup![1]!);
    expect(shadow.cy).toBe(c.tyShadow);
    expect(shadow.cy).not.toBe(c.ty); // 与主圆不同中心
    expect(c.tyShadow).toBe(`${c.y + 3}`);

    // 主圆（PAPER 底片 + INK_DEEP 描边）用 cy = t.y，与阴影是两个独立元素。
    const main = circles(inner).find((a) => a.r === '18.4' && a.fill === PAPER && !a.opacity)!;
    expect(main.cy).toBe(c.ty);
  });

  it('数字 <text> 被 pointer-events="none" 的组包裹；外层 tile 组仍不加', () => {
    for (const t of TILES) {
      const c = coords(t.key);
      const { full, inner } = discFor(t.num, c);
      // 数字 text 不落在指针命中起点上（避免拖动时原生文本选择）。
      expect(full.startsWith('<g pointer-events="none">')).toBe(true);
      expect(inner).toContain('<text');

      // 相机命中走外层 <g class="tile" data-key=…>：必须保留且不带 pointer-events:none。
      const tileOpen = new RegExp(`<g class="tile[^"]*" data-key="${c.key}"[^>]*>`).exec(svg)?.[0];
      expect(tileOpen, `地块 ${t.key} 的 tile 组应保留`).toBeDefined();
      expect(tileOpen).not.toContain('pointer-events');
    }
  });

  it('单/双位数字都 text-anchor="middle" + dominant-baseline="central"，且不给两位数单独偏移', () => {
    for (const t of TILES) {
      const c = coords(t.key);
      const { inner } = discFor(t.num, c);
      const text = texts(inner)[0]!;
      expect(text['text-anchor']).toBe('middle');
      expect(text['dominant-baseline']).toBe('central');
      // 单位数与双位数用同一套 x=t.x / y=t.y 居中，不给两位数加偏移。
      expect(text.x).toBe(c.tx);
      expect(text.y).toBe(c.ty);
      expect(inner).toContain(`>${t.num}</text>`);
    }
  });

  it('概率点以共同中心为基准（cy = t.y + 14.5），PIPS 表与 6/8 红色加粗保留', () => {
    for (const t of TILES) {
      const c = coords(t.key);
      const { inner } = discFor(t.num, c);
      const cs = circles(inner);
      const pips = cs.filter((a) => a.r === '1.35');
      expect(pips.length, `地块 ${t.key} 数字 ${t.num} 的 pips 数`).toBe(PIPS[t.num] ?? 0);
      for (const p of pips) {
        expect(p.cy).toBe(c.tyPips); // 相对共同中心的固定偏移
      }
      // cx 围绕 t.x 对称（保留 t.x - tw/2 + i*gap 逻辑）：
      // 最小与最大 cx 的中点数值上应落在 t.x（用容差，浮点运算会带极小残差）。
      const xs = pips.map((p) => Number(p.cx));
      expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(2 * c.x, 6);

      const r184 = cs.filter((a) => a.r === '18.4');
      const ring = r184.find((a) => a.fill === 'none' && a.stroke === HOT);
      const text = texts(inner)[0]!;
      if (t.hot) {
        expect(ring, `地块 ${t.key} 应有 6/8 红色外环`).toBeDefined();
        expect(ring!.cy).toBe(c.ty);
        expect(text.fill).toBe(HOT); // 红色数字
        expect(text['font-weight']).toBe('800'); // 加粗
      } else {
        expect(ring).toBeUndefined(); // 普通数字没有红环
        expect(text.fill).toBe(INK_DEEP);
      }
    }
  });

  it('沙漠（number === null）不画数字圆片；其余 18 个地块各画一个', () => {
    const groups = [...svg.matchAll(/<g pointer-events="none">/g)];
    expect(groups.length).toBe(18); // MAP_4P 共 19 格，1 个沙漠
    const desertChunk = svg.split(/(?=<g class="tile)/).find((s) => s.includes('data-key="0,2"'));
    expect(desertChunk).toBeDefined();
    expect(desertChunk).not.toContain('pointer-events="none"');
    expect(desertChunk).not.toContain('dominant-baseline');
  });
});

describe('F4 · styles.css 禁止棋盘文字选中，不波及输入/可复制信息', () => {
  const css = readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ''); // 去注释，避免把注释文字当选择器

  it('#board 及其内部文字/地块/图层有 user-select:none + -webkit 前缀', () => {
    expect(clean).toMatch(/#board[^{]*\{[^}]*user-select\s*:\s*none/i);
    expect(clean).toMatch(/#board[^{]*\{[^}]*-webkit-user-select\s*:\s*none/i);
  });

  it('不存在 * { user-select:none } 全局规则；输入/可复制信息保持默认可选', () => {
    expect(clean).not.toMatch(/\*\s*\{[^}]*user-select\s*:\s*none/i);
    // 找出所有「含 user-select:none」的规则块，检查其选择器。
    const noneBlocks = [...clean.matchAll(/([^{}]+)\{([^}]*user-select\s*:\s*none[^}]*)\}/gi)];
    expect(noneBlocks.length).toBeGreaterThan(0);
    for (const m of noneBlocks) {
      const selector = m[1]!.trim();
      expect(selector).not.toBe('*');
      expect(selector).not.toMatch(/\binput\b|\btextarea\b|contenteditable/i);
    }
  });

  it('大厅预览 .lb-hex text 的既有 user-select:none 规则未被改动', () => {
    expect(clean).toMatch(/\.lb-hex text\s*\{[^}]*user-select\s*:\s*none/i);
  });
});

// ---------------------------------------------------------------- 装饰避让数字

describe('F4 · 地形装饰与强盗不得遮挡数字圆片', () => {
  const DISC_R = 18.4;
  const DISC_MARGIN = 2;   // 描边余量
  const src = (): string => readFileSync(path.join(ROOT, 'src/scene.ts'), 'utf8');

  it('装饰组整体位于数字圆片下方（偏移 - 最大上探 ≥ 圆片半径 + 余量）', () => {
    // 装饰原始上探约 41px（wheatStalk(-5,-30) 等），缩放下移后必须整体落在圆片外
    const m = /terrainDecor\(terrain,\s*t\.x,\s*t\.y\s*\+\s*(\d+),\s*([\d.]+)\)/.exec(src());
    expect(m, 'scene.ts 应以「固定偏移 + 缩放」调用 terrainDecor').not.toBeNull();
    const offset = Number(m![1]);
    const scale = Number(m![2]);
    expect(scale).toBeLessThan(1);
    // 装饰 bbox 上探约 41*scale；要求它整体落在圆片（含描边）之外
    expect(offset - 41 * scale).toBeGreaterThanOrEqual(DISC_R + DISC_MARGIN);
  });

  it('强盗带 data-role="robber"，中心在地块右下角而不是数字圆片中心', () => {
    const text = src();
    expect(text).toContain('data-role="robber"');
    const m = /data-role="robber"\s+transform="translate\(\$\{x \+ (\d+)\},\$\{y \+ (\d+)\}\)\s*scale\(([\d.]+)\)"/.exec(text);
    expect(m, '强盗应以右下角偏移绘制').not.toBeNull();
    const dx = Number(m![1]);
    const dy = Number(m![2]);
    expect(Math.hypot(dx, dy)).toBeGreaterThan(DISC_R);
  });
});
