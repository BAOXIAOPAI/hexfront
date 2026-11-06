/**
 * 重构指南阶段 C：报价与行动权限的规则契约（docs/10-refactor-guide.md 第 1 / 7 / 8 / 13.2 节）。
 *
 * 阶段 A 这里放的是「现状缺陷证据 + 目标 todo」；阶段 C 已把 todo 全部转成真实断言。
 * 时钟由 fixture 注入，测试不真实等待 10 秒，也不依赖清理定时器。
 */

import { describe, expect, it } from 'vitest';
import { OFFER_SEND_COOLDOWN_MS, OFFER_TTL_MS } from '../src/protocol.js';
import { Room, type OfferOutcome } from '../src/room.js';
import { FakeSocket, driveSetup } from './helpers.js';

// 验收需要可复现的骰子；真实环境默认关闭（见 room.command 的剥离逻辑）
process.env.HEXFONT_FAKE_DICE = '1';

const NAMES = ['甲', '乙', '丙', '丁'];

/** 满员自动开局 + 走完摆位；每人手牌固定，时钟可控 */
function fixture(capacity = 3) {
  let clock = 1_000_000;
  const room = new Room('contract', { capacity, now: () => clock });
  const sockets: FakeSocket[] = [];
  for (const name of NAMES.slice(0, capacity)) {
    const s = new FakeSocket(name);
    expect(room.join(name, s).ok).toBe(true);
    sockets.push(s);
  }
  driveSetup(room);
  for (const p of room.game!.players) {
    p.resources = { wood: 3, brick: 2, sheep: 2, wheat: 2, ore: 2 };
  }
  return {
    room,
    sockets,
    now: () => clock,
    advance: (ms: number) => { clock += ms; },
  };
}

function okId(outcome: OfferOutcome): string {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(`报价操作失败：${outcome.reason}`);
  return outcome.offerId;
}
function failReason(outcome: OfferOutcome): string {
  expect(outcome.ok).toBe(false);
  return outcome.ok ? '' : outcome.reason;
}
function offersOf(room: Room) {
  return room.offerSnapshot.offers;
}
function offerMessages(s: FakeSocket) {
  return s.sent.filter((m) => m.t === 'OFFERS');
}

// ---------------------------------------------------------------------------
// 7.1 权限与容量
// ---------------------------------------------------------------------------
describe('第 7.1 节：权限、容量与视角', () => {
  it('A/B/C 三条报价并存不互相覆盖，ID 唯一且按创建时间排序', () => {
    const { room } = fixture();
    const a = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    const b = okId(room.makeOffer(1, 0, { brick: 1 }, {}));
    const c = okId(room.makeOffer(2, 0, { sheep: 1 }, {}));
    const list = offersOf(room);
    expect(list).toHaveLength(3);
    expect(new Set(list.map((o) => o.id)).size).toBe(3);
    expect(list.map((o) => o.id)).toEqual([a, b, c]);
    expect(list.map((o) => o.createdAt)).toEqual([...list.map((o) => o.createdAt)].sort((x, y) => x - y));
    expect(list.every((o) => o.expiresAt - o.createdAt === OFFER_TTL_MS)).toBe(true);
  });

  it('每人最多一条有效报价：重发原子替换本人旧报价，不动别人的', () => {
    const { room, advance } = fixture();
    const first = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    okId(room.makeOffer(1, 0, { brick: 1 }, {}));
    advance(OFFER_SEND_COOLDOWN_MS);
    const second = okId(room.makeOffer(0, 2, { wood: 2 }, {}));

    const list = offersOf(room);
    expect(list).toHaveLength(2);
    expect(list.some((o) => o.id === first)).toBe(false);
    expect(list.some((o) => o.id === second)).toBe(true);
    expect(list.find((o) => o.from === 1)).toBeDefined(); // 别人的报价还在
    expect(failReason(room.acceptOffer(1, first))).toBe('OFFER_NOT_FOUND');
  });

  it('重发失败时保留旧报价：先校验新请求，成功后才替换', () => {
    const { room, advance } = fixture();
    const first = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    advance(OFFER_SEND_COOLDOWN_MS);
    // 空换空是无效请求
    expect(failReason(room.makeOffer(0, 1, {}, {}))).toBe('BAD_OFFER');
    expect(offersOf(room).map((o) => o.id)).toEqual([first]);
  });

  it('权限：当前玩家可报价任意人；非当前玩家只能报价当前玩家', () => {
    const { room } = fixture();
    expect(room.game!.current).toBe(0);
    // 两个非当前玩家之间禁止
    expect(failReason(room.makeOffer(1, 2, { wood: 1 }, {}))).toBe('OFFER_FORBIDDEN');
    // 当前玩家 → 任意人
    expect(room.makeOffer(0, 2, { wood: 1 }, {}).ok).toBe(true);
    // 非当前玩家 → 当前玩家
    expect(room.makeOffer(1, 0, { brick: 1 }, {}).ok).toBe(true);
  });

  it('赠予与索取可提交，空换空不可提交，非在座目标被拒', () => {
    const { room } = fixture();
    expect(room.makeOffer(0, 1, { wood: 1 }, {}).ok).toBe(true);   // 赠予
    expect(failReason(room.makeOffer(1, 0, {}, {}))).toBe('BAD_OFFER');
    expect(failReason(room.makeOffer(2, 9, { wood: 1 }, {}))).toBe('BAD_OFFER');
  });
});

// ---------------------------------------------------------------------------
// 7.2 生命周期：时钟、冷却、过期、替换、清空
// ---------------------------------------------------------------------------
describe('第 7.2 节：服务端时钟、冷却与过期', () => {
  it('3 秒内重复发送被拒；无效请求不更新业务冷却', () => {
    const { room, advance } = fixture();
    okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    expect(failReason(room.makeOffer(0, 1, { wood: 2 }, {}))).toBe('OFFER_COOLDOWN');
    expect(offersOf(room)).toHaveLength(1);

    // 无效请求不应把冷却顺延
    room.makeOffer(0, 9, { wood: 1 }, {});
    advance(OFFER_SEND_COOLDOWN_MS);
    expect(room.makeOffer(0, 1, { wood: 2 }, {}).ok).toBe(true);
  });

  it('刷新/重连不绕过冷却；撤回不退还冷却', () => {
    const { room, sockets, advance } = fixture();
    const id = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    room.cancelOffer(0, id);
    expect(failReason(room.makeOffer(0, 1, { wood: 2 }, {}))).toBe('OFFER_COOLDOWN');

    room.leave(0);
    room.reconnect(0, new FakeSocket('甲-重连'));
    expect(failReason(room.makeOffer(0, 1, { wood: 2 }, {}))).toBe('OFFER_COOLDOWN');
    expect(sockets).toHaveLength(3);
    advance(OFFER_SEND_COOLDOWN_MS);
    expect(room.makeOffer(0, 1, { wood: 2 }, {}).ok).toBe(true);
  });

  it('冷却后重发生成新 ID，旧 ID 不可接受，10 秒重新开始', () => {
    const { room, advance, now } = fixture();
    const first = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    advance(OFFER_SEND_COOLDOWN_MS);
    const second = okId(room.makeOffer(0, 1, { wood: 2 }, {}));
    const view = offersOf(room).find((o) => o.id === second)!;
    expect(view.expiresAt - view.createdAt).toBe(OFFER_TTL_MS);
    expect(view.createdAt).toBe(now());
    expect(failReason(room.acceptOffer(1, first))).toBe('OFFER_NOT_FOUND');
    expect(room.acceptOffer(1, second).ok).toBe(true);
  });

  it('到期边界：恰好 10 秒即过期，9.999 秒仍可成交', () => {
    const { room, advance } = fixture();
    const a = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    advance(OFFER_TTL_MS - 1);
    expect(room.acceptOffer(1, a).ok).toBe(true);

    const b = okId(room.makeOffer(1, 0, { brick: 1 }, {}));
    advance(OFFER_TTL_MS);
    expect(failReason(room.acceptOffer(0, b))).toBe('OFFER_EXPIRED');
    expect(offersOf(room)).toHaveLength(0);
  });

  it('清理定时器尚未执行也不能误成交（acceptOffer 用服务端时钟复查）', () => {
    const { room, advance } = fixture();
    const id = okId(room.makeOffer(0, 1, { wood: 99 }, {}));
    advance(OFFER_TTL_MS + 5_000);
    // 不调用 purgeExpired，直接接受
    expect(failReason(room.acceptOffer(1, id))).toBe('OFFER_EXPIRED');
    expect(room.game!.players[0]!.resources.wood).toBe(3); // 没有发生任何资源变化
  });

  it('purgeExpired 会广播过期并带上列表版本', () => {
    const { room, sockets, advance } = fixture();
    okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    const before = room.offerSnapshot.version;
    advance(OFFER_TTL_MS);
    sockets.forEach((s) => s.clear());
    room.purgeExpired();
    expect(offerMessages(sockets[0]!)[0]).toMatchObject({ t: 'OFFERS', reason: 'EXPIRED' });
    expect(room.offerSnapshot.version).toBeGreaterThan(before);
  });

  it('资源不足保留报价至到期并提示，不默默改变交易数量', () => {
    const { room } = fixture();
    const id = okId(room.makeOffer(0, 1, { wood: 99 }, { wheat: 1 }));
    expect(failReason(room.acceptOffer(1, id))).toBe('INSUFFICIENT_RESOURCES');
    expect(offersOf(room).find((o) => o.id === id)).toBeDefined();
    expect(offersOf(room).find((o) => o.id === id)!.give).toEqual({ wood: 99 });
    // 补足资源后同一条报价仍可成交
    room.game!.players[0]!.resources.wood = 99;
    expect(room.acceptOffer(1, id).ok).toBe(true);
  });

  it('两条报价争用同一份资源：第二条不会扣成负数', () => {
    const { room } = fixture();
    const a = okId(room.makeOffer(0, 1, { wood: 3 }, { wheat: 1 }));
    const b = okId(room.makeOffer(1, 0, { wheat: 1 }, { wood: 3 }));
    expect(room.acceptOffer(1, a).ok).toBe(true);
    expect(room.game!.players[0]!.resources.wood).toBe(0);
    expect(failReason(room.acceptOffer(0, b))).toBe('INSUFFICIENT_RESOURCES');
    for (const p of room.game!.players) {
      for (const n of Object.values(p.resources)) expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it('接受成功后只删除对应报价，其余在各自期限内保留', () => {
    const { room } = fixture();
    const a = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    const b = okId(room.makeOffer(1, 0, { brick: 1 }, {}));
    expect(room.acceptOffer(1, a).ok).toBe(true);
    expect(offersOf(room).map((o) => o.id)).toEqual([b]);
  });

  it('掷 7 清空全部报价并广播 ROLL_SEVEN；弃牌期间不能创建或接受', () => {
    const { room, sockets } = fixture();
    const a = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    okId(room.makeOffer(1, 0, { brick: 1 }, {}));
    sockets.forEach((s) => s.clear());
    room.command(0, { type: 'ROLL_DICE', seat: 0, dice: [1, 6] });
    expect(offersOf(room)).toHaveLength(0);
    expect(offerMessages(sockets[0]!).some((m) => m.t === 'OFFERS' && m.reason === 'ROLL_SEVEN')).toBe(true);
    expect(failReason(room.acceptOffer(1, a))).toBe('OFFER_NOT_FOUND');
    expect(failReason(room.makeOffer(0, 1, { wood: 1 }, {}))).toBe('DISCARD_PENDING');
    expect(Object.keys(room.game!.pendingDiscards).length).toBeGreaterThan(0);
  });

  it('有人尚未弃牌时接受已有报价也被拒；弃完后恢复交易', () => {
    const { room } = fixture();
    const id = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    // 模拟服务端已确认掷 7 进入弃牌锁（不通过命令，保住这条报价用于断言）
    room.game!.pendingDiscards = { 0: 1 };
    expect(failReason(room.acceptOffer(1, id))).toBe('DISCARD_PENDING');
    expect(offersOf(room).find((o) => o.id === id)).toBeDefined();
    room.game!.pendingDiscards = {};
    expect(room.acceptOffer(1, id).ok).toBe(true);
  });

  it('回合结束与游戏结束清空全部报价', () => {
    const { room } = fixture(2);
    okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    room.command(0, { type: 'ROLL_DICE', seat: 0, dice: [2, 3] });
    expect(room.command(0, { type: 'END_TURN', seat: 0 }).ok).toBe(true);
    expect(offersOf(room)).toHaveLength(0);

    room.game!.phase = 'ended';
    expect(failReason(room.makeOffer(1, 0, { wood: 1 }, {}))).toBe('GAME_ENDED');
  });
});

// ---------------------------------------------------------------------------
// 7.3 并发与消息契约
// ---------------------------------------------------------------------------
describe('第 7.3 节：按 ID 处理、串行裁决与恢复快照', () => {
  it('P0 竞态回归：旧页面按旧 ID 点接受，绝不会成交被替换后的新报价', () => {
    const { room, advance } = fixture(2);
    const staleId = okId(room.makeOffer(0, 1, { wood: 1 }, { wheat: 1 }));
    advance(OFFER_SEND_COOLDOWN_MS);
    const freshId = okId(room.makeOffer(0, 1, { wood: 3 }, { wheat: 2 }));
    expect(freshId).not.toBe(staleId);

    const result = room.acceptOffer(1, staleId); // 旧页面携带的 ID
    expect(result.ok).toBe(false);
    expect(room.game!.players[0]!.resources.wood).toBe(3); // 3 木一张没少
    expect(offersOf(room).map((o) => o.id)).toEqual([freshId]);
    expect(room.acceptOffer(1, freshId).ok).toBe(true);
    expect(room.game!.players[0]!.resources.wood).toBe(0);
  });

  it('接受 / 拒绝 / 撤回都校验 ID、收件人与发起人', () => {
    const { room } = fixture();
    const a = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    expect(failReason(room.acceptOffer(0, a))).toBe('OFFER_NOT_FOR_YOU');
    expect(failReason(room.cancelOffer(1, a))).toBe('OFFER_FORBIDDEN');
    expect(failReason(room.rejectOffer(2, a))).toBe('OFFER_NOT_FOR_YOU');
    expect(failReason(room.acceptOffer(1, 'o999'))).toBe('OFFER_NOT_FOUND');
    expect(room.rejectOffer(1, a).ok).toBe(true);
    expect(offersOf(room)).toHaveLength(0);
  });

  it('串行裁决：报价先被接受再掷 7，不会出现重复成交', () => {
    const { room } = fixture(2);
    const id = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    expect(room.acceptOffer(1, id).ok).toBe(true);
    const wood = room.game!.players[1]!.resources.wood;
    room.command(0, { type: 'ROLL_DICE', seat: 0, dice: [1, 6] });
    expect(failReason(room.acceptOffer(1, id))).toBe('OFFER_NOT_FOUND');
    expect(room.game!.players[1]!.resources.wood).toBe(wood);
  });

  it('快照带列表版本、服务端时间、本人下次可发时间；重连只恢复未过期报价', () => {
    const { room, now, advance } = fixture();
    const id = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    const snap = room.offerSnapshot;
    expect(snap.serverTime).toBe(now());
    expect(snap.nextSendAt['0']).toBe(now() + OFFER_SEND_COOLDOWN_MS);
    expect(snap.offers.map((o) => o.id)).toEqual([id]);
    const v0 = snap.version;

    advance(OFFER_TTL_MS);
    const later = room.offerSnapshot;
    expect(later.offers).toHaveLength(0);
    expect(later.version).toBeGreaterThan(v0);
    expect(later.nextSendAt['0']).toBeUndefined(); // 冷却也早已过去
  });

  it('广播带终止原因与对应 ID；rid 在拒绝原因里回显', () => {
    const { room, sockets } = fixture(2);
    sockets.forEach((s) => s.clear());
    const id = okId(room.makeOffer(0, 1, { wood: 1 }, {}));
    expect(offerMessages(sockets[0]!).at(-1)).toMatchObject({ t: 'OFFERS', reason: 'CREATED', offerId: id });

    room.makeOffer(0, 1, { wood: 2 }, {}, 'my-click-1');
    const rejected = sockets[0]!.rejects.at(-1);
    expect(rejected).toMatchObject({ t: 'REJECT', reason: 'OFFER_COOLDOWN', rid: 'my-click-1' });
  });

  it('COMMAND 的 rid 也会在引擎拒绝里回显，便于关联这次点击', () => {
    const { room, sockets } = fixture(2);
    sockets[1]!.clear();
    // 1 号位不是当前玩家，伪造 seat 也会被覆盖
    room.command(1, { type: 'ROLL_DICE', seat: 0, dice: [1, 1] }, 'cmd-42');
    expect(sockets[1]!.rejects.at(-1)).toMatchObject({
      t: 'REJECT', reason: 'NOT_YOUR_TURN', rid: 'cmd-42',
    });
  });
});
