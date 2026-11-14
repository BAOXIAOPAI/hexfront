/**
 * 文档 24 F1（前端侧）：CREATE / JOIN 两条链路的意图管理。
 *
 * 用真实 GameClient + 假 WebSocket，验证：
 * - intent='create' 首次建链发 CREATE（带人数），绝不发 JOIN；
 * - 收到 WELCOME 后降级为 join，重连只发 JOIN，绝不重复 CREATE；
 * - intent='join'（默认）只发 JOIN，绝不隐式创建；
 * - CREATE 失败（ROOM_EXISTS）不会被提前降级成 JOIN，用户可改名重试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@hexfront/protocol';
import { GameClient, type ClientHandlers } from '../src/net.js';

type Sent = Record<string, unknown>;

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  static CLOSING = 2;
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, ((ev: unknown) => void)[]>();

  constructor(public url: string) { FakeWS.instances.push(this); }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }

  emit(type: string, ev: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void {
    this.readyState = FakeWS.CLOSED;
    this.emit('close');
  }

  get messages(): Sent[] { return this.sent.map((s) => JSON.parse(s) as Sent); }
}

let restoreGlobals: () => void;
let handlers: ClientHandlers & { messages: unknown[] };

beforeEach(() => {
  FakeWS.instances = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { WebSocket: g['WebSocket'] };
  g['WebSocket'] = FakeWS;
  restoreGlobals = () => { g['WebSocket'] = saved.WebSocket; };
  handlers = {
    messages: [],
    onMessage: (m) => { handlers.messages.push(m); },
    onState: () => {},
    onFatal: () => {},
    onDrop: () => {},
  };
});

afterEach(() => restoreGlobals());

function welcome(): string {
  return JSON.stringify({
    t: 'WELCOME', roomId: 'r1', seat: 0, capacity: 4, players: [], view: null,
    snapshot: { offers: [], version: 0, serverTime: 1, nextSendAt: {} },
    stateSeq: 0, lobby: null, map: null, timer: null, settings: { setupGrant: true },
  });
}

describe('F1 · 前端 CREATE / JOIN 意图', () => {
  it('intent=create：首条消息是 CREATE 且带人数，不是 JOIN', () => {
    const c = new GameClient('ws://x/ws', { roomId: 'r1', name: '甲', players: 6, intent: 'create' }, handlers);
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.emit('open');
    const [first] = ws.messages;
    expect(first!.t).toBe('CREATE');
    expect(first).toMatchObject({ roomId: 'r1', name: '甲', players: 6, v: PROTOCOL_VERSION });
    expect(ws.messages.some((m) => m.t === 'JOIN')).toBe(false);
  });

  it('收到 WELCOME 后降级：重连只发 JOIN，绝不重复 CREATE', () => {
    const c = new GameClient('ws://x/ws', { roomId: 'r1', name: '甲', players: 6, intent: 'create' }, handlers);
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.emit('open');
    ws.emit('message', { data: welcome() });
    expect(c.state).toBe('open');

    // 重连（服务端断开）：新连接只应发 JOIN
    ws.readyState = FakeWS.CLOSED;
    ws.emit('close');
    // 手动触发一次 open（模拟重连成功）
    c.connect();
    const ws2 = FakeWS.instances[FakeWS.instances.length - 1]!;
    ws2.emit('open');
    const kinds = ws2.messages.map((m) => m.t);
    expect(kinds).toContain('JOIN');
    expect(kinds).not.toContain('CREATE');
    // JOIN 不带人数
    const join = ws2.messages.find((m) => m.t === 'JOIN')!;
    expect(join).not.toHaveProperty('players');
  });

  it('intent=join（默认）：只发 JOIN，不隐式创建', () => {
    const c = new GameClient('ws://x/ws', { roomId: 'r1', name: '乙' }, handlers);
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.emit('open');
    const kinds = ws.messages.map((m) => m.t);
    expect(kinds).toEqual(['JOIN']);
    expect(ws.messages[0]).toMatchObject({ roomId: 'r1', name: '乙', v: PROTOCOL_VERSION });
    expect(ws.messages[0]).not.toHaveProperty('players');
  });

  it('CREATE 失败（ROOM_EXISTS）不会被提前降级，仍可改名重试创建', () => {
    const fatal: string[] = [];
    const h = { ...handlers, onFatal: (r: string) => fatal.push(r) };
    const c = new GameClient('ws://x/ws', { roomId: 'r1', name: '甲', players: 4, intent: 'create' }, h);
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ t: 'JOIN_FAILED', reason: 'ROOM_EXISTS' }) });
    expect(fatal).toEqual(['ROOM_EXISTS']);
    expect(ws.messages.map((m) => m.t)).not.toContain('JOIN');
  });
});
