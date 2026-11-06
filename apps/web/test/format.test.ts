import { describe, expect, it } from 'vitest';
import { MAP_4P, buildBoard, createGame, viewFor } from '@hexfront/engine';
import { describeEvent, fmtResources, playerName } from '../src/format.js';

const board = buildBoard(MAP_4P);
const state = createGame(board, ['甲', '乙'], ['red', 'blue']);
state.current = 1;
const view = viewFor(board, state, 0);

describe('资源文案', () => {
  it('只列出非零资源，且顺序固定', () => {
    expect(fmtResources({ wood: 2, wheat: 3, ore: 1 })).toBe('木2 麦3 矿1');
  });

  it('全零时给出「无」而不是空串', () => {
    expect(fmtResources({})).toBe('无');
  });
});

describe('称呼', () => {
  it('自己叫「你」，别人用名字', () => {
    expect(playerName(view, 0)).toBe('你');
    expect(playerName(view, 1)).toBe('乙');
  });

  it('越界索引给兜底名字，不抛异常', () => {
    expect(playerName(view, 9)).toBe('玩家 10');
  });
});

describe('事件文案', () => {
  it('掷骰写出点数与和', () => {
    const text = describeEvent({ type: 'DICE_ROLLED', player: 1, dice: [2, 3], sum: 5 }, view);
    expect(text).toContain('乙');
    expect(text).toContain('2+3');
    expect(text).toContain('5');
  });

  it('交易写出双向内容', () => {
    const text = describeEvent(
      { type: 'TRADE_COMPLETED', a: 0, b: 1, aGives: { brick: 1 }, bGives: { wheat: 2 } },
      view,
    );
    expect(text).toBe('你 用 砖1 换 乙 的 麦2');
  });

  it('结束回合不刷屏（返回 null）', () => {
    expect(describeEvent({ type: 'TURN_ENDED', player: 0 }, view)).toBeNull();
  });
});
