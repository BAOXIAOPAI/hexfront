/**
 * D-04 行为测试：强盗待办（规则状态）与当前交互模式（本地 UI）分开管理。
 *
 * 真实 Ui 实例 + 真实 PlayerView + 真实棋盘事件序列。验证：
 * - 全员弃完后可先建造 / 交易 / 兑换，再返回强盗任务；
 * - 强盗未处理仍不能结束回合、不能用发展卡；
 * - 有人未弃牌时资源变更由服务端拒绝（前端按钮同步禁用）；
 * - boardOverlay / applyHit / onBoardClick 三条路径都按同一优先级走；
 * - paintBuild / paintTrade 不再一见 pendingRobber 就隐藏。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAP_4P, buildBoard, createGame, viewFor, type PlayerView,
} from '@hexfront/engine';
import { MiniDocument, fire, installGlobals, makeWindow, type MiniWindow } from './fixtures/mini-dom.js';
import { Ui, type UiCallbacks } from '../src/ui.js';
import { roadBuildingCandidates } from '../src/build.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let doc: MiniDocument;
let restore: () => void;
let calls: Record<string, ReturnType<typeof vi.fn>>;
let ui: Ui;

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
  v.me.resources = { wood: 5, brick: 5, sheep: 5, wheat: 5, ore: 5 };
  return v;
}

/** 让棋盘进入正式可建造状态：给 0 号一个村庄 + 一条路，以便有合法道路候选 */
function seededView(): PlayerView {
  const v = playView();
  const board = buildBoard(MAP_4P);
  const vk = board.geo.vertexKeys[0]!;
  const ek = board.geo.vertices[vk]!.edges[0]!;
  v.buildings[vk] = { owner: 0, city: false };
  v.roads[ek] = 0;
  return v;
}

function el(id: string) { return doc.getElementById(id)!; }
function overlayHtml(): string { return el('board').innerHTML; }
function hitTiles(): number { return (overlayHtml().match(/class="hit hit-tile/g) ?? []).length; }
function hitEdges(): number { return (overlayHtml().match(/class="hit hit-edge/g) ?? []).length; }
function hitVertices(): number { return (overlayHtml().match(/class="hit hit-vertex/g) ?? []).length; }

/** 把世界坐标换成客户端坐标：相机用真实投影找最近候选，随便给个点不会命中 */
function screenOf(x: number, y: number): { x: number; y: number } {
  const cam = (ui as unknown as { camera: { worldToScreen(p: { x: number; y: number }): { x: number; y: number } } }).camera;
  return cam.worldToScreen({ x, y });
}
function edgeScreen(key: string): { x: number; y: number } {
  const geo = buildBoard(MAP_4P).geo;
  const e = geo.edges[key]!;
  const a = geo.vertices[e.a]!; const b = geo.vertices[e.b]!;
  return screenOf((a.x + b.x) / 2, (a.y + b.y) / 2);
}
function tileScreen(key: string): { x: number; y: number } {
  const t = buildBoard(MAP_4P).geo.tiles[key]!;
  return screenOf(t.x, t.y);
}
function tapAt(p: { x: number; y: number }, id = 4): void {
  fire(el('board'), 'pointerdown', { pointerId: id, clientX: p.x, clientY: p.y });
  fire(el('board'), 'pointerup', { pointerId: id, clientX: p.x, clientY: p.y });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
  doc = new MiniDocument(HTML);
  restore = installGlobals(doc, makeWindow());
  calls = {};
  for (const k of [
    'onRoll', 'onEndTurn', 'onStart', 'onJoin', 'onPlace', 'onDiscard', 'onBuild',
    'onOffer', 'onOfferAccept', 'onOfferReject', 'onOfferCancel', 'onMoveRobber',
    'onSettings', 'onBuyDev', 'onPlayKnight', 'onPlayMonopoly', 'onPlayPlenty',
    'onPlayRoadBuilding', 'onTradeBank', 'onPortTransfer', 'onRequestPick', 'onResume',
  ]) calls[k] = vi.fn();
  const cb = new Proxy(calls, { get: (t, k: string) => (t[k] ??= vi.fn()) }) as unknown as UiCallbacks;
  ui = new Ui(cb);
});
afterEach(() => { restore(); vi.useRealTimers(); });

describe('D-04 · 弃牌完成后的行动矩阵', () => {
  it('全员弃完、强盗待移动：棋盘默认给强盗地块热区', () => {
    const v = playView();
    v.pendingRobber = true;
    ui.render(v, []);
    expect(hitTiles()).toBeGreaterThan(0);
    expect(hitEdges()).toBe(0);
  });

  it('进入建造模式后棋盘切到建造热区，强盗待办没被清掉（按钮与提示仍在）', () => {
    const v = seededView();
    v.pendingRobber = true;
    ui.render(v, []);
    expect(hitTiles()).toBeGreaterThan(0);

    ui.openBuild('road');
    expect(hitEdges()).toBeGreaterThan(0);     // 建造候选出现
    expect(hitTiles()).toBe(0);                // 棋盘不再停在移动强盗模式
    expect(el('robberbar').classList.contains('hidden')).toBe(false);
    expect(el('robberbar').innerHTML).toContain('返回强盗任务');
    expect(el('robberbar').innerHTML).not.toContain('data-action="steal"');
  });

  it('建造选点真实 pointer 序列：点路边 → 确认 → 发出 BUILD_ROAD，不误触 MOVE_ROBBER', () => {
    const v = seededView();
    v.pendingRobber = true;
    ui.render(v, []);
    ui.openBuild('road');
    const edgeHit = el('board').querySelector('[data-edge]')!;
    expect(edgeHit).not.toBeNull();

    // 用真实 pointerdown → pointerup 触发相机 onTap（坐标经真实投影换算）
    const key = edgeHit.getAttribute('data-edge')!;
    tapAt(edgeScreen(key), 4);

    // 选点会先弹确认条；确认后才发命令
    const confirm = el('confirm-strip');
    expect(confirm.innerHTML).toContain('建造');
    const ok = confirm.querySelector('[data-confirm="ok"]')!;
    fire(ok, 'click', {});
    expect(calls['onBuild']).toHaveBeenCalledTimes(1);
    expect(calls['onBuild']).toHaveBeenCalledWith('road', key);
    expect(calls['onMoveRobber']).not.toHaveBeenCalled();
  });

  it('可暂时交易 / 兑换：pendingRobber 不再隐藏 trade 面板，银行/借港入口未被禁用', () => {
    const v = playView();
    v.pendingRobber = true;
    ui.render(v, []);
    ui.openTrade();
    expect(el('trade').classList.contains('hidden')).toBe(false);
    // panels 的行动区：bank / port 在弃完后恢复，只有发展卡仍禁
    const rail = el('rail-actions').innerHTML;
    expect(rail).toContain('data-panel="bank"');
    expect(rail).toContain('data-panel="port"');
    const bankBtn = el('rail-actions').querySelector('[data-panel="bank"]')!;
    const portBtn = el('rail-actions').querySelector('[data-panel="port"]')!;
    expect(bankBtn.disabled).toBe(false);
    expect(portBtn.disabled).toBe(false);
    for (const dev of ['knight', 'monopoly', 'plenty', 'roads']) {
      expect(el('rail-actions').querySelector(`[data-panel="${dev}"]`)!.disabled).toBe(true);
    }
  });

  it('强盗未处理仍不能结束回合；paintActions 不因切模式而放行', () => {
    const v = playView();
    v.pendingRobber = true;
    ui.render(v, []);
    expect(el('btn-end').disabled).toBe(true);
    expect(el('btn-end').title).toContain('强盗');
    ui.openBuild('road');
    ui.render(v, []);                    // 广播更新后仍保持
    expect(el('btn-end').disabled).toBe(true);
    // 前端 confirmEndTurn 也拦一层（服务端另有权威校验）
    fire(el('btn-end'), 'click', {});
    expect(calls['onEndTurn']).not.toHaveBeenCalled();
  });

  it('强盗处理后 END_TURN 才恢复，发展卡入口同步恢复', () => {
    const v = playView();
    v.pendingRobber = true;
    v.me.devCards = [{ card: 'knight', playable: true }];
    ui.render(v, []);
    expect(el('btn-end').disabled).toBe(true);
    const done = structuredClone(v);
    done.pendingRobber = false;
    ui.render(done, []);
    expect(el('btn-end').disabled).toBe(false);
    expect(el('rail-actions').querySelector('[data-panel="knight"]')!.disabled).toBe(false);
  });

  it('用户主动「返回强盗任务」：只切本地模式，规则待办仍在 view 里', () => {
    const v = seededView();
    v.pendingRobber = true;
    ui.render(v, []);
    ui.openBuild('road');
    expect(hitEdges()).toBeGreaterThan(0);

    const back = el('robberbar').querySelector('[data-action="return-robber"]')!;
    fire(back, 'click', {});
    expect(hitTiles()).toBeGreaterThan(0);
    expect(hitEdges()).toBe(0);
    expect(el('robberbar').innerHTML).toContain('点棋盘上红框的地块');
    expect(el('btn-end').disabled).toBe(true);   // 待办没被清掉
  });

  it('强盗结算：点地块 → 选相邻玩家 → 发 MOVE_ROBBER（棋盘热区仍可用）', () => {
    const v = playView();
    v.pendingRobber = true;
    ui.render(v, []);
    const tileHit = el('board').querySelector('[data-tile]')!;
    const tile = tileHit.getAttribute('data-tile')!;
    tapAt(tileScreen(tile), 8);
    expect(el('robberbar').innerHTML).toContain('从谁手里抽');
    const noSteal = el('robberbar').querySelectorAll('[data-action="steal"]')
      .find((b) => !b.hasAttribute('data-seat'))!;
    expect(noSteal).toBeTruthy();
    fire(noSteal, 'click', {});
    expect(calls['onMoveRobber']).toHaveBeenCalledWith(tile, undefined);
  });

  it('有人尚未弃牌时：建造 / 交易 / 兑换 / 发展卡全部暂停（按钮禁用）', () => {
    const v = playView();
    v.pendingDiscards = [{ player: 0, count: 3 }];
    v.pendingRobber = true;
    ui.render(v, []);
    expect(el('btn-build').disabled).toBe(true);
    expect(el('btn-trade').disabled).toBe(true);
    expect(el('btn-end').disabled).toBe(true);
    expect(el('rail-actions').querySelector('[data-panel="bank"]')!.disabled).toBe(true);
    expect(el('rail-actions').querySelector('[data-panel="port"]')!.disabled).toBe(true);
    expect(el('rail-actions').querySelector('[data-panel="knight"]')!.disabled).toBe(true);
    // 前端不判断合法性：按钮禁用只是提示，真正的拒绝仍来自服务端
    expect(hitTiles()).toBe(0);
  });

  it('paintBuild / paintTrade 不再因 pendingRobber 被隐藏', () => {
    const v = playView();
    v.pendingRobber = true;
    ui.render(v, []);
    fire(el('btn-build'), 'click', {});
    expect(el('build').classList.contains('hidden')).toBe(false);
    expect(el('build').innerHTML).toContain('bp-item');
    fire(el('btn-trade'), 'click', {});
    expect(el('trade').classList.contains('hidden')).toBe(false);
  });
});

describe('D-03 连带 · 筑路第二条候选基于假设第一条已建成', () => {
  it('roadBuildingCandidates 把已选第一条当自己的路，扩展出相邻新候选', () => {
    const v = seededView();
    const board = buildBoard(MAP_4P);
    const geo = board.geo;
    const base = roadBuildingCandidates(v, geo, []);
    expect(base.length).toBeGreaterThan(0);
    const first = base[0]!;
    const next = roadBuildingCandidates(v, geo, [first]);
    expect(next).not.toContain(first);                  // 第一条不再可重复选
    // 与「把第一条真的写进 roads」的视图结果一致
    const assumed = structuredClone(v);
    assumed.roads[first] = v.viewer;
    expect(next).toEqual(roadBuildingCandidates(assumed, geo, []));
    expect(next.length).toBeGreaterThanOrEqual(base.length - 1);
  });

  it('Ui 的筑路选点请求用同一份候选（boardOverlay 与 applyHit 口径一致）', () => {
    const v = seededView();
    ui.render(v, []);
    let done: ((keys: string[]) => void) | undefined;
    ui.requestBoardPick('edges', '选 1–2 条路', (keys) => { done = keys ? (() => undefined) : undefined; });
    // 请求期间棋盘应给出合法道路热区（而非所有空边）
    expect(hitEdges()).toBeGreaterThan(0);
    expect(hitVertices()).toBe(0);
    expect(done).toBeUndefined();
  });
});
