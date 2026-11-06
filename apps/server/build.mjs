/**
 * 打包服务端为单文件 CJS，方便发布沙箱直接 `node dist/server.cjs`。
 * 用 JS API 而不是 CLI：pnpm 的 .bin 垫片在本机会把原生二进制交给 node 执行。
 *
 * 同时把前端构建产物复制到 dist/public —— 发布沙箱只上传 apps/server 这一个目录，
 * 前端必须跟着进来，否则线上打开是 404。
 */

import { build } from 'esbuild';
import { cp, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./src/index.ts', import.meta.url));
const outfile = fileURLToPath(new URL('./dist/server.cjs', import.meta.url));
const distDir = fileURLToPath(new URL('./dist', import.meta.url));
const publicDir = fileURLToPath(new URL('./dist/public', import.meta.url));
const webDist = fileURLToPath(new URL('../web/dist', import.meta.url));

await rm(distDir, { recursive: true, force: true });

const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile,
  logLevel: 'warning',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`[build] dist/server.cjs  ${(bytes / 1024).toFixed(1)} KB`);

// 前端产物：不存在就明确提示，不要静默产出一个打不开的包
try {
  await access(`${webDist}/index.html`);
} catch {
  console.error('[build] 缺少 apps/web/dist —— 请先运行 `pnpm --filter @hexfront/web build`');
  process.exit(1);
}

await cp(webDist, publicDir, { recursive: true });
console.log('[build] dist/public      ← apps/web/dist');
