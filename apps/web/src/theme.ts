/** 视觉常量：颜色、名称、概率点，全站唯一来源 */

import type { PlayerColor, Terrain } from '@hexfront/engine';

export const TERRAIN_COLOR: Record<Terrain, string> = {
  wood: '#4A8B5C',
  brick: '#B5603F',
  sheep: '#8FBB5E',
  wheat: '#E0AE43',
  ore: '#8C9298',
  desert: '#D4BD85',
};

export const TERRAIN_NAME: Record<Terrain, string> = {
  wood: '森林',
  brick: '丘陵',
  sheep: '牧场',
  wheat: '田地',
  ore: '山脉',
  desert: '沙漠',
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

export const PLAYER_HEX: Record<PlayerColor, string> = {
  red: '#C8503F',
  blue: '#4A7FB5',
  white: '#EFEDE3',
  orange: '#E8952F',
};

/** 浅色棋子的描边与文字要用深色，否则看不清 */
export function isLight(color: PlayerColor): boolean {
  return color === 'white';
}

export const INK = '#4A3325';
export const INK_DEEP = '#3A2418';
