/**
 * 阶段 D 运行时冒烟（不开浏览器）：用 jsdom 建出 index.html 的 DOM，
 * 真实 new Ui() 并跑一遍 render / setOffers / 连接状态切换，确认不会白屏。
 *
 * jsdom 装在 /tmp/phase-b-dom（不进项目依赖）：
 *   mkdir -p /tmp/phase-b-dom && cd /tmp/phase-b-dom && npm init -y && npm install jsdom
 * 运行：
 *   ./apps/server/node_modules/.bin/tsx probe/phase-d-runtime-smoke.mts
 *
 * 说明：jsdom 不做布局，SVG innerHTML 也不解析，所以它只验证「脚本能跑、DOM 节点齐全」，
 * 不验证画面与手势手感。
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire('/tmp/phase-b-dom/package.json');
const { JSDOM } = req('jsdom') as typeof import('jsdom');

const html = readFileSync(path.join(ROOT, 'apps/web/index.html'), 'utf8')
  .replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''); // main.ts 由 Node 侧手动驱动
const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
const w = dom.window as unknown as Window & { matchMedia: (q: string) => MediaQueryList };
w.matchMedia = ((q: string) => ({
  media: q, matches: false, onchange: null,
  addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
})) as unknown as typeof w.matchMedia;

for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'Element', 'SVGElement', 'Node',
  'Event', 'MouseEvent', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'matchMedia', 'location', 'history',
]) {
  const value = (w as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  try {
    // Node 22 的 navigator 等是只读 getter，defineProperty 也可能失败；跳过即可
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  } catch {
    // 忽略
  }
}

// probe/ 不在 workspace 包内，直接指向 engine 源码；ui.ts 自己从 apps/web 解析 workspace 包
const engineUrl = pathToFileURL(path.join(ROOT, 'packages/engine/src/index.ts')).href;
const { buildBoard, MAP_4P, createGame, viewFor } = await import(engineUrl);
const { Ui } = await import('../apps/web/src/ui.ts');

const board = buildBoard(MAP_4P);
const state = createGame(board, ['甲', '乙', '丙', '丁'], ['red', 'blue', 'white', 'orange']);
const view = viewFor(board, state, 0);

const noop = (): void => {};
const callbacks = new Proxy({}, { get: () => noop }) as never;
const ui = new Ui(callbacks);

const checks: string[] = [];
ui.setRoom('main'); checks.push('setRoom');
ui.setConnection('open'); checks.push('setConnection(open)');
ui.setSynced(true); checks.push('setSynced(true)');
ui.render(view, []); checks.push('render(setup)');
ui.setOffers({ offers: [], version: 0, serverTime: Date.now(), nextSendAt: {} }, 0);
checks.push('setOffers(empty)');
ui.setOffers({
  offers: [{
    id: 'o1', from: 1, to: 0, give: { wood: 2 }, get: { wheat: 1 },
    createdAt: Date.now(), expiresAt: Date.now() + 10_000,
  }],
  version: 1, serverTime: Date.now(), nextSendAt: { '0': Date.now() + 3_000 },
}, 0);
checks.push('setOffers(1 offer)');
ui.render(view, []); checks.push('render(again)');
ui.say('阶段 D 冒烟', '状态'); checks.push('say');
ui.flashReject('测试拒绝原因'); checks.push('flashReject');
ui.setConnection('reconnecting'); checks.push('setConnection(reconnecting)');
ui.setConnection('open'); ui.setSynced(true); checks.push('resume');

// 抽屉/确认条/帮助等面板都真实打开一次，验证 byId 与事件委托不炸
for (const name of ['help', 'dev', 'bank', 'port', 'knight', 'monopoly', 'plenty', 'roads', 'offers'] as const) {
  ui.openPanel(name);
  checks.push(`open:${name}`);
}
ui.openPanel('help');
ui.closePanel();

console.log('✓ 运行时冒烟通过：' + checks.join(' → '));
dom.window.close();
process.exit(0);
