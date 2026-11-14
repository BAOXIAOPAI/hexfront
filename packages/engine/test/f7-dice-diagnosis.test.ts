/**
 * 文档 24 F7：骰子专项诊断（大样本分布）。
 *
 * 这是**本地采样证据**，不是「线上无问题」的证明；也不作为「每若干次必须出现七」的单测。
 * 任务书 §9 优先级 4：对真实随机函数做大样本分布诊断，记录样本数与各点数频率。
 *
 * 线上环境开关/二进制版本本轮 BLOCKED（仓库无平台管理权限），见 docs/CURRENT.md 与
 * probe/f7-dice-report.json 的 blocked 段；本文件只覆盖本地随机源。
 */
import { describe, expect, it } from 'vitest';
import { randomDice } from '../src/rules/roll.js';

const SAMPLES = Number(process.env.F7_SAMPLES ?? 120_000);

interface Result {
  samples: number;
  sums: Record<number, number>;
  sevens: number;
  sevenFreq: number;
  faceFreq: Record<number, number>;
  longestDrought: number;
  chiSquare: number;
}

function sample(n: number): Result {
  const sums: Record<number, number> = {};
  const faces: Record<number, number> = {};
  let drought = 0;
  let longest = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = randomDice();
    faces[a] = (faces[a] ?? 0) + 1;
    faces[b] = (faces[b] ?? 0) + 1;
    const s = a + b;
    sums[s] = (sums[s] ?? 0) + 1;
    if (s === 7) drought = 0;
    else { drought += 1; if (drought > longest) longest = drought; }
  }
  const theoretical: Record<number, number> = {
    2: 1 / 36, 3: 2 / 36, 4: 3 / 36, 5: 4 / 36, 6: 5 / 36, 7: 6 / 36,
    8: 5 / 36, 9: 4 / 36, 10: 3 / 36, 11: 2 / 36, 12: 1 / 36,
  };
  let chi = 0;
  for (let s = 2; s <= 12; s++) {
    const exp = theoretical[s]! * n;
    chi += ((sums[s] ?? 0) - exp) ** 2 / exp;
  }
  return {
    samples: n,
    sums,
    sevens: sums[7] ?? 0,
    sevenFreq: (sums[7] ?? 0) / n,
    faceFreq: Object.fromEntries(Object.entries(faces).map(([k, v]) => [k, v / (n * 2)])),
    longestDrought: longest,
    chiSquare: chi,
  };
}

describe('F7 · 骰子分布（本地随机源，大样本）', () => {
  const r = sample(SAMPLES);

  it('两个骰子都是 1–6，且只出现 2..12 的点数和', () => {
    for (const k of Object.keys(r.faceFreq)) {
      expect(Number(k)).toBeGreaterThanOrEqual(1);
      expect(Number(k)).toBeLessThanOrEqual(6);
    }
    for (const k of Object.keys(r.sums)) {
      const s = Number(k);
      expect(s).toBeGreaterThanOrEqual(2);
      expect(s).toBeLessThanOrEqual(12);
    }
  });

  it('七的频率接近 1/6（大样本 99.9% 容差），但没有被禁用或补偿', () => {
    // 1/6 ≈ 0.1667；12 万样本下 99.9% 区间约 ±0.011。
    // 这不是「必须出七」的业务规则，只是验证随机源未被过滤/补偿。
    expect(r.sevenFreq).toBeGreaterThan(1 / 6 - 0.012);
    expect(r.sevenFreq).toBeLessThan(1 / 6 + 0.012);
    // 明确不是「零七」或「必七」这两种异常形态
    expect(r.sevens).toBeGreaterThan(0);
  });

  it('点数和的卡方统计量落在合理范围（自由度 10）', () => {
    // 自由度 10 的 99.9% 临界值约 29.59；给足余量避免偶发波动误报
    expect(r.chiSquare).toBeLessThan(29.59);
  });

  it('连续未出七的最长长度在几何分布的合理量级（仅记录，不作故障判据）', () => {
    // 12 万样本、p=1/6 时最长干旱通常在 60–90 之间；上限给到 200 只防明显异常
    expect(r.longestDrought).toBeLessThan(200);
  });

  it('产出可存档的诊断摘要（写入 probe/f7-dice-report.json 由脚本负责）', () => {
    // 把关键数字固化在测试报告里，便于人工复核
    expect(r.samples).toBe(SAMPLES);
    // eslint-disable-next-line no-console
    console.log('[F7] samples=%d sevens=%d freq=%s chi2=%s longestDrought=%d',
      r.samples, r.sevens, r.sevenFreq.toFixed(5), r.chiSquare.toFixed(2), r.longestDrought);
  });
});
