/**
 * D-03 / D-05 行为测试：选点回调的状态生命周期、冷却按钮在正确容器中的禁用/文案。
 *
 * 用真实 Panels 实例 + 真实 DOM 事件序列（click 冒泡到 drawer-body / drawer-foot），
 * 不调用私有方法、不只断言纯函数结果。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAP_4P, buildBoard, createGame, viewFor, tileVertexKeys,
  type Board, type GameState, type PlayerView,
} from '@hexfront/engine';
import type { OfferSnapshot, OfferView } from '@hexfront/protocol';
import { MiniDocument, fire, installGlobals, makeWindow, type MiniWindow } from './fixtures/mini-dom.js';
import { Panels, offerSendGate, type PanelCallbacks } from '../src/panels.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let doc: MiniDocument;
let win: MiniWindow;
let restore: () => void;
let calls: Record<string, ReturnType<typeof vi.fn>>;
let panels: Panels;

const NOW = new Date('2026-11-07T12:00:00Z').getTime();

function boardState(): { board: Board; state: GameState; base: PlayerView } {
  const board = buildBoard(MAP_4P);
  const state = createGame(board, ['甲', '乙', '丙', '丁'], ['red', 'blue', 'white', 'orange']);
  return { board, state, base: viewFor(board, state, 0) };
}

/** 视图里放 3 个玩家建筑：相邻且有牌 / 相邻但没牌 / 有牌但不相邻 */
function knightView(): { view: PlayerView; tile: string; adjacentSeat: number } {
  const { board, base } = boardState();
  const view: PlayerView = structuredClone(base);
  view.phase = 'play';
  view.current = 0;
  view.viewer = 0;
  view.robberTile = '';
  const tile = view.tiles.find((t) => t.key !== '')!.key;
  const verts = tileVertexKeys(board.geo, tile);
  const adjacentSeat = 1;
  view.buildings = {
    [verts[0]!]: { owner: adjacentSeat, city: false },   // 相邻 + 有牌 → 应出现
    [verts[1]!]: { owner: 2, city: false },              // 相邻 + 无牌 → 不出现
  };
  // 找一个不与 tile 相邻的顶点放 3 号（有牌），验证不能只按 handSize 过滤
  const far = board.geo.vertexKeys.find((vk) =>
    !verts.includes(vk) && !view.buildings[vk])!;
  view.buildings[far] = { owner: 3, city: false };
  for (const p of view.players) {
    p.handSize = p.index === adjacentSeat || p.index === 3 ? 3 : 0;
  }
  return { view, tile, adjacentSeat };
}

function snapshot(over: Partial<OfferSnapshot> = {}): OfferSnapshot {
  return {
    offers: [], version: 0, serverTime: NOW, nextSendAt: {}, ...over,
  };
}

function offer(id: string, over: Partial<OfferView> = {}): OfferView {
  return {
    id, from: 1, to: 0, give: { wood: 1 }, get: { wheat: 1 },
    createdAt: NOW, expiresAt: NOW + 10_000, ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  doc = new MiniDocument(HTML);
  win = makeWindow();
  restore = installGlobals(doc, win);
  calls = {};
  for (const key of [
    'onBuyDev', 'onPlayKnight', 'onPlayMonopoly', 'onPlayPlenty', 'onPlayRoadBuilding',
    'onTradeBank', 'onPortTransfer', 'onOffer', 'onOfferAccept', 'onOfferReject',
    'onOfferCancel', 'onEndTurn', 'onResume', 'onRequestPick',
  ]) calls[key] = vi.fn();
  const cb = new Proxy(calls, {
    get: (t, key: string) => (t[key] ??= vi.fn()),
  }) as unknown as PanelCallbacks;
  panels = new Panels(cb);
  panels.setConnected(true);
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

function body(): MiniDocument['body'] { return doc.getElementById('drawer-body')!; }
function foot(): MiniDocument['body'] { return doc.getElementById('drawer-foot')!; }
function extra(): MiniDocument['body'] { return doc.getElementById('extra-panel')!; }
function click(sel: string, host = body()): boolean {
  const target = host.querySelector(sel);
  if (!target) return false;
  fire(target, 'click', {});
  return true;
}
/** 触发面板发起的选点并拿到 done 回调 */
function lastPick(): { kind: string; purpose: string; done: (keys: string[]) => void } {
  const fn = calls['onRequestPick']!;
  const args = fn.mock.calls[fn.mock.calls.length - 1]!;
  return { kind: args[0], purpose: args[1], done: args[2] };
}

// ---------------------------------------------------------------- D-03

describe('D-03 · 骑士 / 筑路选点的状态生命周期', () => {
  it('骑士：选地块 → 保留地块进入第二步 → 选玩家提交闭环（不再被 open 清空）', () => {
    const { view, tile, adjacentSeat } = knightView();
    panels.setView(view);
    panels.openFresh('knight');
    expect(extra().innerHTML).toContain('去棋盘选地块');

    expect(click('[data-act="knight-pick"]')).toBe(true);
    expect(calls['onRequestPick']).toHaveBeenCalledTimes(1);
    expect(lastPick().kind).toBe('tile');

    lastPick().done([tile]);
    const step2 = extra().innerHTML;
    expect(step2).toContain('已选地块');
    expect(step2).toContain(tile);
    expect(step2).toContain(`data-val="${adjacentSeat}"`);
    expect(step2).toContain('不抽牌');

    expect(click(`[data-act="knight-steal"][data-val="${adjacentSeat}"]`)).toBe(true);
    expect(calls['onPlayKnight']).toHaveBeenCalledWith(tile, adjacentSeat);
  });

  it('骑士抽牌对象只包含「所选地块相邻 + 手里有牌」的玩家（与服务端 hasBuildingAdjacent 一致）', () => {
    const { view, tile, adjacentSeat } = knightView();
    panels.setView(view);
    panels.openFresh('knight');
    click('[data-act="knight-pick"]');
    lastPick().done([tile]);
    const step2 = extra().innerHTML;
    expect(step2).toContain(`data-val="${adjacentSeat}"`);
    // 相邻但没牌（2 号）、有牌但不相邻（3 号）都不能出现
    expect(step2).not.toContain('data-val="2"');
    expect(step2).not.toContain('data-val="3"');
  });

  it('骑士无合法目标时只保留「不抽牌」，仍可提交且不误伤别的玩家', () => {
    const { view, tile } = knightView();
    for (const p of view.players) p.handSize = 0;
    panels.setView(view);
    panels.openFresh('knight');
    click('[data-act="knight-pick"]');
    lastPick().done([tile]);
    const step2 = extra().innerHTML;
    expect(step2).toContain('没有手里的玩家');
    expect(step2.match(/data-act="knight-steal"/g) ?? []).toHaveLength(1);
    expect(click('[data-act="knight-steal"][data-val=""]')).toBe(true);
    expect(calls['onPlayKnight']).toHaveBeenCalledWith(tile, undefined);
  });

  it('骑士：取消选点 / 再次打开 / 重选地块都有确定结果', () => {
    const { view, tile } = knightView();
    panels.setView(view);
    panels.openFresh('knight');
    click('[data-act="knight-pick"]');
    lastPick().done([]);                       // 取消：第一步不动
    expect(extra().innerHTML).toContain('去棋盘选地块');

    lastPick().done([tile]);
    expect(extra().innerHTML).toContain('已选地块');
    expect(click('[data-act="knight-pick"]')).toBe(true);   // 重选地块
    expect(calls['onRequestPick']).toHaveBeenCalledTimes(2);

    panels.close();
    panels.openFresh('knight');                // 再次打开 = 新操作，回到第一步
    expect(extra().innerHTML).toContain('去棋盘选地块');
    expect(extra().innerHTML).not.toContain('已选地块');
  });

  it('骑士：广播更新后仍合法则保留，失效则清除并解释（不悄悄改选）', () => {
    const { view, tile } = knightView();
    panels.setView(view);
    panels.openFresh('knight');
    click('[data-act="knight-pick"]');
    lastPick().done([tile]);
    expect(extra().innerHTML).toContain('已选地块');

    // 权威广播：仍然是真实地块且强盗不在上面 → 保留
    panels.setView(view);
    expect(extra().innerHTML).toContain('已选地块');

    // 权威广播：强盗已挪到所选地块 → 失效，回到第一步并给出提示
    const moved = structuredClone(view);
    moved.robberTile = tile;
    panels.setView(moved);
    expect(extra().innerHTML).toContain('去棋盘选地块');
    expect(doc.getElementById('toast')!.textContent).toContain('失效');
  });

  it('筑路：选 1–2 条 → 确认闭环，所选道路不再被清空', () => {
    const { base } = boardState();
    const view = structuredClone(base);
    view.phase = 'play';
    panels.setView(view);
    panels.openFresh('roads');
    expect(extra().innerHTML).toContain('去棋盘选路');

    click('[data-act="roads-pick"]');
    expect(lastPick().kind).toBe('edges');
    lastPick().done(['e1', 'e2']);

    const step2 = extra().innerHTML;
    expect(step2).toContain('已选 2 条路');
    expect(step2).toContain('e1');
    expect(step2).toContain('e2');
    expect(foot().innerHTML).toContain('data-foot="roads"');
    expect(click('[data-foot="roads"]', foot())).toBe(true);
    expect(calls['onPlayRoadBuilding']).toHaveBeenCalledWith(['e1', 'e2']);
  });

  it('筑路：只选一条也能提交；取消 / 再次打开有确定结果', () => {
    const { base } = boardState();
    const view = structuredClone(base);
    view.phase = 'play';
    panels.setView(view);
    panels.openFresh('roads');
    click('[data-act="roads-pick"]');
    lastPick().done(['e1']);
    expect(extra().innerHTML).toContain('已选 1 条路');
    expect(click('[data-foot="roads"]', foot())).toBe(true);
    expect(calls['onPlayRoadBuilding']).toHaveBeenCalledWith(['e1', undefined]);

    panels.close();
    panels.openFresh('roads');
    expect(extra().innerHTML).toContain('去棋盘选路');
  });

  it('筑路：广播更新把已占用的边剔除，仍合法则保留', () => {
    const { base } = boardState();
    const view = structuredClone(base);
    view.phase = 'play';
    panels.setView(view);
    panels.openFresh('roads');
    click('[data-act="roads-pick"]');
    lastPick().done(['e1', 'e2']);
    const occupied = structuredClone(view);
    occupied.roads['e2'] = 1;
    panels.setView(occupied);
    expect(extra().innerHTML).toContain('已选 1 条路');
    expect(extra().innerHTML).toContain('e1');
    expect(extra().innerHTML).not.toContain('e2');
  });

  it('open() 只负责展示当前步骤，初始化只发生在 openFresh()', () => {
    const { view, tile } = knightView();
    panels.setView(view);
    panels.openFresh('knight');
    click('[data-act="knight-pick"]');
    lastPick().done([tile]);
    // 直接 open（例如同帧恢复）不得清空状态
    panels.open('knight');
    expect(extra().innerHTML).toContain('已选地块');
  });
});

// ---------------------------------------------------------------- D-05

describe('D-05 · 发送冷却按钮与报价列表稳定性', () => {
  function setupOffers(snap = snapshot()): void {
    const { base } = boardState();
    const view = structuredClone(base);
    view.phase = 'play';
    view.current = 0;
    // 手里得有牌，否则「增加我付出」按持有量钳到 0（界面不会让人给不存在的资源）
    view.me.resources = { wood: 5, brick: 5, sheep: 5, wheat: 5, ore: 5 };
    panels.setView(view);
    panels.setOffers(snap);
    panels.openFresh('offers');
  }
  function send(): MiniDocument['body'] {
    const btn = foot().querySelector('#offer-send')!;
    fire(btn, 'click', {});
    return btn;
  }
  function sendButton(): MiniDocument['body'] {
    return foot().querySelector('#offer-send')!;
  }

  it('发送按钮渲染在 drawerFoot（不是 drawerBody），tick 能在正确容器找到它', () => {
    setupOffers();
    expect(body().querySelector('#offer-send')).toBeNull();
    expect(foot().querySelector('#offer-send')).not.toBeNull();
    expect(foot().innerHTML).toContain('id="offer-send"');
    expect(foot().innerHTML).toContain('data-foot="refresh"');
  });

  it('发送后显示冷却倒计时且不可重复发送；冷却期间草稿仍可编辑', () => {
    setupOffers();
    // 先写一份非空草稿
    click('[data-act="give"][data-val="wood"][data-step="1"]');
    expect(sendButton().disabled).toBe(false);        // 条件齐备才允许点击
    expect(send().disabled).toBe(true);               // 点完立刻本地防连点
    expect(calls['onOffer']).toHaveBeenCalledTimes(1);
    expect(sendButton().textContent).toContain('已发送');

    // 服务端广播带 nextSendAt 的快照
    panels.setOffers(snapshot({ version: 1, nextSendAt: { '0': NOW + 3000 } }));
    const btn = foot().querySelector('#offer-send')!;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/发送冷却 3\.0s/);
    expect(send().disabled).toBe(true);             // 重复点击不再发出
    expect(calls['onOffer']).toHaveBeenCalledTimes(1);

    // 冷却期间编辑草稿不被禁用条件抹掉
    click('[data-act="give"][data-val="wood"][data-step="1"]');
    expect(doc.getElementById('drawer-foot')!.querySelector('#offer-send')!.disabled).toBe(true);
    expect(extra().innerHTML).toContain('我付出');
  });

  it('冷却结束后仅「非空 + 合法对象 + 已同步 + 普通阶段 + 无弃牌锁」可发送', () => {
    setupOffers(snapshot({ nextSendAt: { '0': NOW + 3000 } }));
    click('[data-act="give"][data-val="wood"][data-step="1"]');
    expect(foot().querySelector('#offer-send')!.disabled).toBe(true);

    vi.advanceTimersByTime(3100);
    panels.setOffers(snapshot({ version: 1, serverTime: NOW + 3100, nextSendAt: {} }));
    expect(foot().querySelector('#offer-send')!.disabled).toBe(false);
    expect(foot().querySelector('#offer-send')!.textContent).toBe('发送报价');
  });

  it('offerSendGate：断线 / 弃牌锁 / 阶段不对 / 非法对象 / 空内容 一律禁用', () => {
    const ok = {
      connected: true, phase: 'play' as const, discardLock: false, pendingSend: false,
      targets: [1, 2, 3], target: 1, give: { wood: 1 }, get: {}, cooldownMsLeft: 0,
    };
    expect(offerSendGate(ok).disabled).toBe(false);
    expect(offerSendGate({ ...ok, connected: false }).label).toContain('连接未同步');
    expect(offerSendGate({ ...ok, phase: 'setup' }).label).toContain('阶段');
    expect(offerSendGate({ ...ok, discardLock: true }).label).toContain('弃牌');
    expect(offerSendGate({ ...ok, pendingSend: true }).label).toContain('已发送');
    expect(offerSendGate({ ...ok, cooldownMsLeft: 1200 }).label).toContain('发送冷却 1.2s');
    expect(offerSendGate({ ...ok, target: 9 }).label).toContain('报价对象');
    expect(offerSendGate({ ...ok, give: {}, get: {} }).disabled).toBe(true);
  });

  it('断线 / 弃牌锁 / 回合变化后按钮状态及时更新（tick 不会意外解除禁用）', () => {
    setupOffers();
    click('[data-act="give"][data-val="wood"][data-step="1"]');
    expect(foot().querySelector('#offer-send')!.disabled).toBe(false);

    panels.setConnected(false);
    expect(foot().querySelector('#offer-send')!.disabled).toBe(true);
    vi.advanceTimersByTime(600);   // 三次 tick 不能把它改回 enabled
    expect(foot().querySelector('#offer-send')!.disabled).toBe(true);
    panels.setConnected(true);

    const { base } = boardState();
    const locked = structuredClone(base);
    locked.phase = 'play';
    locked.pendingDiscards = [{ player: 0, count: 3 }];
    panels.setView(locked);
    expect(foot().querySelector('#offer-send')!.disabled).toBe(true);
    expect(foot().querySelector('#offer-send')!.textContent).toContain('弃牌');

    // 回合变化：非当前玩家只能向当前玩家报价，原草稿目标失效
    const turned = structuredClone(locked);
    turned.pendingDiscards = [];
    turned.current = 2;
    panels.setView(turned);
    expect(foot().querySelector('#offer-send')!.disabled).toBe(true);
  });

  it('刷新/重连不能绕过服务端冷却：WELCOME 带回的 nextSendAt 仍禁用按钮', () => {
    setupOffers();
    click('[data-act="give"][data-val="wood"][data-step="1"]');
    // 模拟重连后 WELCOME 的 snapshot（服务端时间更晚，冷却仍旧有效）
    panels.setOffers(snapshot({ version: 7, serverTime: NOW + 500, nextSendAt: { '0': NOW + 3000 } }));
    expect(foot().querySelector('#offer-send')!.disabled).toBe(true);
    expect(foot().querySelector('#offer-send')!.textContent).toContain('发送冷却');
    expect(send().disabled).toBe(true);
    expect(calls['onOffer']).not.toHaveBeenCalled();
  });

  it('到期 / 替换 / 清除报价后卡片原地失效，不让另一条接受按钮顶到手指下', () => {
    const first = offer('o1');
    const second = offer('o2', { from: 2 });
    setupOffers(snapshot({ offers: [first, second], version: 1 }));
    const before = body().querySelectorAll('[data-offer]').map((c) => c.dataset.offer);
    expect(before).toEqual(['o1', 'o2']);
    const acceptBefore = body().querySelectorAll('[data-act="accept"]');
    expect(acceptBefore).toHaveLength(2);

    // 服务端把 o1 清掉（被接受 / 替换 / 掷 7 清空），只剩 o2
    panels.setOffers(snapshot({ offers: [second], version: 2 }));
    const after = body().querySelectorAll('[data-offer]').map((c) => c.dataset.offer);
    expect(after).toEqual(['o1', 'o2']);        // 节点没被删除、顺序没变 → 位置不跳
    const endedCard = body().querySelector('[data-offer="o1"]')!;
    expect(endedCard.dataset.offerEnded).toBe('1');
    const endedAccept = endedCard.querySelector('[data-act="accept"]')!;
    expect(endedAccept.disabled).toBe(true);
    // 点已失效卡片的「接受」不会把 o2 的意图发出去
    fire(endedAccept, 'click', {});
    expect(calls['onOfferAccept']).not.toHaveBeenCalled();
    // 剩下的 o2 仍停在自己原来的位置（第二个），不会因为 o1 消失而顶到手指下
    const acceptButtons = body().querySelectorAll('[data-act="accept"]');
    expect(acceptButtons).toHaveLength(2);
    expect(acceptButtons[0]!.disabled).toBe(true);
    expect(acceptButtons[1]!.disabled).toBe(false);
    expect(acceptButtons[1]!.closest('[data-offer]')!.dataset.offer).toBe('o2');

    // 只有用户主动点「返回列表」才重排
    click('[data-foot="refresh"]', foot());
    expect(body().querySelectorAll('[data-offer]').map((c) => c.dataset.offer)).toEqual(['o2']);
  });

  it('冷却期间编辑草稿不会重排报价列表（按钮位置保持稳定）', () => {
    const first = offer('o1');
    const second = offer('o2', { from: 2 });
    setupOffers(snapshot({ offers: [first, second], version: 1, nextSendAt: { '0': NOW + 3000 } }));
    const before = body().querySelectorAll('[data-act="accept"]').map((b) => b.closest('[data-offer]')!.dataset.offer);
    expect(before).toEqual(['o1', 'o2']);

    click('[data-act="give"][data-val="wood"][data-step="1"]');
    click('[data-act="target"][data-val="2"]');
    expect(body().querySelectorAll('[data-act="accept"]').map((b) => b.closest('[data-offer]')!.dataset.offer))
      .toEqual(['o1', 'o2']);
    expect(body().querySelector('[data-offer-draft]')).not.toBeNull();
    // 编辑草稿不解除冷却禁用
    expect(foot().querySelector('#offer-send')!.disabled).toBe(true);
    expect(foot().querySelector('#offer-send')!.textContent).toContain('发送冷却');
  });

  it('后台超过 10 秒的报价正确过期：过期卡片禁用原操作并提示返回列表', () => {
    const expired = offer('o-old', { createdAt: NOW - 11_000, expiresAt: NOW - 1000 });
    setupOffers(snapshot({ offers: [expired], version: 1 }));
    const card = body().querySelector('[data-offer="o-old"]')!;
    expect(card.dataset.offerEnded).toBe('1');
    expect(card.querySelector('[data-act="accept"]')!.disabled).toBe(true);
    expect(card.querySelector('.meta')!.textContent).toContain('已过期');
  });
});
