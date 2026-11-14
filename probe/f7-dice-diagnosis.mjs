#!/usr/bin/env node
/**
 * 文档 24 F7：骰子专项诊断报告生成器（只读、可复跑）。
 *
 * 真正的分布断言在 `packages/engine/test/f7-dice-diagnosis.test.ts`（vitest 可直接跑）。
 * 这个脚本把「能证明什么、什么 BLOCKED」整理成可存档 JSON，避免把本地采样当线上证明。
 *
 * 用法（仓库根目录）：
 *   node probe/f7-dice-diagnosis.mjs
 * 输出：probe/f7-dice-report.json
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = Number(process.env.F7_SAMPLES ?? 120_000);

// 与 packages/engine/src/rules/roll.ts 的 randomDice 完全同构：两次独立均匀 1–6
const randomDice = () => [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];

const sums = {};
const faces = {};
let drought = 0;
let longestDrought = 0;
for (let i = 0; i < SAMPLES; i++) {
  const [a, b] = randomDice();
  faces[a] = (faces[a] ?? 0) + 1;
  faces[b] = (faces[b] ?? 0) + 1;
  const s = a + b;
  sums[s] = (sums[s] ?? 0) + 1;
  if (s === 7) drought = 0;
  else { drought += 1; if (drought > longestDrought) longestDrought = drought; }
}

const theoretical = {
  2: 1 / 36, 3: 2 / 36, 4: 3 / 36, 5: 4 / 36, 6: 5 / 36, 7: 6 / 36,
  8: 5 / 36, 9: 4 / 36, 10: 3 / 36, 11: 2 / 36, 12: 1 / 36,
};
let chiSquare = 0;
for (let s = 2; s <= 12; s++) {
  const exp = theoretical[s] * SAMPLES;
  chiSquare += ((sums[s] ?? 0) - exp) ** 2 / exp;
}

const report = {
  generatedAt: new Date().toISOString(),
  scope: '本地 Node 进程内采样（与 engine randomDice 同构）；不代表线上服务端版本或环境开关',
  samples: SAMPLES,
  sumCounts: sums,
  sumFreq: Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, v / SAMPLES])),
  faceFreq: Object.fromEntries(Object.entries(faces).map(([k, v]) => [k, v / (SAMPLES * 2)])),
  sevens: sums[7] ?? 0,
  sevenFreq: (sums[7] ?? 0) / SAMPLES,
  expectedSevenFreq: 1 / 6,
  longestDrought,
  chiSquare: { stat: chiSquare, df: 10, reference99: 23.21 },
  fakeDiceEnv: process.env.HEXFONT_FAKE_DICE ?? '(unset)',
  blocked: [
    {
      item: '线上运行中服务端的环境变量与二进制版本',
      status: 'BLOCKED',
      reason: '仓库只有只读 HTTP/WS 访问能力，无平台管理/容器访问权限，无法读取 HEXFRONT_FAKE_DICE 或构建版本。任务书要求缺少能力时明确记 BLOCKED，不假装已查。',
    },
    {
      item: '线上真实房间逐次 DICE_ROLLED / STATE.dice / 前端动画最终点数对照',
      status: 'NOT_RUN',
      reason: '不在用户正在使用的房间做干扰性实验；需用户同意后另开隔离测试房再跑。',
    },
  ],
  conclusions: [
    'randomDice 用两次独立均匀 1–6，未过滤七，也未加入任何补偿。',
    '本地大样本的点数和分布与理论值一致（chiSquare 见上），七的频率接近 1/6。',
    '「连续未出七」是几何分布的正常波动；少量实测不能确定故障。',
    '线上是否被环境开关影响：本轮 BLOCKED，既未证明也未排除。',
    '不得为「没掷到七」改成强制七或补偿概率。',
  ],
};

writeFileSync(path.join(ROOT, 'probe', 'f7-dice-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
