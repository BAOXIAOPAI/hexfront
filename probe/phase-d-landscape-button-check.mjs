/**
 * 「一键进入横屏」真实浏览器复验（不依赖 ADB 设备）。
 *
 * 用无头 Chrome + CDP 设置真实手机竖屏 CSS 视口（390x844, dpr=2, mobile），
 * 以真实指针点击 #portrait-landscape，观察：
 * - 竖屏卡片是否自动展开、按钮文案是否正确；
 * - 点击后是否调用全屏 + 方向锁定（headless 下通常被拒）；
 * - 被拒时是否降级为「手动旋转」提示，而不是静默失败或假装成功。
 *
 * 运行：node probe/phase-d-landscape-button-check.mjs
 * 前提：单端口服务已在 8792 启动（PORT=8792 node apps/server/dist/server.cjs）
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

const CDP_PORT = 9413;
const ROOM = process.env.HEXFRONT_ROOM || 'qacdp';
const PAGE_URL = `http://127.0.0.1:8792/?name=P1&room=${ROOM}`;
const CHROME = process.env.HEXFRONT_CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = `/tmp/hexfront-landscape-chrome-${Date.now()}`;
const OUT = 'docs/shots/phase-d-landscape-button-check.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdpHttp(method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CDP_PORT, path: pathname, method }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && s.pending.has(msg.id)) {
        const { resolve, reject } = s.pending.get(msg.id);
        s.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
    return s;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

let chrome = null;
let session = null;
const report = { viewport: '390x844 @2 (mobile portrait)', pass: [], fail: [], observed: {} };

try {
  chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--proxy-bypass-list=*', '--remote-allow-origins=*',
    '--disable-background-networking', '--disable-component-update', '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 40 && !version; i += 1) {
    try { version = await cdpHttp('GET', '/json/version'); } catch { await sleep(250); }
  }
  if (!version) throw new Error('CDP 未就绪');
  report.chrome = version.Browser;

  const target = await cdpHttp('PUT', `/json/new?${encodeURIComponent('about:blank')}`);
  session = await Session.connect(target.webSocketDebuggerUrl);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    screenOrientation: { angle: 0, type: 'portraitPrimary' },
  });
  // 用鼠标指针复验（开启 touch emulation 时 dispatchMouseEvent 不生成 click）
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  // 记录 API 能力（headless Chrome 通常有 lock，但全屏/方向锁定会被拒）
  await session.send('Page.navigate', { url: PAGE_URL });
  await sleep(4000);   // 留时间给满员自动开局与 STATE 广播

  const before = await session.evaluate(`(() => {
    const gate = document.getElementById('portrait-gate');
    const btn = document.getElementById('portrait-landscape');
    return {
      gateHidden: gate?.classList.contains('hidden'),
      gateDisplay: gate ? getComputedStyle(gate).display : null,
      btnText: btn?.textContent?.trim(),
      hintHidden: document.getElementById('portrait-hint')?.classList.contains('hidden'),
      orientation: typeof screen !== 'undefined' && screen.orientation ? 'present' : 'absent',
      lockType: typeof screen !== 'undefined' && screen.orientation
        ? typeof screen.orientation.lock : 'absent',
      innerWidth, innerHeight,
    };
  })()`);
  report.observed.before = before;
  (before.gateHidden === false && before.btnText === '进入横屏' ? report.pass : report.fail)
    .push('竖屏卡片自动展开且主按钮为「进入横屏」');

  // 探针：区分「点击没到按钮」与「全屏/lock 挂起或失败」
  await session.evaluate(`(() => {
    window.__probe = { clicks: 0, locks: [], fullscreens: 0, errors: [] };
    document.getElementById('portrait-landscape')
      .addEventListener('click', () => { window.__probe.clicks += 1; }, true);
    const so = screen.orientation;
    if (so && typeof so.lock === 'function') {
      const orig = so.lock.bind(so);
      so.lock = (o) => { window.__probe.locks.push(o); return orig(o); };
    }
    const el = document.documentElement;
    if (typeof el.requestFullscreen === 'function') {
      const origFs = el.requestFullscreen.bind(el);
      el.requestFullscreen = () => { window.__probe.fullscreens += 1; return origFs(); };
    }
    window.addEventListener('unhandledrejection', (e) => {
      window.__probe.errors.push(String(e.reason));
    });
    return true;
  })()`);

  // 真实指针点击按钮中心
  const rect = await session.evaluate(`(() => {
    const r = document.getElementById('portrait-landscape').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  report.observed.clickAt = rect;
  report.observed.hitTarget = await session.evaluate(`(() => {
    const el = document.elementFromPoint(${rect.x}, ${rect.y});
    return el ? { tag: el.tagName, id: el.id, cls: String(el.className || '') } : null;
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type, x: rect.x, y: rect.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
  await sleep(1200);

  const after = await session.evaluate(`(() => {
    const hint = document.getElementById('portrait-hint');
    const gate = document.getElementById('portrait-gate');
    return {
      hintHidden: hint?.classList.contains('hidden'),
      hintText: hint?.textContent?.trim() || '',
      gateHidden: gate?.classList.contains('hidden'),
      toastText: document.getElementById('toast')?.textContent?.trim() || '',
      fullscreenElement: document.fullscreenElement ? 'present' : null,
      orientationType: typeof screen !== 'undefined' && screen.orientation ? screen.orientation.type : null,
      probe: window.__probe || null,
    };
  })()`);
  report.observed.after = after;
  report.observed.probe = after.probe;

  const degraded = !after.hintHidden && after.hintText.length > 0;
  const locked = after.orientationType && String(after.orientationType).startsWith('landscape');
  if (degraded || locked) {
    report.pass.push(locked
      ? '方向锁定成功，已切到横屏'
      : '浏览器拒绝方向锁定 → 已降级为手动旋转提示（非静默失败）');
  } else {
    report.fail.push('点击后既没有锁定横屏，也没有出现降级提示');
  }
  if (locked) report.pass.push('横屏后竖屏卡片自动收起');
  else if (after.gateHidden === false) report.pass.push('降级时卡片保留，用户仍能看到说明与操作入口');

  const shot = await session.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync('docs/shots', { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  report.screenshot = OUT;

  // 回归：改过 .portrait-gate 的 display / z-index，必须在三个横屏视口确认
  // 卡片不会误显示、右侧行动区仍在、棋盘布局没被遮挡。
  report.landscapeViewports = [];
  await sleep(2400);   // 等降级 toast 淡出，避免污染横屏截图
  for (const [w, h] of [[667, 375], [844, 390], [932, 430]]) {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 2, mobile: true,
      screenOrientation: { angle: 90, type: 'landscapePrimary' },
    });
    await sleep(350);
    const vp = await session.evaluate(`(() => {
      const g = document.getElementById('portrait-gate');
      const rail = document.querySelector('.rail');
      const stage = document.querySelector('.board-stage');
      return {
        gateDisplay: g ? getComputedStyle(g).display : null,
        gateHidden: g ? g.classList.contains('hidden') : null,
        railDisplay: rail ? getComputedStyle(rail).display : null,
        stageWidth: stage ? Math.round(stage.getBoundingClientRect().width) : null,
        innerWidth, innerHeight,
      };
    })()`);
    const vpShot = await session.send('Page.captureScreenshot', { format: 'png' });
    const file = `docs/shots/phase-d-landscape-vp-${w}x${h}.png`;
    fs.writeFileSync(file, Buffer.from(vpShot.data, 'base64'));
    const row = { viewport: `${w}x${h}`, ...vp, screenshot: file };
    report.landscapeViewports.push(row);
    (vp.gateDisplay === 'none' ? report.pass : report.fail)
      .push(`${w}x${h}: 横屏下竖屏卡片${vp.gateDisplay === 'none' ? '已隐藏' : '仍显示 ' + vp.gateDisplay}`);
    if (vp.railDisplay === 'none') report.fail.push(`${w}x${h}: 右侧行动区被隐藏`);
    else if (vp.railDisplay) report.pass.push(`${w}x${h}: 右侧行动区正常展开`);
  }
} catch (err) {
  report.fail.push(`脚本异常：${err.message}`);
} finally {
  session?.close();
  if (chrome) { try { chrome.kill('SIGKILL'); } catch { /* ignore */ } }
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(JSON.stringify(report, null, 2));
const p = 'probe/phase-d-landscape-button-report.json';
fs.writeFileSync(p, JSON.stringify(report, null, 2));
console.log(`\n报告已写入 ${p}`);
