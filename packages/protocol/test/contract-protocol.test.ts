/**
 * 重构指南阶段 A：把 docs/10-refactor-guide.md 第 1、7、8 节已确认的决定
 * 转成可执行的「规则契约」，并把协议现状与目标行为分开记录。
 *
 * 本文件不修改任何应用代码：
 * - 现状用真实断言固化（能通过，用于证明缺陷存在）
 * - 目标用 it.todo 列出（阶段 C 实现后逐条转成真实断言）
 *
 * 阶段 C 实现时请以本文件的常量为准，不要再从旧文档注释里抄数字。
 */

import { describe, expect, it } from 'vitest';
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeClient,
  PROTOCOL_VERSION,
  type ClientMessage,
} from '../src/index.js';

/** 指南第 1 / 7.2 / 8.1 节：用户已确认的产品决定 */
export const CONTRACT = {
  /** 每条报价存活 10 秒，服务端判过期 */
  offerTtlMs: 10_000,
  /** 每位玩家成功发出后 3 秒内不能再发 */
  sendCooldownMs: 3_000,
  /** 每人最多 1 条存活报价 */
  maxLiveOffersPerPlayer: 1,
  /** 8 张起弃一半，向上取整 */
  discardThreshold: 8,
  discardRoundUp: true,
  /** 必须清空全部活跃报价的时点 */
  clearOffersOn: ['ROLL_SEVEN', 'END_TURN', 'GAME_END'],
} as const;

describe('第 1 节：已确认的产品决定（数值契约）', () => {
  it('报价 10 秒过期、发送冷却 3 秒、每人最多 1 条有效报价', () => {
    expect(CONTRACT.offerTtlMs).toBe(10_000);
    expect(CONTRACT.sendCooldownMs).toBe(3_000);
    expect(CONTRACT.maxLiveOffersPerPlayer).toBe(1);
  });

  it('弃牌 8 张起、弃一半且向上取整', () => {
    expect(CONTRACT.discardThreshold).toBe(8);
    expect(CONTRACT.discardRoundUp).toBe(true);
  });

  it('掷 7 / 回合结束 / 游戏结束时清空全部报价', () => {
    expect(CONTRACT.clearOffersOn).toEqual(['ROLL_SEVEN', 'END_TURN', 'GAME_END']);
  });
});

describe('协议现状（阶段 A 固化；这些是缺陷证据，不是目标行为）', () => {
  it('OFFER_ACCEPT / REJECT / CANCEL 都不带 offerId，无法指定处理哪一条', () => {
    for (const t of ['OFFER_ACCEPT', 'OFFER_REJECT', 'OFFER_CANCEL']) {
      const decoded = decodeClientMessage(JSON.stringify({ t }));
      expect(decoded).toEqual({ t });
      expect(decoded && 'offerId' in decoded).toBe(false);
    }
  });

  it('OFFER 消息只承载单条 offer，没有列表、版本与服务端时间', () => {
    const raw = JSON.stringify({
      t: 'OFFER',
      offer: { from: 0, to: 1, give: { wood: 1 }, get: {} },
    });
    const decoded = decodeServerMessage(raw);
    expect(decoded).toMatchObject({ t: 'OFFER' });
    expect(decoded && 'offers' in decoded).toBe(false);
    expect(decoded && 'listVersion' in decoded).toBe(false);
    expect(decoded && 'serverTime' in decoded).toBe(false);
    expect(decoded && 'offer' in decoded && decoded.t === 'OFFER' && decoded.offer
      ? 'id' in decoded.offer
      : false).toBe(false);
  });

  it('TradeOfferView 没有 id / createdAt / expiresAt 字段', () => {
    const view = { from: 0, to: 1, give: { wood: 1 }, get: {} };
    for (const key of ['id', 'createdAt', 'expiresAt']) {
      expect(key in view).toBe(false);
    }
  });

  it('JOIN 的 v 在解析层被丢弃，PROTOCOL_VERSION 目前无法真正拒绝错位客户端', () => {
    const msg: ClientMessage = { t: 'JOIN', roomId: 'main', name: '甲', v: PROTOCOL_VERSION };
    const decoded = decodeClientMessage(encodeClient(msg));
    expect(decoded?.t).toBe('JOIN');
    expect(decoded && 'v' in decoded).toBe(false);
  });

  it('WELCOME 只声明单条 offer，没有报价列表快照', () => {
    const raw = JSON.stringify({
      t: 'WELCOME', roomId: 'main', seat: 0, capacity: 4,
      players: [], view: null, offer: null,
    });
    const decoded = decodeServerMessage(raw);
    expect(decoded?.t).toBe('WELCOME');
    expect(decoded && 'offers' in decoded).toBe(false);
    expect(decoded && 'offer' in decoded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 阶段 C 待实现：每条 todo 对应指南的一条验收要求，实现后改为真实断言
// ---------------------------------------------------------------------------

describe('第 7.3 节目标契约（阶段 C）', () => {
  it.todo('OfferView 带 id / createdAt / expiresAt；WELCOME 与恢复快照带报价列表、列表版本、服务端时间与本人下次可发时间');
  it.todo('OFFER_ACCEPT / REJECT / CANCEL 携带 offerId，解析层校验类型，畸形请求返回 null');
  it.todo('报价创建/替换与终止原因带命令结果关联标识，重复点击可去重');
  it.todo('JOIN 保留 v 并校验 PROTOCOL_VERSION；协议不兼容升级可被明确识别，新旧协议不混用');
  it.todo('STATE / 恢复快照带状态版本或序列，旧更新不能覆盖新更新');
});
