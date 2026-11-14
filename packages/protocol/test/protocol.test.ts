import { describe, expect, it } from 'vitest';
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeClient,
  PROTOCOL_VERSION,
  type ClientMessage,
} from '../src/index.js';

describe('ClientMessage 编解码', () => {
  it('JOIN 往返一致', () => {
    const msg: ClientMessage = { t: 'JOIN', roomId: 'main', name: '甲', v: PROTOCOL_VERSION };
    expect(decodeClientMessage(encodeClient(msg))).toMatchObject({
      t: 'JOIN',
      roomId: 'main',
      name: '甲',
    });
  });

  it('缺少 roomId / name 时回落默认值，不抛异常', () => {
    expect(decodeClientMessage('{"t":"JOIN"}')).toEqual({ t: 'JOIN', roomId: 'main', name: '' });
  });

  it('COMMAND 保留原始 cmd', () => {
    const cmd = { type: 'ROLL_DICE', seat: 2 };
    expect(decodeClientMessage(JSON.stringify({ t: 'COMMAND', cmd }))).toEqual({ t: 'COMMAND', cmd });
  });

  it('COMMAND 没有 type 字段视为畸形', () => {
    expect(decodeClientMessage('{"t":"COMMAND","cmd":{"seat":0}}')).toBeNull();
  });

  it('非 JSON / 非对象 / 未知类型一律 null', () => {
    expect(decodeClientMessage('not json')).toBeNull();
    expect(decodeClientMessage('null')).toBeNull();
    expect(decodeClientMessage('{"t":"DROP_TABLE"}')).toBeNull();
  });
});

describe('ServerMessage 解码', () => {
  it('识别全部合法类型', () => {
    for (const t of [
      'WELCOME', 'LOBBY', 'LOBBY_CONFIG', 'SETTINGS', 'STATE', 'SETUP_TIMER',
      'SETUP_AUTO_PLACED', 'OFFERS', 'REJECT', 'JOIN_FAILED', 'PONG',
    ]) {
      expect(decodeServerMessage(JSON.stringify({ t }))?.t).toBe(t);
    }
  });

  it('脏数据返回 null，不让界面崩掉', () => {
    expect(decodeServerMessage('<<<')).toBeNull();
    expect(decodeServerMessage('"hello"')).toBeNull();
    expect(decodeServerMessage('{"t":"MYSTERY"}')).toBeNull();
  });
});

describe('房间设置消息', () => {
  it('SET_SETTINGS 往返一致，非 boolean 一律拒绝', () => {
    expect(decodeClientMessage(encodeClient({ t: 'SET_SETTINGS', setupGrant: false }))).toEqual({
      t: 'SET_SETTINGS',
      setupGrant: false,
    });
    expect(decodeClientMessage('{"t":"SET_SETTINGS","setupGrant":"false"}')).toBeNull();
    expect(decodeClientMessage('{"t":"SET_SETTINGS"}')).toBeNull();
  });

  it('服务端 SETTINGS 广播可被解析', () => {
    const raw = JSON.stringify({ t: 'SETTINGS', settings: { setupGrant: false }, locked: true });
    expect(decodeServerMessage(raw)).toMatchObject({ t: 'SETTINGS', locked: true });
  });
});
