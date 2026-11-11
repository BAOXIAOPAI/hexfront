/**
 * D-01 行为测试：真实 pointerdown → pointerup → click 序列。
 *
 * 旧实现把手势监听绑在整个 .board-stage 上，而缩放/确认/弃牌/强盗/报价
 * 浮层都是它的子节点。结果：按钮上的 pointer 也进入手势流程，handleUp 触发
 * 棋盘 onTap 并置 suppressClick，随后捕获阶段把原生 click 吃掉，按钮 handler
 * 永远收不到事件（浏览器实测「确认」点了没反应、Enter 却成功）。
 *
 * 本测试用真实事件序列验证「棋盘输入层 / UI 控件」边界，而不是只断言按钮存在。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MiniDocument, MiniEvent, fire, installGlobals, makeWindow,
  type MiniElement, type MiniWindow,
} from './fixtures/mini-dom.js';
import { BoardCamera, DRAG_THRESHOLD_PX, isUiControlTarget } from '../src/camera.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let doc: MiniDocument;
let win: MiniWindow;
let restore: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
  doc = new MiniDocument(HTML);
  win = makeWindow();
  restore = installGlobals(doc, win);
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

function stage(): MiniElement { return doc.getElementById('board-stage')!; }
function svg(): MiniElement { return doc.getElementById('board')!; }
function el(id: string): MiniElement { return doc.getElementById(id)!; }

/** 把 SVG 内的一个热区当作点选目标（真实子元素，事件会冒泡到 svg） */
function addSvgHit(): MiniElement {
  svg().innerHTML = '<g class="hit hit-tile" data-tile="0,0"><polygon points="0,0 1,1 2,2"/></g>';
  return svg().querySelector('[data-tile]')!;
}

describe('D-01 · 棋盘输入层与 UI 控件边界', () => {
  it('index.html 已把浮层标成 data-board-ui，SVG 是唯一棋盘输入层', () => {
    expect(el('board').hasAttribute('data-board-input')).toBe(true);
    for (const id of ['cam-tools', 'confirm-strip', 'setupbar', 'robberbar', 'discard', 'offer']) {
      expect(el(id).hasAttribute('data-board-ui'), `${id} 缺 data-board-ui`).toBe(true);
    }
    for (const id of ['situation', 'toast', 'table-empty', 'setupbar']) {
      expect(el(id).hasAttribute('data-info-only'), `${id} 应为纯说明`).toBe(true);
    }
  });

  it('isUiControlTarget 认出按钮与标记浮层，但棋盘热区不是 UI 控件', () => {
    const asTarget = (n: MiniElement): EventTarget => n as unknown as EventTarget;
    expect(isUiControlTarget(asTarget(el('zoom-in')))).toBe(true);
    expect(isUiControlTarget(asTarget(el('confirm-strip')))).toBe(true);
    const hit = addSvgHit();
    expect(isUiControlTarget(asTarget(hit))).toBe(false);
    expect(isUiControlTarget(null)).toBe(false);
  });

  it('点浮层按钮：真实 pointerdown→pointerup→click 后按钮 handler 收到 click，棋盘 onTap 不被调用', () => {
    const onTap = vi.fn();
    const cam = new BoardCamera(stage() as unknown as HTMLElement, svg() as unknown as SVGSVGElement, onTap);
    const btn = el('zoom-in');
    const btnClick = vi.fn();
    btn.addEventListener('click', btnClick);

    // 用户用手指/鼠标完整地点了一次按钮
    fire(btn, 'pointerdown', { pointerId: 7, clientX: 800, clientY: 20 });
    fire(btn, 'pointerup', { pointerId: 7, clientX: 800, clientY: 20 });
    const click = fire(btn, 'click', { clientX: 800, clientY: 20 });

    expect(btnClick).toHaveBeenCalledTimes(1);
    expect(click.defaultPrevented).toBe(false);       // click 没被捕获阶段吃掉
    expect(onTap).not.toHaveBeenCalled();             // 更没有顺带选中棋盘位置
    expect(btn.captured).toEqual([]);                 // 也没把 pointer capture 抢到棋盘
    cam.destroy();
  });

  it('点在棋盘热区：onTap 只触发一次，随后的原生 click 在捕获阶段被吃掉（防止 DOM 委托重复处理）', () => {
    const onTap = vi.fn();
    const cam = new BoardCamera(stage() as unknown as HTMLElement, svg() as unknown as SVGSVGElement, onTap);
    const hit = addSvgHit();
    const bubble = vi.fn();
    svg().addEventListener('click', bubble);   // 模拟 ui.ts 的 onBoardClick 兜底

    fire(hit, 'pointerdown', { pointerId: 3, clientX: 100, clientY: 100 });
    fire(hit, 'pointerup', { pointerId: 3, clientX: 100, clientY: 100 });
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledWith(100, 100);
    expect(svg().captured).toEqual([3]);        // capture 落在棋盘输入层（SVG），不是舞台
    expect(svg().released).toEqual([3]);
    expect(stage().captured).toEqual([]);

    const click = fire(hit, 'click', { clientX: 100, clientY: 100 });
    expect(click.defaultPrevented).toBe(true);
    expect(bubble).not.toHaveBeenCalled();
    cam.destroy();
  });

  it('拖动超过阈值后抬手不建造，且不会吃掉随后 UI 按钮的 click', () => {
    const onTap = vi.fn();
    const cam = new BoardCamera(stage() as unknown as HTMLElement, svg() as unknown as SVGSVGElement, onTap);
    const hit = addSvgHit();
    const zoom = el('zoom-in');
    const zoomClick = vi.fn();
    zoom.addEventListener('click', zoomClick);

    fire(hit, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    fire(hit, 'pointermove', { pointerId: 1, clientX: 100 + DRAG_THRESHOLD_PX + 5, clientY: 100 });
    fire(hit, 'pointerup', { pointerId: 1, clientX: 100 + DRAG_THRESHOLD_PX + 5, clientY: 100 });
    expect(onTap).not.toHaveBeenCalled();

    // 拖动产生的 click 落在棋盘上 → 被抑制
    const dragClick = fire(hit, 'click', {});
    expect(dragClick.defaultPrevented).toBe(true);

    // 紧接着点浮层按钮，绝不能被上一次残留的 suppressClick 吃掉
    fire(zoom, 'pointerdown', { pointerId: 2, clientX: 800, clientY: 20 });
    fire(zoom, 'pointerup', { pointerId: 2, clientX: 800, clientY: 20 });
    const btnClick = fire(zoom, 'click', {});
    expect(btnClick.defaultPrevented).toBe(false);
    expect(zoomClick).toHaveBeenCalledTimes(1);
    cam.destroy();
  });

  it('双指结束后不误选：两根手指依次抬起都不触发 onTap', () => {
    const onTap = vi.fn();
    const cam = new BoardCamera(stage() as unknown as HTMLElement, svg() as unknown as SVGSVGElement, onTap);
    const hit = addSvgHit();
    fire(hit, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    fire(hit, 'pointerdown', { pointerId: 2, clientX: 160, clientY: 100 });
    fire(hit, 'pointermove', { pointerId: 2, clientX: 200, clientY: 100 });
    fire(hit, 'pointerup', { pointerId: 2, clientX: 200, clientY: 100 });
    fire(hit, 'pointerup', { pointerId: 1, clientX: 100, clientY: 100 });
    expect(onTap).not.toHaveBeenCalled();
    cam.destroy();
  });

  it('wheel 落在浮层上不缩放也不 preventDefault；落在棋盘上才缩放', () => {
    const onTap = vi.fn();
    const cam = new BoardCamera(stage() as unknown as HTMLElement, svg() as unknown as SVGSVGElement, onTap);
    cam.setScene({ x: 0, y: 0, width: 1000, height: 800 }, []);
    const before = cam.state.zoom;

    const overUi = fire(el('discard'), 'wheel', { deltaY: -100, clientX: 200, clientY: 200 });
    expect(overUi.defaultPrevented).toBe(false);
    expect(cam.state.zoom).toBe(before);

    const overBoard = fire(svg(), 'wheel', { deltaY: -100, clientX: 200, clientY: 200 });
    expect(overBoard.defaultPrevented).toBe(true);
    expect(cam.state.zoom).toBeGreaterThan(before);
    cam.destroy();
  });

  it('clipboard：捕获阶段只抑制棋盘 click，纯说明浮层的 click 也照常放行', () => {
    const onTap = vi.fn();
    const cam = new BoardCamera(stage() as unknown as HTMLElement, svg() as unknown as SVGSVGElement, onTap);
    const hit = addSvgHit();
    fire(hit, 'pointerdown', { pointerId: 9, clientX: 50, clientY: 50 });
    fire(hit, 'pointerup', { pointerId: 9, clientX: 50, clientY: 50 });
    // 用户点了一下情境提示（纯说明），不应被上一次的抑制标记误伤
    const info = el('situation');
    const infoClick = vi.fn();
    info.addEventListener('click', infoClick);
    const click = fire(info, 'click', {});
    expect(click.defaultPrevented).toBe(false);
    expect(infoClick).toHaveBeenCalledTimes(1);
    cam.destroy();
  });

  it('destroy() 解绑棋盘层监听，不再响应 pointer', () => {
    const onTap = vi.fn();
    const cam = new BoardCamera(stage() as unknown as HTMLElement, svg() as unknown as SVGSVGElement, onTap);
    cam.destroy();
    const hit = addSvgHit();
    fire(hit, 'pointerdown', { pointerId: 1 });
    fire(hit, 'pointerup', { pointerId: 1 });
    expect(onTap).not.toHaveBeenCalled();
  });

  it('MiniEvent 的 stopImmediatePropagation 能阻断同节点后续监听（捕获阶段抑制基础）', () => {
    const node = el('board');
    const calls: string[] = [];
    node.addEventListener('click', (e) => { calls.push('capture'); e.stopImmediatePropagation(); }, true);
    node.addEventListener('click', () => calls.push('bubble'));
    fire(node, 'click', {});
    expect(calls).toEqual(['capture']);
  });
});
