/**
 * 文档 24 F5 / F6：正式前端行为验收。
 *
 * F5：银行严格 4:1 独立入口、自有港口只列「我的港口」、通用港三张可混选、
 *     专用港对应 2:1、移除借港代换、非自己回合显示原因。
 * F6：两步交易「我想收到 → 我愿给出 → 摘要发送」接入真实 OFFER 协议，
 *     草稿保留、切换不重置、不根据对方隐藏库存限制索取、全零拒绝。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_4P, buildBoard, createGame, viewFor, type Board, type PlayerView } from '@hexfront/engine';
import type { OfferSnapshot } from '@hexfront/protocol';
import { MiniDocument, fire, installGlobals, makeWindow, type MiniWindow } from './fixtures/mini-dom.js';
import { Panels, type PanelCallbacks } from '../src/panels.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const NOW = new Date('2026-11-14T12:00:00Z').getTime();

let doc: MiniDocument;
let win: MiniWindow;
let restore: () => void;
let calls: Record<string, ReturnType<typeof vi.fn>>;
let panels: Panels;

function baseView(): PlayerView {
  const board: Board = buildBoard(MAP_4P);
  const state = createGame(board, ['甲', '乙', '丙', '丁'], ['red', 'blue', 'white', 'orange']);
  const v = viewFor(board, state, 0);
  v.phase = 'play';
  v.current = 0;
  v.viewer = 0;
  v.me.resources = { wood: 5, brick: 5, sheep: 5, wheat: 5, ore: 5 };
  return v;
}

/** 给视图塞两个「我的港口」：通用港 + 专用羊港，端点放自己的村庄 */
function withMyPorts(v: PlayerView): PlayerView {
  const nv = structuredClone(v);
  nv.ports = [
    { edge: 'pa|pb', port: { kind: 'generic' } },
    { edge: 'pc|pd', port: { kind: 'specific', resource: 'sheep' } },
  ];
  nv.buildings['pa'] = { owner: 0, city: false };
  nv.buildings['pc'] = { owner: 0, city: false };
  return nv;
}

function snap(over: Partial<OfferSnapshot> = {}): OfferSnapshot {
  return { offers: [], version: 0, serverTime: NOW, nextSendAt: {}, ...over };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  doc = new MiniDocument(HTML);
  win = makeWindow();
  restore = installGlobals(doc, win);
  calls = {};
  for (const k of [
    'onBuyDev', 'onPlayKnight', 'onPlayMonopoly', 'onPlayPlenty', 'onPlayRoadBuilding',
    'onTradeBank', 'onTradePort', 'onOffer', 'onOfferAccept', 'onOfferReject',
    'onOfferCancel', 'onEndTurn', 'onResume', 'onRequestPick',
  ]) calls[k] = vi.fn();
  const cb = new Proxy(calls, { get: (t, k: string) => (t[k] ??= vi.fn()) }) as unknown as PanelCallbacks;
  panels = new Panels(cb);
  panels.setConnected(true);
  panels.setOffers(snap());
});
afterEach(() => { restore(); vi.useRealTimers(); });

function extra(): string { return doc.getElementById('extra-panel')!.innerHTML; }
/**
 * 草稿区的可读文本。编辑草稿只重画 [data-offer-draft] 子容器，
 * 而测试替身的 innerHTML getter 不序列化子节点，因此这里递归收集
 * 草稿子树的文本与关键属性，拼成可断言的字符串（等价于真实 DOM 的 textContent + outerHTML 摘要）。
 */
function draft(): string {
  const host = doc.getElementById('extra-panel')!.querySelector('[data-offer-draft]');
  if (!host) return extra();
  const parts: string[] = [];
  const walk = (n: { textContent: string; attributes?: Record<string, string>; children: unknown[] }): void => {
    // 只收叶子节点的文本（父节点 textContent 已聚合子节点，重复收集会干扰断言）
    if (n.children.length === 0 && n.textContent) parts.push(n.textContent);
    if (n.attributes) {
      for (const [k, v] of Object.entries(n.attributes)) {
        if (k.startsWith('data-') || k === 'max' || k === 'min') parts.push(`${k}="${v}"`);
      }
    }
    for (const c of n.children) walk(c as typeof n);
  };
  walk(host as unknown as Parameters<typeof walk>[0]);
  return parts.join(' ');
}
function foot(): string { return doc.getElementById('drawer-foot')!.innerHTML; }
function click(sel: string, host = doc.getElementById('drawer-body')!): boolean {
  const t = host.querySelector(sel);
  if (!t) return false;
  fire(t, 'click', {});
  return true;
}
function footClick(sel: string): boolean {
  const t = doc.getElementById('drawer-foot')!.querySelector(sel);
  if (!t) return false;
  fire(t, 'click', {});
  return true;
}

// ---------------------------------------------------------------- F5 银行

describe('F5 · 银行严格 4:1（独立入口，不因港口降比例）', () => {
  it('面板标题与文案明确 4:1；不含「港口」降比例提示', () => {
    panels.setView(withMyPorts(baseView()));
    panels.openFresh('bank');
    expect(extra()).toContain('严格 4:1');
    expect(extra()).toContain('银行不因你拥有港口而降低比例');
    expect(foot()).toContain('data-foot="bank"');
    expect(foot()).toContain('4:1');
  });

  it('完整收付预览：交出 4 张同类 → 收到 1 张', () => {
    panels.setView(baseView());
    panels.openFresh('bank');
    expect(extra()).toContain('交出 木 ×4');
    expect(extra()).toContain('收到 砖 ×1');
  });

  it('同种兑换禁用确认；确认回调只带 give/get 两个资源', () => {
    const v = baseView();
    panels.setView(v);
    panels.openFresh('bank');
    click('[data-act="select"][data-key="bankGet"][data-val="wood"]');
    expect(extra()).toContain('同种资源不能兑换');
    expect(doc.getElementById('drawer-foot')!.querySelector('[data-foot="bank"]')!.disabled).toBe(true);

    click('[data-act="select"][data-key="bankGet"][data-val="ore"]');
    footClick('[data-foot="bank"]');
    expect(calls['onTradeBank']).toHaveBeenCalledWith('wood', 'ore');
  });

  it('非自己回合显示原因并禁用确认', () => {
    const v = baseView();
    v.current = 2;
    panels.setView(v);
    panels.openFresh('bank');
    expect(extra()).toContain('仅自己的回合');
    expect(doc.getElementById('drawer-foot')!.querySelector('[data-foot="bank"]')!.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------- F5 港口

describe('F5 · 我的港口（通用港混合 3 张 / 专用港 2:1）', () => {
  it('无港口时明确不可兑换，不列任何港口', () => {
    panels.setView(baseView());   // 没有建筑在港口端点
    panels.openFresh('port');
    expect(extra()).toContain('你还没有自己的港口');
    expect(extra()).toContain('无港口时不可兑换');
    expect(doc.getElementById('drawer-foot')!.querySelector('[data-foot="port"]')!.disabled).toBe(true);
  });

  it('只列「我的港口」：通用港 3:1 + 专用港 2:1，不出现借港代换', () => {
    panels.setView(withMyPorts(baseView()));
    panels.openFresh('port');
    expect(extra()).toContain('通用港 3:1');
    expect(extra()).toContain('2:1 羊港');
    expect(extra()).not.toContain('借港代换');
    expect(extra()).not.toContain('受益人');
  });

  it('通用港：1木+1砖+1羊 混合三张 → 1矿，回调带资源袋与港口边', () => {
    panels.setView(withMyPorts(baseView()));
    panels.openFresh('port');
    // 选通用港（默认第一个即通用港）
    expect(extra()).toContain('交出资源（共 0 / 需要 3 张，可混合');
    click('[data-act="port-bag"][data-val="wood"][data-step="1"]');
    click('[data-act="port-bag"][data-val="brick"][data-step="1"]');
    click('[data-act="port-bag"][data-val="sheep"][data-step="1"]');
    click('[data-act="select"][data-key="portGet"][data-val="ore"]');
    expect(extra()).toContain('交出 木×1 + 砖×1 + 羊×1 → 收到 矿 ×1');
    footClick('[data-foot="port"]');
    expect(calls['onTradePort']).toHaveBeenCalledWith('pa|pb', { wood: 1, brick: 1, sheep: 1 }, 'ore');
  });

  it('总数不是 3 时确认禁用（由前端预览拦截，服务端仍独立校验）', () => {
    panels.setView(withMyPorts(baseView()));
    panels.openFresh('port');
    click('[data-act="port-bag"][data-val="wood"][data-step="1"]');
    expect(extra()).toContain('需要恰好 3 张');
    expect(doc.getElementById('drawer-foot')!.querySelector('[data-foot="port"]')!.disabled).toBe(true);
  });

  it('专用港：只放行对应资源，给出上限提示', () => {
    panels.setView(withMyPorts(baseView()));
    panels.openFresh('port');
    click('[data-act="port-edge"][data-edge="pc|pd"]');
    expect(extra()).toContain('仅限 羊');
    // 非对应资源的 + 按钮被禁用
    const plusWood = doc.getElementById('extra-panel')!
      .querySelector('[data-act="port-bag"][data-val="wood"][data-step="1"]')!;
    expect(plusWood.disabled).toBe(true);
    expect(extra()).toContain('需要 2 张');
  });

  it('非自己回合显示原因并禁用确认', () => {
    const v = withMyPorts(baseView());
    v.current = 1;
    panels.setView(v);
    panels.openFresh('port');
    expect(extra()).toContain('仅自己的回合');
    expect(doc.getElementById('drawer-foot')!.querySelector('[data-foot="port"]')!.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------- F6 两步交易

describe('F6 · 两步滑条交易接入真实 OFFER 协议', () => {
  function openOffers(v = baseView()): void {
    panels.setView(v);
    panels.setOffers(snap());
    panels.openFresh('offers');
  }

  it('第一步只显示「我想收到」，第二步才显示「我愿给出」与完整摘要', () => {
    openOffers();
    expect(draft()).toContain('我想收到');
    expect(draft()).not.toContain('完整条件');
    expect(foot()).toContain('下一步：我愿给出');
    expect(foot()).not.toContain('发送给「');

    footClick('[data-foot="offer-next"]');
    expect(draft()).toContain('我愿给出');
    expect(draft()).toContain('完整条件');
    expect(draft()).toContain('改第一步');
    expect(foot()).toContain('发送给「乙」');   // 默认报价对象
  });

  it('「我想收到」不按对方隐藏库存限制上限；「我愿给出」受自己库存约束', () => {
    const v = baseView();
    // 把对方（乙）手牌做成 2 张、我方羊只有 2 张
    v.players[1]!.handSize = 2;
    v.me.resources.sheep = 2;
    openOffers(v);
    // 「我想收到」的羊行上限固定 99：不按对方隐藏库存（乙只有 2 张）限制编辑
    expect(draft()).toContain('data-side="get" data-val="sheep"');
    expect(draft()).toMatch(/data-side="get"[\s\S]{0,60}?data-val="sheep"[\s\S]{0,120}?max="99"/);

    footClick('[data-foot="offer-next"]');
    // 「我愿给出」的羊行上限 = 自己持有 2
    expect(draft()).toMatch(/data-side="give"[\s\S]{0,60}?data-val="sheep"[\s\S]{0,120}?max="2"/);
  });

  it('切换步骤 / 返回编辑都保留草稿，不自动发送', () => {
    openOffers();
    // 第一步：想收到 3 羊（对方只有 2 张也能编辑并发出）
    for (let i = 0; i < 3; i++) {
      click('[data-act="offer-qty"][data-side="get"][data-val="sheep"][data-step="1"]');
    }
    footClick('[data-foot="offer-next"]');
    // 第二步：愿给出 2 木
    click('[data-act="offer-qty"][data-side="give"][data-val="wood"][data-step="1"]');
    click('[data-act="offer-qty"][data-side="give"][data-val="wood"][data-step="1"]');
    expect(draft()).toContain('羊×3');
    expect(draft()).toContain('木×2');
    // 返回第一步再回来，草稿仍在
    footClick('[data-foot="offer-back"]');
    footClick('[data-foot="offer-next"]');
    expect(draft()).toContain('羊×3');
    expect(draft()).toContain('木×2');
    expect(calls['onOffer']).not.toHaveBeenCalled();
  });

  it('点击「发送给」把 give/get 原样交给真实 OFFER 协议回调', () => {
    openOffers();
    click('[data-act="offer-qty"][data-side="get"][data-val="sheep"][data-step="1"]');
    click('[data-act="offer-qty"][data-side="get"][data-val="sheep"][data-step="1"]');
    footClick('[data-foot="offer-next"]');
    click('[data-act="offer-qty"][data-side="give"][data-val="ore"][data-step="1"]');
    footClick('[data-foot="send"]');
    expect(calls['onOffer']).toHaveBeenCalledWith(1, { ore: 1 }, { sheep: 2 });
  });

  it('两侧全零不能发送（发送按钮被 offerSendGate 禁用）', () => {
    openOffers();
    footClick('[data-foot="offer-next"]');
    const send = doc.getElementById('drawer-foot')!.querySelector('#offer-send')!;
    expect(send.disabled).toBe(true);
    fire(send, 'click', {});
    expect(calls['onOffer']).not.toHaveBeenCalled();
  });

  it('切换报价列表（收到的提议）不丢草稿', () => {
    openOffers();
    click('[data-act="offer-qty"][data-side="get"][data-val="wheat"][data-step="1"]');
    footClick('[data-foot="refresh"]');   // 返回列表重绘
    expect(draft()).toContain('麦×1');
  });
});
