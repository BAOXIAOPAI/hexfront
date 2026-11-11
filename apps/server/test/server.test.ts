import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildBoard, MAP_4P, type PlayerView } from '@hexfront/engine';

// 集成测试要断言确定的骰子点数；服务端子进程会继承这个开关
process.env.HEXFONT_FAKE_DICE = '1';
import { createAppServer, type AppServer } from '../src/server.js';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/protocol.js';

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
    // 测试目标是联机流程，版本字段统一补齐；版本不匹配另有专门用例直接发原始 JSON
    const payload = msg.t === 'JOIN' && msg.v === undefined
      ? { ...msg, v: PROTOCOL_VERSION }
      : msg;
    this.ws.send(JSON.stringify(payload));
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

  it('缺 v 或旧版本的 JOIN 被明确拒绝，不会静默入座（指南 10.3）', async () => {
    const c = await TestClient.connect();
    c.ws.send(JSON.stringify({ t: 'JOIN', roomId: 'version', name: '甲' }));
    expect((await c.wait('JOIN_FAILED')).reason).toBe('PROTOCOL_MISMATCH');
    c.close();

    const d = await TestClient.connect();
    d.ws.send(JSON.stringify({ t: 'JOIN', roomId: 'version', name: '乙', v: PROTOCOL_VERSION - 1 }));
    expect((await d.wait('JOIN_FAILED')).reason).toBe('PROTOCOL_MISMATCH');
    d.close();
  });

  it('WELCOME 带恢复快照与权威状态版本', async () => {
    const c = await TestClient.connect();
    c.send({ t: 'JOIN', roomId: 'snapshot', name: '甲' });
    const welcome = await c.wait('WELCOME');
    expect(welcome.snapshot.offers).toEqual([]);
    expect(welcome.snapshot.version).toBe(0);
    expect(typeof welcome.snapshot.serverTime).toBe('number');
    expect(welcome.stateSeq).toBe(0);
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

describe('阶段 D 完整多人流程（真实 WS）', () => {
  it('入房 → 开局 → 摆位 → 报价按 ID 成交 → 掷骰 → 结束回合清空报价', async () => {
    const a = await TestClient.connect();
    const b = await TestClient.connect();
    a.send({ t: 'JOIN', roomId: 'd-e2e', name: '甲' });
    const welcome = await a.wait('WELCOME');
    expect(welcome.snapshot.offers).toEqual([]);
    b.send({ t: 'JOIN', roomId: 'd-e2e', name: '乙' });
    await b.wait('WELCOME');
    await a.wait('LOBBY');

    a.send({ t: 'START' });
    let view = (await a.wait('STATE')).view;
    await b.wait('STATE');
    for (let i = 0; i < 4; i++) {
      const seat = view.setup!.seat;
      const actor = seat === 0 ? a : b;
      actor.send({ t: 'COMMAND', cmd: { type: 'PLACE_SETTLEMENT', seat, ...findSpot(view) } });
      const next = await a.wait('STATE');
      await b.wait('STATE');
      view = next.view;
    }
    expect(view.phase).toBe('play');

    // 造资源（测试白盒）：让 0 号有木、1 号有麦，验证成交链路
    const room = app.registry.get('d-e2e');
    expect(room).toBeDefined();
    room!.game!.players[0]!.resources.wood = 3;
    room!.game!.players[1]!.resources.wheat = 3;

    a.send({ t: 'OFFER', to: 1, give: { wood: 1 }, get: { wheat: 1 } });
    const created = await a.wait('OFFERS');
    expect(created.reason).toBe('CREATED');
    const id = created.snapshot.offers[0]!.id;
    expect(id).toBeTruthy();
    await b.wait('OFFERS');

    // 3 秒冷却：同一人立刻重发被拒，且 rid 回显
    a.send({ t: 'OFFER', to: 1, give: { wood: 2 }, get: {}, rid: 'dup-1' });
    const rejected = await a.wait('REJECT');
    expect(rejected.reason).toBe('OFFER_COOLDOWN');
    expect(rejected.rid).toBe('dup-1');

    // 收件人按 ID 接受 → 交易事件广播 + 只删这一条
    b.send({ t: 'OFFER_ACCEPT', offerId: id });
    const accepted = await b.wait('OFFERS');
    expect(accepted.reason).toBe('ACCEPTED');
    expect(accepted.snapshot.offers).toEqual([]);
    const traded = await a.wait('STATE');
    await b.wait('STATE');
    expect(traded.view.me.resources.wheat).toBeGreaterThan(0);

    // 旧 ID 不能重复成交
    b.send({ t: 'OFFER_ACCEPT', offerId: id, rid: 'again' });
    const gone = await b.wait('REJECT');
    expect(gone.reason).toBe('OFFER_NOT_FOUND');
    expect(gone.rid).toBe('again');

    // 由另一位玩家挂一条新报价，验证回合结束清空
    b.send({ t: 'OFFER', to: 0, give: { wheat: 1 }, get: {} });
    const pending = await b.wait('OFFERS');
    expect(pending.snapshot.offers).toHaveLength(1);

    a.send({ t: 'COMMAND', cmd: { type: 'ROLL_DICE', seat: 0, dice: [2, 3] } });
    const roll = await a.wait('STATE');
    await b.wait('STATE');
    expect(roll.view.dice).toEqual([2, 3]);

    a.send({ t: 'COMMAND', cmd: { type: 'END_TURN', seat: 0 } });
    const ended = await a.wait('STATE');
    await b.wait('STATE');
    expect(ended.view.current).toBe(1);
    const cleared = await b.wait('OFFERS');
    expect(cleared.reason).toBe('END_TURN');
    expect(cleared.snapshot.offers).toEqual([]);

    a.close();
    b.close();
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
