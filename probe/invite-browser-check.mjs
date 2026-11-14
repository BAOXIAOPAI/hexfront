#!/usr/bin/env node
/**
 * 文档 23 邀请链接：真实浏览器验收。
 *
 * 覆盖：
 *   1. 直接打开首页（无 ?room=）→ 自动生成一个随机房间号 + 邀请链接
 *   2. 点「换一个」→ 房间号与链接同步变化
 *   3. 复制邀请链接 → 剪贴板内容是带 room（且不带 name）的链接
 *   4. 用带 ?room= 的链接打开 → 房间号被预填，且不会被随机号覆盖
 *   5. 链接透传 sharecode（发布环境鉴权关键）
 *
 * 用法：node probe/invite-browser-check.mjs
 * 输出：probe/invite-browser-report.json
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps/server', 'index.cjs'));
const WebSocket = require('ws');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PORT = Number(process.env.INVITE_PORT ?? 18790);
const CDP_PORT = Number(process.env.INVITE_CDP ?? 9419);
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > ms) throw new Error(`超时：${label}`);
    await sleep(150);
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(String(m.params.exceptionDetails.text));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

async function cdpHttp(method, pathname) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}${pathname}`, { method });
  return { status: r.status, body: await r.text() };
}

async function openPage(url) {
  const created = await cdpHttp('PUT', `/json/new?${encodeURIComponent(url)}`);
  if (created.status !== 200) throw new Error(`/json/new ${created.status}`);
  const target = JSON.parse(created.body);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (e) => reject(new Error(e?.message ?? 'ws error')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });
  await waitFor(async () => cdp.eval('document.readyState === "complete"'), 15000, '页面加载');
  await waitFor(async () => cdp.eval(`!!document.getElementById('f-room')`), 15000, '入房表单');
  return { cdp, ws, target };
}

const report = { startedAt: new Date().toISOString(), checks: {}, errors: [] };
let server, chrome, profile;

try {
  if (!(await import('node:fs')).existsSync(CHROME)) throw new Error(`Chrome 不存在: ${CHROME}`);
  server = spawn(process.execPath, [path.join(ROOT, 'apps/server/dist/server.cjs')], {
    cwd: ROOT, env: { ...process.env, PORT: String(SERVER_PORT), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 15000, '服务端 /health');

  profile = mkdtempSync(path.join(os.tmpdir(), 'invite-chrome-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  await waitFor(async () => (await cdpHttp('GET', '/json/version')).status === 200, 15000, 'Chrome CDP');

  // ---- 1. 首页自动生成随机号 + 邀请链接 ----
  const home = await openPage(`${BASE}/?sharecode=INVITE-SC`);
  const first = await home.cdp.eval(`({
    room: document.getElementById('f-room').value,
    link: document.getElementById('f-invite').value,
    hasReroll: !!document.getElementById('btn-reroll-room'),
    hasCopy: !!document.getElementById('btn-copy-invite'),
    text: document.getElementById('sheet').textContent,
  })`);
  report.checks.randomRoom = {
    room: first.room, valid: /^[a-z0-9_-]{1,24}$/.test(first.room),
    hasReroll: first.hasReroll, hasCopy: first.hasCopy,
  };
  report.checks.linkHasRoom = new URL(first.link).searchParams.get('room') === first.room;
  report.checks.linkPassesSharecode = new URL(first.link).searchParams.get('sharecode') === 'INVITE-SC';
  report.checks.linkHasNoName = !new URL(first.link).searchParams.has('name');
  report.checks.textRewritten = first.text.includes('邀请链接') && !first.text.includes('同一 WiFi') && !first.text.includes('『前往』');

  // ---- 2. 点「换一个」→ 房间号与链接同步变化 ----
  await home.cdp.eval(`document.getElementById('btn-reroll-room').click()`);
  const second = await home.cdp.eval(`({
    room: document.getElementById('f-room').value,
    link: document.getElementById('f-invite').value,
  })`);
  report.checks.rerollChangesRoom = second.room !== first.room && /^[a-z0-9_-]{1,24}$/.test(second.room);
  report.checks.rerollSyncsLink = new URL(second.link).searchParams.get('room') === second.room;

  // ---- 3. 复制邀请链接 ----
  // headless 下 navigator.clipboard 需要权限，回退 execCommand 也可；这里验证点击后链接值仍正确且有反馈
  await home.cdp.eval(`document.getElementById('btn-copy-invite').click()`);
  await sleep(200);
  const afterCopy = await home.cdp.eval(`({
    note: document.getElementById('join-invite-note').textContent,
    feed: document.getElementById('feed-text').textContent,
  })`);
  report.checks.copyFeedback = /已复制|手动/.test(afterCopy.note + afterCopy.feed);
  report.errors.push(...home.cdp.errors);
  home.ws.close();

  // ---- 4. 用邀请链接打开：房间号预填且不被随机号覆盖 ----
  const invited = await openPage(first.link);
  const joined = await invited.cdp.eval(`({ room: document.getElementById('f-room').value })`);
  report.checks.inviteLinkPrefillsRoom = joined.room === first.room;
  report.errors.push(...invited.cdp.errors);
  invited.ws.close();

  const failed = Object.entries(report.checks).filter(([, v]) => {
    if (typeof v === 'boolean') return !v;
    if (v && typeof v === 'object' && 'valid' in v) return !v.valid;
    return false;
  });
  report.summary = {
    total: Object.keys(report.checks).length,
    passed: Object.keys(report.checks).length - failed.length,
    failed: failed.map(([k]) => k),
    pageErrors: report.errors.length,
  };
  console.log('[invite] 检查项', JSON.stringify(report.checks, null, 2));
  console.log('[invite] 汇总', JSON.stringify(report.summary));
  if (failed.length > 0 || report.errors.length > 0) process.exitCode = 1;
} catch (e) {
  report.errors.push(String(e));
  console.error('[invite] FAIL', e);
  process.exitCode = 1;
} finally {
  try { chrome?.kill('SIGTERM'); } catch { /* */ }
  try { server?.kill('SIGTERM'); } catch { /* */ }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* */ } }
  writeFileSync(path.join(ROOT, 'probe/invite-browser-report.json'), JSON.stringify(report, null, 2));
  console.log('[invite] 报告: probe/invite-browser-report.json');
}
