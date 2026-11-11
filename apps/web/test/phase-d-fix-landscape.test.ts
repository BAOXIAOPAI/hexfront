/**
 * 手机竖屏「CSS 自旋转 + 系统方向锁定渐进增强」行为测试。
 *
 * 用真实 Panels 实例 + 真实 click / 方向事件序列，验证 7 项默认与 12 条对齐要点：
 * - C7：可选 44px 方向入口点击 → 先全屏 → lock('landscape')；不点也完全可玩；
 * - C3：①API 缺失 / ②被拒 / ③超时与无法区分，三分支文案逐字一致，无技术黑话；
 * - C1/C2：唯一 +90deg 常量派生转向词与主副句，正立提示层不参与自转；
 * - S0–S8：入房不干预、首次 S2 只弹一次提示、S4 还原、S6 出口与恢复、S8 不复活；
 * - 旧 DOM id 全保留；旧全屏卡片永久收起，不再是必须点按的主路径。
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

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function gate() { return doc.getElementById('portrait-gate')!; }
function hint() { return doc.getElementById('portrait-hint')!; }
function landscapeBtn() { return doc.getElementById('portrait-landscape')!; }
function hud() { return doc.getElementById('landscape-hud')!; }
function mainCopy() { return doc.getElementById('landscape-hint-main')!; }
function statusLine() { return doc.getElementById('landscape-hint-status')!; }
function toast() { return doc.getElementById('toast')!; }
function clickLandscape(): void { fire(landscapeBtn(), 'click', {}); }
function clickOptionalEntry(): void { fire(doc.getElementById('btn-orientation')!, 'click', {}); }

beforeEach(() => {
  doc = new MiniDocument(HTML);
  win = makeWindow();
  // visualViewport 在软键盘 / 地址栏伸缩时也会触发；用可驱动的真实监听验证重算
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
  const cb = new Proxy({} as Record<string, unknown>, {
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

describe('可选系统横屏增强（C7）与 C1–C3 文案', () => {
  it('静态结构：旧 DOM id 全保留、正立提示层默认隐藏、C2 主副句就位', () => {
    for (const id of ['portrait-gate', 'portrait-landscape', 'portrait-hint',
      'portrait-dismiss', 'portrait-help', 'portrait-status', 'landscape-hud',
      'landscape-exit', 'landscape-resume', 'btn-orientation']) {
      expect(doc.getElementById(id), `缺少 #${id}`).toBeTruthy();
    }
    expect(landscapeBtn().textContent).toContain('尝试系统横屏（可选）');
    expect(mainCopy().textContent).toBe(HINT_COPY.main);
    expect(hint().textContent).toBe(HINT_COPY.sub);
    expect(hud().classList.contains('hidden')).toBe(true);
    expect(LANDSCAPE_ROTATION).toBe(90);
    expect(HINT_COPY.main).toContain('向左');
  });

  it('卡片层级必须高于入房浮层(40)（历史回归：卡片虽已隐藏，规则仍保留）', () => {
    const css = readFileSync(path.join(ROOT, 'src/layout.css'), 'utf8');
    const z = /\.portrait-gate\s*\{[^}]*?z-index:\s*(\d+)/s.exec(css)?.[1];
    expect(Number(z)).toBeGreaterThan(40);
  });

  it('S0 入房阶段：不弹卡片、不弹任何转向提示、不旋转', () => {
    expect(gate().classList.contains('hidden')).toBe(true);
    expect(hud().classList.contains('hidden')).toBe(true);
    expect(doc.getElementById('shell')!.dataset.landscapeMode).toBe('off');
    orientationChange();
    expect(gate().classList.contains('hidden')).toBe(true);
    expect(hud().classList.contains('hidden')).toBe(true);
  });

  it('C7 可选入口：真实点击先请求全屏，再锁定 landscape，不消费游戏点击', async () => {
    clickOptionalEntry();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    await flush();
    expect(lock).toHaveBeenCalledWith('landscape');
    expect(hint().textContent).toBe(HINT_COPY.sub);        // 成功不写降级文案
    expect(hud().classList.contains('hidden')).toBe(true);  // S0 不弹提示
    expect(toast().textContent).not.toContain('不能自动横屏'); // 不叠加降级 toast
  });

  it('全屏被拒也不放弃：仍尝试锁定方向', async () => {
    requestFullscreen.mockImplementation(() => Promise.reject(new Error('denied')));
    clickLandscape();
    await flush();
    expect(lock).toHaveBeenCalledWith('landscape');
  });

  it('C3 ① 不支持 lock：正立副句替换为①，不请求全屏、无技术黑话、不叠 toast', async () => {
    delete g['screen'];
    panels.setInGame(true);
    clickLandscape();
    await flush();
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(hint().textContent).toBe(HINT_COPY.unsupported);
    expect(hint().textContent).not.toContain('API');
    expect(hint().textContent).not.toContain('请手动把手机横过来');
    expect(hint().textContent).not.toContain('请检查系统的旋转锁定设置');
    expect(hud().classList.contains('hidden')).toBe(false);
    expect(gate().classList.contains('hidden')).toBe(true);
    expect(toast().textContent).not.toContain('不能自动横屏');
  });

  it('C3 ② 浏览器拒绝 lock：正立副句替换为②，自转保持生效', async () => {
    lock.mockImplementation(() => Promise.reject(new Error('not allowed')));
    panels.setInGame(true);
    clickLandscape();
    await flush();
    expect(hint().textContent).toBe(HINT_COPY.rejected);
    expect(hud().classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('shell')!.dataset.landscapeMode).toBe('css');
  });

  it('S4 锁定成功且视口真变横屏：正立层与卡片都收起，不等 STATE', async () => {
    panels.setInGame(true);
    clickLandscape();
    await flush();
    setOrientation(false);
    orientationChange();
    expect(gate().classList.contains('hidden')).toBe(true);
    expect(hud().classList.contains('hidden')).toBe(true);
    expect(doc.getElementById('shell')!.dataset.landscapeMode).toBe('system');
  });

  it('S6「仍在竖屏查看」后本次不再弹出（回归指南 4.2）', () => {
    panels.setInGame(true);
    fire(doc.getElementById('landscape-exit')!, 'click', {});
    expect(gate().classList.contains('hidden')).toBe(true);
    expect(doc.getElementById('portrait-gate')!.dataset.dismissed).toBe('1');
    orientationChange();
    expect(gate().classList.contains('hidden')).toBe(true);
    expect(panels.landscapeMemory.forced).toBe(false);
  });
});

// ================================================================== ULS：CSS 自旋转状态机
function shellEl() { return doc.getElementById('shell')!; }
function mode() { return shellEl().dataset.landscapeMode; }
function viewportStyle(): Record<string, unknown> {
  return doc.documentElement.style as unknown as Record<string, unknown>;
}

function playView(): PlayerView {
  const board = buildBoard(MAP_4P);
  const state = createGame(board, ['甲', '乙', '丙', '丁'], ['red', 'blue', 'white', 'orange']);
  const v = structuredClone(viewFor(board, state, 0));
  v.phase = 'play';
  v.current = 0;
  v.viewer = 0;
  v.hasRolled = true;
  v.pendingDiscards = [];
  v.pendingRobber = false;
  return v;
}

describe('ULS · S0–S8 状态机（真实 Panels + 真实 click / 方向事件）', () => {
  it('S0 入房 / LOBBY 不旋转：构造与 orientationchange 都是 off，正立层也不弹', () => {
    expect(mode()).toBe('off');
    orientationChange();
    expect(mode()).toBe('off');
    expect(panels.landscapeRotation).toBe(0);
    expect(hud().classList.contains('hidden')).toBe(true);
    expect(panels.landscapeMemory.hintShown).toBe(false);
  });

  it('S1→S2：开局后瞬时启用自转（不停留退化布局），正立提示条只弹一次', () => {
    panels.setInGame(true);
    expect(mode()).toBe('css');
    expect(shellEl().dataset.landscapeDir).toBe('cw');
    expect(panels.landscapeRotation).toBe(90);
    expect(hud().classList.contains('hidden')).toBe(false);
    expect(hud().classList.contains('lh-settled')).toBe(false);
    expect(mainCopy().textContent).toBe(HINT_COPY.main);
    expect(hint().textContent).toBe(HINT_COPY.sub);
    expect(statusLine().textContent).toContain('横屏棋盘已铺好');
    expect(panels.landscapeMemory.hintShown).toBe(true);
    expect(toast().textContent).toBe('');            // 不叠加 toast、不弹卡片
    expect(gate().classList.contains('hidden')).toBe(true);
  });

  it('C1 唯一常量派生：dir / --ul-rotation / 箭头镜像标记 / 转向词 / 相机角度一致', () => {
    panels.setInGame(true);
    expect(LANDSCAPE_ROTATION).toBe(90);
    expect(shellEl().dataset.landscapeDir).toBe('cw');
    expect(hud().dataset.landscapeDir).toBe('cw');
    expect((shellEl().style as unknown as Record<string, unknown>)['--ul-rotation']).toBe('90deg');
    expect(HINT_COPY.main).toContain('向左');
    expect(HINT_COPY.unsupported).toContain('向左');
    expect(panels.landscapeRotation).toBe(90);
    // 不新增第二个方向入口：帮助面板没有翻转按钮，方向说明改为「转回来重来一次」
    panels.open('help');
    expect(doc.getElementById('drawer-body')!.querySelector('[data-act="landscape-flip"]')).toBeNull();
    expect(doc.getElementById('extra-panel')!.textContent).toContain('转反了就把手机转回来');
    expect(shellEl().dataset.landscapeDir).toBe('cw');
  });

  it('C3 ① 不支持 lock：开局即自旋转，副句并入①，不弹致命页、不静默、不叠 toast', async () => {
    delete g['screen'];
    panels.setInGame(true);
    expect(mode()).toBe('css');
    expect(hint().textContent).toBe(HINT_COPY.unsupported);
    expect(hud().classList.contains('hidden')).toBe(false);
    clickLandscape();
    await flush();
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(hint().textContent).toBe(HINT_COPY.unsupported);
    expect(toast().textContent).not.toContain('不能自动横屏');
    expect(gate().classList.contains('hidden')).toBe(true);
  });

  it('C3 ② 浏览器拒绝 lock：副句②，S5 与 S2 同态、不重试、不重弹提示', async () => {
    lock.mockImplementation(() => Promise.reject(new Error('not allowed')));
    panels.setInGame(true);
    clickLandscape();
    await flush();
    expect(mode()).toBe('css');
    expect(hint().textContent).toBe(HINT_COPY.rejected);
    expect(lock).toHaveBeenCalledTimes(1);           // 不重试
    expect(hud().classList.contains('lh-settled')).toBe(false); // 不重弹/不提前收起
    expect(panels.landscapeMemory.hintShown).toBe(true);
  });

  it('C3 ③ lock 既不 resolve 也不 reject：短时上限后统一兜底文案，不假装成功', async () => {
    vi.useFakeTimers();
    try {
      lock.mockImplementation(() => new Promise<void>(() => {}));
      panels.setInGame(true);
      clickLandscape();
      await flush();
      await vi.advanceTimersByTimeAsync(1300);
      expect(mode()).toBe('css');
      expect(hint().textContent).toBe(HINT_COPY.fallback);
      expect(hint().textContent).not.toContain('旋转锁定');
    } finally {
      vi.useRealTimers();
    }
  });

  it('S4 lock 成功但视口没变不假装成功：CSS 仍兜底；系统真变横屏才撤掉旋转', async () => {
    panels.setInGame(true);
    clickLandscape();
    await flush();
    expect(lock).toHaveBeenCalledWith('landscape');
    expect(mode()).toBe('css');                 // 视口仍是竖屏 → 不撤
    setOrientation(false);
    orientationChange();
    expect(mode()).toBe('system');             // S7 系统横屏生效 → 取消 CSS 旋转
    expect(panels.landscapeRotation).toBe(0);
    expect(gate().classList.contains('hidden')).toBe(true);
    expect(hud().classList.contains('hidden')).toBe(true);
    expect(hint().textContent).toBe(HINT_COPY.sub);  // 没有误写降级文案
  });

  it('S6 对局中出口 → off：本次会话反复 resize / 重进对局都不再强制，但状态条与恢复入口常驻', () => {
    panels.setInGame(true);
    expect(mode()).toBe('css');
    fire(doc.getElementById('landscape-exit')!, 'click', {});
    expect(mode()).toBe('off');
    expect(panels.landscapeMemory.forced).toBe(false);
    expect(doc.getElementById('portrait-gate')!.dataset.dismissed).toBe('1');
    // S6 不是空白页：正立状态条常驻，恢复入口可用，出口收起
    expect(hud().classList.contains('hidden')).toBe(false);
    expect(hud().classList.contains('lh-settled')).toBe(true);
    expect(doc.getElementById('landscape-resume')!.classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('landscape-exit')!.classList.contains('hidden')).toBe(true);
    orientationChange();
    expect(mode()).toBe('off');
    panels.setInGame(false);
    panels.setInGame(true);
    expect(mode()).toBe('off');
    expect(gate().classList.contains('hidden')).toBe(true);
  });

  it('入房阶段点旧卡片的退出不误伤开局自转（软键盘阶段不会整局竖屏）', () => {
    fire(doc.getElementById('portrait-dismiss')!, 'click', {});
    expect(gate().classList.contains('hidden')).toBe(true);
    expect(mode()).toBe('off');
    expect(panels.landscapeMemory.forced).toBe(true);
    panels.setInGame(true);
    expect(mode()).toBe('css');
  });

  it('C5 恢复入口：正立层按钮 + 帮助面板都能回到 css，且不重复叠加提示', () => {
    panels.setInGame(true);
    fire(doc.getElementById('landscape-exit')!, 'click', {});
    expect(mode()).toBe('off');
    fire(doc.getElementById('landscape-resume')!, 'click', {});
    expect(mode()).toBe('css');
    expect(panels.landscapeMemory.forced).toBe(true);
    expect(panels.landscapeMemory.hintShown).toBe(true);   // 不重置，不重弹
    expect(hud().classList.contains('lh-settled')).toBe(true);
    fire(doc.getElementById('landscape-exit')!, 'click', {});
    panels.open('help');
    const resume = doc.getElementById('drawer-body')!.querySelector('[data-act="landscape-resume"]')!;
    expect(resume.textContent).toContain('重新铺成横屏');
    fire(resume, 'click', {});
    expect(mode()).toBe('css');
    expect(panels.landscapeRotation).toBe(90);
    // 帮助面板也有出口（提示淡出后可达），且不带技术黑话
    expect(doc.getElementById('drawer-body')!.querySelector('[data-act="landscape-exit"]')).toBeTruthy();
  });

  it('回归 UL-UX09/10：提示淡出前退出再恢复，转向提示不得复活（shows 恒 ≤1）', () => {
    panels.setInGame(true);
    // 首次 S2：提示条可见（shows=1）
    expect(hud().classList.contains('lh-settled')).toBe(false);
    expect(panels.landscapeMemory.tipRendered).toBe(true);
    // 5s 自动淡出之前就点「仍按竖屏查看」
    fire(doc.getElementById('landscape-exit')!, 'click', {});
    expect(mode()).toBe('off');
    expect(panels.landscapeMemory.tipClosed).toBe(true);
    expect(hud().classList.contains('lh-settled')).toBe(true);
    // 再点「重新铺成横屏」：绝不能再取消 settled 让 .lh-main 复活
    fire(doc.getElementById('landscape-resume')!, 'click', {});
    expect(mode()).toBe('css');
    expect(hud().classList.contains('lh-settled')).toBe(true);
    expect(hud().classList.contains('fading')).toBe(false);
    // 反复来回切 + 方向来回变，仍不复活
    fire(doc.getElementById('landscape-exit')!, 'click', {});
    fire(doc.getElementById('landscape-resume')!, 'click', {});
    setOrientation(false); orientationChange();
    setOrientation(true); orientationChange();
    expect(hud().classList.contains('lh-settled')).toBe(true);
    expect(hud().classList.contains('fading')).toBe(false);
    expect(panels.landscapeMemory.hintShown).toBe(true);
    expect(mainCopy().textContent).toBe(HINT_COPY.main);
  });

  it('退出后 5s 定时器不会触发淡出/复活（退出即清定时器）', () => {
    vi.useFakeTimers();
    try {
      panels.setInGame(true);
      fire(doc.getElementById('landscape-exit')!, 'click', {});
      expect(hud().classList.contains('lh-settled')).toBe(true);
      vi.advanceTimersByTime(6000);
      expect(hud().classList.contains('lh-settled')).toBe(true);
      expect(hud().classList.contains('fading')).toBe(false);
      expect(panels.landscapeMemory.tipClosed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('A-10 不反复弹提示：知道了 / resize / S7↔S8 / visualViewport 都不复活转向提示', () => {
    panels.setInGame(true);
    expect(hud().classList.contains('lh-settled')).toBe(false);
    fire(doc.getElementById('landscape-hint-close')!, 'click', {});
    expect(hud().classList.contains('lh-settled')).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      fireVisualViewport('resize');
      orientationChange();
      win.dispatchEvent({ type: 'resize' } as MiniEvent);
    }
    expect(hud().classList.contains('lh-settled')).toBe(true);
    expect(mainCopy().textContent).toBe(HINT_COPY.main);
    setOrientation(false);
    orientationChange();
    expect(mode()).toBe('system');
    expect(hud().classList.contains('hidden')).toBe(true);
    setOrientation(true);                    // S8 回到竖屏
    orientationChange();
    expect(mode()).toBe('css');
    expect(hud().classList.contains('lh-settled')).toBe(true);   // 未复活
    expect(panels.landscapeMemory.hintShown).toBe(true);
  });

  it('C2 / 要点 11 正立状态摘要：真实 PlayerView 渲染连接 / 当前玩家 / 待办', () => {
    panels.setInGame(true);
    panels.setView(playView());
    const text = statusLine().textContent;
    expect(text).toContain('横屏棋盘已铺好');
    expect(text).toContain('连接已同步');
    expect(text).toContain('轮到 甲');
    expect(text).toContain('待处理');
    // 状态摘要与出口/恢复入口都在 #shell 之外的不旋转层
    expect(shellEl().querySelector('#landscape-hud')).toBeNull();
    expect(doc.getElementById('landscape-exit')).toBeTruthy();
    expect(doc.getElementById('landscape-resume')).toBeTruthy();
    expect(shellEl().getAttribute('aria-label')).toBe('横屏对局画布');
  });

  it('要点 2 视口判据：平板竖屏 / 桌面 / 小横屏都不自转，只有短边 ≤700 的手机竖屏才自转', () => {
    panels.setInGame(true);
    expect(mode()).toBe('css');
    // 平板竖屏 768×1024：短边 > 700 → 不干预（且不是「假 system」）
    g['innerWidth'] = 768; g['innerHeight'] = 1024;
    orientationChange();
    expect(mode()).toBe('off');
    expect(hud().classList.contains('hidden')).toBe(true);
    // 桌面 / 大横屏：视口真是横屏 → system，无需自转
    setOrientation(false);
    g['innerWidth'] = 1366; g['innerHeight'] = 768;
    orientationChange();
    expect(mode()).toBe('system');
    // 小横屏 667×375（旧 900px 断点会误判）同样是 system
    g['innerWidth'] = 667; g['innerHeight'] = 375;
    orientationChange();
    expect(mode()).toBe('system');
    // 回到手机竖屏 → css
    setOrientation(true);
    orientationChange();
    expect(mode()).toBe('css');
  });

  it('C6 / E6：结束页保持自转且可点，「回到房间」退出自转回 S0', () => {
    panels.setInGame(true);
    const v = playView();
    v.phase = 'ended';
    v.winner = 0;
    panels.setView(v);
    expect(mode()).toBe('css');
    const end = doc.getElementById('end-screen')!;
    expect(end.classList.contains('hidden')).toBe(false);
    expect(hud().classList.contains('hidden')).toBe(false);   // 正立状态条仍在，不吃点击
    fire(doc.getElementById('end-back')!, 'click', {});
    expect(mode()).toBe('off');
    expect(end.classList.contains('hidden')).toBe(true);
  });

  it('resize / orientationchange / visualViewport 都重算尺寸与状态（老 WebView 的 px 兜底）', () => {
    // mini-dom 没有 CSS.supports → 走「不支持 dvh」的 JS 量 px 兜底路径
    expect(viewportStyle()['--ul-vw']).toBe('390px');
    expect(viewportStyle()['--ul-vh']).toBe('844px');
    panels.setInGame(true);
    expect(mode()).toBe('css');
    setOrientation(false);
    fireVisualViewport('resize');
    expect(viewportStyle()['--ul-vw']).toBe('844px');
    expect(viewportStyle()['--ul-vh']).toBe('390px');
    expect(mode()).toBe('system');
    fireVisualViewport('scroll');
    expect(mode()).toBe('system');
  });

  it('支持 dvh 的现代浏览器不写 px 变量，交给 CSS 动态视口单位', () => {
    delete viewportStyle()['--ul-vw'];
    delete viewportStyle()['--ul-vh'];
    g['CSS'] = { supports: () => true };
    const cb = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (t[k] ??= vi.fn()),
    }) as unknown as PanelCallbacks;
    const modern = new Panels(cb);
    modern.setInGame(true);
    expect(viewportStyle()['--ul-vw']).toBeUndefined();
    expect(mode()).toBe('css');
  });

  it('要点 9 减少动效：应用开关与系统偏好都关掉正立层淡出/箭头动画，自转仍生效', () => {
    shellEl().dataset.reduceMotion = '1';
    panels.setInGame(true);
    expect(mode()).toBe('css');                 // 减少动效 ≠ 关闭横屏
    expect(hud().classList.contains('reduce-motion')).toBe(true);
    const css = readFileSync(path.join(ROOT, 'src/layout.css'), 'utf8');
    expect(css).toContain('.shell[data-landscape-mode="css"][data-reduce-motion="1"] { transition: none !important; }');
    expect(css).toContain('.landscape-hud.reduce-motion');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    // 系统偏好由 CSS 媒体查询兜底（求值时 reduceMotion=true）
    expect(css).toContain('.lh-icon');
  });
});

// ================================================================== ULS：旋转画布的 CSS 级联行为
// 不是「CSS 里有字符串」式断言：用一个小型级联求值器，按引入顺序 / 特异性 /
// !important / 媒体查询，求「竖屏视口 + data-landscape-mode=css」下元素的最终值。
interface CssDesc { tag: string; classes: string[]; attrs: Record<string, string> }
interface CssRule { sels: string[]; decls: Map<string, { v: string; imp: boolean }>; order: number; media: string | null }
interface CssVp { w: number; h: number; orientation: 'portrait' | 'landscape'; reduceMotion?: boolean }

function parseLayout(css: string): CssRule[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: CssRule[] = [];
  let i = 0; let order = 0;
  const walk = (media: string | null, end: number): void => {
    while (i < end) {
      const open = clean.indexOf('{', i);
      if (open < 0 || open >= end) return;
      const head = clean.slice(i, open).trim();
      let depth = 1; let j = open + 1;
      while (j < clean.length && depth > 0) {
        if (clean[j] === '{') depth++;
        else if (clean[j] === '}') depth--;
        j++;
      }
      const body = clean.slice(open + 1, j - 1);
      const after = j;
      i = after;
      if (head.startsWith('@media')) {
        const saved = i;
        i = open + 1;
        walk(media ? `${media} and ${head.slice(6).trim()}` : head.slice(6).trim(), j - 1);
        i = saved;
        continue;
      }
      if (head.startsWith('@')) continue;
      const decls = new Map<string, { v: string; imp: boolean }>();
      for (const part of body.split(';')) {
        const c = part.indexOf(':');
        if (c < 0) continue;
        const prop = part.slice(0, c).trim().toLowerCase();
        let v = part.slice(c + 1).trim();
        const imp = v.includes('!important');
        v = v.replace(/!important/g, '').trim();
        if (prop && v) decls.set(prop, { v, imp });
      }
      out.push({ sels: head.split(',').map((s) => s.trim()).filter(Boolean), decls, order: order++, media });
    }
  };
  walk(null, clean.length);
  return out;
}

const RULES = parseLayout(readFileSync(path.join(ROOT, 'src/layout.css'), 'utf8'));

function spec(sel: string): number {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length;
  const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const tags = (sel.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 10000 + cls * 100 + tags;
}
function compound(d: CssDesc, c: string): boolean {
  const re = /(^[a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m: RegExpExecArray | null; let saw = false;
  re.lastIndex = 0;
  while ((m = re.exec(c)) !== null) {
    saw = true;
    const tag = m[1]; const id = m[2]; const cl = m[3]; const attr = m[4]; const val = m[5];
    if (tag && tag !== '*' && d.tag !== tag.toLowerCase()) return false;
    if (id && d.attrs.id !== id) return false;
    if (cl && !d.classes.includes(cl)) return false;
    if (attr) {
      const actual = d.attrs[attr] ?? (attr === 'class' ? d.classes.join(' ') : undefined);
      if (actual === undefined) return false;
      if (val !== undefined && actual !== val) return false;
    }
  }
  return saw;
}
function matches(chain: CssDesc[], sel: string): boolean {
  const parts = sel.trim().split(/\s+/).filter(Boolean);
  let idx = chain.length - 1;
  for (let p = parts.length - 1; p >= 0; p--) {
    let found = false;
    while (idx >= 0) {
      if (compound(chain[idx]!, parts[p]!)) { found = true; idx--; break; }
      idx--;
    }
    if (!found) return false;
  }
  return true;
}
function mediaOk(media: string | null, vp: CssVp): boolean {
  if (!media) return true;
  return media.split(/\s+and\s+/).every((cond) => {
    const c = cond.trim().replace(/^\(|\)$/g, '');
    const m = /^(min|max)-(width|height)\s*:\s*(\d+)(px)?$/.exec(c);
    if (m) {
      const actual = m[2] === 'width' ? vp.w : vp.h;
      return m[1] === 'min' ? actual >= Number(m[3]) : actual <= Number(m[3]);
    }
    const o = /^orientation\s*:\s*(\w+)$/.exec(c);
    if (o) return o[1] === vp.orientation;
    if (c.includes('prefers-reduced-motion')) return vp.reduceMotion === true;
    return true;
  });
}
function computed(chain: CssDesc[], vp: CssVp): Map<string, string> {
  const out = new Map<string, { v: string; rank: number; imp: boolean }>();
  for (const rule of RULES) {
    if (!mediaOk(rule.media, vp)) continue;
    const sel = rule.sels.find((s) => matches(chain, s));
    if (!sel) continue;
    const base = spec(sel) * 1_000_000 + rule.order;
    for (const [prop, { v, imp }] of rule.decls) {
      const prev = out.get(prop);
      if (!prev || (imp && !prev.imp) || (imp === prev.imp && base >= prev.rank)) {
        out.set(prop, { v, rank: base, imp });
      }
    }
  }
  return new Map([...out].map(([k, x]) => [k, x.v]));
}

const VP: CssVp = { w: 390, h: 844, orientation: 'portrait' };
const shellCss: CssDesc = { tag: 'div', classes: ['shell'], attrs: { 'data-landscape-mode': 'css' } };
const shellOff: CssDesc = { tag: 'div', classes: ['shell'], attrs: {} };
const stage: CssDesc = { tag: 'main', classes: ['stage-main'], attrs: {} };
const boardStage: CssDesc = { tag: 'section', classes: ['board-stage'], attrs: {} };

describe('ULS · 旋转后竖屏退化规则被真正覆盖（级联求值）', () => {
  it('竖屏媒体查询确实会隐藏 .rail；css 模式下被高特异性覆盖回 flex', () => {
    const off = computed([shellOff, stage, { tag: 'aside', classes: ['rail'], attrs: {} }], VP);
    expect(off.get('display')).toBe('none');
    const on = computed([shellCss, stage, { tag: 'aside', classes: ['rail'], attrs: {} }], VP);
    expect(on.get('display')).toBe('flex');
  });

  it('两栏主舞台恢复、情境提示恢复、抽屉宽度按旋转画布重算', () => {
    expect(computed([shellOff, stage], VP).get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(computed([shellCss, stage], VP).get('grid-template-columns')).toContain('var(--d-rail)');
    const sit = { tag: 'div', classes: ['situation'], attrs: {} };
    expect(computed([shellOff, boardStage, sit], VP).get('display')).toBe('none');
    expect(computed([shellCss, boardStage, sit], VP).get('display')).toBe('block');
    expect(computed([shellCss, { tag: 'div', classes: ['drawer'], attrs: {} }], VP).get('width')).toContain('48%');
  });

  it('画布用 dvh/dvw 互换宽高，角度取唯一常量派生的 --ul-rotation，JS px 变量兜底', () => {
    const c = computed([shellCss], VP);
    expect(c.get('position')).toBe('fixed');
    expect(c.get('width')).toBe('var(--ul-vh, 100dvh)');
    expect(c.get('height')).toBe('var(--ul-vw, 100dvw)');
    expect(c.get('transform')).toBe('translateX(var(--ul-vw, 100dvw)) rotate(var(--ul-rotation, 90deg))');
    expect(c.get('transform-origin')).toBe('0 0');
    // 要点 6：旋转是等距变换，绝不叠 scale（否则 44px 触控目标与字号会缩水）
    expect(c.get('transform')).not.toContain('scale');
  });

  it('ccw 分支（唯一常量翻转后的杠杆）换 translateY 与角度，安全区四边按方向重新映射', () => {
    const ccw: CssDesc = {
      tag: 'div', classes: ['shell'],
      attrs: { 'data-landscape-mode': 'css', 'data-landscape-dir': 'ccw' },
    };
    expect(computed([ccw], VP).get('transform')).toBe('translateY(var(--ul-vh, 100dvh)) rotate(var(--ul-rotation, -90deg))');
    // cw: 画布左 = 设备顶（刘海）；ccw: 画布左 = 设备底（Home 条）
    expect(computed([shellCss], VP).get('--ul-safe-left')).toBe('env(safe-area-inset-top, 0px)');
    expect(computed([ccw], VP).get('--ul-safe-left')).toBe('env(safe-area-inset-bottom, 0px)');
    expect(computed([shellCss], VP).get('padding'))
      .toBe('var(--ul-safe-top) var(--ul-safe-right) var(--ul-safe-bottom) var(--ul-safe-left)');
    // 要点 8：viewport-fit=cover 保持不变，env() 才有值可映射
    expect(HTML).toContain('viewport-fit=cover');
  });

  it('要点 10：正立层 z-index 高于 toast(60)、贴底 ≤56px、容器不吃点击、按钮 44×44 可点', () => {
    const hudDesc: CssDesc = { tag: 'div', classes: ['landscape-hud'], attrs: {} };
    const c = computed([hudDesc], VP);
    expect(Number(c.get('z-index'))).toBeGreaterThan(60);
    expect(c.get('max-height')).toBe('56px');
    expect(c.get('bottom')).toContain('env(safe-area-inset-bottom');
    expect(c.get('pointer-events')).toBe('none');
    const btn: CssDesc = { tag: 'button', classes: ['lh-btn'], attrs: {} };
    const b = computed([hudDesc, btn], VP);
    expect(b.get('min-width')).toBe('44px');
    expect(b.get('min-height')).toBe('44px');
    expect(b.get('pointer-events')).toBe('auto');
    // 箭头默认静态；只有唯一常量翻到 ccw 时才镜像，不新增第二个方向入口
    const icon: CssDesc = { tag: 'svg', classes: ['lh-icon'], attrs: {} };
    expect(computed([hudDesc, icon], VP).get('animation')).toBeUndefined();
    const ccwHud: CssDesc = { tag: 'div', classes: ['landscape-hud'], attrs: { 'data-landscape-dir': 'ccw' } };
    expect(computed([ccwHud, icon], VP).get('transform')).toBe('scaleX(-1)');
  });

  it('C7 可选方向入口只在 css 模式出现，且沿用 44px 触控目标', () => {
    const btn: CssDesc = { tag: 'button', classes: ['iconbtn', 'orientation-btn'], attrs: {} };
    expect(computed([shellOff, btn], VP).get('display')).toBe('none');
    expect(computed([shellCss, btn], VP).get('display')).toBe('grid');
    expect(computed([shellCss, btn], VP).get('min-width')).toContain('--d-tap');
  });

  it('C6 / 要点 7：结束页、抽屉、确认条随画布自转且保持可点，touch-action 仍只归 #board', () => {
    const end: CssDesc = { tag: 'div', classes: ['end-screen'], attrs: {} };
    expect(computed([shellCss, end], VP).get('pointer-events')).toBe('auto');
    expect(computed([shellCss, end], VP).get('display')).toBe('grid');
    const drawer: CssDesc = { tag: 'div', classes: ['drawer'], attrs: {} };
    expect(computed([shellCss, drawer], VP).get('pointer-events')).toBe('auto');
    const strip: CssDesc = { tag: 'div', classes: ['confirm-strip'], attrs: {} };
    expect(computed([shellCss, boardStage, strip], VP).get('pointer-events')).toBe('auto');
    const board: CssDesc = { tag: 'svg', classes: [], attrs: { id: 'board' } };
    expect(computed([shellCss, boardStage, board], VP).get('touch-action')).toBe('none');
    expect(computed([shellCss], VP).get('transition')).toBe('none');  // 自转切换无过渡
  });

  it('减少动效（要点 9）：画布、正立层、箭头在应用开关与系统偏好下都无过渡/动画', () => {
    const reduce: CssDesc = {
      tag: 'div', classes: ['shell'],
      attrs: { 'data-landscape-mode': 'css', 'data-reduce-motion': '1' },
    };
    expect(computed([shellCss], VP).get('transition')).toBe('none');
    expect(computed([reduce], VP).get('transition')).toBe('none');
    expect(computed([shellCss], { ...VP, reduceMotion: true }).get('transition')).toBe('none');
    const hudDesc: CssDesc = { tag: 'div', classes: ['landscape-hud'], attrs: {} };
    const hudReduce: CssDesc = { tag: 'div', classes: ['landscape-hud', 'reduce-motion'], attrs: {} };
    expect(computed([hudReduce], VP).get('transition')).toBe('none');
    expect(computed([hudDesc], { ...VP, reduceMotion: true }).get('transition')).toBe('none');
    const icon: CssDesc = { tag: 'svg', classes: ['lh-icon'], attrs: {} };
    expect(computed([hudDesc, icon], { ...VP, reduceMotion: true }).get('animation')).toBe('none');
  });
});
