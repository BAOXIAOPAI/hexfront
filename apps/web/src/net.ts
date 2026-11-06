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
  type ClientMessage,
  type ServerMessage,
} from '@hexfront/protocol';

export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'dead';

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
}

export interface Identity {
  roomId: string;
  name: string;
}

export class GameClient {
  private socket: WebSocket | null = null;
  private retry = 0;
  private closedByUser = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private current: ConnState = 'idle';

  constructor(
    private readonly url: string,
    private identity: Identity,
    private readonly handlers: ClientHandlers,
  ) {}

  get state(): ConnState {
    return this.current;
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

  send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeClient(msg));
  }

  join(): void {
    this.send({ t: 'JOIN', roomId: this.identity.roomId, name: this.identity.name, v: PROTOCOL_VERSION });
  }

  start(): void {
    this.send({ t: 'START' });
  }

  command(cmd: Command): void {
    this.send({ t: 'COMMAND', cmd });
  }

  makeOffer(to: number, give: Partial<ResourceCount>, get: Partial<ResourceCount>): void {
    this.send({ t: 'OFFER', to, give, get });
  }

  acceptOffer(): void {
    this.send({ t: 'OFFER_ACCEPT' });
  }

  rejectOffer(): void {
    this.send({ t: 'OFFER_REJECT' });
  }

  cancelOffer(): void {
    this.send({ t: 'OFFER_CANCEL' });
  }

  close(): void {
    this.closedByUser = true;
    this.stopPing();
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

    socket.addEventListener('open', () => {
      this.retry = 0;
      this.setStatus('open');
      this.join();
      this.startPing();
    });

    socket.addEventListener('message', (ev) => {
      const msg = decodeServerMessage(typeof ev.data === 'string' ? ev.data : '');
      if (!msg) return;
      if (msg.t === 'JOIN_FAILED') {
        // 座位被顶 / 房间满了：重连没有意义，停下来告诉人
        this.closedByUser = true;
        this.setStatus('dead');
        this.handlers.onFatal(msg.reason);
        return;
      }
      this.handlers.onMessage(msg);
    });

    socket.addEventListener('close', () => {
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
    setTimeout(() => {
      if (this.closedByUser) return;
      this.open();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    // 25s < 服务端 30s 心跳，避免被误判为半开连接
    this.pingTimer = setInterval(() => this.send({ t: 'PING' }), 25_000);
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
