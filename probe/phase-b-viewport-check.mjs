/**
 * 阶段 B 视口核对：用 Chrome DevTools Protocol 的 Emulation.setDeviceMetricsOverride
 * 设置真实 CSS 视口，读取布局数据并截图。
 *
 * 为什么不用 --window-size：docs/09-mobile-assessment.md 记录过 headless Chrome
 * 会把外窗按更大宽度布局再缩放，导致「移动端被裁切」的误判。
 * 本脚本核对 iframe/页面内的 innerWidth、innerHeight 与元素 getBoundingClientRect。
 *
 * 运行：node probe/phase-b-viewport-check.mjs
 * 产物：docs/shots/phase-b-*.png、probe/phase-b-viewport-report.json
 * 这只是模拟视口，不替代真机（指南 13.1）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 优先用 /tmp 里的独立 Chromium headless shell：系统 /Applications/Google Chrome.app
// 在 macOS 启动时会碰 ~/Library/Application Support/Google 与签名克隆临时文件，
// 在本机沙箱下会被拦截。可用 HEXFRONT_CHROME 覆盖路径。
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOCAL_CHROME = '/tmp/phase-b-browsers/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const CHROME = process.env.HEXFRONT_CHROME || (existsSync(LOCAL_CHROME) ? LOCAL_CHROME : SYSTEM_CHROME);
const IS_HEADLESS_SHELL = CHROME.includes('chrome-headless-shell');
const PORT = 9333;
const PROFILE = '/tmp/hexfront-phase-b-chrome';
// Chrome 在 macOS 上启动时会碰 ~/Library/Application Support/Google（RLZ），
// 用临时 HOME 隔离，避免读取/写入用户目录，也避免沙箱策略拦截。
const CHROME_HOME = '/tmp/hexfront-phase-b-home';
const SHOTS = path.join(ROOT, 'docs', 'shots');
const REPORT = path.join(ROOT, 'probe', 'phase-b-viewport-report.json');
const PAGE = pathToFileURL(path.join(ROOT, 'prototype', 'mobile-b.html')).href;
const VIEWPORTS_PAGE = pathToFileURL(path.join(ROOT, 'prototype', 'mobile-b-viewports.html')).href;

const CASES = [
  { name:'667x375-default',  w:667,  h:375,  q:'state=default&debug=0&badge=1' },
  { name:'667x375-build',    w:667,  h:375,  q:'state=build&autopick=1&debug=0&badge=1' },
  { name:'667x375-discard',  w:667,  h:375,  q:'state=discard&debug=0&badge=1' },
  { name:'844x390-trade',    w:844,  h:390,  q:'state=trade&drawer=offers&debug=0&badge=1' },
  { name:'932x430-robber',   w:932,  h:430,  q:'state=robber&debug=0&badge=1' },
  { name:'375x667-lobby',    w:375,  h:667,  q:'state=lobby&debug=0&badge=1' },
  { name:'390x844-portrait', w:390,  h:844,  q:'state=default&debug=0&badge=1' },
  { name:'1024x768-tablet',  w:1024, h:768,  q:'state=default&drawer=help&debug=0&badge=1' },
  { name:'1366x768-desktop', w:1366, h:768,  q:'state=default&debug=0&badge=1' },
];

const PROBE_EXPRESSION = `(() => {
  const q = s => document.querySelector(s);
  const rect = s => { const e = q(s); if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height) }; };
  const visible = e => !!e && e.offsetParent !== null;
  const targets = [...document.querySelectorAll('.btn,.act-btn,.stepper,.cam-btn,.iconbtn')]
    .filter(visible)
    .map(e => ({ cls:e.className, w:Math.round(e.getBoundingClientRect().width), h:Math.round(e.getBoundingClientRect().height) }));
  const inView = r => !!r && r.x >= -1 && r.y >= -1 && r.x + r.w <= innerWidth + 1 && r.y + r.h <= innerHeight + 1;
  const confirm = rect('#confirmbar');
  return JSON.stringify({
    viewport:{ w:innerWidth, h:innerHeight, dpr:devicePixelRatio,
               orientation: innerWidth >= innerHeight ? 'landscape' : 'portrait' },
    badge: q('#viewport-badge') ? q('#viewport-badge').textContent : '',
    topbar: rect('.topbar'), actionbar: rect('.actionbar'), board: rect('.board-wrap'),
    situation: rect('.situation'),
    confirmbar: confirm,
    confirmVisible: q('#confirmbar').classList.contains('show'),
    confirmInViewport: inView(confirm),
    drawerOpen: q('#drawer').classList.contains('open'),
    discardOpen: q('#discard-sheet').classList.contains('show'),
    portraitGateVisible: getComputedStyle(q('#portrait-gate')).display !== 'none',
    detailPaneVisible: getComputedStyle(q('#detail-pane')).display !== 'none',
    actionbarVisible: getComputedStyle(q('.actionbar')).display !== 'none',
    tapTargets: targets.length,
    undersized: targets.filter(t => t.w < 44 || t.h < 44),
    docScroll:{ w:document.documentElement.scrollWidth, h:document.documentElement.scrollHeight },
    safeAreaTop: getComputedStyle(q('.app')).paddingTop,
    appHeightUnit: getComputedStyle(q('.app')).height,
  });
})()`;

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        const list = this.listeners.get(msg.method) || [];
        for (const fn of [...list]) fn(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  waitEvent(method, ms = 12000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 ' + method + ' 超时')), ms);
      const list = this.listeners.get(method) || [];
      const fn = (p) => {
        clearTimeout(timer);
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
        resolve(p);
      };
      list.push(fn);
      this.listeners.set(method, list);
    });
  }
}

async function waitForServer(url, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch (_) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  await mkdir(CHROME_HOME, { recursive: true });
  const chrome = spawn(CHROME, [
    ...(IS_HEADLESS_SHELL ? [] : ['--headless=new']),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--allow-file-access-from-files',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--disable-breakpad', '--disable-crash-reporter', '--disable-component-update',
    '--no-default-browser-check',
    'about:blank',
  ], {
    stdio: 'ignore',
    env: { ...process.env, HOME: CHROME_HOME },
  });

  let ws;
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/json/version`);
    const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    const target = await created.json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const results = [];
    for (const c of CASES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: c.w, height: c.h, deviceScaleFactor: 2, mobile: true,
        screenWidth: c.w, screenHeight: c.h,
        screenOrientation: {
          type: c.w >= c.h ? 'landscapePrimary' : 'portraitPrimary',
          angle: c.w >= c.h ? 90 : 0,
        },
      });
      const loaded = cdp.waitEvent('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${PAGE}?${c.q}` });
      await loaded;
      await new Promise(r => setTimeout(r, 250)); // 等 iframe/计时器与字体稳定

      const evaluated = await cdp.send('Runtime.evaluate', {
        expression: PROBE_EXPRESSION, returnByValue: true,
      });
      if (evaluated.exceptionDetails) throw new Error(JSON.stringify(evaluated.exceptionDetails));
      const data = JSON.parse(evaluated.result.value);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(SHOTS, `phase-b-${c.name}.png`);
      await writeFile(file, Buffer.from(shot.data, 'base64'));

      const checks = {
        viewportMatches: data.viewport.w === c.w && data.viewport.h === c.h,
        noHorizontalOverflow: data.docScroll.w <= c.w + 1,
        topbarInRange: data.topbar.h >= 40 && data.topbar.h <= 48,
        boardHasArea: data.board.w > 200 && data.board.h > 200,
        tapTargetsOk: data.undersized.length === 0,
        confirmInViewport: !data.confirmVisible || data.confirmInViewport,
        keyPanelVisible: data.confirmVisible || data.drawerOpen || data.discardOpen || data.portraitGateVisible,
      };
      results.push({ case: c.name, requested:{ w:c.w, h:c.h }, query:c.q,
        screenshot: path.relative(ROOT, file), data, checks,
        pass: Object.values(checks).every(Boolean) });
      console.log(`${checks && results.at(-1).pass ? '✓' : '✗'} ${c.name}: ${JSON.stringify(data.viewport)} tap=${data.tapTargets} undersized=${data.undersized.length} confirm=${data.confirmVisible}`);
    }

    // 核对页本身也截一张，确认 iframe 布局不会互相干扰
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    const loaded2 = cdp.waitEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: VIEWPORTS_PAGE });
    await loaded2;
    await new Promise(r => setTimeout(r, 800));
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const gridFile = path.join(SHOTS, 'phase-b-viewports-grid.png');
    await writeFile(gridFile, Buffer.from(shot2.data, 'base64'));

    const report = {
      generatedAt: new Date().toISOString(),
      method: 'Chrome CDP Emulation.setDeviceMetricsOverride（真实 CSS 视口，非 --window-size）',
      page: PAGE,
      viewportsPage: VIEWPORTS_PAGE,
      gridScreenshot: path.relative(ROOT, gridFile),
      cases: results,
      allPass: results.every(r => r.pass),
      caveat: '模拟视口不是真机替代；双指手势、后台语音、网络切换与误触手感仍需真机验收。',
    };
    await writeFile(REPORT, JSON.stringify(report, null, 2));
    console.log(`\n全部通过：${report.allPass} · ${results.filter(r=>r.pass).length}/${results.length}`);
    console.log(`报告：${path.relative(ROOT, REPORT)}`);
  } finally {
    if (ws) ws.close();
    chrome.kill('SIGTERM');
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
