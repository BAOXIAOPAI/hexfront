#!/usr/bin/env node
/**
 * 文档 23 L-5：完整对局到 phase=ended 的端到端验收。
 *
 * 与 l5-endtoend.mjs 的区别：这里用「会建造/交易/计分」的 bot 真正打到终局，
 * 而不只是掷骰 + 结束回合的链路覆盖。
 *
 * 覆盖：
 *   - 4 人标准盘（19 格）：4 个 bot 完整对局到 ended，有胜者与分数
 *   - 8 人扩展盘（30 格 / 2 沙漠 / 11 港）：8 个 bot 完整对局到 ended
 *   - 真实 WS 协议 v3：JOIN(players) → READY → START(configVersion) → 摆位 → 对局 → ended
 *
 * 用法：node probe/l5-fullgame.mjs
 * 输出：probe/l5-fullgame-report.json
 */

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(ROOT, 'node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/cli.mjs');
const SERVER = path.join(ROOT, 'apps/server/dist/server.cjs');
const BOT = path.join(ROOT, 'apps/server/scripts/bot.ts');
const PORT = Number(process.env.L5_FULL_PORT ?? 18788);
const WS = `ws://127.0.0.1:${PORT}/?sharecode=l5full`;
const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > ms) throw new Error(`超时：${label}`);
    await sleep(200);
  }
}

/** 起一局：N 个 bot，host 负责创建房间与开始；返回终局信息 */
async function runGame(room, count, board, label, timeoutMs = 240000) {
  const ws = `${WS}&room=${room}`;
  const bots = [];
  const logs = [];
  const ended = { seen: false, winner: null, winnerName: null, scores: null, line: null, by: null };
  const errors = [];

  for (let i = 0; i < count; i++) {
    const name = NAMES[i];
    const args = [
      BOT, ws, name, '--fast', '--turbo',
      ...(i === 0 ? ['--host', `--players=${count}`] : []),
    ];
    const b = spawn(process.execPath, [TSX, ...args], {
      cwd: path.join(ROOT, 'apps/server'),
      env: { ...process.env, HEXFONT_FAKE_DICE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (d, isErr) => {
      const s = String(d).trim();
      if (!s) return;
      logs.push({ name, at: Date.now(), text: s.slice(0, 300), ...(isErr ? { stderr: true } : {}) });
      const m = /对局结束：胜者 (\d+) 号「([^」]*)」，比分 ([\d:]+)/.exec(s);
      if (m && !ended.seen) {
        ended.seen = true;
        ended.winner = Number(m[1]);
        ended.winnerName = m[2];
        ended.scores = m[3].split(':').map(Number);
        ended.line = s;
        ended.by = name;
      }
      if (isErr && /Error|异常退出|进房失败|超时/.test(s)) errors.push({ name, text: s.slice(0, 300) });
    };
    b.stdout.on('data', (d) => capture(d, false));
    b.stderr.on('data', (d) => capture(d, true));
    bots.push(b);
    await sleep(350);   // 串行入座，避免 JOIN 竞态
  }

  try {
    await waitFor(async () => ended.seen, timeoutMs, `${label} 对局到 ended`);
  } catch (e) {
    // 超时也保留日志尾部供诊断
    for (const b of bots) { try { b.kill('SIGTERM'); } catch { /* ignore */ } }
    return {
      label, players: count, board, ended: false, error: e.message,
      errors, logsTail: logs.slice(-25), endedInfo: ended,
    };
  }
  // 给其他 bot 一点时间打印结束信息，然后收尾
  await sleep(800);
  for (const b of bots) { try { b.kill('SIGTERM'); } catch { /* ignore */ } }
  return {
    label, players: count, board, ended: true,
    winner: ended.winner, winnerName: ended.winnerName, scores: ended.scores,
    line: ended.line, reportedBy: ended.by,
    errors,
    logsTail: logs.slice(-15),
    /** 观察项：拥挤程度（D1 只写观察，不设硬指标） */
    observations: [
      `${count} 人 × ${board === 'base' ? '19 格标准盘' : '30 格扩展盘'}`,
      '7–8 人属本项目自定义玩法，不宣称官方支持',
    ],
  };
}

async function main() {
  if (!existsSync(SERVER)) throw new Error('缺少 dist/server.cjs，请先 pnpm build');
  if (!existsSync(TSX)) throw new Error('缺少 tsx cli');

  const server = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += `[stderr] ${d}`; });

  const out = {
    startedAt: new Date().toISOString(),
    port: PORT,
    protocolVersion: 3,
    games: [],
    serverLogTail: [],
  };
  try {
    await waitFor(async () => {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); return r.ok; } catch { return false; }
    }, 15000, '服务端 /health');
    out.health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();

    for (const [room, count, board, label] of [
      ['l5full-p4', 4, 'base', '4 人标准盘 · 完整对局到终局'],
      ['l5full-p8', 8, 'ext', '8 人扩展盘 · 完整对局到终局'],
    ]) {
      const r = await runGame(room, count, board, label);
      out.games.push(r);
      console.log(`[L5-full] ${label}: ${r.ended ? `OK 胜者 ${r.winnerName} 比分 ${r.scores?.join(':')}` : `FAIL ${r.error}`}`);
      // 房间之间留一点清理时间
      await sleep(500);
    }
  } finally {
    server.kill('SIGTERM');
    await sleep(400);
  }
  out.serverLogTail = serverLog.trim().split('\n').slice(0, 12);
  const report = path.join(ROOT, 'probe/l5-fullgame-report.json');
  writeFileSync(report, JSON.stringify(out, null, 2));
  const failed = out.games.filter((g) => !g.ended).length;
  console.log(`\n[L5-full] 报告: ${report}`);
  console.log(`[L5-full] 完整对局 ${out.games.length - failed}/${out.games.length} 到达 ended`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
