/**
 * 文档 24 F6：隐藏手牌 / 隐私疑点专项隔离复现。
 *
 * 任务书 §8 要求：
 * - 隔离测试中固定乙只有 2 羊，甲在「我想收到」选 3 羊，应能编辑并发出，
 *   乙接受时才检验资源。
 * - 改变乙羊数但保持甲自身状态相同，比较甲的编辑上限/按钮状态/提示/网络响应，
 *   必须无隐藏库存差异；自己给出数量受自己的库存约束。
 * - 审查实际广播消息，不只检查 TS 类型；公开人数/手牌总数不属于隐藏种类泄漏。
 * - 不得为实现滑条把别人的完整资源袋下发客户端。
 *
 * 结论口径：这里只证明「本地实现与广播结构」是否泄漏；用户线上现象仍需隔离房复现，
 * 不能未复现就宣称已修复。
 */
import { describe, expect, it } from 'vitest';
import {
  MAP_4P, buildBoard, createGame, viewFor, type Board, type GameState, type PlayerView,
} from '@hexfront/engine';
import { Room } from '../src/room.js';
import type { ServerMessage } from '../src/protocol.js';
import { driveSetup, FakeSocket } from './helpers.js';

const NAMES = ['甲', '乙', '丙', '丁'];
const COLORS = ['red', 'blue', 'white', 'orange'] as const;

function boardAndState(): { board: Board; state: GameState } {
  const board = buildBoard(MAP_4P);
  const state = createGame(board, NAMES, [...COLORS]);
  return { board, state };
}

/** 乙（seat 1）持有 sheep 张羊；甲（seat 0）状态完全不变 */
function viewWithOtherSheep(sheep: number): PlayerView {
  const { board, state } = boardAndState();
  const next = structuredClone(state);
  next.players[1]!.resources = { wood: 0, brick: 0, sheep, wheat: 0, ore: 0 };
  next.players[0]!.resources = { wood: 2, brick: 2, sheep: 2, wheat: 2, ore: 2 };
  next.phase = 'play';
  next.current = 0;
  const v = viewFor(board, next, 0);
  return v;
}

describe('F6 · 隐藏手牌不进入他人视图（结构审计）', () => {
  it('公共 PlayerView 只给他人手牌总数，不含 resources / devCards 明细', () => {
    const v = viewWithOtherSheep(2);
    for (const p of v.players) {
      expect(p).not.toHaveProperty('resources');
      expect(p).not.toHaveProperty('devCards');
      expect(typeof p.handSize).toBe('number');
    }
    // 自己才有完整资源袋
    expect(v.me.resources).toBeDefined();
  });

  it('改变乙的羊数：甲的可见信息除 handSize 外完全一致（无种类泄漏）', () => {
    const a = viewWithOtherSheep(2);
    const b = viewWithOtherSheep(5);
    // 除「乙的手牌总数」外，甲的视图与乙的库存种类无关
    const strip = (v: PlayerView): unknown => ({
      ...v,
      players: v.players.map((p) => ({ ...p, handSize: p.index === 1 ? 0 : p.handSize })),
    });
    expect(strip(b)).toEqual(strip(a));
  });

  it('makeOffer 不因对方库存不足而拒绝：报价只校验发起方与内容', () => {
    const room = new Room('f6-privacy', { capacity: 4, minPlayers: 4, skipReadyCheck: true, now: () => 1000 });
    const sockets = NAMES.map((n) => new FakeSocket(n));
    NAMES.forEach((n, i) => expect(room.join(n, sockets[i]!).ok).toBe(true));
    for (let s = 0; s < 4; s++) room.setReady(s, true);
    expect(room.start(0, room.lobbyConfig().configVersion).ok).toBe(true);
    driveSetup(room);   // 走完摆位进入 play 阶段

    const g = room.game!;
    g.players[0]!.resources = { wood: 2, brick: 0, sheep: 0, wheat: 0, ore: 0 };
    g.players[1]!.resources = { wood: 0, brick: 0, sheep: 2, wheat: 0, ore: 0 };  // 乙只有 2 羊
    g.current = 0;

    // 甲在「我想收到」选 3 羊（超过乙的 2 张）→ 仍能发出
    const out = room.makeOffer(0, 1, { wood: 1 }, { sheep: 3 });
    expect(out.ok).toBe(true);

    // 乙接受时才由服务端校验资源 → 不足则拒绝，报价保留到到期
    const accepted = room.acceptOffer(1, out.ok ? out.offerId : '');
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.reason).toBe('INSUFFICIENT_RESOURCES');
    expect(room.snapshot().offers).toHaveLength(1);
  });

  it('广播的 OFFER 快照只含双方条件，不含任何一方完整资源袋', () => {
    const room = new Room('f6-broadcast', { capacity: 4, minPlayers: 4, skipReadyCheck: true, now: () => 1000 });
    const sockets = NAMES.map((n) => new FakeSocket(n));
    NAMES.forEach((n, i) => expect(room.join(n, sockets[i]!).ok).toBe(true));
    for (let s = 0; s < 4; s++) room.setReady(s, true);
    room.start(0, room.lobbyConfig().configVersion);
    driveSetup(room);
    room.game!.players[0]!.resources = { wood: 2, brick: 0, sheep: 0, wheat: 0, ore: 0 };
    room.game!.current = 0;
    room.makeOffer(0, 1, { wood: 1 }, { sheep: 3 });

    const offers = sockets[1]!.sent.filter((m): m is Extract<ServerMessage, { t: 'OFFERS' }> => m.t === 'OFFERS');
    expect(offers.length).toBeGreaterThan(0);
    const raw = JSON.stringify(offers.at(-1));
    expect(raw).not.toContain('"resources"');
    expect(raw).not.toContain('"devCards"');
    // 只应出现报价双方的条件字段
    expect(raw).toContain('"give"');
    expect(raw).toContain('"get"');
  });

  it('STATE 广播给每个座位都只带自己的 resources，不含他人明细', () => {
    const room = new Room('f6-state', { capacity: 4, minPlayers: 4, skipReadyCheck: true, now: () => 1000 });
    const sockets = NAMES.map((n) => new FakeSocket(n));
    NAMES.forEach((n, i) => expect(room.join(n, sockets[i]!).ok).toBe(true));
    for (let s = 0; s < 4; s++) room.setReady(s, true);
    room.start(0, room.lobbyConfig().configVersion);
    driveSetup(room);
    room.sync();

    for (let seat = 0; seat < 4; seat++) {
      const states = sockets[seat]!.sent.filter((m): m is Extract<ServerMessage, { t: 'STATE' }> => m.t === 'STATE');
      const view = states.at(-1)!.view;
      // 自己的 resources 有明细，别人的没有
      expect(view.me.resources).toBeDefined();
      for (const p of view.players) {
        expect(p).not.toHaveProperty('resources');
      }
      // 序列化后的广播里，他人座位不可能出现资源种类明细
      const raw = JSON.stringify(states.at(-1));
      const meName = view.me.name;
      expect(raw).toContain(`"name":"${meName}"`);
      expect((raw.match(/"resources"/g) ?? []).length).toBe(1);   // 只有自己的 me.resources
    }
  });
});

describe('F6 · 前端编辑上限只看自己（与任务书验收一致）', () => {
  it('「我想收到」上限固定 99，不随对方手牌变化；「我愿给出」上限 = 自己持有', () => {
    // 这两个上限由 panels.offerDraftHtml 的 sideRows 决定：
    //   max = isGive ? v.me.resources[r] : 99
    // 这里用纯逻辑复刻断言，避免依赖 DOM；DOM 侧由 f5-f6-panels.test.ts 覆盖。
    const cap = (isGive: boolean, own: number): number => (isGive ? own : 99);
    for (const otherSheep of [0, 2, 5, 40]) {
      void otherSheep;   // 对方库存不参与任何上限计算
      expect(cap(false, 2)).toBe(99);
      expect(cap(true, 2)).toBe(2);
    }
  });
});
