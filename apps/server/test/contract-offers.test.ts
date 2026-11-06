/**
 * 重构指南阶段 A：报价与行动权限的规则契约（docs/10-refactor-guide.md 第 1、7、8 节）。
 *
 * 现状缺陷用「能通过的断言」固化成可执行证据；目标行为用 it.todo 列出，
 * 阶段 C 实现后逐条改成真实断言。数值契约的单一来源在
 * packages/protocol/test/contract-protocol.test.ts 的 CONTRACT。
 *
 * 尤其重要：第一个用例复现指南 2. 表格 P0「新报价直接覆盖 + 接受消息无报价 ID」
 * 造成的竞态 —— 旧页面上的「接受」会成交一条用户没看过的报价。
 */

import { describe, expect, it } from 'vitest';
import { Room } from '../src/room.js';
import { FakeSocket, driveSetup } from './helpers.js';

// 验收需要可复现的骰子；真实环境默认关闭（见 room.command 的剥离逻辑）
process.env.HEXFONT_FAKE_DICE = '1';

/** 两人房，已摆位进入 play；0 号 3 木，1 号 2 麦 */
function ready(): { room: Room; a: FakeSocket; b: FakeSocket } {
  const room = new Room('contract', { capacity: 2 });
  const a = new FakeSocket('a');
  const b = new FakeSocket('b');
  expect(room.join('甲', a).ok).toBe(true);
  expect(room.join('乙', b).ok).toBe(true);
  driveSetup(room);
  room.game!.players[0]!.resources.wood = 3;
  room.game!.players[1]!.resources.wheat = 2;
  return { room, a, b };
}

/** 三人房，已摆位进入 play；用来验证「多条并存」与「非当前玩家权限」 */
function threeSeat(): Room {
  const room = new Room('contract3', { capacity: 3 });
  for (const name of ['甲', '乙', '丙']) {
    expect(room.join(name, new FakeSocket(name)).ok).toBe(true);
  }
  driveSetup(room);
  return room;
}

describe('P0 竞态：旧页面上的接受会成交被替换后的新报价', () => {
  it('重发覆盖后，收件人点「接受」成交的是自己没看过的新报价', () => {
    const { room, a, b } = ready();

    // 报价 1：0 号给 1 木、要 1 麦。收件人的旧页面停在这里。
    expect(room.makeOffer(0, 1, { wood: 1 }, { wheat: 1 })).toBe(true);
    const stale = b.sent.filter((m) => m.t === 'OFFER').at(-1);
    expect(stale).toBeDefined();

    // 0 号重发，把报价改成给 3 木、要 2 麦（房间无冷却、无 ID）
    expect(room.makeOffer(0, 1, { wood: 3 }, { wheat: 2 })).toBe(true);
    expect(room.currentOffer).toEqual({ from: 0, to: 1, give: { wood: 3 }, get: { wheat: 2 } });

    // 收件人按旧页面点接受：消息里只有 t:'OFFER_ACCEPT'，服务端无法知道指的是哪一条
    a.clear();
    b.clear();
    const outcome = room.acceptOffer(1);
    expect(outcome.ok).toBe(true);

    // 结果按新报价结算：3 木全被拿走（旧报价只会拿走 1 木、剩 2 木）
    expect(room.game!.players[0]!.resources.wood).toBe(0);
    expect(room.game!.players[0]!.resources.wheat).toBe(2);
    expect(room.game!.players[1]!.resources.wood).toBe(3);
    expect(room.game!.players[1]!.resources.wheat).toBe(0);
    expect(room.currentOffer).toBeNull();
  });
});

describe('第 7 节：报价生命周期的现状固化（缺陷证据，不是目标行为）', () => {
  it('房间只保留一条报价：A/B/C 先后挂价，前两条被静默覆盖', () => {
    const room = threeSeat();
    expect(room.makeOffer(0, 1, { wood: 1 }, {})).toBe(true);
    expect(room.makeOffer(1, 0, { brick: 1 }, {})).toBe(true);
    expect(room.makeOffer(2, 0, { sheep: 1 }, {})).toBe(true);
    expect(room.currentOffer).toEqual({ from: 2, to: 0, give: { sheep: 1 }, get: {} });
  });

  it('没有 3 秒发送冷却：同一人连续两次挂价都立即成功', () => {
    const { room } = ready();
    expect(room.makeOffer(0, 1, { wood: 1 }, {})).toBe(true);
    expect(room.makeOffer(0, 1, { wood: 2 }, {})).toBe(true);
  });

  it('没有 10 秒期限：报价对象不含 id / createdAt / expiresAt，可无限期挂着', () => {
    const { room } = ready();
    expect(room.makeOffer(0, 1, { wood: 1 }, {})).toBe(true);
    expect(Object.keys(room.currentOffer!).sort()).toEqual(['from', 'get', 'give', 'to']);
  });

  it('非当前玩家也能向另一个非当前玩家报价（与 7.1 权限不符）', () => {
    const room = threeSeat();
    // 摆位结束后当前玩家为 0；2 → 1 两侧都不是当前玩家
    expect(room.game!.current).toBe(0);
    expect(room.makeOffer(2, 1, { sheep: 1 }, {})).toBe(true);
    expect(room.currentOffer?.to).toBe(1);
  });

  it('掷 7 不清空报价：房间只在 END_TURN 分支清理', () => {
    const { room } = ready();
    expect(room.makeOffer(0, 1, { wood: 1 }, {})).toBe(true);
    const rolled = room.command(0, { type: 'ROLL_DICE', seat: 0, dice: [1, 6] });
    expect(rolled.ok).toBe(true);
    expect(room.game!.dice).toEqual([1, 6]);
    expect(room.currentOffer).not.toBeNull();
  });

  it('现状回归：END_TURN 确实会清空报价（阶段 C 需保留）', () => {
    const { room } = ready();
    expect(room.makeOffer(0, 1, { wood: 1 }, {})).toBe(true);
    room.command(0, { type: 'ROLL_DICE', seat: 0, dice: [2, 3] });
    expect(room.command(0, { type: 'END_TURN', seat: 0 }).ok).toBe(true);
    expect(room.currentOffer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 阶段 C 待实现：对应指南 7.1 / 7.2 / 7.3 / 13.2 的验收条目
// ---------------------------------------------------------------------------

describe('第 7 节目标契约（阶段 C）', () => {
  it.todo('A/B/C 三条报价并存不互相覆盖；每人最多一条有效报价，当前玩家也不能同时挂多条');
  it.todo('服务端分配唯一 ID / createdAt / expiresAt；到期即不可成交，即使清理定时器尚未执行');
  it.todo('每位玩家成功发出后 3 秒冷却；刷新/重连不绕过，撤回不退还冷却，无效请求不更新业务冷却');
  it.todo('接受/拒绝/撤回都带 offerId；过期或已替换的 ID 返回明确原因，绝不操作另一条报价');
  it.todo('重发先校验新请求，失败保留旧报价，成功后原子替换并重新计时；撤回需再次主动点击');
  it.todo('接受成功后只删对应报价，其余在各自期限内保留并在成交时重新校验资源');
  it.todo('资源不足保留报价至到期并提示，不默默改变交易数量，不出现负数或重复扣减');
  it.todo('权限：当前玩家可报价任意人；非当前玩家只能报价当前玩家；赠予/索取合法，空换空拒绝');
  it.todo('掷 7 / 回合结束 / 游戏结束清空全部活跃报价；重连只恢复未过期报价');
  it.todo('接受与掷 7、回合结束、本人重发交错到达时按服务端串行顺序裁决，不依赖客户端禁用按钮');
  it.todo('WELCOME 与恢复快照包含报价列表、列表版本、服务端时间与下次可发时间');
});
