/**
 * HTTP + WebSocket 单端口服务。
 *
 * 部署约束（T0 实测）：
 * - 发布沙箱只给一个 HTTP 端口，所以静态页面与 WS 共用同一个 server
 * - 必须监听 0.0.0.0 与 process.env.PORT
 * - 反向代理要求 WS 连接带 ?sharecode=xxx，服务端无需处理（平台在代理层鉴权）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room, RoomRegistry, normalizeRoomId } from './room.js';
import { decodeClientMessage, encode, PROTOCOL_VERSION, type ServerMessage } from './protocol.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

let cachedRoot: string | null | undefined;

/**
 * 前端构建产物的位置。
 *
 * 三种运行方式下目录关系不同，所以按顺序探：
 * 1. 打包后 `dist/public`（build.mjs 会把 web/dist 复制进来）
 * 2. 本地 `node dist/server.cjs` 时的 `../web/dist`
 * 3. 从仓库根直接跑时的 `apps/web/dist`
 */
function webRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;

  const entryDir = path.dirname(process.argv[1] ?? process.cwd());
  const candidates = [
    path.join(entryDir, 'public'),
    path.join(entryDir, '..', 'web', 'dist'),
    path.join(process.cwd(), 'public'),
    path.join(process.cwd(), '..', 'web', 'dist'),
    path.join(process.cwd(), 'apps', 'web', 'dist'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      cachedRoot = path.resolve(dir);
      return cachedRoot;
    }
  }
  cachedRoot = null;
  return null;
}

/** 把 URL 路径映射到磁盘文件；不存在或越界返回 null */
function resolveWebFile(pathname: string): string | null {
  const root = webRoot();
  if (!root) return null;

  let clean: string;
  try {
    clean = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root)) return null; // 防路径穿越

  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

function serveFile(res: http.ServerResponse, file: string): void {
  const ext = path.extname(file).toLowerCase();
  const isHashed = /-[A-Za-z0-9_]{8}\./.test(path.basename(file));
  const headers: Record<string, string> = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // 带 hash 的资源可以长缓存；index.html 必须每次回源，否则更新后用户看到旧版
    'cache-control': isHashed && ext !== '.html' ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('read error');
  }
}

export interface AppServerOptions {
  port?: number;
  host?: string;
  /** 房间座位上限 */
  capacity?: number;
  /** 心跳间隔，0 关闭（测试用） */
  heartbeatMs?: number;
}

interface Session {
  room: Room;
  seat: number;
}

export interface AppServer {
  readonly registry: RoomRegistry;
  readonly httpServer: http.Server;
  listen(): Promise<number>;
  close(): Promise<void>;
}

const HEALTH_PLACEHOLDER = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>六角拓荒 · 服务端</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d2230;color:#dbe8ec;
       font-family:-apple-system,"PingFang SC",sans-serif}
  .box{text-align:center;padding:28px 34px;border:1px solid rgba(255,255,255,.14);border-radius:16px;
       background:rgba(255,255,255,.04)}
  h1{font-size:16px;margin:0 0 6px;letter-spacing:.08em}
  p{margin:0;font-size:12px;color:#7fa3b1}
</style></head>
<body><div class="box"><h1>六角拓荒 · 服务端在线</h1>
<p>WebSocket 已就绪，等待前端构建产物</p></div></body></html>`;

export function createAppServer(opts: AppServerOptions = {}): AppServer {
  const registry = new RoomRegistry({ capacity: opts.capacity });
  const heartbeatMs = opts.heartbeatMs ?? 30_000;

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/health') {
      const rooms = registry.list().map((r) => ({
        id: r.id,
        players: r.playerCount,
        connected: r.connectedCount,
        started: r.started,
        turn: r.game?.turn ?? 0,
      }));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, rooms }));
      return;
    }

    // 静态前端：有构建产物就直出；没有则回落占位页（开发期只跑服务端时用）
    if (url.pathname !== '/') {
      const file = resolveWebFile(url.pathname);
      if (file) {
        serveFile(res, file);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const index = resolveWebFile('/');
    if (index) {
      serveFile(res, index);
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HEALTH_PLACEHOLDER);
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 });
  const sessions = new Map<WebSocket, Session>();

  wss.on('connection', (ws: WebSocket) => {
    // 每条连接独立的存活标记，心跳失败就断，避免半开连接占着座位
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });

    const reply = (msg: ServerMessage): void => {
      if (ws.readyState === ws.OPEN) ws.send(encode(msg));
    };

    ws.on('message', (raw) => {
      const msg = decodeClientMessage(raw.toString());
      if (!msg) {
        reply({ t: 'JOIN_FAILED', reason: 'BAD_MESSAGE' });
        return;
      }

      switch (msg.t) {
        case 'PING':
          reply({ t: 'PONG', id: msg.id });
          return;

        case 'JOIN': {
          const roomId = normalizeRoomId(msg.roomId) ?? 'main';
          const room = registry.getOrCreate(roomId);
          if (!room) {
            reply({ t: 'JOIN_FAILED', reason: 'ROOM_LIMIT' });
            return;
          }
          const result = room.join(msg.name, { send: (data) => ws.send(data) });
          if (!result.ok) {
            reply({ t: 'JOIN_FAILED', reason: result.reason });
            return;
          }
          sessions.set(ws, { room, seat: result.seat });
          reply({
            t: 'WELCOME',
            roomId: room.id,
            seat: result.seat,
            capacity: room.capacity,
            players: room.lobbyPlayers(),
            view: result.view,
            offer: room.currentOffer,
          });
          // 房间设置是权威值：新入座/重连/满员自动开局都要同步一次
          room.broadcastSettings();
          room.sync();
          return;
        }

        case 'SET_SETTINGS': {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: 'REJECT', reason: 'NOT_SEATED' });
            return;
          }
          // 开局后 setSettings 会拒绝；无论如何都把权威值回推，纠正客户端显示
          session.room.setSettings({ setupGrant: msg.setupGrant });
          session.room.broadcastSettings();
          return;
        }

        case 'OFFER': {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: 'REJECT', reason: 'NOT_SEATED' });
            return;
          }
          session.room.makeOffer(session.seat, msg.to, msg.give, msg.get);
          return;
        }

        case 'OFFER_ACCEPT': {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: 'REJECT', reason: 'NOT_SEATED' });
            return;
          }
          const outcome = session.room.acceptOffer(session.seat);
          if (outcome.ok) session.room.sync(outcome.events);
          return;
        }

        case 'OFFER_REJECT': {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: 'REJECT', reason: 'NOT_SEATED' });
            return;
          }
          session.room.rejectOffer(session.seat);
          return;
        }

        case 'OFFER_CANCEL': {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: 'REJECT', reason: 'NOT_SEATED' });
            return;
          }
          session.room.cancelOffer(session.seat);
          return;
        }

        case 'START': {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: 'REJECT', reason: 'NOT_SEATED' });
            return;
          }
          const started = session.room.start();
          if (!started.ok) {
            reply({ t: 'REJECT', reason: started.reason === 'ALREADY_STARTED' ? 'WRONG_PHASE' : 'NOT_YOUR_TURN' });
            return;
          }
          session.room.sync();
          return;
        }

        case 'COMMAND': {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: 'REJECT', reason: 'NOT_SEATED' });
            return;
          }
          const outcome = session.room.command(session.seat, msg.cmd);
          if (outcome.ok) session.room.sync(outcome.events);
          return;
        }

        default:
          reply({ t: 'JOIN_FAILED', reason: 'BAD_MESSAGE' });
      }
    });

    ws.on('close', () => {
      const session = sessions.get(ws);
      if (!session) return;
      sessions.delete(ws);
      session.room.leave(session.seat);
      session.room.sync();
    });

    ws.on('error', () => {
      // 网络抖动不是逻辑错误，交给 close 处理
    });

    if (heartbeatMs > 0) {
      const timer = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }, heartbeatMs);
      ws.on('close', () => clearInterval(timer));
    }
  });

  return {
    registry,
    httpServer,
    async listen(): Promise<number> {
      const port = opts.port ?? 8787;
      const host = opts.host ?? '0.0.0.0';
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
      const addr = httpServer.address();
      return typeof addr === 'object' && addr ? addr.port : port;
    },
    async close(): Promise<void> {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

export { PROTOCOL_VERSION };
