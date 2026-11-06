import { defineConfig } from 'vite';

/**
 * 开发期用 Vite 带 HMR，WebSocket 走同源 /ws 代理到本地服务端，
 * 这样页面与 WS 同源，避免跨域与 mixed-content 的坑；
 * 发布期页面由 Node 服务端直出，前端连 location.host 根路径。
 */
const WS_TARGET = process.env.HEXFRONT_WS_TARGET ?? 'ws://127.0.0.1:8787';
const proxy = {
  '/ws': { target: WS_TARGET, ws: true, changeOrigin: true },
};

export default defineConfig({
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 4173, proxy },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
