/**
 * 文档 23 前端：大厅展示与地图一致性的纯函数验收。
 * 用 mini-dom 构造最小 DOM，验证 LobbyView 渲染、地图摘要、蛇形预览、倒计时。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MiniDocument, fire, installGlobals, makeWindow } from './fixtures/mini-dom.js';
import {
  LobbyView,
  mapSummary,
  remainingSeconds,
  snakePreview,
  type LobbyState,
} from '../src/lobby.js';
import type { LobbyConfig, MapSnapshot, SetupTimer } from '@hexfront/protocol';

const baseMap: MapSnapshot = {
  kind: 'base',
  rows: [3, 4, 5, 4, 3],
  tiles: [
    { key: '0,0', terrain: 'wood', number: 6 },
    { key: '2,0', terrain: 'desert', number: null },
    { key: '1,1', terrain: 'brick', number: 8 },
  ],
  ports: [
    { edge: 'a', port: { kind: 'generic' } },
    { edge: 'b', port: { kind: 'specific', resource: 'wood' } },
  ],
  robberTile: '2,0',
  seed: 'abcdefgh-1234',
  generatorVersion: 1,
  boardVersion: 3,
};

const extMap: MapSnapshot = {
  ...baseMap,
  kind: 'ext',
  rows: [3, 4, 5, 6, 5, 4, 3],
  tiles: [
    ...baseMap.tiles,
    { key: '4,2', terrain: 'desert', number: null },
    { key: '0,4', terrain: 'sheep', number: 6 },
  ],
  ports: Array.from({ length: 11 }, (_, i) => ({
    edge: `e${i}`,
    port: i < 5 ? { kind: 'generic' as const } : { kind: 'specific' as const, resource: 'sheep' },
  })),
  boardVersion: 7,
};

function lobby(overrides: Partial<LobbyConfig> = {}): LobbyConfig {
  return {
    hostSeat: 0,
    targetPlayers: 4,
    board: 'base',
    boardChoice: 'auto',
    recommendedBoard: 'base',
    configVersion: 3,
    actionOrder: [0, 1, 2, 3],
    ready: [false, false, false, false],
    changedBy: 0,
    changeReason: 'REROLL_MAP',
    canStart: false,
    startBlockReason: 'NOT_ALL_READY',
    ...overrides,
  };
}

function state(overrides: Partial<LobbyState> = {}): LobbyState {
  return {
    roomId: 'main',
    seat: 0,
    players: [
      { seat: 0, name: '甲', connected: true, ready: false },
      { seat: 1, name: '乙', connected: true, ready: true },
      { seat: 2, name: '丙', connected: false, ready: false },
      { seat: 3, name: '丁', connected: true, ready: true },
    ],
    lobby: lobby(),
    map: baseMap,
    timer: null,
    ...overrides,
  };
}

describe('纯函数：地图摘要', () => {
  it('摘要包含格数、地形配比、红点数、港口数、种子前缀与版本', () => {
    const s = mapSummary(baseMap);
    expect(s).toContain('3 格');
    expect(s).toContain('红点2');
    expect(s).toContain('2 港');
    expect(s).toContain('abcdefgh');
    expect(s).toContain('v3');
  });

  it('扩展盘摘要体现 11 港与版本号', () => {
    const s = mapSummary(extMap);
    expect(s).toContain('11 港');
    expect(s).toContain('v7');
  });
});

describe('纯函数：蛇形预览', () => {
  it('展示正序 + 倒序，末位连续两次', () => {
    const s = snakePreview([2, 0, 3, 1], ['甲', '乙', '丙', '丁']);
    expect(s).toContain('丙 → 甲 → 丁 → 乙 ⇄ 乙 → 丁 → 甲 → 丙');
  });
  it('8 人顺序也正确', () => {
    const names = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
    const s = snakePreview([0, 1, 2, 3, 4, 5, 6, 7], names);
    expect(s).toContain('辛 → 庚 → 己 → 戊 → 丁 → 丙 → 乙 → 甲');
  });
});

describe('纯函数：倒计时（服务端权威）', () => {
  const timer: SetupTimer = {
    step: 0, seat: 0, startedAt: 1000, deadline: 181_000, serverTime: 1000,
  };
  it('按服务端 serverTime + 本地偏差计算，不用本地绝对时间直接减', () => {
    expect(remainingSeconds(timer, 1000, 1000)).toBe(180);
    expect(remainingSeconds(timer, 1000, 61_000)).toBe(120);
    expect(remainingSeconds(timer, 1000, 181_000)).toBe(0);
  });
  it('迟到/时钟偏差不会得到负数', () => {
    expect(remainingSeconds(timer, 1000, 999_999)).toBe(0);
  });
});

describe('LobbyView 渲染', () => {
  let doc: MiniDocument;
  let restore: () => void;
  let sheet: ReturnType<MiniDocument['getElementById']>;
  let overlay: ReturnType<MiniDocument['getElementById']>;
  let calls: Array<[string, unknown]>;

  function makeView(): LobbyView {
    calls = [];
    return new LobbyView(sheet! as unknown as HTMLElement, overlay! as unknown as HTMLElement, {
      onReady: (r) => calls.push(['ready', r]),
      // F2：人数与手选地图分成两个独立回调
      onPlayerCount: (p, ver) => calls.push(['players', [p, ver]]),
      onBoard: (b, ver) => calls.push(['board', [b, ver]]),
      onReroll: (ver) => calls.push(['reroll', ver]),
      onOrder: (o, ver) => calls.push(['order', [o, ver]]),
      onRandomizeOrder: (ver) => calls.push(['random', ver]),
      onStart: (ver) => calls.push(['start', ver]),
    });
  }

  beforeEach(() => {
    doc = new MiniDocument('<body><div class="overlay hidden" id="overlay"><div class="sheet" id="sheet"></div></div></body>');
    restore = installGlobals(doc, makeWindow());
    sheet = doc.getElementById('sheet');
    overlay = doc.getElementById('overlay');
  });
  afterEach(() => restore());

  it('显示席位、准备状态、房主、地图摘要、顺序与开始按钮', () => {
    const v = makeView();
    v.setState(state());
    expect(overlay!.classList.contains('hidden')).toBe(false);
    const html = sheet!.innerHTML;
    expect(html).toContain('房间 MAIN');
    expect(html).toContain('房主');
    expect(html).toContain('已准备');
    expect(html).toContain('未准备');
    expect(html).toContain('离线');
    expect(html).toContain('地图预览');
    expect(html).toContain('abcdefgh');
    expect(html).toContain('选地 / 回合顺序');
    expect(html).toContain('开始游戏');
    expect(html).toContain('我准备好了');
  });

  it('非房主看不到人数/地图配置与排序按钮，但能看到提示', () => {
    const v = makeView();
    v.setState(state({ seat: 2 }));
    const html = sheet!.innerHTML;
    expect(html).toContain('仅房主可修改人数、地图与顺序');
    expect(html).not.toContain('lb-config');
    expect(html).not.toContain('id="lb-players"');
  });

  it('手动改选到不推荐地图时给出拥挤提示', () => {
    const v = makeView();
    v.setState(state({
      lobby: lobby({ board: 'base', boardChoice: 'manual', recommendedBoard: 'ext', targetPlayers: 8 }),
    }));
    expect(sheet!.innerHTML).toContain('拥挤');
    expect(sheet!.innerHTML).toContain('自定义地图');
  });

  it('点击准备/开始/重抽/随机顺序会带上当前 configVersion', () => {
    const v = makeView();
    v.setState(state({ lobby: lobby({ canStart: true, startBlockReason: null }) }));
    for (const act of ['ready', 'start', 'reroll', 'random-order']) {
      const el = sheet!.querySelector(`[data-act="${act}"]`)!;
      fire(el, 'click', {});
    }
    expect(calls).toEqual([
      ['ready', true],
      ['start', 3],
      ['reroll', 3],
      ['random', 3],
    ]);
  });

  it('F2：改人数与改地图分别只发一条意图，不把当前盘一起提交', () => {
    const v = makeView();
    v.setState(state({ seat: 0, lobby: lobby({ canStart: false, startBlockReason: 'NOT_ALL_READY' }) }));
    const players = sheet!.querySelector('#lb-players') as unknown as { value: string };
    const board = sheet!.querySelector('#lb-board') as unknown as { value: string };
    players.value = '6';
    fire(players as never, 'change', {});
    expect(calls).toEqual([['players', [6, 3]]]);
    calls = [];
    board.value = 'ext';
    fire(board as never, 'change', {});
    expect(calls).toEqual([['board', ['ext', 3]]]);
  });

  it('两次 setState 用同一份地图快照时摘要一致（全员同一预览）', () => {
    const v = makeView();
    const s = state();
    v.setState(s);
    const a = sheet!.innerHTML;
    v.setState({ ...s, seat: 1 });   // 换一个观察者
    const b = sheet!.innerHTML;
    const grab = (h: string): string => (h.match(/lb-map-meta">([^<]*)</)?.[1] ?? '');
    expect(grab(a)).toBe(grab(b));
    expect(grab(a)).toContain('abcdefgh');
  });

  it('选地计时存在时渲染倒计时节点，tick 只改数字', () => {
    const v = makeView();
    const timer: SetupTimer = { step: 2, seat: 1, startedAt: 1000, deadline: 181_000, serverTime: 1000 };
    v.setState(state({ timer }));
    expect(sheet!.innerHTML).toContain('data-timer');
    expect(sheet!.innerHTML).toContain('超时系统代放');
    v.tick(Date.now());
    const node = sheet!.querySelector('[data-timer]')!;
    expect(node.textContent).toMatch(/^\d+:\d{2}$/);
  });
});
