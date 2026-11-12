/**
 * 晴湾纸雕桌面接入 · 行为测试（docs/21-desktop-integration.md）。
 *
 * 覆盖本轮新增的呈现层契约，以及用户点名的三条硬约束：
 *  - 报价计时沿用服务端（expiresAt / serverTime / nextSendAt，前端只渲染倒计时）
 *  - 骰子结果来自服务端（view.dice；spinDice 只是表演，落定后回到权威值）
 *  - 动画不延迟游戏状态更新（收到 STATE 立即 render()，动效只改 transform/opacity）
 *
 * 这些是 jsdom 之外的 MiniDocument 行为测试，不冒充浏览器/真机；真实浏览器证据见
 * docs/shots/pc1-* 与 probe/desktop-{build,dice}-flow.mjs 的结构化输出。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MiniDocument, fire, installGlobals, makeWindow } from './fixtures/mini-dom.js';
import { Ui, type UiCallbacks } from '../src/ui.js';
import { installShelfBridge, syncShelf } from '../src/shelf.js';
import { offerSendGate, offerTargets } from '../src/panels.js';
import { OFFER_TTL_MS, OFFER_SEND_COOLDOWN_MS, type OfferSnapshot } from '@hexfront/protocol';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const UI_SRC = readFileSync(path.join(ROOT, 'src/ui.ts'), 'utf8');
const PANELS_SRC = readFileSync(path.join(ROOT, 'src/panels.ts'), 'utf8');
const SCENE_SRC = readFileSync(path.join(ROOT, 'src/scene.ts'), 'utf8');
const CSS = readFileSync(path.join(ROOT, 'src/papercut.css'), 'utf8');

describe('晴湾纸雕桌面主画面 · DOM 结构', () => {
  it('index.html 是三行桌面 shell（顶栏 / 主区 / 底栏手牌架）且保留全部旧 id', () => {
    expect(HTML).toContain('data-theme="papercut"');
    expect(HTML).toContain('<footer class="shelf" id="shelf">');
    for (const id of [
      'shell', 'board-stage', 'board', 'players', 'rail-task', 'offer',
      'shelf-hand', 'shelf-btn-roll', 'shelf-btn-build', 'shelf-btn-trade', 'shelf-btn-end',
      'btn-roll', 'btn-build', 'btn-trade', 'btn-end', 'hand', 'devcards', 'die1', 'die2',
      'landscape-hud',
    ]) {
      expect(new RegExp(`id="${id}"`).test(HTML), `缺少 #${id}`).toBe(true);
    }
    // 主题层最后加载，layout.css 在它之前（dom-contract 的引入顺序契约）
    expect(HTML.indexOf('/src/papercut.css')).toBeGreaterThan(HTML.indexOf('/src/layout.css'));
    expect(HTML.indexOf('/src/layout.css')).toBeGreaterThan(HTML.indexOf('/src/styles.css'));
    // 正立层仍在 shell 之外
    const shellEnd = HTML.indexOf('</div>\n\n  <!-- ULS 正立层');
    expect(HTML.indexOf('id="landscape-hud"')).toBeGreaterThan(shellEnd);
  });

  it('没有重复 id（重复会让 byId 拿到错误节点）', () => {
    const ids = [...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('底栏手牌架桥接 · 不重复实现规则入口', () => {
  let doc: MiniDocument; let restore: () => void;
  beforeEach(() => {
    doc = new MiniDocument(HTML);
    restore = installGlobals(doc, makeWindow() as never);
  });
  afterEach(() => restore());

  it('可见按钮点击只转发到既有逻辑按钮，不绕过 disabled', () => {
    const logic = doc.getElementById('btn-build') as unknown as HTMLButtonElement;
    const mirror = doc.getElementById('shelf-btn-build') as unknown as HTMLButtonElement;
    // MiniElement 没有浏览器原生 .click()；补一个等价 shim，让被测代码路径与真实浏览器一致
    (logic as unknown as Record<string, unknown>)['click'] = () => fire(logic as never, 'click', {});
    let clicks = 0;
    logic.addEventListener('click', () => { clicks += 1; });
    installShelfBridge();
    logic.disabled = true;
    fire(mirror as never, 'click', {});
    expect(clicks).toBe(0);                       // 禁用时不发送
    logic.disabled = false;
    fire(mirror as never, 'click', {});
    expect(clicks).toBe(1);                       // 只触发一次，不重复提交
  });

  it('syncShelf 把逻辑节点的手牌 / 数量 / 禁用原因同步到可见镜像', () => {
    const hand = doc.getElementById('hand')!;
    hand.innerHTML = '<div class="card"><div class="cband"></div><div class="cnum">4</div><div class="cname">森林</div></div>';
    const total = doc.getElementById('hand-total')!;
    total.textContent = '9 张';
    const reason = doc.getElementById('blocked-reason')!;
    reason.textContent = '还需移动强盗';
    const roll = doc.getElementById('btn-roll') as unknown as HTMLButtonElement;
    roll.disabled = true;
    syncShelf();
    expect(doc.getElementById('shelf-hand')!.innerHTML).toContain('cnum');
    expect(doc.getElementById('shelf-hand-total')!.textContent).toBe('9 张');
    expect(doc.getElementById('shelf-action-note')!.textContent).toBe('还需移动强盗');
    expect((doc.getElementById('shelf-btn-roll') as unknown as HTMLButtonElement).disabled).toBe(true);
    expect(doc.getElementById('risk-chip')!.classList.contains('hidden')).toBe(false);
  });
});

describe('三条硬约束 · 服务端权威', () => {
  it('骰子点数只读 view.dice；spinDice 的随机点数只是表演且落定后回到权威值', () => {
    expect(UI_SRC).toContain('view.dice');
    expect(UI_SRC).toContain('paintDice(this.view)');   // 动画结束回到服务端值
    expect(UI_SRC).toContain('Math.random()');          // 仅用于 spinDice 表演
    // 代码里不存在「本地指定骰点发给服务端」的路径
    expect(UI_SRC).not.toMatch(/ROLL_DICE[^;]*dice:/);
  });

  it('报价计时以服务端 expiresAt / serverTime / nextSendAt 为准，不本地裁决', () => {
    expect(PANELS_SRC).toContain('snapshot.serverTime - Date.now()');
    expect(PANELS_SRC).toContain('o.expiresAt - this.serverNow()');
    expect(PANELS_SRC).toContain('nextSendAt');
    expect(PANELS_SRC).toContain('offerSendGate');
    // 协议常量就是 10s / 3s，前端不另设业务上限
    expect(OFFER_TTL_MS).toBe(10_000);
    expect(OFFER_SEND_COOLDOWN_MS).toBe(3_000);
  });

  it('sendGate 在冷却 / 弃牌 / 未同步时禁用，且文案给出原因', () => {
    const base = {
      connected: true, phase: 'play' as const, discardLock: false, pendingSend: false,
      targets: [1, 2, 3], target: 1, give: { wood: 1 }, get: {}, cooldownMsLeft: 0,
    };
    expect(offerSendGate(base).disabled).toBe(false);
    expect(offerSendGate({ ...base, cooldownMsLeft: 1200 }).label).toContain('发送冷却');
    expect(offerSendGate({ ...base, discardLock: true }).label).toContain('弃牌');
    expect(offerSendGate({ ...base, connected: false }).label).toContain('连接未同步');
  });

  it('非当前玩家只能向当前玩家报价（服务端权限的界面呈现）', () => {
    const stub = (viewer: number, current: number) => ({
      viewer, current,
      players: [0, 1, 2, 3].map((i) => ({ index: i })),
    }) as never;
    expect(offerTargets(stub(0, 0))).toEqual([1, 2, 3]);
    expect(offerTargets(stub(1, 0))).toEqual([0]);
  });
});

describe('棋盘几何与建造链路 · 只换皮不动契约', () => {
  it('scene.ts 保留 viewBox / PAD / data-* / layer 顺序 / roadMarkup 无 filter', () => {
    expect(SCENE_SRC).toContain('const PAD = 92');
    expect(SCENE_SRC).toContain('setAttribute(\'viewBox\'');
    expect(SCENE_SRC).toContain('data-layer="hits"');
    expect(SCENE_SRC).toContain('data-edge=');
    expect(SCENE_SRC).toContain('data-vertex=');
    expect(SCENE_SRC).toContain('data-tile=');
    expect(SCENE_SRC).toContain('data-layer="roads"');
    expect(SCENE_SRC).toContain('data-layer="buildings"');
    // 道路仍不用 filter（垂直边 bbox 宽 0 会被裁掉）
    const roadFn = SCENE_SRC.slice(SCENE_SRC.indexOf('export function roadMarkup'), SCENE_SRC.indexOf('const road = roadMarkup'));
    expect(roadFn).not.toContain('filter=');
    expect((roadFn.match(/<line /g) ?? []).length).toBe(4);
  });

  it('papercut.css 在桌面 ≥1180px 撤销整页自转，且保留减少动效降级', () => {
    expect(CSS).toContain('@media (min-width: 1180px)');
    expect(CSS).toContain('transform: none');
    expect(CSS).toContain('prefers-reduced-motion');
    expect(CSS).toContain('[data-reduce-motion="1"]');
    expect(CSS).toContain('--pc-top-h: 78px');
    expect(CSS).toContain('--pc-shelf-h: 146px');
    expect(CSS).toContain('--pc-rail-w: 324px');
  });
});

describe('弃牌选择在多人同时弃牌时不被清空（真实缺陷回归）', () => {
  it('签名只认「回合 + 我需要弃几张」，不含「还有几个人要弃」', () => {
    // 缺陷：旧签名是 `${turn}:${need}:${total}`。
    // 多人同时弃牌时，别人先弃完会让 total 从 2 变 1，
    // 导致我正在选、尚未提交的牌单被清空，确认按钮一直不可用。
    const src = readFileSync(path.join(ROOT, 'src/ui.ts'), 'utf8');
    const block = src.slice(src.indexOf('换回合、换需求就清空已选'), src.indexOf('const total = pickedTotal'));
    // 只看真正赋值的那一行，避免命中解释性注释
    const sigLine = block.split('\n').find((l) => l.includes('const sig =')) ?? '';
    expect(sigLine).toContain('${view.turn}:${info.need}');
    expect(sigLine).not.toContain('info.total');
  });
});

describe('布局不产生横向溢出（真实缺陷回归）', () => {
  it('shell 用 overflow:clip，抽屉用 fixed，避免把画布推出视口', () => {
    // 缺陷：抽屉的 translateX(105%) 在 overflow:hidden 下仍会撑出可滚动区域
    // （实测 scrollWidth 1878 > 1440）。浏览器 focus/scrollIntoView 会把整块画布
    // 横向推走，导致棋盘与弃牌面板的按钮落在负坐标、点不到。
    const shellBlock = CSS.slice(CSS.indexOf('body[data-theme="papercut"] .shell {'),
      CSS.indexOf('/* 桌面 ≥1180px'));
    expect(shellBlock).toContain('overflow: clip');
    expect(shellBlock).not.toMatch(/^\s*overflow: hidden;/m);

    const drawerBlock = CSS.slice(CSS.indexOf('body[data-theme="papercut"] .drawer {'));
    expect(drawerBlock.slice(0, 300)).toContain('position: fixed');
  });
});

describe('掷出 7 时清掉未完成的建造草稿（真实缺陷回归）', () => {
  it('render() 在 pendingRobber 时清除 buildMode，避免强盗热区不出现', () => {
    // 缺陷：玩家点「建造」但还没选位置就掷出 7，buildMode 残留；
    // boardInteraction() 里 buildMode 优先于强盗 → 强盗热区永远不出现，
    // 玩家无法结算、回合卡死（四浏览器验收实测 turn=64 空转）。
    const src = readFileSync(path.join(ROOT, 'src/ui.ts'), 'utf8');
    const renderBlock = src.slice(src.indexOf('render(view: PlayerView'), src.indexOf('private ensureGeo'));
    expect(renderBlock).toContain('view.pendingRobber');
    expect(renderBlock).toContain('this.buildMode = null');
    // 不能误清「已经选了位置、正等确认」的草稿
    expect(renderBlock).toContain('!this.pendingKey');
  });
});
