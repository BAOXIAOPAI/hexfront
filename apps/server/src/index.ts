/**
 * 服务端入口。
 *
 * 环境变量：
 * - PORT  发布沙箱注入，本地默认 8787
 * - HOST  默认 0.0.0.0（沙箱必须，否则容器外连不进来）
 */

import { createAppServer } from './server.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const app = createAppServer({ port, host });

app
  .listen()
  .then((actual) => {
    console.log(`[hexfront] server listening on http://${host}:${actual}`);
    console.log('[hexfront] ws endpoint: ws://<host>:<port>/?sharecode=<code>');
  })
  .catch((err: unknown) => {
    console.error('[hexfront] failed to listen:', err);
    process.exit(1);
  });

let closing = false;
const shutdown = (signal: string): void => {
  if (closing) return;
  closing = true;
  console.log(`[hexfront] ${signal} received, shutting down`);
  app
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
