/**
 * 文档 24 F1：显式创建 / 加入分离、创建者即房主。
 *
 * 用真实 WebSocket 走 CREATE → JOIN 两段路径，不调用 RoomRegistry.getOrCreate。
 * 验收：加入不存在房间不产生房间；两人并发创建同名只有一人成功；随后加入者
 * 不抢房主；创建已有房间不静默加入；断线重连与既有房主移交不回归。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAppServer, type AppServer } from '../src/server.js';
import { PROTOCOL_VERSION, type ServerMessage } from '../src/protocol.js';

let app: AppServer;
let wsUrl = '';

beforeAll(async () => {
  app = createAppServer({ port: 0, host: '127.0.0.1', heartbeatMs: 0, capacity: 4 });
  const port = await app.listen();
  wsUrl = `ws://127.0.0.1:${port}/`;
});
afterAll(async () => { await app.close(); });

class C {
  readonly ws: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void;
    timer: ReturnType<typeof setTimeout> }[] = [];
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => this.push(JSON.parse(raw.toString()) as ServerMessage));
  }
  static async connect(): Promise<C> {
    const ws = new WebSocket(`${wsUrl}?sharecode=f1`);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return new C(ws);
  }
  private push(msg: ServerMessage): void {
    const i = this.waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) {
      const w = this.waiters.splice(i, 1)[0]!;
      clearTimeout(w.timer); w.resolve(msg); return;
    }
    this.queue.push(msg);
  }
  wait<T extends ServerMessage['t']>(t: T, timeout = 4000): Promise<Extract<ServerMessage, { t: T }>> {
    const pred = (m: ServerMessage): boolean => m.t === t;
    const hit = this.queue.findIndex(pred);
    if (hit >= 0) return Promise.resolve(this.queue.splice(hit, 1)[0]! as Extract<ServerMessage, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${t} 超时`)), timeout);
      this.waiters.push({ pred, resolve: (m) => resolve(m as Extract<ServerMessage, { t: T }>), timer });
    });
  }
  send(obj: Record<string, unknown>): void { this.ws.send(JSON.stringify(obj)); }
  create(roomId: string, name: string, players = 4): void {
    this.send({ t: 'CREATE', roomId, name, v: PROTOCOL_VERSION, players });
  }
  join(roomId: string, name: string): void {
    this.send({ t: 'JOIN', roomId, name, v: PROTOCOL_VERSION });
  }
  close(): void { this.ws.terminate(); }
}

describe('F1 · 创建与加入严格分开', () => {
  it('JOIN 不存在的房间返回 ROOM_NOT_FOUND，且不会在 /health 里留下房间', async () => {
    const c = await C.connect();
    c.join('f1-ghost', '路人');
    const failed = await c.wait('JOIN_FAILED');
    expect(failed.reason).toBe('ROOM_NOT_FOUND');

    const health = await (await fetch(`http://127.0.0.1:${(app.httpServer.address() as { port: number }).port}/health`)).json() as { rooms: { id: string }[] };
    expect(health.rooms.some((r) => r.id === 'f1-ghost')).toBe(false);
    c.close();
  });

  it('CREATE 成功者是房主（hostSeat=自己的 seat）；随后 JOIN 者不抢房主', async () => {
    const a = await C.connect();
    a.create('f1-host', '房主', 4);
    const wa = await a.wait('WELCOME');
    expect(wa.seat).toBe(0);
    // CREATE 会推 LOBBY（含房主配置）
    const lobbyA = await a.wait('LOBBY');
    expect(lobbyA.lobby.hostSeat).toBe(0);

    const b = await C.connect();
    b.join('f1-host', '客人');
    const wb = await b.wait('WELCOME');
    expect(wb.seat).toBe(1);
    const lobbyB = await b.wait('LOBBY');
    expect(lobbyB.lobby.hostSeat).toBe(0);   // 加入者不抢房主
    a.close(); b.close();
  });

  it('创建重名房间返回 ROOM_EXISTS，不会静默加入', async () => {
    const a = await C.connect();
    a.create('f1-dup', '甲', 4);
    await a.wait('WELCOME');

    const b = await C.connect();
    b.create('f1-dup', '乙', 6);
    const failed = await b.wait('JOIN_FAILED');
    expect(failed.reason).toBe('ROOM_EXISTS');
    // 乙没有被入座（没有 WELCOME）
    expect(b.ws.readyState).toBe(b.ws.OPEN);
    a.close(); b.close();
  });

  it('两人并发 CREATE 同名房间只有一人成功（原子创建）', async () => {
    const a = await C.connect();
    const b = await C.connect();
    const first = (c: C): Promise<string> => Promise.race([
      c.wait('WELCOME').then(() => 'welcome'),
      c.wait('JOIN_FAILED').then((m) => m.reason),
    ]);
    a.create('f1-race', '甲', 4);
    b.create('f1-race', '乙', 4);
    const [ra, rb] = await Promise.all([first(a), first(b)]);
    expect(ra === 'welcome' || rb === 'welcome').toBe(true);
    expect([ra, rb].filter((r) => r === 'welcome')).toHaveLength(1);
    expect([ra, rb]).toContain('ROOM_EXISTS');
    a.close(); b.close();
  });

  it('旧客户端把 players 混进 JOIN 不会隐式创建，也不会改人数', async () => {
    const c = await C.connect();
    c.send({ t: 'JOIN', roomId: 'f1-legacy', name: '甲', v: PROTOCOL_VERSION, players: 8 });
    expect((await c.wait('JOIN_FAILED')).reason).toBe('ROOM_NOT_FOUND');

    const a = await C.connect();
    a.create('f1-legacy', '房主', 4);
    await a.wait('WELCOME');
    const lobby = await a.wait('LOBBY');
    expect(lobby.lobby.targetPlayers).toBe(4);
    a.close(); c.close();
  });

  it('房主断线重连回到原座位且仍是房主（既有移交规则不回归）', async () => {
    const a = await C.connect();
    a.create('f1-reconnect', '房主', 4);
    await a.wait('WELCOME');
    a.close();
    // 等服务端处理完 close/leave，再同名重连（避免半开连接撞 SEAT_TAKEN）
    await new Promise((r) => setTimeout(r, 120));
    const back = await C.connect();
    back.join('f1-reconnect', '房主');
    const w = await back.wait('WELCOME');
    expect(w.seat).toBe(0);
    const lobby = await back.wait('LOBBY');
    expect(lobby.lobby.hostSeat).toBe(0);
    back.close();
  });
});
