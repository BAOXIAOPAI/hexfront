/**
 * ULS：CSS 自旋转后的触摸命中验证。
 *
 * 这三个文件（camera.ts / panels.ts / layout.css）里最容易出错的一处是：
 * rotate(±90deg) 之后 getBoundingClientRect() 的 AABB 宽高互换、坐标轴交换，
 * 继续用 clientX-r.left / clientY-r.top 会把命中整体转 90° 并镜像。
 * 这里用真实几何反解 + 真实 BoardCamera + 真实 pointer 序列验证：
 * - 纯函数 clientToLocal / localToClient 在 0 / 90 / -90 三种角度互为逆运算；
 * - 旋转后 measure() 把 W/H 换回来，nearest() 命中正确的候选；
 * - 8px 拖动阈值、双指缩放、pointer capture 不回归；
 * - 旋转模式切换只重算几何，不丢 zoom/pan，也不丢待确认的选择；
 * - 真实 Ui 端到端：旋转画布上点道路 → 确认条 → COMMAND 回调带正确的 key。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_4P, buildBoard, createGame, viewFor, type PlayerView } from '@hexfront/engine';
import {
  MiniDocument, MiniEvent, fire, installGlobals, makeWindow, type MiniWindow,
} from './fixtures/mini-dom.js';
import {
  BoardCamera, clientToLocal, localToClient, measureRotated, resolveHits,
  DRAG_THRESHOLD_PX, MAX_HIT_PX, type LandscapeRotation,
  type BoardCandidate, type Hit,
} from '../src/camera.js';
import { Ui, type UiCallbacks } from '../src/ui.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const g = globalThis as unknown as Record<string, unknown>;

// 竖屏视口 Vw=390 / Vh=844；画布 844×390，顶栏 44px → 舞台局部 844×346。
// 舞台局部框 [0,44]-[844,390]，两种旋转对应的 AABB：
//   cw : r.left=Vw-44-346=0, r.top=0, r.width=346, r.height=844
//   ccw: r.left=44,          r.top=0, r.width=346, r.height=844
const CW_RECT = { left: 0, top: 0, width: 346, height: 844 };
const CCW_RECT = { left: 44, top: 0, width: 346, height: 844 };
const FLAT_RECT = { left: 0, top: 0, width: 844, height: 390 };

let doc: MiniDocument;
let win: MiniWindow;
let restore: () => void;

function setPortrait(portrait: boolean): void {
  g['matchMedia'] = (q: string) => ({
    matches: portrait && q.includes('portrait'), media: q,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  });
  g['innerWidth'] = portrait ? 390 : 844;
  g['innerHeight'] = portrait ? 844 : 390;
}

beforeEach(() => {
  vi.useFakeTimers();
  doc = new MiniDocument(HTML);
  win = makeWindow();
  restore = installGlobals(doc, win);
  setPortrait(true);
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

function stageEl() { return doc.getElementById('board-stage')!; }
function svgEl() { return doc.getElementById('board')!; }
function svgChild(): ReturnType<MiniDocument['createElement']> {
  const node = doc.createElement('circle');
  node.parent = svgEl();
  svgEl().children.push(node);
  return node;
}

describe('ULS · 坐标换算纯函数（真实几何反解）', () => {
  it('cw：舞台局部 (400,200) → 客户端 (146,400)，反解一致', () => {
    // 画布 client = (Vw - y, x)；舞台 y 还要加上顶栏 44
    expect(localToClient(CW_RECT, 400, 200, 90)).toEqual({ clientX: 146, clientY: 400 });
    expect(clientToLocal(CW_RECT, 146, 400, 90)).toEqual({ x: 400, y: 200 });
  });

  it('ccw：舞台局部 (400,200) → 客户端 (244,444)，反解一致', () => {
    // 画布 client = (y, Vh - x)；舞台 y 加上顶栏 44
    expect(localToClient(CCW_RECT, 400, 200, -90)).toEqual({ clientX: 244, clientY: 444 });
    expect(clientToLocal(CCW_RECT, 244, 444, -90)).toEqual({ x: 400, y: 200 });
  });

  it('0 / 90 / -90 三种角度 clientToLocal ↔ localToClient 都是恒等往返', () => {
    for (const rot of [0, 90, -90] as LandscapeRotation[]) {
      const rect = rot === 0 ? FLAT_RECT : rot === 90 ? CW_RECT : CCW_RECT;
      for (const p of [{ x: 0, y: 0 }, { x: 400, y: 200 }, { x: 843, y: 345 }]) {
        const c = localToClient(rect, p.x, p.y, rot);
        const back = clientToLocal(rect, c.clientX, c.clientY, rot);
        expect(back.x, `rot=${rot}`).toBeCloseTo(p.x, 6);
        expect(back.y, `rot=${rot}`).toBeCloseTo(p.y, 6);
      }
    }
  });

  it('旋转保持距离：8px 阈值不会因坐标轴交换而缩小', () => {
    const a = clientToLocal(CW_RECT, 146, 400, 90);
    const b = clientToLocal(CW_RECT, 146 + DRAG_THRESHOLD_PX + 1, 400, 90);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(DRAG_THRESHOLD_PX + 1, 6);
  });

  it('measureRotated 把 AABB 宽高换回来，未旋转时原样保留', () => {
    expect(measureRotated(CW_RECT, 90)).toEqual({ W: 844, H: 346 });
    expect(measureRotated(CCW_RECT, -90)).toEqual({ W: 844, H: 346 });
    expect(measureRotated(FLAT_RECT, 0)).toEqual({ W: 844, H: 390 });
  });

  it('若沿用旧的「clientX-left / clientY-top」减法，命中会离目标 300px 以上', () => {
    const p = { x: 400, y: 200 };
    const c = localToClient(CW_RECT, p.x, p.y, 90);
    const naive = { x: c.clientX - CW_RECT.left, y: c.clientY - CW_RECT.top };
    expect(Math.hypot(naive.x - p.x, naive.y - p.y)).toBeGreaterThan(MAX_HIT_PX);
  });
});

describe('ULS · BoardCamera 在旋转画布上的真实手势', () => {
  const BOX = { x: 0, y: 0, width: 1000, height: 800 };
  const CANDIDATES: BoardCandidate[] = [
    { key: 'v1', kind: 'vertex', x: 500, y: 400 },
    { key: 'v2', kind: 'vertex', x: 900, y: 760 },
  ];

  function rotateCamera(rot: LandscapeRotation, rect = CW_RECT) {
    stageEl().rect = { ...rect };
    const onTap = vi.fn();
    const cam = new BoardCamera(
      stageEl() as unknown as HTMLElement,
      svgEl() as unknown as SVGSVGElement,
      onTap,
      () => rot,
    );
    cam.measure();
    cam.setScene(BOX, CANDIDATES);
    return { cam, onTap };
  }

  it('cw：measure 换回 W/H，nearest 精确命中变换后的客户端坐标', () => {
    const { cam } = rotateCamera(90);
    expect(cam.state.W).toBe(844);
    expect(cam.state.H).toBe(346);
    const p = cam.worldToScreen(CANDIDATES[0]!);
    const r = stageEl().getBoundingClientRect();
    const c = localToClient(r, p.x, p.y, 90);
    const hits: Hit[] = cam.nearest(c.clientX, c.clientY);
    expect(hits[0]!.candidate.key).toBe('v1');
    expect(hits[0]!.dist).toBeLessThan(1e-6);
    // 反证：把局部坐标当客户端坐标喂进去，旧实现会完全点不中
    expect(cam.nearest(p.x, p.y)[0]!.dist).toBeGreaterThan(MAX_HIT_PX);
    cam.destroy();
  });

  it('ccw：反向自转同样命中正确候选', () => {
    const { cam } = rotateCamera(-90, CCW_RECT);
    const p = cam.worldToScreen(CANDIDATES[0]!);
    const r = stageEl().getBoundingClientRect();
    const c = localToClient(r, p.x, p.y, -90);
    expect(cam.nearest(c.clientX, c.clientY)[0]!.candidate.key).toBe('v1');
    expect(cam.nearest(c.clientX, c.clientY)[0]!.dist).toBeLessThan(1e-6);
    cam.destroy();
  });

  it('真实 pointerdown→pointerup：onTap 收到客户端坐标，capture 落在棋盘层', () => {
    const { cam, onTap } = rotateCamera(90);
    const p = cam.worldToScreen(CANDIDATES[0]!);
    const c = localToClient(stageEl().getBoundingClientRect(), p.x, p.y, 90);
    const hit = svgChild();
    fire(hit, 'pointerdown', { pointerId: 5, clientX: c.clientX, clientY: c.clientY });
    fire(hit, 'pointerup', { pointerId: 5, clientX: c.clientX, clientY: c.clientY });
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledWith(c.clientX, c.clientY);
    expect(svgEl().captured).toEqual([5]);
    expect(svgEl().released).toEqual([5]);
    // Ui.handleBoardTap 会拿这两个坐标去 nearest —— 必须能选中 v1
    expect(resolveHits(cam.nearest(c.clientX, c.clientY)).kind).toBe('single');
    cam.destroy();
  });

  it('旋转后拖动超过 8px 抬手不触发 onTap（阈值不回归）', () => {
    const { cam, onTap } = rotateCamera(90);
    const p = cam.worldToScreen(CANDIDATES[0]!);
    const c = localToClient(stageEl().getBoundingClientRect(), p.x, p.y, 90);
    const hit = svgChild();
    fire(hit, 'pointerdown', { pointerId: 1, clientX: c.clientX, clientY: c.clientY });
    fire(hit, 'pointermove', {
      pointerId: 1, clientX: c.clientX + DRAG_THRESHOLD_PX + 1, clientY: c.clientY,
    });
    fire(hit, 'pointerup', {
      pointerId: 1, clientX: c.clientX + DRAG_THRESHOLD_PX + 1, clientY: c.clientY,
    });
    expect(onTap).not.toHaveBeenCalled();
    cam.destroy();
  });

  it('旋转后双指缩放仍生效且不误选（mid 需按旋转反解回客户端坐标）', () => {
    const { cam, onTap } = rotateCamera(90);
    const p = cam.worldToScreen(CANDIDATES[0]!);
    const c = localToClient(stageEl().getBoundingClientRect(), p.x, p.y, 90);
    const hit = svgChild();
    fire(hit, 'pointerdown', { pointerId: 1, clientX: c.clientX, clientY: c.clientY });
    fire(hit, 'pointerdown', { pointerId: 2, clientX: c.clientX, clientY: c.clientY + 40 });
    fire(hit, 'pointermove', { pointerId: 2, clientX: c.clientX, clientY: c.clientY + 100 });
    fire(hit, 'pointerup', { pointerId: 2, clientX: c.clientX, clientY: c.clientY + 100 });
    fire(hit, 'pointerup', { pointerId: 1, clientX: c.clientX, clientY: c.clientY });
    expect(cam.state.zoom).toBeGreaterThan(1);
    expect(onTap).not.toHaveBeenCalled();
    cam.destroy();
  });

  it('旋转后抽屉/浮层按钮的 click 不被吞，也不会顺带命中棋盘', () => {
    const { cam, onTap } = rotateCamera(90);
    const btn = doc.getElementById('zoom-in')!;
    const click = vi.fn();
    btn.addEventListener('click', click);
    const p = cam.worldToScreen(CANDIDATES[0]!);
    const c = localToClient(stageEl().getBoundingClientRect(), p.x, p.y, 90);
    fire(btn, 'pointerdown', { pointerId: 7, clientX: c.clientX, clientY: c.clientY });
    fire(btn, 'pointerup', { pointerId: 7, clientX: c.clientX, clientY: c.clientY });
    const ev = fire(btn, 'click', { clientX: c.clientX, clientY: c.clientY });
    expect(click).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(false);
    expect(onTap).not.toHaveBeenCalled();
    expect(svgEl().captured).toEqual([]);
    cam.destroy();
  });

  it('角度切换（0→90）只重算 W/H，zoom / pan 原样保留', () => {
    let rot: LandscapeRotation = 0;
    stageEl().rect = { ...FLAT_RECT };
    const cam = new BoardCamera(
      stageEl() as unknown as HTMLElement, svgEl() as unknown as SVGSVGElement,
      vi.fn(), () => rot,
    );
    cam.setScene(BOX, CANDIDATES);
    cam.zoomAt(1.25);
    cam.measure();
    const before = cam.state;
    rot = 90;
    stageEl().rect = { ...CW_RECT };
    cam.measure();                     // 等价于 Ui.relayout()
    expect(cam.state.W).toBe(844);
    expect(cam.state.H).toBe(346);
    expect(cam.state.zoom).toBe(before.zoom);
    expect(cam.state.panX).toBe(before.panX);
    expect(cam.state.panY).toBe(before.panY);
    expect(cam.state.zoom).toBeGreaterThan(1);
    cam.destroy();
  });
});

// ---------------------------------------------------------------- 真实 Ui 端到端
function seededPlayView(): PlayerView {
  const board = buildBoard(MAP_4P);
  const state = createGame(board, ['甲', '乙', '丙', '丁'], ['red', 'blue', 'white', 'orange']);
  const v = structuredClone(viewFor(board, state, 0));
  v.phase = 'play';
  v.current = 0;
  v.viewer = 0;
  v.hasRolled = true;
  v.pendingDiscards = [];
  v.pendingRobber = false;
  v.me.resources = { wood: 5, brick: 5, sheep: 5, wheat: 5, ore: 5 };
  const vk = board.geo.vertexKeys[0]!;
  const ek = board.geo.vertices[vk]!.edges[0]!;
  v.buildings[vk] = { owner: 0, city: false };
  v.roads[ek] = 0;
  return v;
}

describe('ULS · 真实 Ui：旋转画布点选 → 确认 → COMMAND，重算不丢待确认选择', () => {
  let ui: Ui;
  let calls: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    calls = {};
    const cb = new Proxy(calls, { get: (t, k: string) => (t[k] ??= vi.fn()) }) as unknown as UiCallbacks;
    ui = new Ui(cb);
    stageEl().rect = { ...CW_RECT };
  });

  const camera = (): BoardCamera => (ui as unknown as { camera: BoardCamera }).camera;
  const candidates = (): BoardCandidate[] =>
    (camera() as unknown as { candidates: BoardCandidate[] }).candidates;

  it('要点 1：WELCOME 直接带 view（恢复快照，无 STATE）也启用自转，W/H 换回、候选照常生成', () => {
    ui.render(seededPlayView(), []);   // 等价于 main.ts 的 WELCOME(msg.view) → ui.render(view, [])
    expect(doc.getElementById('shell')!.dataset.landscapeMode).toBe('css');
    expect(camera().state.W).toBe(844);
    expect(camera().state.H).toBe(346);
    ui.openBuild('road');
    expect(candidates().length).toBeGreaterThan(0);
  });

  it('按旋转后的客户端坐标点道路 → 确认条 → 提交带正确 key 的建造意图', () => {
    const v = seededPlayView();
    ui.render(v, []);
    ui.openBuild('road');
    const cam = camera();
    const r = stageEl().getBoundingClientRect();

    // 找一个无歧义的候选，避免两个热区太近时走消歧分支
    let chosen: { key: string; clientX: number; clientY: number } | null = null;
    for (const c of candidates()) {
      const p = cam.worldToScreen({ x: c.x, y: c.y });
      const client = localToClient(r, p.x, p.y, 90);
      const res = resolveHits(cam.nearest(client.clientX, client.clientY));
      if (res.kind === 'single' && res.first.key === c.key) {
        chosen = { key: c.key, ...client };
        break;
      }
    }
    expect(chosen, '旋转画布上应能找到一个无歧义道路候选').toBeTruthy();
    const target = chosen!;

    const hit = svgChild();
    fire(hit, 'pointerdown', { pointerId: 21, clientX: target.clientX, clientY: target.clientY });
    fire(hit, 'pointerup', { pointerId: 21, clientX: target.clientX, clientY: target.clientY });
    const strip = doc.getElementById('confirm-strip')!;
    expect(strip.innerHTML).toContain('在此建造道路');
    expect(doc.getElementById('shell')!.dataset.picking).toBe('1');

    const ok = strip.querySelector('[data-confirm="ok"]')!;
    fire(ok, 'click', {});
    expect(calls['onBuild']).toHaveBeenCalledWith('road', target.key);
  });

  it('模式切换 / resize 重算几何后，zoom 与待确认的选择都不丢（指南 5.1）', () => {
    const v = seededPlayView();
    ui.render(v, []);
    ui.openBuild('road');
    const cam = camera();
    const r = stageEl().getBoundingClientRect();

    let client: { clientX: number; clientY: number } | null = null;
    for (const c of candidates()) {
      const p = cam.worldToScreen({ x: c.x, y: c.y });
      const cl = localToClient(r, p.x, p.y, 90);
      const res = resolveHits(cam.nearest(cl.clientX, cl.clientY));
      if (res.kind === 'single' && res.first.key === c.key) { client = cl; break; }
    }
    expect(client).toBeTruthy();
    const tap = client!;

    const hit = svgChild();
    fire(hit, 'pointerdown', { pointerId: 31, clientX: tap.clientX, clientY: tap.clientY });
    fire(hit, 'pointerup', { pointerId: 31, clientX: tap.clientX, clientY: tap.clientY });
    const titleBefore = doc.getElementById('confirm-strip')!.dataset.title;

    fire(doc.getElementById('zoom-in')!, 'click', {});
    const zoomBefore = cam.state.zoom;
    expect(zoomBefore).toBeGreaterThan(1);

    // 系统方向锁定成功：视口变横屏 → mode=system、CSS 旋转撤掉，舞台 AABB 变回未旋转
    setPortrait(false);
    stageEl().rect = { ...FLAT_RECT };
    win.dispatchEvent(new MiniEvent('orientationchange'));
    vi.advanceTimersByTime(200);   // Ui 的 orientationchange 延迟重算

    expect(doc.getElementById('shell')!.dataset.landscapeMode).toBe('system');
    expect(cam.state.zoom).toBe(zoomBefore);
    expect(cam.state.W).toBe(844);
    expect(cam.state.H).toBe(390);
    const strip = doc.getElementById('confirm-strip')!;
    expect(strip.dataset.title).toBe(titleBefore);      // 待确认选择没被重算冲掉
    expect(strip.classList.contains('hidden')).toBe(false);
    expect(strip.innerHTML).toContain('在此建造道路');
    expect(strip.querySelector('[data-confirm="ok"]')).toBeTruthy();
    fire(strip.querySelector('[data-confirm="ok"]')!, 'click', {});
    expect(calls['onBuild']).toHaveBeenCalledTimes(1);
  });

  it('C7 手势搭车：一次游戏点击顺带尝试 lock，不改变/不消费点击语义、不重复请求', () => {
    const lock = vi.fn(() => Promise.resolve());
    g['screen'] = { orientation: { lock } };
    try {
      ui.render(seededPlayView(), []);
      ui.openBuild('road');
      const cam = camera();
      const r = stageEl().getBoundingClientRect();
      let target: { key: string; clientX: number; clientY: number } | null = null;
      for (const c of candidates()) {
        const p = cam.worldToScreen({ x: c.x, y: c.y });
        const cl = localToClient(r, p.x, p.y, 90);
        const res = resolveHits(cam.nearest(cl.clientX, cl.clientY));
        if (res.kind === 'single' && res.first.key === c.key) {
          target = { key: c.key, ...cl };
          break;
        }
      }
      expect(target).toBeTruthy();
      const t = target!;
      const hit = svgChild();
      fire(hit, 'pointerdown', { pointerId: 41, clientX: t.clientX, clientY: t.clientY });
      fire(hit, 'pointerup', { pointerId: 41, clientX: t.clientX, clientY: t.clientY });
      expect(lock).toHaveBeenCalledTimes(1);
      expect(lock).toHaveBeenCalledWith('landscape');
      // 游戏语义完全不变：仍是确认条 → 提交正确的建造 key
      const strip = doc.getElementById('confirm-strip')!;
      expect(strip.innerHTML).toContain('在此建造道路');
      fire(strip.querySelector('[data-confirm="ok"]')!, 'click', {});
      expect(calls['onBuild']).toHaveBeenCalledWith('road', t.key);
      // 第二次点击不再重复搭车
      fire(hit, 'pointerdown', { pointerId: 42, clientX: t.clientX, clientY: t.clientY });
      fire(hit, 'pointerup', { pointerId: 42, clientX: t.clientX, clientY: t.clientY });
      expect(lock).toHaveBeenCalledTimes(1);
    } finally {
      delete g['screen'];
    }
  });
});
