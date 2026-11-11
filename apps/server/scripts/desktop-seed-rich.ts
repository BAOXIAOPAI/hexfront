/**
 * 桌面验收专用 · 造一个「资源充足、指定座位为当前玩家、无 7/弃牌/强盗待办」的真实房间。
 *
 * 纪律：只走协议命令（JOIN → START → 摆位 → ROLL_DICE → END_TURN），不碰服务端内存。
 * 依赖 HEXFONT_FAKE_DICE=1 的本地验收后端（生产端该开关关闭，骰子仍由服务端随机）。
 * 安全骰子：跳过任何和为 7 的点数，避免进入弃牌 / 强盗流程。
 *
 * 用法（apps/server 下）：
 *   PORT=8792 npx tsx ../../probe/desktop-seed-rich.ts <roomId> [目标座位=0]
 */
import WebSocket from 'ws';
import { MAP_4P, buildBoard, type PlayerView } from '@hexfront/engine';
import { PROTOCOL_VERSION } from '@hexfront/protocol';

type Msg = Record<string, unknown> & { t: string };

class Client {
  private ws: WebSocket;
  private inbox: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  lastSeq = 0;
  view: PlayerView | null = null;
  constructor(private readonly url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Msg;
      if (msg.t === 'STATE') {
        const s = msg as unknown as { view: PlayerView; seq: number };
        this.view = s.view; this.lastSeq = s.seq;
      }
      const idx = this.waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) { const [w] = this.waiters.splice(idx, 1); w!.resolve(msg); }
      else this.inbox.push(msg);
    });
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
  }
  send(msg: unknown): void { this.ws.send(JSON.stringify(msg)); }
  next(pred: (m: Msg) => boolean, timeoutMs = 4000): Promise<Msg> {
    const hit = this.inbox.findIndex(pred);
    if (hit >= 0) return Promise.resolve(this.inbox.splice(hit, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待消息超时')), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }
  drain(): void { this.inbox.length = 0; }
  close(): void { this.ws.close(); }
}

const roomId = (process.argv[2] ?? 'richdesk').toLowerCase();
const targetSeat = Number(process.argv[3] ?? 0);
const port = Number(process.env.PORT ?? 8792);
const url = `ws://127.0.0.1:${port}/`;
const names = ['甲', '乙', '丙', '丁'];
const geo = buildBoard(MAP_4P).geo;

function pickSpot(view: PlayerView): { vertex: string; edge: string } | null {
  const candidates = geo.vertexKeys
    .filter((k) => !view.buildings[k])
    .filter((k) => !geo.vertices[k]!.neighbors.some((n) => view.buildings[n]))
    .sort((a, b) => Math.hypot(geo.vertices[b]!.x, geo.vertices[b]!.y) - Math.hypot(geo.vertices[a]!.x, geo.vertices[a]!.y));
  for (const vertex of candidates) {
    const edge = geo.vertices[vertex]!.edges.find((e) => view.roads[e] === undefined);
    if (edge) return { vertex, edge };
  }
  return null;
}

/** 安全点数：2..12 中不产生 7 的组合，尽量覆盖多种地形产出 */
const SAFE_DICE: [number, number][] = [
  [2, 3], [4, 5], [3, 3], [5, 6], [2, 2], [6, 6],
  [1, 2], [4, 4], [3, 5], [2, 6], [1, 5], [5, 5], [6, 2], [1, 1], [2, 4],
];

async function main(): Promise<void> {
  const clients: Client[] = [];
  for (const name of names) {
    const c = new Client(url);
    await c.open();
    c.send({ t: 'JOIN', roomId, name, v: PROTOCOL_VERSION });
    const w = await c.next((m) => m.t === 'WELCOME' || m.t === 'JOIN_FAILED');
    if (w.t !== 'WELCOME') throw new Error(`入座失败：${String(w.reason)}`);
    clients.push(c);
  }
  // 4 人满员自动开局
  let view = (await clients[0]!.next((m) => m.t === 'STATE') as unknown as { view: PlayerView }).view;

  // 摆位
  let guard = 0;
  while (view.phase === 'setup' && guard++ < 16) {
    const spot = pickSpot(view);
    if (!spot) throw new Error('找不到合法摆位点');
    const seat = view.setup!.seat;
    const step = view.setup!.step;
    clients[seat]!.drain();
    clients[seat]!.send({ t: 'COMMAND', cmd: { type: 'PLACE_SETTLEMENT', seat, vertex: spot.vertex, edge: spot.edge } });
    const next = await clients[seat]!.next((m) => {
      if (m.t === 'REJECT') return true;
      if (m.t !== 'STATE') return false;
      const v = (m as unknown as { view: PlayerView }).view;
      return v.phase !== 'setup' || (v.setup?.step ?? 0) > step;
    });
    if (next.t === 'REJECT') throw new Error(`摆位被拒：${next.reason}`);
    view = (next as unknown as { view: PlayerView }).view;
  }

  /** 发一条命令并等待新 STATE（按 seq 前进） */
  async function act(seat: number, cmd: unknown): Promise<PlayerView | null> {
    const before = clients[0]!.lastSeq;
    clients[seat]!.drain();
    clients[seedSeat(seat)]!.send({ t: 'COMMAND', cmd });
    const msg = await clients[seedSeat(seat)]!.next((m) => {
      if (m.t === 'REJECT') return true;
      if (m.t !== 'STATE') return false;
      return (m as unknown as { seq: number }).seq > before;
    });
    if (msg.t === 'REJECT') return null;
    return (msg as unknown as { view: PlayerView }).view;
  }
  // 命令必须由「当前座位」的连接发（服务端以连接定座位）
  function seedSeat(seat: number): number { return seat; }

  // 跑若干完整轮次，直到「目标座位为当前玩家且尚未掷骰」再停；跳过 7（安全骰子）
  let rolls = 0;
  let reachedTarget = false;
  const MIN_ROUNDS = 16; // 先攒够资源，再停在甲的回合
  for (let round = 0; round < 120 && view.phase === 'play'; round++) {
    const seat = view.current;
    if (!view.hasRolled) {
      const d = SAFE_DICE[rolls % SAFE_DICE.length]!;
      const v = await act(seat, { type: 'ROLL_DICE', seat, dice: d });
      if (v) view = v;
      rolls++;
    }
    const ended = await act(seat, { type: 'END_TURN', seat });
    if (ended) view = ended;
    if (round >= MIN_ROUNDS && view.current === targetSeat && !view.hasRolled) {
      reachedTarget = true;
      break;
    }
  }
  // 用真实银行 4:1 兑换把多余木材换成砖块/麦子，凑齐「道路」(木1砖1) 或「村庄」成本。
  // 只走协议命令；兑换失败（资源不足）会被引擎 REJECT，忽略即可。
  if (view.current === targetSeat && view.phase === 'play') {
    for (const get of ['brick', 'wheat', 'brick']) {
      const r = await act(targetSeat, { type: 'TRADE_BANK', seat: targetSeat, give: 'wood', get });
      if (r) view = r;
    }
  }

  console.log(JSON.stringify({
    ok: view.phase === 'play' && !view.pendingRobber && view.pendingDiscards.length === 0,
    roomId, phase: view.phase, turn: view.turn, current: view.current, targetSeat,
    hands: view.players.map((p) => p.handSize),
    myResources: view.players[targetSeat]?.name,
    buildings: Object.keys(view.buildings).length, roads: Object.keys(view.roads).length,
    pendingDiscards: view.pendingDiscards, pendingRobber: view.pendingRobber,
    rolls,
  }));
  for (const c of clients) c.close();
  await new Promise((r) => setTimeout(r, 120));
}
main().catch((e) => { console.error(e); process.exit(1); });
