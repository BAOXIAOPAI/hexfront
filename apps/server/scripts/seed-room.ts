/**
 * 造一局「已经开局、且摆位完成」的房间，供前端联调与自动化验收使用。
 *
 * 用法（在 apps/server 下）：
 *   npx tsx scripts/seed-room.ts [房间号] [人数] [--setup]
 *
 * `--setup` 表示只入座 + 开局就停手，房间留在摆位第 0 步，
 * 交给浏览器去点路口 —— T3 的摆位交互验收要靠它。
 *
 * 它只做客户端能做的事：join → start → 摆位命令，
 * 不碰服务端内存，因此也能顺手验证协议是否够用。
 */

import WebSocket from 'ws';
import { MAP_4P, buildBoard, type PlayerView } from '@hexfront/engine';

type Msg = Record<string, unknown> & { t: string };

class Client {
  private ws: WebSocket;
  private inbox: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void; reject: (e: Error) => void }[] = [];

  constructor(
    private readonly url: string,
    private readonly onState?: (v: PlayerView, seq: number) => void,
  ) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Msg;
      if (msg.t === 'STATE') {
        const stateMsg = msg as unknown as { view: PlayerView; seq: number };
        this.onState?.(stateMsg.view, stateMsg.seq);
      }
      const idx = this.waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w!.resolve(msg);
      } else {
        this.inbox.push(msg);
      }
    });
    this.ws.on('error', (err) => {
      for (const w of this.waiters.splice(0)) w.reject(err as Error);
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  next(pred: (m: Msg) => boolean, timeoutMs = 4000): Promise<Msg> {
    const hit = this.inbox.findIndex(pred);
    if (hit >= 0) {
      const [msg] = this.inbox.splice(hit, 1);
      return Promise.resolve(msg!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('等待消息超时'));
      }, timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }

  /** 丢掉已经堆积的旧消息 —— 发命令前清一次，避免读到上一条 STATE */
  drain(): void {
    this.inbox.length = 0;
  }
}

const roomId = (process.argv[2] ?? 'e2e').toLowerCase();
const count = Math.max(2, Math.min(4, Number(process.argv[3] ?? 2)));
const port = Number(process.env.PORT ?? 8787);
const url = `ws://127.0.0.1:${port}/`;

const names = ['甲', '乙', '丙', '丁'].slice(0, count);
const geo = buildBoard(MAP_4P).geo;
const vertexKeys = geo.vertexKeys.slice();

function pickSpot(view: PlayerView): { vertex: string; edge: string } | null {
  // 挑离岛中心最远的可用顶点，摆位会比较散，看起来像真的一局
  const candidates = vertexKeys
    .filter((k) => !view.buildings[k])
    .filter((k) => !geo.vertices[k]!.neighbors.some((n) => view.buildings[n]))
    .sort((a, b) => Math.hypot(geo.vertices[b]!.x, geo.vertices[b]!.y) - Math.hypot(geo.vertices[a]!.x, geo.vertices[a]!.y));

  for (const vertex of candidates) {
    const edge = geo.vertices[vertex]!.edges.find((e) => view.roads[e] === undefined);
    if (edge) return { vertex, edge };
  }
  return null;
}

async function main(): Promise<void> {
  const clients: Client[] = [];
  let view: PlayerView | null = null;
  let lastSeq = 0;

  for (const name of names) {
    const c = new Client(url, (v, s) => { view = v; lastSeq = s; });
    await c.open();
    c.send({ t: 'JOIN', roomId, name });
    const welcome = await c.next((m) => m.t === 'WELCOME' || m.t === 'JOIN_FAILED');
    if (welcome.t !== 'WELCOME') throw new Error(`入座失败：${String(welcome.reason)}`);
    console.error(`[seed] ${name} → seat ${String(welcome.seat)}`);
    clients.push(c);
  }

  // 满员会自动开局，此时再发 START 会打乱消息顺序（T3 验收时就栽在这）
  if (names.length < 4) {
    clients[0]!.send({ t: 'START' });
  }
  const first = (await clients[0]!.next((m) => m.t === 'STATE')) as unknown as { view: PlayerView };
  view = first.view;

  let guard = 0;
  const setupOnly = process.argv.includes('--setup');
  while (!setupOnly && view.phase === 'setup' && guard++ < 16) {
    const spot = pickSpot(view);
    if (!spot) throw new Error('找不到合法摆位点');
    const seat = view.setup!.seat;
    const step = view.setup!.step;

    clients[seat]!.send({ t: 'COMMAND', cmd: { type: 'PLACE_SETTLEMENT', seat, vertex: spot.vertex, edge: spot.edge } });
    console.error(`[seed] 摆位 step=${step} seat=${seat}`);

    // 只认「比当前更靠后」的快照，否则会读到队列里的旧 STATE 而重复摆位
    const next = (await clients[seat]!.next((m) => {
      if (m.t === 'REJECT') return true;
      if (m.t !== 'STATE') return false;
      const v = (m as unknown as { view: PlayerView }).view;
      return v.phase !== 'setup' || (v.setup?.step ?? 0) > step;
    })) as unknown as { t: string; view?: PlayerView; reason?: string };

    if (next.t === 'REJECT') throw new Error(`摆位被拒：${next.reason}`);
    view = next.view!;
    console.error(`[seed] -> phase=${view.phase} step=${view.setup?.step ?? 'null'}`);
  }

  /** 发一条命令，等它触发的新 STATE（按 seq 前进判断）；被拒返回 null */
  async function act(client: Client, cmd: unknown): Promise<PlayerView | null> {
    const before = lastSeq;
    client.send({ t: 'COMMAND', cmd });
    const msg = await client.next((m) => {
      if (m.t === 'REJECT') return true;
      if (m.t !== 'STATE') return false;
      return (m as unknown as { seq: number }).seq > before;
    });
    if (msg.t === 'REJECT') {
      console.error(`命令被拒：${String((msg as { reason?: string }).reason)}`);
      return null;
    }
    return view;
  }

  // --seven：反复掷骰 + 结束回合，直到出现「有人需要弃牌」的状态，
  // 供前端 T4 的弃牌面板做自动化验收。掷 7 的概率 1/6，40 轮内几乎必中。
  if (process.argv.includes('--seven')) {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    for (let round = 0; round < 40 && view.phase === 'play'; round++) {
      // 视图偶尔会落后一格（广播有先后），拿不到就等一下按最新座位重试
      let seat = view.current;
      let rolled = await act(clients[seat]!, { type: 'ROLL_DICE', seat });
      for (let retry = 0; !rolled && retry < 3; retry++) {
        await wait(200);
        seat = view.current;
        rolled = await act(clients[seat]!, { type: 'ROLL_DICE', seat });
      }
      if (!rolled) break;
      view = rolled;

      if (view.pendingDiscards.length > 0) {
        console.error(`第 ${round + 1} 轮掷出 7，${view.pendingDiscards.length} 人需要弃牌`);
        break;
      }

      const ended = await act(clients[seat]!, { type: 'END_TURN', seat });
      if (!ended) break;
      view = ended;
    }
  }

  // --rounds N：轮换不同点数跑 N 轮，攒资源，供建造验收
  const roundsIdx = process.argv.indexOf('--rounds');
  if (roundsIdx > 0) {
    const total = Number(process.argv[roundsIdx + 1] ?? 8);
    const CYCLE: [number, number][] = [[2, 3], [4, 5], [6, 1], [3, 6], [5, 5], [1, 4]];
    for (let i = 0; i < total && view.phase === 'play'; i++) {
      const seat = view.current;
      const rolled = await act(clients[seat]!, {
        type: 'ROLL_DICE',
        seat,
        dice: CYCLE[i % CYCLE.length]!,
      });
      if (!rolled) break;
      view = rolled;
      if (view.pendingDiscards.length > 0) break;
      const ended = await act(clients[seat]!, { type: 'END_TURN', seat });
      if (!ended) break;
      view = ended;
    }
  }

  // --roll：掷一次固定 2+3=5（一定有产出地块，方便验证高亮）。
  // 服务端目前透传 dice，仅用于自动化验收；生产环境应剥离。
  if (process.argv.includes('--roll')) {
    const seat = view.current;
    const rolled = await act(clients[seat]!, { type: 'ROLL_DICE', seat, dice: [2, 3] });
    if (rolled) view = rolled;
  }

  // --offer：让当前玩家向下一家挂一条报价，用于验收报价横幅
  if (process.argv.includes('--offer')) {
    const from = view.current;
    const to = (from + 1) % view.players.length;
    clients[from]!.send({ t: 'OFFER', to, give: { wood: 1 }, get: { wheat: 1 } });
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(
    JSON.stringify({
      ok: setupOnly ? view.phase === 'setup' && view.setup?.step === 0 : view.phase === 'play',
      roomId,
      phase: view.phase,
      setup: view.setup,
      turn: view.turn,
      current: view.current,
      players: view.players.map((p) => p.name),
      buildings: Object.keys(view.buildings).length,
      roads: Object.keys(view.roads).length,
      pendingDiscards: view.pendingDiscards.map((p) => ({ seat: p.player, count: p.count })),
      hands: view.players.map((p) => p.handSize),
    }),
  );

  for (const c of clients) c.close();
  // 座位保留：本脚本退出后，浏览器用同名 JOIN 仍能坐回原座
  await new Promise((r) => setTimeout(r, 120));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
