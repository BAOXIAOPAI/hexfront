/**
 * 传输层客户端。
 *
 * 三条纪律：
 * 1. 一切变更都是 COMMAND，本地绝不改状态
 * 2. 连接必须带 sharecode（平台反向代理靠它鉴权）
 * 3. 断线自动重连，并用同名 JOIN 回到原座位
 */

import type { Command, ResourceCount } from '@hexfront/engine';
import {
  decodeServerMessage,
  encodeClient,
  PROTOCOL_VERSION,
  type BoardKind,
  type ClientMessage,
  type ServerMessage,
} from '@hexfront/protocol';

export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'dead';
/** 回前台核对阶段（纯客户端 UI 状态，不进协议） */
export type ReconcilePhase = 'checking' | 'stalled' | 'synced';

/** 探活等待 PONG 的上限；超时即视为半开连接，主动重建（用户选定的 D-06 路线） */
export const RESUME_PROBE_TIMEOUT_MS = 1500;
/** 整体核对 watchdog：无论链路多糟，都不永久停在「正在核对」 */
export const RESUME_WATCHDOG_MS = 8000;
/**
 * 同名座位被半开连接占着时，服务端要等 30s 心跳 x 2 才释放（最长约 60s）。
 * 浏览器被回收/强杀后立刻重开会撞上这个窗口；直接判致命会把人困在错误页，
 * 因此做有限次退避重试。真机（Android 12 / 华为浏览器）实测复现过此场景。
 */
export const SEAT_TAKEN_RETRY_MS = 2000;
export const SEAT_TAKEN_MAX_RETRIES = 30;

export interface WsUrlInput {
  /** 页面 origin，例如 http://localhost:5173 */
  origin: string;
  /** 平台鉴权参数，必须原样透传 */
  sharecode?: string | null;
}

/**
 * WS 地址统一走同源的 /ws：
 * - 开发期 Vite 把 /ws 代理到本地服务端
 * - 发布期页面由 Node 直出，同一个 server 直接处理 upgrade
 * 两端路径一致，就不会出现「开发能连、构建后连不上」这种只在验收时才暴露的错。
 */
export function wsUrlFor(input: WsUrlInput): string {
  const base = new URL(input.origin);
  const proto = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${proto}//${base.host}/ws`);
  const code = input.sharecode?.trim();
  if (code) url.searchParams.set('sharecode', code);
  return url.toString();
}

export interface ClientHandlers {
  onMessage(msg: ServerMessage): void;
  onState(state: ConnState): void;
  /** 服务端明确拒绝入座时回调，UI 应当提示而不是无限重连 */
  onFatal(reason: string): void;
  /** 连接未就绪时消息被丢弃：必须给出可见反馈，不能静默吞掉用户命令 */
  onDrop?(msg: ClientMessage): void;
  /**
   * D-06：回前台核对状态变化。只用于呈现清晰连接状态，不新增协议消息：
   * 完整权威快照依旧来自重新 JOIN 后服务端已发的 WELCOME（view + snapshot + stateSeq）。
   */
  onReconcile?(phase: ReconcilePhase, detail?: string): void;
}

export interface Identity {
  roomId: string;
  name: string;
  /** F1：CREATE 时由房主设定的目标人数（4–8）；JOIN 与重连绝不带 */
  players?: number;
  /** F1：本次连接是否走显式 CREATE（仅创建房间的第一条链路为 true） */
  intent?: 'create' | 'join';
}

export class GameClient {
  private socket: WebSocket | null = null;
  private retry = 0;
  private closedByUser = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private current: ConnState = 'idle';

  // ---- D-06 回前台核对（受控重连 + 探活超时兜底） ----
  /** 正在核对：此期间不得提交任何会改变对局的意图，也不重放离线点击 */
  private reconciling = false;
  /** 一次恢复流程尚未拿到 WELCOME：watchdog 只把状态降为 stalled，仍等权威快照来收尾 */
  private resumePending = false;
  private probeId = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /** 半开连接期间 socket.readyState 仍可能是 OPEN，用它记住「该重建了」 */
  private staleGeneration = 0;
  /** 冷启动 / 恢复期撞上 SEAT_TAKEN 的退避次数，拿到 WELCOME 归零 */
  private seatTakenRetries = 0;

  constructor(
    private readonly url: string,
    private identity: Identity,
    private readonly handlers: ClientHandlers,
  ) {}

  get state(): ConnState {
    return this.current;
  }

  /** UI/命令入口据此判断是否暂缓提交；核对完成前为 true */
  get isReconciling(): boolean {
    return this.reconciling;
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  setName(name: string): void {
    this.identity = { ...this.identity, name };
  }

  setRoom(roomId: string): void {
    this.identity = { ...this.identity, roomId };
  }

  /** 一切「用户意图」入口：核对完成前直接丢弃并给可见反馈，绝不排队重放（D-06） */
  send(msg: ClientMessage): void {
    if (this.reconciling) { this.handlers.onDrop?.(msg); return; }
    this.transmit(msg);
  }

  /** 内部链路消息（JOIN / PING 心跳 / 探活）不走用户意图闸门 */
  private transmit(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeClient(msg));
    else this.handlers.onDrop?.(msg);   // 不自动排队重放，交给 UI 明确告知
  }

  /**
   * 返回前台：先发带超时的探活；超时或半开连接则主动重建连接，
   * 用重新 JOIN 后服务端已发的 WELCOME（view + snapshot + stateSeq）完成核对。
   * 不新增协议消息、不改 PROTOCOL_VERSION、不动 server.ts。
   *
   * 关键保证：
   * - 核对完成前 reconciling=true，send() 丢弃一切命令并给可见反馈，绝不排队重放；
   * - 报价有效期以快照里的 expiresAt / serverTime 为准，不续期；
   * - watchdog 保证不会永久停在「正在核对」。
   */
  resume(): void {
    if (this.closedByUser) return;
    if (this.reconciling) {
      // 重复 visibilitychange：只重置 watchdog，不叠加探活
      this.armWatchdog();
      return;
    }
    this.reconciling = true;
    this.resumePending = true;
    this.handlers.onReconcile?.('checking', '正在核对服务端权威状态与未过期报价');
    this.armWatchdog();
    this.probeId += 1;
    const id = this.probeId;
    const alive = this.socket && this.socket.readyState === WebSocket.OPEN;
    if (alive) {
      this.transmit({ t: 'PING', id });
      this.probeTimer = setTimeout(() => {
        if (!this.reconciling || id !== this.probeId) return;
        this.probeTimer = null;
        // 探活超时 = 半开连接：readyState 会撒谎，主动重建
        this.rebuild('探活超时，正在重建连接');
      }, RESUME_PROBE_TIMEOUT_MS);
    } else {
      // 连接本就不干净：直接重建
      this.rebuild('连接已断开，正在重建');
    }
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (!this.reconciling) return;
      // 不再无限停在「正在核对」；交给常规重连继续尝试，并给出清晰状态。
      // resumePending 保留：等常规重连终于带回 WELCOME 时仍要宣布「已核对」。
      this.reconciling = false;
      this.clearProbe();
      this.staleGeneration += 1;
      this.handlers.onReconcile?.('stalled', '暂时无法核对，仍在自动重连；离线期间的点击不会被重放');
      // 常规重连由 close 事件触发；若 socket 还开着，主动踢一下
      if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.close();
      else this.open();
    }, RESUME_WATCHDOG_MS);
  }

  /** 受控重建：先等旧连接真正关闭（服务端才会 leave 座位），再重新 JOIN。
   *  否则同名 JOIN 会撞上尚未释放的座位被判 SEAT_TAKEN。半开连接不触发 close，
   *  因此另有短超时强制重开，最长由 watchdog 兜底。 */
  private rebuild(detail: string): void {
    this.clearProbe();
    this.staleGeneration += 1;   // 旧连接的迟到消息/关闭事件全部作废
    const generation = this.staleGeneration;
    this.handlers.onReconcile?.('checking', detail);
    this.stopPing();
    const old = this.socket;
    this.socket = null;
    this.retry = 1;   // 前后台恢复立刻重连，但状态仍显示「正在恢复」而非首次连接
    this.setStatus('reconnecting');

    let started = false;
    const start = (): void => {
      if (started || generation !== this.staleGeneration || this.closedByUser) return;
      started = true;
      this.open();
    };
    if (!old || old.readyState === WebSocket.CLOSED) { start(); return; }
    old.addEventListener('close', start, { once: true });
    try {
      if (old.readyState !== WebSocket.CLOSING) old.close();
    } catch { start(); }
    // 半开连接可能永远不回 close：250ms 后强制重开
    setTimeout(start, 250);
  }

  /** WELCOME 携带权威 view / snapshot / stateSeq —— 核对完成 */
  private finishReconcile(): void {
    if (!this.reconciling && !this.resumePending) return;
    this.reconciling = false;
    this.resumePending = false;
    this.clearProbe();
    this.clearWatchdog();
    this.handlers.onReconcile?.('synced', '已核对服务端权威状态与报价');
  }

  private clearProbe(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.probeId += 1;   // 让迟到的 PONG 作废
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /** 返回前台后探活（供心跳/外部使用）；完整视图仍以 WELCOME / STATE 为准 */
  ping(): void {
    this.transmit({ t: 'PING' });
  }

  /**
   * F1：每次建链的第一条入座消息由 intent 决定。
   * - 'create' → 发 CREATE（带人数），服务端原子创建并授予本连接房主；
   *   创建成功后把 intent 降级为 'join'，后续任何重连都只发 JOIN，绝不重复创建。
   * - 'join'（默认）→ 只发 JOIN；房间不存在由服务端回 ROOM_NOT_FOUND，绝不隐式创建。
   * JOIN/CREATE 是链路消息，不能被 reconcile 闸门挡住。
   */
  join(): void {
    if (this.identity.intent === 'create') {
      this.transmit({
        t: 'CREATE', roomId: this.identity.roomId, name: this.identity.name, v: PROTOCOL_VERSION,
        ...(this.identity.players === undefined ? {} : { players: this.identity.players }),
      });
      // 只在首次成功后由 WELCOME 处理降级；这里先不预置，避免创建失败被永久降级。
      return;
    }
    this.transmit({
      t: 'JOIN', roomId: this.identity.roomId, name: this.identity.name, v: PROTOCOL_VERSION,
    });
  }

  /** WELCOME 到达：创建链路完成，后续重连一律按 JOIN 回原座位 */
  markJoined(): void {
    this.identity = { ...this.identity, intent: 'join', players: undefined };
  }

  start(configVersion?: number): void {
    this.send({ t: 'START', ...(configVersion === undefined ? {} : { configVersion }) });
  }

  // ---- F2：人数与手动选图分成两条独立消息 ----
  setPlayerCount(targetPlayers: number, configVersion: number): void {
    this.send({ t: 'SET_PLAYER_COUNT', targetPlayers, configVersion });
  }

  setBoard(board: BoardKind, configVersion: number): void {
    this.send({ t: 'SET_BOARD', board, configVersion });
  }

  rerollMap(configVersion: number): void {
    this.send({ t: 'REROLL_MAP', configVersion });
  }

  ready(value: boolean): void {
    this.send({ t: 'READY', ready: value });
  }

  setOrder(order: number[], configVersion: number): void {
    this.send({ t: 'SET_ORDER', order, configVersion });
  }

  randomizeOrder(configVersion: number): void {
    this.send({ t: 'RANDOMIZE_ORDER', configVersion });
  }

  command(cmd: Command): void {
    this.send({ t: 'COMMAND', cmd });
  }

  makeOffer(to: number, give: Partial<ResourceCount>, get: Partial<ResourceCount>): void {
    this.send({ t: 'OFFER', to, give, get });
  }

  /** 接受/拒绝/撤回一律携带报价 ID；rid 可用于把服务端的拒绝原因关联回这次点击 */
  acceptOffer(offerId: string, rid?: string): void {
    this.send({ t: 'OFFER_ACCEPT', offerId, ...(rid ? { rid } : {}) });
  }

  rejectOffer(offerId: string, rid?: string): void {
    this.send({ t: 'OFFER_REJECT', offerId, ...(rid ? { rid } : {}) });
  }

  cancelOffer(offerId: string, rid?: string): void {
    this.send({ t: 'OFFER_CANCEL', offerId, ...(rid ? { rid } : {}) });
  }

  close(): void {
    this.closedByUser = true;
    this.stopPing();
    this.clearProbe();
    this.clearWatchdog();
    this.reconciling = false;
    this.resumePending = false;
    this.seatTakenRetries = 0;
    this.staleGeneration += 1;
    this.socket?.close();
    this.socket = null;
    this.setStatus('idle');
  }

  // -------------------------------------------------------------------------

  private open(): void {
    this.setStatus(this.retry === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    // 每次受控重建都换一代：旧连接的迟到消息 / close 一律忽略，
    // 避免半开连接的 PONG 或关闭事件把新连接的状态弄乱（D-06）
    const generation = this.staleGeneration;

    socket.addEventListener('open', () => {
      if (generation !== this.staleGeneration || this.socket !== socket) return;
      this.retry = 0;
      this.setStatus('open');
      this.join();
      this.startPing();
    });

    socket.addEventListener('message', (ev) => {
      if (generation !== this.staleGeneration || this.socket !== socket) return;
      const msg = decodeServerMessage(typeof ev.data === 'string' ? ev.data : '');
      if (!msg) return;
      if (msg.t === 'JOIN_FAILED') {
        // 旧连接是半开时，服务端还没释放同名座位（最长约 60s 心跳窗口）。
        // 受控重连与冷启动都可能撞上：有限次退避重试，期间 UI 显示「正在恢复」，
        // 次数用尽才显示致命页。真机实测：强杀浏览器后 1s 内重开会命中此路径。
        if (msg.reason === 'SEAT_TAKEN' && this.seatTakenRetries < SEAT_TAKEN_MAX_RETRIES) {
          this.seatTakenRetries += 1;
          const delay = this.reconciling ? 300 : SEAT_TAKEN_RETRY_MS;
          const generation = this.staleGeneration;
          this.setStatus('reconnecting');
          setTimeout(() => {
            if (generation !== this.staleGeneration || this.closedByUser) return;
            const stale = this.socket;
            this.socket = null;
            if (stale) { try { stale.close(); } catch { /* ignore */ } }
            this.open();
          }, delay);
          return;
        }
        // 房间满了 / 协议不匹配 / 重试耗尽：重连没有意义，停下来告诉人
        this.closedByUser = true;
        this.setStatus('dead');
        this.handlers.onFatal(msg.reason);
        return;
      }
      if (msg.t === 'PONG') {
        if (this.reconciling && this.probeTimer !== null && msg.id === this.probeId) {
          // 探活通过：链路是通的，但 PONG 不含 view/报价快照。
          // 仍按用户选定路线受控重建，用 WELCOME 的完整权威快照完成核对。
          this.rebuild('连接正常，正在取回权威状态快照');
        }
        return;
      }
      // 先把 WELCOME 的权威 view / snapshot / stateSeq 交给 UI 落地，再宣布核对完成
      this.handlers.onMessage(msg);
      if (msg.t === 'WELCOME') {
        // F1：创建链路已完成；之后所有重连都按 JOIN 回原座位，绝不重复 CREATE
        this.markJoined();
        this.seatTakenRetries = 0;
        this.finishReconcile();
      }
    });

    socket.addEventListener('close', () => {
      if (generation !== this.staleGeneration || this.socket !== socket) return;
      this.stopPing();
      if (this.closedByUser) {
        this.setStatus('idle');
        return;
      }
      this.scheduleRetry();
    });

    socket.addEventListener('error', () => {
      // 交给 close 处理，避免重复排重连
    });
  }

  private scheduleRetry(): void {
    const delay = Math.min(8000, 1000 * 2 ** Math.min(this.retry, 3));
    this.retry += 1;
    this.setStatus('reconnecting');
    const generation = this.staleGeneration;
    setTimeout(() => {
      if (this.closedByUser || generation !== this.staleGeneration) return;
      this.open();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    // 25s < 服务端 30s 心跳，避免被误判为半开连接
    this.pingTimer = setInterval(() => this.transmit({ t: 'PING' }), 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setStatus(state: ConnState): void {
    if (this.current === state) return;
    this.current = state;
    this.handlers.onState(state);
  }
}
