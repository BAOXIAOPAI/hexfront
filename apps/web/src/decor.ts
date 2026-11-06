/**
 * 地块插画：全部纯 SVG，不用位图。
 * 每个地块 3~6 个小元素，围绕中央数字圆片摆放。
 */

import type { Terrain } from '@hexfront/engine';

function pine(x: number, y: number, s: number): string {
  return `<g transform="translate(${x},${y}) scale(${s})">
    <path d="M0,-17 L8,-5 L5,-5 L11,7 L-11,7 L-5,-5 L-8,-5 Z" fill="#1F5636" stroke="#123A22" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M0,-17 L3.4,-10.5 L0,-8.5 L-3.4,-10.5 Z" fill="#2F7048"/>
    <rect x="-1.6" y="7" width="3.2" height="4.5" rx=".8" fill="#3E2A1A"/>
  </g>`;
}

function grassTuft(x: number, y: number): string {
  return `<path d="M${x},${y} l-2.5,-6 M${x},${y} l0,-7 M${x},${y} l2.5,-6" stroke="#3B7A4C" stroke-width="1.5" stroke-linecap="round" fill="none"/>`;
}

function brickStack(x: number, y: number, s: number): string {
  return `<g transform="translate(${x},${y}) scale(${s * 1.18})" stroke="#6E3018" stroke-width="1.3" stroke-linejoin="round">
    <rect x="-10" y="2" width="9.5" height="6.4" rx="1.2" fill="#D4805A" transform="rotate(-8)"/>
    <rect x="1.5" y="2.5" width="9.5" height="6.4" rx="1.2" fill="#C06F4A" transform="rotate(6)"/>
    <rect x="-4.5" y="-6" width="9.5" height="6.4" rx="1.2" fill="#E0906A" transform="rotate(-3)"/>
    <path d="M-7.5,1.6 L-7.5,5 M-1,3 L-1,6.6 M5,1.5 L5,5.4" stroke="#8E4020" stroke-width="1" opacity=".7"/>
  </g>`;
}

function sheep(x: number, y: number, s: number, flip: boolean): string {
  const f = flip ? -1 : 1;
  return `<g transform="translate(${x},${y}) scale(${s * f},${s})">
    <ellipse cx="0" cy="0" rx="8" ry="5.8" fill="#FBFDF6" stroke="#BFC7B6" stroke-width=".9"/>
    <circle cx="-5" cy="-3" r="4" fill="#FBFDF6" stroke="#BFC7B6" stroke-width=".9"/>
    <circle cx="4" cy="-4" r="4.4" fill="#FBFDF6" stroke="#BFC7B6" stroke-width=".9"/>
    <circle cx="5.5" cy="1.5" r="3.6" fill="#FBFDF6" stroke="#BFC7B6" stroke-width=".9"/>
    <ellipse cx="10" cy="-1.5" rx="3.2" ry="2.8" fill="#4A4040"/>
    <path d="M-3,5 L-3,9 M2.5,5 L2.5,9" stroke="#4A4040" stroke-width="1.5" stroke-linecap="round"/>
  </g>`;
}

function wheatStalk(x: number, y: number, s: number): string {
  return `<g transform="translate(${x},${y}) scale(${s})" stroke="#6E4408" stroke-width="1.9" stroke-linecap="round" fill="none">
    <path d="M0,12 L0,-14"/>
    <path d="M0,-3 L-5,-7.5 M0,-3 L5,-7.5"/>
    <path d="M0,-7.5 L-5,-12 M0,-7.5 L5,-12"/>
    <path d="M0,-11.5 L-3.5,-15 M0,-11.5 L3.5,-15"/>
  </g>`;
}

function mountain(x: number, y: number, s: number): string {
  return `<g transform="translate(${x},${y}) scale(${s})">
    <path d="M-16,11 L-2,-14 L12,11 Z" fill="#6A7178" stroke="#2E353D" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M-2,-14 L-7.5,-4.5 L-2.5,-6.5 L1.5,-3.8 L-2,-14 Z" fill="#EDF2F6"/>
    <path d="M5,11 L14,-4 L23,11 Z" fill="#525A62" stroke="#2E353D" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M14,-4 L10,2.5 L14,1 L16.5,3.4 L14,-4 Z" fill="#DDE5EB"/>
    <path d="M-14,11 L-9,4 L-4,11 Z" fill="#5A6268" stroke="#2E353D" stroke-width="1.2" stroke-linejoin="round"/>
  </g>`;
}

function cactus(x: number, y: number, s: number): string {
  return `<g transform="translate(${x},${y}) scale(${s})" fill="#6E8F4E" stroke="#4A6632" stroke-width="1.2" stroke-linejoin="round">
    <rect x="-2.6" y="-13" width="5.2" height="21" rx="2.6"/>
    <path d="M-2.6,-6 L-8,-6 Q-10,-6 -10,-8 L-10,-11" fill="none" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M2.6,-9 L7,-9 Q9,-9 9,-7 L9,-4" fill="none" stroke-width="3.4" stroke-linecap="round"/>
  </g>`;
}

function smallStone(x: number, y: number, s: number): string {
  return `<ellipse cx="${x}" cy="${y}" rx="${4 * s}" ry="${2.6 * s}" fill="#9A8560" opacity=".5"/>`;
}

/** 场景装饰，坐标相对地块中心 */
export function terrainDecor(kind: Terrain, cx: number, cy: number): string {
  let g = `<g transform="translate(${cx},${cy})">`;

  if (kind === 'wood') {
    g += pine(-22, 0, 0.9) + pine(16, -14, 0.74) + pine(-4, -32, 0.64) + pine(24, 12, 0.58);
    g += grassTuft(-26, 26) + grassTuft(18, 29) + grassTuft(1, 35) + grassTuft(30, -6);
  } else if (kind === 'brick') {
    g += brickStack(-21, -18, 0.92) + brickStack(15, 4, 0.82) + brickStack(-10, 22, 0.62);
    g += `<path d="M-28,-2 q8,-6 16,-1 t16,0" stroke="#8E4A31" stroke-width="1.6" fill="none" opacity=".4"/>`;
    g += smallStone(24, 24, 0.9);
  } else if (kind === 'sheep') {
    g += sheep(-21, -16, 0.8, false) + sheep(14, -26, 0.66, true);
    g += sheep(21, 16, 0.72, false) + sheep(-17, 22, 0.58, true);
    g += grassTuft(-28, 6) + grassTuft(2, 32) + grassTuft(28, -4);
    g += `<circle cx="-26" cy="-28" r="1.9" fill="#F0D45A"/><circle cx="27" cy="26" r="1.6" fill="#F0D45A"/>`;
  } else if (kind === 'wheat') {
    g += wheatStalk(-20, -12, 0.92) + wheatStalk(17, -8, 0.85) + wheatStalk(-5, -30, 0.74);
    g += wheatStalk(25, 17, 0.7) + wheatStalk(-24, 12, 0.66);
    g += `<g stroke="#B8871E" stroke-width="1.3" opacity=".45">
      <path d="M-28,32 L-14,32 M-6,34 L10,34 M16,32 L30,32 M-18,-2 L-6,-2"/></g>`;
  } else if (kind === 'ore') {
    g += mountain(-15, -5, 0.9) + mountain(15, 6, 0.66) + mountain(-25, 14, 0.48);
    g += smallStone(-8, 30, 1) + smallStone(25, 27, 0.8);
    g += `<path d="M-2,29 l2.6,-4.5 l2.6,4.5 Z" fill="#4C535A" opacity=".6"/>`;
  } else {
    g += cactus(19, -12, 0.86);
    g += `<path d="M-28,-2 q9,-9 18,0 t18,0" stroke="#B59A5E" stroke-width="1.8" fill="none" opacity=".7"/>`;
    g += `<path d="M-24,16 q9,-9 18,0 t18,0" stroke="#C4A96C" stroke-width="1.8" fill="none" opacity=".6"/>`;
    g += smallStone(-22, 27, 1) + smallStone(3, 31, 0.7) + smallStone(-6, -30, 0.6);
  }

  return `${g}</g>`;
}
