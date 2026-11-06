import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildBoard, MAP_4P, type PlayerView } from '@hexfront/engine';

// 集成测试要断言确定的骰子点数；服务端子进程会继承这个开关
process.env.HEXFONT_FAKE_DICE = '1';
import { createAppServer, type AppServer } from '../src/server.js';
import type { ClientMessage, ServerMessage } from '../src/protocol.js';

/**
 * 真实 socket 集成测试：验证 T1 验收条件
 * —— 两个 ws 客户端连同一房间，一方发命令，两人都收到新视图。
 */

let app: AppServer;
let baseUrl = '';
let wsUrl = '';

beforeAll(async () => {
  app = createAppServer({ port: 0, host: '127.0.0.1', heartbeatMs: 0 });
  const port = await app.listen();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/`;
});

afterAll(async () => {
  await app.close();
});

class TestClient {
  readonly ws: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: {
    pred: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => this.push(JSON.parse(raw.toString()) as ServerMessage));
  }

  static async connect(): Promise<TestClient> {
    const ws = new WebSocket(`${wsUrl}?sharecode=test`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new TestClient(ws);
  }

  private push(msg: ServerMessage): void {
    const idx = this.waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

  wait<T extends ServerMessage['t']>(t: T, timeout = 4000): Promise<Extract<ServerMessage, { t: T }>> {
    const pred = (m: ServerMessage): boolean => m.t === t;
    const hit = this.queue.findIndex(pred);
    if (hit >= 0) {
      const msg = this.queue.splice(hit, 1)[0]! as Extract<ServerMessage, { t: T }>;
      return Promise.resolve(msg);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${t} 超时`)), timeout);
      this.waiters.push({
        pred,
        resolve: (m) => resolve(m as Extract<ServerMessage, { t: T }>),
        timer,
      });
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.terminate();
  }
}

const geo = buildBoard(MAP_4P).geo;

function findSpot(view: PlayerView): { vertex: string; edge: string } {
  for (const vk of geo.vertexKeys) {
    const v = geo.vertices[vk]!;
    if (view.buildings[vk]) continue;
    if (v.neighbors.some((nb) => view.buildings[nb])) continue;
    const edge = v.edges.find((ek) => view.roads[ek] === undefined);
    if (edge) return { vertex: vk, edge };
  }
  throw new Error('找不到合法摆位点');
}

describe('WebSocket 联机', () => {
  it('/health 可用', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; rooms: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.rooms)).toBe(true);
  });

  it('两人同房 → 开局 → 摆位 → 掷骰，双方全程同步', async () => {
    const a = await TestClient.connect();
    const b = await TestClient.connect();

    a.send({ t: 'JOIN', roomId: 't1', name: '阿甲' });
    const welcomeA = await a.wait('WELCOME');
    expect(welcomeA.seat).toBe(0);
    expect(welcomeA.roomId).toBe('t1');
    await a.wait('LOBBY');

    b.send({ t: 'JOIN', roomId: 't1', name: '阿乙' });
    const welcomeB = await b.wait('WELCOME');
    expect(welcomeB.seat).toBe(1);
    // 4 人房两人到齐不会自动开局，由房主点「开始」
    await a.wait('LOBBY');

    a.send({ t: 'START' });
    const firstA = await a.wait('STATE');
    const firstB = await b.wait('STATE');
    expect(firstA.view.phase).toBe('setup');
    expect(firstB.view.phase).toBe('setup');

    let view = firstA.view;
    expect(view.setup?.seat).toBe(0);

    // 4 次摆位，每次都由当前该放的客户端发命令
    for (let i = 0; i < 4; i++) {
      const seat = view.setup!.seat;
      const actor = seat === 0 ? a : b;
      const spot = findSpot(view);
      actor.send({ t: 'COMMAND', cmd: { type: 'PLACE_SETTLEMENT', seat, ...spot } });

      const sa = await a.wait('STATE');
      const sb = await b.wait('STATE');
      expect(sa.seq).toBe(sb.seq);
      view = sa.view;
    }

    expect(view.phase).toBe('play');
    expect(view.current).toBe(0);
    expect(view.hasRolled).toBe(false);

    // 掷骰：两人都收到同一 seq 的新视图
    a.send({ t: 'COMMAND', cmd: { type: 'ROLL_DICE', seat: 0, dice: [2, 3] } });
    const rollA = await a.wait('STATE');
    const rollB = await b.wait('STATE');

    expect(rollA.seq).toBe(rollB.seq);
    expect(rollA.view.dice).toEqual([2, 3]);
    expect(rollB.view.dice).toEqual([2, 3]);
    expect(rollA.view.hasRolled).toBe(true);
    expect(rollA.events.some((e) => e.type === 'DICE_ROLLED')).toBe(true);

    a.close();
    b.close();
  });

  it('非当前玩家发命令只得 REJECT，且不影响别人', async () => {
    const a = await TestClient.connect();
    const b = await TestClient.connect();
    a.send({ t: 'JOIN', roomId: 't1-reject', name: '甲' });
    await a.wait('WELCOME');
    b.send({ t: 'JOIN', roomId: 't1-reject', name: '乙' });
    await b.wait('WELCOME');
    await a.wait('LOBBY');

    a.send({ t: 'START' });
    await a.wait('STATE');
    await b.wait('STATE');

    // 摆位阶段由 0 号位先放，1 号位抢着放
    b.send({ t: 'COMMAND', cmd: { type: 'PLACE_SETTLEMENT', seat: 0, vertex: 'x', edge: 'y' } });
    const rejected = await b.wait('REJECT');
    expect(rejected.reason).toBe('NOT_YOUR_TURN');

    // A 没有收到任何 REJECT：用一次 PING 探活，确认连接正常且没有被塞进拒绝消息
    a.send({ t: 'PING', id: 7 });
    const pong = await a.wait('PONG');
    expect(pong.id).toBe(7);

    a.close();
    b.close();
  });

  it('畸形消息不会打断连接', async () => {
    const c = await TestClient.connect();
    c.ws.send('这是一段垃圾数据');
    const failed = await c.wait('JOIN_FAILED');
    expect(failed.reason).toBe('BAD_MESSAGE');

    c.send({ t: 'PING', id: 1 });
    expect((await c.wait('PONG')).id).toBe(1);
    c.close();
  });

  it('/health 反映在线人数与开局状态', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as {
      rooms: { id: string; players: number; connected: number; started: boolean }[];
    };
    const room = body.rooms.find((r) => r.id === 't1');
    expect(room).toBeDefined();
    expect(room!.started).toBe(true);
    expect(room!.players).toBe(2);
  });
});

describe('房间设置端到端', () => {
  it('开局前关掉起始发牌 → 摆完仍空手；开局后设置锁定', async () => {
    const a = await TestClient.connect();
    const b = await TestClient.connect();

    a.send({ t: 'JOIN', roomId: 'grant-off', name: '甲' });
    await a.wait('WELCOME');
    const initial = await a.wait('SETTINGS');
    expect(initial.settings.setupGrant).toBe(true);
    expect(initial.locked).toBe(false);
    await a.wait('LOBBY');

    a.send({ t: 'SET_SETTINGS', setupGrant: false });
    const changed = await a.wait('SETTINGS');
    expect(changed.settings.setupGrant).toBe(false);

    b.send({ t: 'JOIN', roomId: 'grant-off', name: '乙' });
    await b.wait('WELCOME');
    const synced = await b.wait('SETTINGS');
    expect(synced.settings.setupGrant).toBe(false);
    expect(synced.locked).toBe(false);
    // b 入座时也会给 a 推一次 SETTINGS/LOBBY，先消费掉，后面的断言才读得到「新回推」的那条
    await a.wait('SETTINGS');
    await a.wait('LOBBY');

    a.send({ t: 'START' });
    let view = (await a.wait('STATE')).view;
    await b.wait('STATE');
    expect(view.phase).toBe('setup');

    // 开局后改设置应被拒绝，回推 locked=true 且值不变
    a.send({ t: 'SET_SETTINGS', setupGrant: true });
    const lockedMsg = await a.wait('SETTINGS');
    expect(lockedMsg.locked).toBe(true);
    expect(lockedMsg.settings.setupGrant).toBe(false);

    for (let i = 0; i < 4; i++) {
      const seat = view.setup!.seat;
      const actor = seat === 0 ? a : b;
      actor.send({ t: 'COMMAND', cmd: { type: 'PLACE_SETTLEMENT', seat, ...findSpot(view) } });
      const sa = await a.wait('STATE');
      await b.wait('STATE');
      view = sa.view;
    }

    expect(view.phase).toBe('play');
    expect(view.me.handSize).toBe(0);
    expect(view.players.every((p) => p.handSize === 0)).toBe(true);
    a.close();
    b.close();
  });
});
