/**
 * 视觉常量：颜色、名称、概率点，全站唯一来源。
 *
 * 「晴湾纸雕」桌面基准（design/desktop/handoff/DESIGN-SPEC.md §3）接入：
 * 颜色取自原型 board.js THEME.papercut / css/papercut.css，几何与数据契约不变。
 * 这些值同时被 SVG 棋盘、资源卡色条、玩家头像与 CSS 主题层消费。
 */

import type { PlayerColor, Terrain } from '@hexfront/engine';

/** 纸雕地形基色：与 design/desktop/js/board.js THEME.papercut.terrain[].base 一致 */
export const TERRAIN_COLOR: Record<Terrain, string> = {
  wood: '#74A46B',
  brick: '#D07F57',
  sheep: '#ACCF7A',
  wheat: '#E7BE57',
  ore: '#98A6A5',
  desert: '#EBD39D',
};

/** 地形深色（纸雕阴影层） */
export const TERRAIN_DEEP: Record<Terrain, string> = {
  wood: '#3F7A4B',
  brick: '#A24F32',
  sheep: '#78A34E',
  wheat: '#BA8628',
  ore: '#617577',
  desert: '#C29D5B',
};

/** 地形浅色（纸质高光） */
export const TERRAIN_LIGHT: Record<Terrain, string> = {
  wood: '#B9D69A',
  brick: '#EFAF86',
  sheep: '#DCEBB5',
  wheat: '#F7DC8E',
  ore: '#CBD6D2',
  desert: '#F8E7BE',
};

export const TERRAIN_NAME: Record<Terrain, string> = {
  wood: '森林',
  brick: '丘陵',
  sheep: '牧场',
  wheat: '麦田',
  ore: '矿山',
  desert: '沙丘',
};

export const TERRAIN_SHORT: Record<Terrain, string> = {
  wood: '木',
  brick: '砖',
  sheep: '羊',
  wheat: '麦',
  ore: '矿',
  desert: '沙',
};

/** 2~12 的概率点（36 面骰中的出现次数） */
export const PIPS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

/** 玩家色：甲珊瑚红 / 乙海蓝 / 丙深赭黄 / 丁叶绿（纸雕玩家色，见 DESIGN-SPEC §3.1） */
export const PLAYER_HEX: Record<PlayerColor, string> = {
  red: '#C9503F',
  blue: '#3B6FA0',
  white: '#B4741D',
  orange: '#4C8B67',
};

/**
 * 屋顶首字：玩家身份的第二通道（不只靠颜色）。
 * 座位顺序 0..3 → 甲/乙/丙/丁，与原型一致。
 */
export const PLAYER_MARK: Record<PlayerColor, string> = {
  red: '甲', blue: '乙', white: '丙', orange: '丁',
};

/** 道路中心虚线纹理：玩家身份的第二通道（A 实线 / B 3 4 / C .5 4 / D 6 3） */
export const ROAD_DASH: Record<PlayerColor, string> = {
  red: 'none', blue: '3 4', white: '.5 4', orange: '6 3',
};

/** 浅色棋子的描边与文字要用深色，否则看不清（纸雕白棋已改深赭黄，仍保留判定） */
export function isLight(color: PlayerColor): boolean {
  return false;
}

/** 纸雕主文字 / 深色纸边 */
export const INK = '#23372F';
export const INK_DEEP = '#2A4036';
/** 奶油纸面 */
export const PAPER = '#FFF6E2';
export const PAPER_2 = '#F2E3C6';
/** 强调金 / 珊瑚红 */
export const ACCENT = '#E9A93B';
export const HOT = '#B84E37';
