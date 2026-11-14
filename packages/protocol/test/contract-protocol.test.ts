/**
 * 重构指南阶段 C：协议层规则契约（docs/10-refactor-guide.md 第 1 / 7.3 / 10.3 节）。
 *
 * 阶段 A 这里放的是「现状缺陷证据 + 目标 todo」；阶段 C 已全部转成真实断言。
 * 数值契约直接引用协议常量，不再在测试里抄一份数字。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_OFFERS_PER_PLAYER,
  OFFER_SEND_COOLDOWN_MS,
  OFFER_TTL_MS,
  PROTOCOL_VERSION,
  decodeClientMessage,
  decodeServerMessage,
  encode,
  encodeClient,
  type ClientMessage,
  type ServerMessage,
} from '../src/index.js';

describe('第 1 / 7.2 节：产品决定的数值契约', () => {
  it('报价 10 秒过期、发送冷却 3 秒、每人最多 1 条有效报价', () => {
    expect(OFFER_TTL_MS).toBe(10_000);
    expect(OFFER_SEND_COOLDOWN_MS).toBe(3_000);
    expect(MAX_LIVE_OFFERS_PER_PLAYER).toBe(1);
  });

  it('协议版本升到 4（文档 24 显式创建/银行港口拆分），不兼容升级必须能被识别', () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });
});

describe('第 7.3 节：报价 ID 与消息契约', () => {
  const snapshot = {
    offers: [{
      id: 'o1', from: 0, to: 1, give: { wood: 2 }, get: { wheat: 1 },
      createdAt: 1000, expiresAt: 11000,
    }],
    version: 3,
    serverTime: 1000,
    nextSendAt: { '0': 4000 },
  };

  it('接受 / 拒绝 / 撤回必须带 offerId，没有 ID 的请求一律视为畸形', () => {
    for (const t of ['OFFER_ACCEPT', 'OFFER_REJECT', 'OFFER_CANCEL']) {
      expect(decodeClientMessage(JSON.stringify({ t }))).toBeNull();
      expect(decodeClientMessage(JSON.stringify({ t, offerId: 123 }))).toBeNull();
      expect(decodeClientMessage(JSON.stringify({ t, offerId: 'o1' }))).toEqual({ t, offerId: 'o1' });
    }
  });

  it('rid 关联标识在命令与报价消息里保留，超长或畸形被丢弃', () => {
    const cmd: ClientMessage = { t: 'COMMAND', cmd: { type: 'ROLL_DICE', seat: 0 }, rid: 'click-7' };
    expect(decodeClientMessage(encodeClient(cmd))).toMatchObject({ t: 'COMMAND', rid: 'click-7' });
    expect(decodeClientMessage('{"t":"OFFER_ACCEPT","offerId":"o1","rid":"r1"}'))
      .toEqual({ t: 'OFFER_ACCEPT', offerId: 'o1', rid: 'r1' });
    const tooLong = `{"t":"OFFER","to":1,"give":{},"get":{},"rid":"${'x'.repeat(65)}"}`;
    expect(decodeClientMessage(tooLong)).toMatchObject({ t: 'OFFER' });
    expect(decodeClientMessage(tooLong)).not.toHaveProperty('rid');
    expect(decodeClientMessage('{"t":"OFFER","to":1,"give":{},"get":{},"rid":7}'))
      .not.toHaveProperty('rid');
  });

  it('OFFERS 广播带列表快照、版本、服务端时间、冷却与终止原因', () => {
    const msg: ServerMessage = { t: 'OFFERS', snapshot, reason: 'CREATED', offerId: 'o1' };
    const decoded = decodeServerMessage(encode(msg));
    expect(decoded).toMatchObject({ t: 'OFFERS', reason: 'CREATED', offerId: 'o1' });
    expect(decoded && decoded.t === 'OFFERS' && decoded.snapshot.offers[0]).toMatchObject({
      id: 'o1', from: 0, to: 1, createdAt: 1000, expiresAt: 11000,
    });
    expect(decoded && decoded.t === 'OFFERS' && decoded.snapshot.nextSendAt['0']).toBe(4000);
  });

  it('单条 OFFER 消息已被移除，旧客户端不会被静默当成新消息', () => {
    expect(decodeServerMessage(JSON.stringify({ t: 'OFFER', offer: null }))).toBeNull();
    expect(decodeServerMessage(JSON.stringify({ t: 'OFFERS', snapshot, reason: 'ACCEPTED' }))?.t).toBe('OFFERS');
  });

  it('WELCOME 带恢复快照与权威状态版本；STATE 带 seq', () => {
    const welcome: ServerMessage = {
      t: 'WELCOME', roomId: 'main', seat: 0, capacity: 4, players: [],
      view: null, snapshot, stateSeq: 12,
    };
    expect(decodeServerMessage(encode(welcome))).toMatchObject({
      t: 'WELCOME', stateSeq: 12,
    });
    const state = decodeServerMessage(JSON.stringify({ t: 'STATE', seq: 13, events: [], view: {} }));
    expect(state).toMatchObject({ t: 'STATE', seq: 13 });
  });

  it('REJECT 能回显 rid 与新错误码', () => {
    const msg: ServerMessage = { t: 'REJECT', reason: 'OFFER_EXPIRED', rid: 'click-7' };
    expect(decodeServerMessage(encode(msg))).toMatchObject({
      t: 'REJECT', reason: 'OFFER_EXPIRED', rid: 'click-7',
    });
  });
});

describe('第 10.3 节：JOIN 版本字段保留', () => {
  it('encodeClient → decodeClientMessage 往返保留 v', () => {
    const msg: ClientMessage = { t: 'JOIN', roomId: 'main', name: '甲', v: PROTOCOL_VERSION };
    expect(decodeClientMessage(encodeClient(msg))).toEqual(msg);
  });

  it('缺少 v 的 JOIN 仍可解析成不带 v，由服务端判定为版本不匹配', () => {
    const decoded = decodeClientMessage('{"t":"JOIN","roomId":"main","name":"甲"}');
    expect(decoded).toEqual({ t: 'JOIN', roomId: 'main', name: '甲' });
    expect(decoded && 'v' in decoded).toBe(false);
  });

  it('JOIN_FAILED 支持 PROTOCOL_MISMATCH', () => {
    const msg: ServerMessage = { t: 'JOIN_FAILED', reason: 'PROTOCOL_MISMATCH' };
    expect(decodeServerMessage(encode(msg))).toMatchObject({ t: 'JOIN_FAILED', reason: 'PROTOCOL_MISMATCH' });
  });
});
