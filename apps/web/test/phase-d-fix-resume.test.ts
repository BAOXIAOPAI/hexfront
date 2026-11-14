/**
 * D-06 行为测试：受控重连 + 探活超时兜底。
 *
 * 真实 GameClient 状态机 + 假 WebSocket + 假时钟，验证：
 * - 回前台先发带超时探活；PONG 回来仍受控重建，用 WELCOME 的完整权威快照完成核对；
 * - 半开连接（readyState 撒谎）超时后主动重建；
 * - 不永久停在「正在核对」（watchdog → stalled）；
 * - 核对完成前不提交任何命令、不重放离线意图；
 * - 后台超 10 秒报价正确过期（WELCOME 的 snapshot 由服务端裁剪，不续期）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeClientMessage, encode, PROTOCOL_VERSION, type ServerMessage, type ClientMessage } from '@hexfront/protocol';
import {
  GameClient, RESUME_PROBE_TIMEOUT_MS, RESUME_WATCHDOG_MS,
  SEAT_TAKEN_RETRY_MS, SEAT_TAKEN_MAX_RETRIES,
  type ClientHandlers, type ReconcilePhase,
} from '../src/net.js';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();

  constructor(readonly url: string) { FakeSocket.all.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void): void {
    const l = this.listeners.get(type) ?? []; l.push(fn); this.listeners.set(type, l);
  }
  removeEventListener(type: string, fn: (e: { data?: string }) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  emit(type: string, e: { data?: string } = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  open(): void { this.readyState = FakeSocket.OPEN; this.emit('open'); }
  message(msg: ServerMessage): void { this.emit('message', { data: encode(msg) }); }
  send(raw: string): void { this.sent.push(raw); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
    this.emit('close');
  }
  lastSent(): ClientMessage | null {
    const raw = this.sent[this.sent.length - 1];
    return raw ? decodeClientMessage(raw) : null;
  }
}

const WELCOME: Extract<ServerMessage, { t: 'WELCOME' }> = {
  t: 'WELCOME', roomId: 'main', seat: 0, capacity: 4,
  players: [{ seat: 0, name: 'tester', connected: true, ready: false }],
  view: null,
  snapshot: { offers: [], version: 3, serverTime: 1000, nextSendAt: {} },
  stateSeq: 42,
  lobby: null, map: null, timer: null,
  settings: { setupGrant: true },
};

let socketCtor: typeof WebSocket;
let handlers: ClientHandlers & {
  messages: ServerMessage[]; states: string[]; dropped: ClientMessage[];
  phases: { phase: ReconcilePhase; detail?: string }[]; fatals: string[];
};
let client: GameClient;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  socketCtor = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  handlers = {
    messages: [], states: [], dropped: [], phases: [], fatals: [],
    onMessage: (m) => { handlers.messages.push(m); },
    onState: (s) => { handlers.states.push(s); },
    onFatal: (r) => { handlers.fatals.push(r); },
    onDrop: (m) => { handlers.dropped.push(m); },
    onReconcile: (phase, detail) => { handlers.phases.push({ phase, detail }); },
  };
  client = new GameClient('ws://localhost/ws', { roomId: 'main', name: 'tester' }, handlers);
  client.connect();
  FakeSocket.all[0]!.open();       // 首连：JOIN 已发
  handlers.messages = [];
  handlers.states = [];
});
afterEach(() => {
  client.close();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = socketCtor;
  vi.useRealTimers();
});

function last(): FakeSocket { return FakeSocket.all[FakeSocket.all.length - 1]!; }
/** 真实浏览器会在新 socket 上派发 open → 客户端才发 JOIN */
function settle(ms = 300): FakeSocket {
  vi.advanceTimersByTime(ms);
  const s = last();
  if (s.readyState === FakeSocket.CONNECTING) s.open();
  return s;
}
function welcome(sock: FakeSocket, over: Partial<Extract<ServerMessage, { t: 'WELCOME' }>> = {}): void {
  sock.message({ ...WELCOME, ...over } as ServerMessage);
}
function phases(): ReconcilePhase[] { return handlers.phases.map((p) => p.phase); }

describe('D-06 · 前台恢复链路', () => {
  it('回前台先发带超时的探活（PING 带 id）；PONG 回来仍受控重建，用 WELCOME 完整快照完成核对', () => {
    const first = last();
    client.resume();
    expect(client.isReconciling).toBe(true);
    expect(phases()[0]).toBe('checking');
    expect(first.lastSent()).toMatchObject({ t: 'PING', id: expect.any(Number) });
    expect(handlers.messages).toEqual([]);     // PONG 不是权威快照，不能宣布已核对

    // 探活通过 → 受控重建：旧连接关闭、重新 JOIN
    first.message({ t: 'PONG', id: (first.lastSent() as { id: number }).id });
    const second = settle();
    expect(first.closed).toBe(true);
    expect(second).not.toBe(first);
    expect(second.sent.length).toBeGreaterThan(0);
    expect(decodeClientMessage(second.sent[0]!)).toEqual({
      t: 'JOIN', roomId: 'main', name: 'tester', v: PROTOCOL_VERSION,
    });

    // WELCOME 带 view + snapshot + stateSeq → 核对完成
    welcome(second, { view: null });
    expect(handlers.messages[0]).toMatchObject({ t: 'WELCOME', stateSeq: 42 });
    expect((handlers.messages[0] as Extract<ServerMessage, { t: 'WELCOME' }>).snapshot.version).toBe(3);
    expect(client.isReconciling).toBe(false);
    expect(phases()).toEqual(['checking', 'checking', 'synced']);
  });

  it('探活超时（半开连接 readyState 仍为 OPEN）→ 主动重建，不靠 readyState 判断', () => {
    const first = last();
    expect(first.readyState).toBe(FakeSocket.OPEN);
    client.resume();
    expect(first.lastSent()?.t).toBe('PING');
    vi.advanceTimersByTime(RESUME_PROBE_TIMEOUT_MS + 10);
    expect(first.closed).toBe(true);
    expect(last()).not.toBe(first);
    expect(phases()).toContain('checking');
    expect(client.isReconciling).toBe(true);   // 还没拿到 WELCOME，仍在核对
  });

  it('WELCOME 到达前不提交任何命令；离线意图不排队、不重放', () => {
    const first = last();
    first.sent = [];
    client.resume();
    client.command({ type: 'END_TURN', seat: 0 });
    client.makeOffer(1, { wood: 1 }, {});
    client.acceptOffer('o-old');
    // 全部被闸门丢弃并给出可见反馈；没有一条进入网络
    expect(handlers.dropped).toHaveLength(3);
    expect(first.sent.filter((s) => decodeClientMessage(s)?.t !== 'PING')).toEqual([]);

    const second = settle(RESUME_PROBE_TIMEOUT_MS + 10);
    const before = second.sent.length;
    client.command({ type: 'END_TURN', seat: 0 });
    expect(handlers.dropped).toHaveLength(4);
    expect(second.sent.length).toBe(before);

    // WELCOME 后恢复正常提交，但绝不自动重放刚才那 4 条
    welcome(second);
    expect(client.isReconciling).toBe(false);
    const after = second.sent.length;
    vi.advanceTimersByTime(1000);
    expect(second.sent.length).toBe(after);
    client.command({ type: 'ROLL_DICE', seat: 0 });
    expect(decodeClientMessage(second.sent[second.sent.length - 1]!)).toMatchObject({ t: 'COMMAND' });
  });

  it('watchdog 兜底：链路一直不回 WELCOME，不会永久停在「正在核对」', () => {
    client.resume();
    expect(client.isReconciling).toBe(true);
    vi.advanceTimersByTime(RESUME_WATCHDOG_MS + 10);
    expect(phases()).toContain('stalled');
    expect(client.isReconciling).toBe(false);
    expect(handlers.phases.find((p) => p.phase === 'stalled')!.detail).toContain('重连');
  });

  it('连接本就不干净（非 open）时直接重建，不浪费探活等待', () => {
    const first = last();
    first.readyState = FakeSocket.CLOSED;   // 假连接已断，客户端还以为开着
    first.sent = [];
    client.resume();
    // 没有 PING 探活，直接触发重建
    expect(phases()[0]).toBe('checking');
    expect(handlers.phases.some((p) => p.detail?.includes('重建'))).toBe(true);
    expect(first.sent.filter((s) => decodeClientMessage(s)?.t === 'PING')).toEqual([]);
  });

  it('后台超 10 秒的报价正确过期：WELCOME 快照由服务端裁剪，不携带过期报价也不续期', () => {
    const first = last();
    client.resume();
    const second = settle(RESUME_PROBE_TIMEOUT_MS + 10);
    const stale: Extract<ServerMessage, { t: 'WELCOME' }> = {
      ...WELCOME,
      snapshot: {
        offers: [],                      // 服务端 snapshot() 已 pruneExpired
        version: 9, serverTime: 20_000, nextSendAt: {},
      },
    };
    second.message(stale);
    const got = handlers.messages.find((m) => m.t === 'WELCOME') as Extract<ServerMessage, { t: 'WELCOME' }>;
    expect(got.snapshot.offers).toEqual([]);
    expect(got.snapshot.serverTime).toBe(20_000);
    expect(client.isReconciling).toBe(false);
    expect(first.closed).toBe(true);
  });

  it('重复 visibilitychange 不叠加探活，只重置 watchdog', () => {
    const first = last();
    client.resume();
    const pingsBefore = first.sent.filter((s) => decodeClientMessage(s)?.t === 'PING').length;
    client.resume();
    client.resume();
    const pingsAfter = first.sent.filter((s) => decodeClientMessage(s)?.t === 'PING').length;
    expect(pingsAfter).toBe(pingsBefore);
    expect(phases().filter((p) => p === 'checking')).toHaveLength(1);
  });

  it('旧连接的迟到 PONG / close 不会污染新连接的状态', () => {
    const first = last();
    client.resume();
    first.message({ t: 'PONG', id: (first.lastSent() as { id: number }).id });
    const second = settle();
    // 旧连接再补一个迟到 PONG
    first.message({ t: 'PONG', id: 1 });
    expect(last()).toBe(second);
    expect(FakeSocket.all).toHaveLength(2);
    welcome(second);
    expect(client.isReconciling).toBe(false);
  });

  it('SEAT_TAKEN 在恢复期只重试，不误判成无法恢复', () => {
    const first = last();
    client.resume();
    first.message({ t: 'PONG', id: (first.lastSent() as { id: number }).id });
    const second = settle();
    second.message({ t: 'JOIN_FAILED', reason: 'SEAT_TAKEN' });
    expect(handlers.fatals).toEqual([]);
    expect(client.state).not.toBe('dead');
    expect(client.isReconciling).toBe(true);
    const third = settle(350);
    expect(third).not.toBe(second);
    welcome(third);
    expect(client.isReconciling).toBe(false);
  });

  it('核对状态有清晰文案：checking / stalled / synced 都上报给 UI', () => {
    client.resume();
    expect(handlers.phases[0]!.detail).toContain('核对');
    vi.advanceTimersByTime(RESUME_WATCHDOG_MS + 10);
    expect(handlers.phases.find((p) => p.phase === 'stalled')!.detail).toContain('不会');
    const sock = settle(10);   // 常规重连带回 WELCOME 仍要收尾
    welcome(sock);
    expect(handlers.phases.find((p) => p.phase === 'synced')!.detail).toContain('已核对');
  });
});

// ---------------------------------------------------------------------------
// 真机（Android 12 / 华为浏览器）实测复现：强杀浏览器后 1s 内重开，
// 服务端旧连接仍是半开，JOIN 被判 SEAT_TAKEN；旧实现直接显示致命页把人困住。
// ---------------------------------------------------------------------------
describe('SEAT_TAKEN 冷启动退避（真机复现）', () => {
  it('冷启动撞上半开座位：不判致命，退避后重新 JOIN 并拿到 WELCOME', () => {
    const first = last();
    first.message({ t: 'JOIN_FAILED', reason: 'SEAT_TAKEN' });
    expect(handlers.fatals).toEqual([]);
    expect(handlers.states).toContain('reconnecting');

    vi.advanceTimersByTime(SEAT_TAKEN_RETRY_MS + 1);
    const second = last();
    expect(second).not.toBe(first);
    expect(FakeSocket.all).toHaveLength(2);
    second.open();
    expect(second.lastSent()?.t).toBe('JOIN');
    welcome(second);
    expect(handlers.messages.some((m) => m.t === 'WELCOME')).toBe(true);
    expect(handlers.fatals).toEqual([]);
    expect(client.state).toBe('open');
  });

  it('重试次数用尽才显示致命页，不会无限重连', () => {
    for (let i = 0; i < SEAT_TAKEN_MAX_RETRIES; i += 1) {
      last().message({ t: 'JOIN_FAILED', reason: 'SEAT_TAKEN' });
      vi.advanceTimersByTime(SEAT_TAKEN_RETRY_MS + 1);
      last().open();
    }
    expect(handlers.fatals).toEqual([]);
    last().message({ t: 'JOIN_FAILED', reason: 'SEAT_TAKEN' });
    expect(handlers.fatals).toEqual(['SEAT_TAKEN']);
    expect(client.state).toBe('dead');
  });

  it('其他 JOIN_FAILED 原因仍立即判致命，不被退避逻辑吞掉', () => {
    last().message({ t: 'JOIN_FAILED', reason: 'PROTOCOL_MISMATCH' });
    expect(handlers.fatals).toEqual(['PROTOCOL_MISMATCH']);
    expect(client.state).toBe('dead');
  });
});
