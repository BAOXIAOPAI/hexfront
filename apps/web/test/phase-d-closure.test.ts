/**
 * 阶段 D 放行后「18 §4 缺口」补齐：把 UL-UX08 / UL-UX10 / UL-UX12 / UL-UX11
 * 与 18 §4.5「源码已落地但未经复验」里**不依赖真机**的部分钉成可执行断言。
 *
 * 与 phase-d-fix-landscape.test.ts 的区别：
 * - 后者按实现要点组织、覆盖较广但**没有按 §4.3.1 的 P1–P8 逐条命名**；
 * - 本文件按 docs/17 §4.3.1 的复活路径清单逐条独立 it()，每条断言
 *   「不复活」的不变量（hintShown / tipRendered / tipClosed / lh-settled / fading）；
 * - 另补 S0–S8 状态迁移表（S1 不停留、S3 超时按 S5）、C3 三分支逐字文案 +
 *   禁用旧主提示/技术黑话的否定断言、减少动效两种开关、enterkeyhint 静态对账。
 *
 * 证据口径：全部是 jsdom 之外的 MiniDocument + 真实 Panels 行为测试（单测），
 * **不冒充浏览器 / 真机**。真机必需项（iOS Safari / 微信内置 / 国产自带浏览器 /
 * A-13 物理转机 / 第三方 IME）仍 BLOCKED，不在本文件判定范围。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MiniDocument, fire, installGlobals, makeWindow,
  type MiniEvent, type MiniWindow,
} from './fixtures/mini-dom.js';
import { MAP_4P, buildBoard, createGame, viewFor, type PlayerView } from '@hexfront/engine';
import { Panels, HINT_COPY, LANDSCAPE_ROTATION, type PanelCallbacks } from '../src/panels.js';
import { Ui, type UiCallbacks } from '../src/ui.js';
import { makeProjection, panForZoomAround, type CameraBox } from '../src/camera.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const g = globalThis as unknown as Record<string, unknown>;

let doc: MiniDocument;
let win: MiniWindow;
let restore: () => void;
let panels: Panels;
let lock: ReturnType<typeof vi.fn>;
let requestFullscreen: ReturnType<typeof vi.fn>;
let fireVisualViewport: (type: string) => void;
let onResumeSpy: ReturnType<typeof vi.fn>;

function setOrientation(portrait: boolean): void {
  g['matchMedia'] = (q: string) => ({
    matches: portrait && q.includes('portrait'), media: q,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  });
  g['innerWidth'] = portrait ? 390 : 844;
  g['innerHeight'] = portrait ? 844 : 390;
}

function orientationChange(): void {
  win.dispatchEvent({ type: 'orientationchange' } as MiniEvent);
}
function resize(): void {
  win.dispatchEvent({ type: 'resize' } as MiniEvent);
}
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}
function playView(): PlayerView {
  const board = buildBoard(MAP_4P);
  const state = createGame(board, ['甲', '乙', '丙', '丁'], ['red', 'blue', 'white', 'orange']);
  const v = structuredClone(viewFor(board, state, 0));
  v.phase = 'play'; v.current = 0; v.viewer = 0; v.hasRolled = true;
  v.pendingDiscards = []; v.pendingRobber = false;
  return v;
}

const el = (id: string) => doc.getElementById(id)!;
const hud = () => el('landscape-hud');
const mainCopy = () => el('landscape-hint-main');
const hint = () => el('portrait-hint');
const statusLine = () => el('landscape-hint-status');
const toast = () => el('toast');
const shell = () => el('shell');
const mode = () => shell().dataset.landscapeMode;
const mem = () => panels.landscapeMemory;

/** 提示已收起的四层不变量：渲染只一次、已收尾、正立层 settled、无 fading 残留 */
function expectSettled(): void {
  expect(mem().tipRendered).toBe(true);
  expect(mem().tipClosed).toBe(true);
  expect(mem().hintShown).toBe(true);
  expect(hud().classList.contains('lh-settled')).toBe(true);
  expect(hud().classList.contains('fading')).toBe(false);
  expect(mainCopy().textContent).toBe(HINT_COPY.main);
}

beforeEach(() => {
  doc = new MiniDocument(HTML);
  win = makeWindow();
  const vvListeners = new Map<string, (() => void)[]>();
  (win as unknown as Record<string, unknown>)['visualViewport'] = {
    width: 390, height: 844,
    addEventListener: (t: string, f: () => void) => {
      vvListeners.set(t, [...(vvListeners.get(t) ?? []), f]);
    },
  };
  fireVisualViewport = (t: string) => { for (const f of vvListeners.get(t) ?? []) f(); };
  restore = installGlobals(doc, win);
  setOrientation(true);
  lock = vi.fn(() => Promise.resolve());
  requestFullscreen = vi.fn(() => Promise.resolve());
  g['screen'] = { orientation: { lock } };
  (doc.documentElement as unknown as Record<string, unknown>)['requestFullscreen'] = requestFullscreen;
  onResumeSpy = vi.fn();
  const cb = new Proxy({ onResume: onResumeSpy } as Record<string, unknown>, {
    get: (t, k: string) => (t[k] ??= vi.fn()),
  }) as unknown as PanelCallbacks;
  panels = new Panels(cb);
  panels.setConnected(true);
});

afterEach(() => {
  restore();
  delete g['screen'];
  delete g['CSS'];
});

// ================================================================ UL-UX10 / A-10：§4.3.1 P1–P8
describe('UL-UX10 · A-10 提示复活路径 P1–P8 逐条（docs/17 §4.3.1）', () => {
  it('P1 点「知道了」收起：本会话不再出现，定时器被清、无 fading 残留', () => {
    panels.setInGame(true);
    expect(hud().classList.contains('lh-settled')).toBe(false); // 首次 S2 提示可见
    fire(el('landscape-hint-close'), 'click', {});
    expectSettled();
    // 再触发 6s（超过 5s 自动淡出窗口）也不会重新插入提示
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(6000);
      expectSettled();
    } finally { vi.useRealTimers(); }
  });

  it('P2 点「仍按竖屏查看」(S6)：不再出现，且再回竖屏/再变横屏都不恢复', () => {
    panels.setInGame(true);
    fire(el('landscape-exit'), 'click', {});
    expect(mode()).toBe('off');
    expect(mem().forced).toBe(false);
    expectSettled();
    setOrientation(false); orientationChange();          // 系统真横屏：forced=off 只约束竖屏强制
    expect(panels.landscapeRotation).toBe(0);             // 横屏下不额外自转（布局本就正常）
    expect(mem().forced).toBe(false);                     // 方向切换不改写用户选择
    setOrientation(true); orientationChange();           // 再回竖屏 → S6（forced=off）
    expect(mode()).toBe('off');
    expectSettled();
    expect(hud().classList.contains('hidden')).toBe(false); // S6 状态条仍常驻
  });

  it('P3 每次 STATE / HUD 重绘：不重建提示 DOM、不残留 fading、不重新出现', () => {
    panels.setInGame(true);
    fire(el('landscape-hint-close'), 'click', {});
    expectSettled();
    // 模拟 3 次权威视图广播（setView 会 updateLandscape + renderLandscapeStatus）
    for (let i = 0; i < 3; i += 1) {
      panels.setView(playView());
      expect(mem().tipRendered).toBe(true);
      expect(hud().classList.contains('lh-settled')).toBe(true);
      expect(hud().classList.contains('fading')).toBe(false);
      expect(mainCopy().textContent).toBe(HINT_COPY.main);
      expect(statusLine().textContent).toContain('横屏棋盘已铺好');
    }
    // 显式重算 HUD（方向/尺寸变化路径）同样不复活
    fireVisualViewport('resize');
    expectSettled();
  });

  it('P4 从后台回前台（visibilitychange→visible / onResume）：不重新展示转向提示', () => {
    panels.setInGame(true);
    fire(el('landscape-hint-close'), 'click', {});
    expectSettled();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent({ type: 'visibilitychange' } as MiniEvent);
    expect(onResumeSpy).not.toHaveBeenCalled();
    doc.visibilityState = 'visible';
    doc.dispatchEvent({ type: 'visibilitychange' } as MiniEvent);
    expect(onResumeSpy).toHaveBeenCalledTimes(1);   // 只做状态核对
    expectSettled();                                 // 不重弹提示
  });

  it('P5 resize / orientationchange / visualViewport 连发 ≥3 次：稳定不显示、不闪', () => {
    panels.setInGame(true);
    fire(el('landscape-hint-close'), 'click', {});
    for (let i = 0; i < 5; i += 1) {
      resize();
      orientationChange();
      fireVisualViewport('resize');
      fireVisualViewport('scroll');
    }
    expectSettled();
  });

  it('P6 S7↔S8 来回切：提示不复活，forced / hintShown 不被方向切换改写', () => {
    panels.setInGame(true);
    fire(el('landscape-hint-close'), 'click', {});
    const forcedBefore = mem().forced;
    const hintShownBefore = mem().hintShown;
    for (let i = 0; i < 3; i += 1) {
      setOrientation(false); orientationChange();     // S7
      expect(mode()).toBe('system');
      setOrientation(true); orientationChange();      // S8 → S2
      expect(mode()).toBe('css');
      expect(hud().classList.contains('lh-settled')).toBe(true);
    }
    expect(mem().forced).toBe(forcedBefore);
    expect(mem().hintShown).toBe(hintShownBefore);
    expectSettled();
  });

  it('P7 降级说明（S5）：并入既有提示条/状态摘要，不叠 toast、不作为第二次提示', async () => {
    lock.mockImplementation(() => Promise.reject(new Error('not allowed')));
    panels.setInGame(true);
    fire(el('landscape-hint-close'), 'click', {});
    expectSettled();
    const hudNodeCountBefore = hud().children.length;
    fire(el('portrait-landscape'), 'click', {});     // 手动重试一次 lock → 被拒
    await flush();
    // 降级文案只进正立层既有节点，不开新卡片、不叠 toast
    expect([hint().textContent, statusLine().textContent]).toContain(HINT_COPY.rejected);
    expect(toast().textContent).not.toContain('不能自动横屏');
    expect(hud().children.length).toBe(hudNodeCountBefore);  // 无新增提示节点
    expect(hud().classList.contains('lh-settled')).toBe(true); // 不是「第二次提示」
    expect(hud().classList.contains('fading')).toBe(false);
    expect(mem().hintShown).toBe(true);
  });

  it('P8 刷新页面（新 Panels 实例）：允许且仅允许再出现一次（新会话）', () => {
    panels.setInGame(true);
    fire(el('landscape-hint-close'), 'click', {});
    expectSettled();
    // 模拟刷新：新建 Panels（同一 DOM 结构等价于新文档加载后的构造）
    const prev = panels;
    void prev;
    const cb2 = new Proxy({ onResume: vi.fn() } as Record<string, unknown>, {
      get: (t, k: string) => (t[k] ??= vi.fn()),
    }) as unknown as PanelCallbacks;
    const fresh = new Panels(cb2);
    fresh.setConnected(true);
    expect(fresh.landscapeMemory.tipRendered).toBe(false); // 新会话记忆位清零
    expect(fresh.landscapeMemory.hintShown).toBe(false);
    fresh.setInGame(true);
    expect(fresh.landscapeMemory.tipRendered).toBe(true);  // 新会话出现一次
    expect(fresh.landscapeMemory.hintShown).toBe(true);
    // 把 panels 指到新实例，避免 afterEach 里旧实例 ticker 干扰（restore 会清全局）
    panels = fresh;
  });
});

// ================================================================ UL-UX08 / A-8：状态迁移表
describe('UL-UX08 · A-8 S0–S8 状态迁移表（S1 不停留 / S3 超时按 S5）', () => {
  it('S0→S1→S2 同帧瞬时完成：setInGame 后直接 css，绝不停在退化竖屏', () => {
    expect(mode()).toBe('off');
    panels.setInGame(true);
    expect(mode()).toBe('css');              // S1 不停留（无中间态可观测）
    expect(panels.landscapeRotation).toBe(LANDSCAPE_ROTATION);
    expect(mem().hintShown).toBe(true);
  });

  it('S3 尝试锁定期间 mode 不变、不阻断操作；超时按 S5 统一兜底文案，不假装成功', async () => {
    vi.useFakeTimers();
    try {
      lock.mockImplementation(() => new Promise<void>(() => {})); // 既不 resolve 也不 reject
      panels.setInGame(true);
      expect(mode()).toBe('css');
      fire(el('btn-orientation'), 'click', {});
      await flush();
      expect(mode()).toBe('css');                    // S3 仍保持自转、不闪
      expect(lock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1300);      // 超过 LOCK_TIMEOUT_MS=1200
      expect(mode()).toBe('css');                    // 超时按 S5：与 S2 同态
      expect(hint().textContent).toBe(HINT_COPY.fallback);
      expect(hint().textContent).not.toContain('旋转锁定');
      expect(panels.landscapeRotation).toBe(LANDSCAPE_ROTATION);
      expect(lock).toHaveBeenCalledTimes(1);        // 不重试
    } finally { vi.useRealTimers(); }
  });

  it('S4 锁定成功但视口仍竖屏不撤自转；视口真变横屏才 S7 还原', async () => {
    panels.setInGame(true);
    fire(el('btn-orientation'), 'click', {});
    await flush();
    expect(mode()).toBe('css');                    // 不假装成功（防 lock 假成功）
    setOrientation(false);
    orientationChange();
    expect(mode()).toBe('system');
    expect(panels.landscapeRotation).toBe(0);
    expect(hud().classList.contains('hidden')).toBe(true);
  });

  it('S6→恢复→S2、S7→S8→S2：forced / hintShown 迁移与 §3.1 一致', () => {
    panels.setInGame(true);
    fire(el('landscape-exit'), 'click', {});
    expect(mode()).toBe('off'); expect(mem().forced).toBe(false);
    fire(el('landscape-resume'), 'click', {});
    expect(mode()).toBe('css'); expect(mem().forced).toBe(true);
    expect(mem().hintShown).toBe(true);             // 恢复入口不碰提示记忆位
    setOrientation(false); orientationChange();
    expect(mode()).toBe('system');
    setOrientation(true); orientationChange();
    expect(mode()).toBe('css');
    expect(mem().forced).toBe(true);
    expect(mem().hintShown).toBe(true);
  });
});

// ================================================================ UL-UX12 / A-12：降级三分支逐字文案
describe('UL-UX12 · A-12 降级三分支文案（§6.2 逐字 + 禁用旧主提示/技术黑话）', () => {
  const BANNED = ['screen.orientation', 'requestFullscreen', 'API 缺失', '方向锁定',
    'WebView', '请检查系统旋转锁定设置', '请手动把手机横过来', '浏览器内核'];

  it('HINT_COPY 五条文案逐字稳定、方向词由唯一常量派生、无技术黑话', () => {
    expect(LANDSCAPE_ROTATION).toBe(90);
    expect(HINT_COPY.main).toBe('把手机向左横过来，棋盘就正了');
    expect(HINT_COPY.sub).toBe('页面已替你转好，不用改手机设置，也不会退出房间。');
    expect(HINT_COPY.unsupported).toBe('这个浏览器不能自动横屏，页面已替你铺好横屏棋盘；把手机向左横过来就能玩。');
    expect(HINT_COPY.rejected).toBe('这个浏览器没允许切换方向，页面已替你铺好横屏棋盘；把手机向左横过来就能玩。');
    expect(HINT_COPY.fallback).toBe('页面已替你铺好横屏棋盘，把手机向左横过来就能玩；不用改手机设置，也不会退出房间。');
    for (const text of Object.values(HINT_COPY)) {
      for (const bad of BANNED) expect(text).not.toContain(bad);
    }
    expect(HINT_COPY.main).toContain('向左');
    expect(HINT_COPY.fallback).toContain('不用改手机设置'); // 系统旋转锁定开着也不误导去改设置
  });

  it('① API 缺失：首次进入 S2 即并入 unsupported，不弹卡片、不叠 toast', () => {
    delete g['screen'];
    panels.setInGame(true);
    expect(hint().textContent).toBe(HINT_COPY.unsupported);
    expect(hud().classList.contains('hidden')).toBe(false);
    expect(toast().textContent).not.toContain('不能自动横屏');
    expect(el('portrait-gate').classList.contains('hidden')).toBe(true);
  });

  it('② 请求被拒：rejected 逐字一致，S5 与 S2 同态、不重试、不重弹', async () => {
    lock.mockImplementation(() => Promise.reject(new Error('not allowed')));
    panels.setInGame(true);
    fire(el('portrait-landscape'), 'click', {});
    await flush();
    expect(hint().textContent).toBe(HINT_COPY.rejected);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(mode()).toBe('css');
    expect(hud().classList.contains('lh-settled')).toBe(false);
    expect(mem().hintShown).toBe(true);
  });

  it('③ Promise pending 超时：fallback 逐字一致、无「旋转锁定」旧词、不假装成功', async () => {
    vi.useFakeTimers();
    try {
      lock.mockImplementation(() => new Promise<void>(() => {}));
      panels.setInGame(true);
      fire(el('portrait-landscape'), 'click', {});
      await flush();
      await vi.advanceTimersByTimeAsync(1300);
      expect(hint().textContent).toBe(HINT_COPY.fallback);
      expect(hint().textContent).not.toContain('旋转锁定');
      expect(mode()).toBe('css');
      expect(panels.landscapeRotation).toBe(90);
    } finally { vi.useRealTimers(); }
  });

  it('静态对账：index.html / panels.ts 全文不含被禁用的旧主提示文案', () => {
    const panelsSrc = readFileSync(path.join(ROOT, 'src/panels.ts'), 'utf8');
    const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    for (const bad of ['请检查系统旋转锁定设置', '请手动把手机横过来', '浏览器没有允许切换方向']) {
      expect(panelsSrc).not.toContain(bad);
      expect(html).not.toContain(bad);
    }
  });
});

// ================================================================ UL-UX11 / A-11：减少动效两种开关
describe('UL-UX11 · A-11 减少动效开关（应用内 + 系统偏好）与静态 a11y 标记', () => {
  it('应用内开关：#btn-motion 切换 data-reduce-motion / aria-pressed，并同步正立层', () => {
    panels.setInGame(true);
    const btn = el('btn-motion');
    fire(btn, 'click', {});
    expect(shell().dataset.reduceMotion).toBe('1');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(hud().classList.contains('reduce-motion')).toBe(true);
    fire(btn, 'click', {});
    expect(shell().dataset.reduceMotion).toBe('0');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(hud().classList.contains('reduce-motion')).toBe(false);
  });

  it('系统偏好 prefers-reduced-motion 也被 reduceMotion() 采纳（CSS 媒体查询 + HUD 类）', () => {
    const css = readFileSync(path.join(ROOT, 'src/layout.css'), 'utf8');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.landscape-hud.reduce-motion');
    g['matchMedia'] = (q: string) => ({
      matches: q.includes('prefers-reduced-motion') || q.includes('portrait'), media: q,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    });
    panels.setInGame(true);
    // 系统偏好走 CSS 媒体查询 + HUD 类，不产生 toast（toast 只由应用内开关点击触发）
    expect(hud().classList.contains('reduce-motion')).toBe(true);
    expect(css).toContain('.lh-icon');                    // 减少动效时箭头不循环、保留静态文字
    // 应用内开关点击才有 toast 文案，且明确「保留静态高亮与文字」
    fire(el('btn-motion'), 'click', {});
    expect(toast().textContent).toContain('保留静态高亮与文字');
  });

  it('静态对账：正立层 role=status / aria-live=polite、画布 aria-label、44px 触控目标 token', () => {
    const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const css = readFileSync(path.join(ROOT, 'src/layout.css'), 'utf8');
    expect(html).toMatch(/id="landscape-hud"[^>]*role="status"/);
    expect(html).toMatch(/aria-live="polite"/);
    expect(shell().getAttribute('aria-label')).toBe('横屏对局画布');
    expect(css).toContain('--d-tap: 44px');
  });
});

// ================================================================ UL-UX07 / A-7：WELCOME 带 view 恢复路径
describe('UL-UX07 · A-7 带 view 的 WELCOME 恢复快照（18 §4.3 点名未完整补跑）', () => {
  it('Ui.render(view) 直接带权威视图（恢复路径）→ 自转启用、入房浮层收起、提示只弹一次', () => {
    // 独立建 DOM/全局，避免与 beforeEach 的 Panels 实例争用同一 HUD 节点。
    // 用真实 Ui（而非只测 Panels）覆盖 main.ts:147 的 WELCOME 分支接线契约：
    // `if (msg.view) { view = msg.view; ui.hideOverlay(); ui.render(view, []) }`
    restore();
    const doc2 = new MiniDocument(HTML);
    const win2 = makeWindow();
    restore = installGlobals(doc2, win2);
    setOrientation(true);
    g['screen'] = { orientation: { lock: vi.fn(() => Promise.resolve()) } };
    const calls = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (t[k] ??= vi.fn()),
    }) as unknown as UiCallbacks;
    const ui = new Ui(calls);
    const sh = doc2.getElementById('shell')!;
    expect(sh.dataset.landscapeMode).toBe('off');       // S0 入房阶段
    ui.hideOverlay();
    ui.render(playView(), []);                          // 恢复快照直接带 view
    expect(sh.dataset.landscapeMode).toBe('css');       // 恢复玩家也进入 S2 自转
    expect(sh.dataset.landscapeDir).toBe('cw');
    expect(doc2.getElementById('landscape-hud')!.classList.contains('hidden')).toBe(false);
    expect(doc2.getElementById('landscape-hint-main')!.textContent).toBe(HINT_COPY.main);
    // 多次广播重绘不重复弹提示（A-10 不变量同样适用）
    for (let i = 0; i < 3; i += 1) ui.render(playView(), []);
    expect(doc2.getElementById('landscape-hud')!.classList.contains('fading')).toBe(false);
    // 还原到本用例自建的全局，交给 afterEach 统一 restore() 清理
    doc = doc2; win = win2;
  });

  it('结束页 → 「回到房间」退出自转回 S0（与既有测试一致，纳入迁移表对账）', () => {
    // 同样独立建 DOM，避免依赖上一用例替换过的全局
    restore();
    const doc3 = new MiniDocument(HTML);
    const win3 = makeWindow();
    restore = installGlobals(doc3, win3);
    setOrientation(true);
    g['screen'] = { orientation: { lock: vi.fn(() => Promise.resolve()) } };
    const cb3 = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (t[k] ??= vi.fn()),
    }) as unknown as PanelCallbacks;
    const p3 = new Panels(cb3);
    p3.setConnected(true);
    const sh = doc3.getElementById('shell')!;
    p3.setInGame(true);
    const v = playView(); v.phase = 'ended'; v.winner = 0;
    p3.setView(v);
    expect(sh.dataset.landscapeMode).toBe('css');
    fire(doc3.getElementById('end-back')!, 'click', {});
    expect(sh.dataset.landscapeMode).toBe('off');
    expect(doc3.getElementById('end-screen')!.classList.contains('hidden')).toBe(true);
    doc = doc3; win = win3; panels = p3;
  });
});

// ================================================================ D01-09 复跑 FAIL 的根因定点复验
describe('18 §4.1 复跑残留 D01-09 · 判据根因定点复验（数学层，不改历史报告）', () => {
  const BOX: CameraBox = { x: -497.7, y: -316, width: 995.4, height: 632 };
  const W = 995.4, H = 632;

  it('规范初值（zoom=1, pan=0）下 zoom→reset 严格回到 vb0（产品行为正确）', () => {
    const base = makeProjection(BOX, W, H, 1, 0, 0).viewBox();
    // 模拟 zoom-in（保持手势中心），再 zoom-out，再 reset（reset 即 zoom=1/pan=0）
    const world = { x: 0, y: 0 };
    const screen = { x: W / 2, y: H / 2 };
    const panIn = panForZoomAround(world, screen, BOX, W, H, 1.25);
    const vbIn = makeProjection(BOX, W, H, 1.25, panIn.panX, panIn.panY).viewBox();
    expect(vbIn.w).not.toBe(base.w);                 // zoom 确实改变 viewBox
    const vbReset = makeProjection(BOX, W, H, 1, 0, 0).viewBox();   // camera.reset()
    expect(vbReset).toEqual(base);                  // reset 回到规范初值
    expect(vbReset.x).toBe(-497.7);
    expect(vbReset.y).toBe(-316);
  });

  it('复现 FAIL 根因：若「初值」取自带非零 pan 的状态，reset 后必然不等于它', () => {
    // 复跑报告观测：viewBoxInitial=-666.672… -469.172… 995.4 632，
    // viewBoxReset=-497.7 -316 995.4 632 —— 宽高一致、原点差 168.97，
    // 恰等于 (W/2 + panX)/s 的偏移量，说明 vb0 是「前面拖动流程留下平移」的快照。
    const dirty = makeProjection(BOX, W, H, 1, 168.9722222222222, 153.1722222222222).viewBox();
    const reset = makeProjection(BOX, W, H, 1, 0, 0).viewBox();
    expect(dirty.w).toBe(reset.w);
    expect(dirty.h).toBe(reset.h);
    expect(dirty.x).not.toBe(reset.x);              // 与复跑报告一致：x 不同
    expect(dirty.y).not.toBe(reset.y);
    // 结论写进断言意图：D01-09 的判据 `vb3 === vb0` 把「带 pan 的初值」当基准，
    // 是 phase-d-browser-verify.mjs:2002 的判据缺陷，不是 camera.reset() 回归。
    // 历史 2026-11-09 复跑报告里的 FAIL 原样保留，不改写、不改判。
  });
});

// ================================================================ 18 §4.5：源码已落地但未经复验
describe('18 §4.5 · enterkeyhint 与引导文案静态对账（真机仍 BLOCKED）', () => {
  it('index.html 的昵称/房间号输入框带 enterkeyhint=next/go，且不与 ui.ts 渲染冲突', () => {
    const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const uiSrc = readFileSync(path.join(ROOT, 'src/ui.ts'), 'utf8');
    // ui.ts 的 showJoin 会重建表单，属性必须在渲染模板里（uls-join-form.test.ts 验运行时）
    expect(uiSrc).toContain('enterkeyhint="next"');
    expect(uiSrc).toContain('enterkeyhint="go"');
    expect(uiSrc).toContain('输完按键盘上的『前往』即可加入');
    // index.html 里的静态表单若存在，也应带属性（或完全由 ui.ts 生成）
    const staticName = /id="f-name"[^>]*/.exec(html)?.[0] ?? '';
    if (staticName) expect(staticName).toContain('enterkeyhint');
  });

  it('明确标注：本文件不覆盖真机取证（iOS Safari / 微信内置 / 国产浏览器 / 第三方 IME / A-13）', () => {
    // 这是一条口径断言：把「单测已补」与「真机仍 BLOCKED」同时写进测试意图，
    // 防止后续会话把本文件当成真机通过的证据。
    const source = readFileSync(path.join(ROOT, 'test/phase-d-closure.test.ts'), 'utf8');
    expect(source).toContain('不冒充浏览器 / 真机');
    for (const k of ['iOS Safari', '微信内置', 'A-13', '第三方 IME']) {
      expect(source).toContain(k);
    }
  });
});
