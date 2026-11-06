import { describe, expect, it } from 'vitest';
import {
  MAP_4P,
  applyCommand,
  buildBoard,
  createGame,
  viewFor,
  type Board,
  type GameState,
  type PlayerColor,
  type ResourceCount,
} from '@hexfront/engine';
import {
  DISCARD_ORDER,
  adjustPick,
  canConfirm,
  discardInfo,
  emptyPick,
  pickRemaining,
  pickedTotal,
  productionTiles,
  rollHighlight,
} from '../src/discard.js';

const COLORS: PlayerColor[] = ['red', 'blue', 'white', 'orange'];
const ZERO: ResourceCount = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };

function newGame(players = 2): { board: Board; state: GameState } {
  const board = buildBoard(MAP_4P);
  const names = ['甲', '乙', '丙', '丁'].slice(0, players);
  return { board, state: createGame(board, names, COLORS.slice(0, players)) };
}

/** 把局面推进到正式回合：按引擎接受的位置摆完 2×人数 手 */
function playPhase(players = 2): { board: Board; state: GameState } {
  const board = buildBoard(MAP_4P);
  let state = createGame(board, ['甲', '乙', '丙', '丁'].slice(0, players), COLORS.slice(0, players));
  const geo = board.geo;

  while (state.phase === 'setup') {
    const seat = state.setup!.seat;
    let placed = false;
    for (const vk of geo.vertexKeys) {
      if (state.buildings[vk]) continue;
      const v = geo.vertices[vk]!;
      if (v.neighbors.some((nb) => state.buildings[nb])) continue;
      for (const ek of v.edges) {
        if (state.roads[ek] !== undefined) continue;
        const r = applyCommand(board, state, { type: 'PLACE_SETTLEMENT', seat, vertex: vk, edge: ek });
        if (r.ok) {
          state = r.state;
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) throw new Error('摆位失败');
  }
  return { board, state };
}

function setHands(state: GameState, hands: Partial<ResourceCount>[]): GameState {
  const next = structuredClone(state);
  hands.forEach((h, i) => {
    if (!next.players[i]) return;
    next.players[i]!.resources = { ...ZERO, ...h };
  });
  return next;
}

/** 掷出 7（3+4），返回掷完但还没人弃牌的局面 */
function afterSeven(hands: Partial<ResourceCount>[]): { board: Board; state: GameState } {
  const { board, state } = playPhase(hands.length);
  const s = setHands(state, hands);
  const r = applyCommand(board, s, { type: 'ROLL_DICE', seat: 0, dice: [3, 4] });
  if (!r.ok) throw new Error('掷骰失败');
  return { board, state: r.state };
}

describe('弃牌信息', () => {
  it('没有弃牌锁时是 null', () => {
    const { board, state } = playPhase(2);
    expect(discardInfo(viewFor(board, state, 0))).toBeNull();
  });

  it('轮到我自己时 need 是我的张数，其他人进 waiting', () => {
    const { board, state } = afterSeven([{ wood: 5, brick: 4 }, { brick: 8 }]);
    const info = discardInfo(viewFor(board, state, 0))!;

    expect(info.mine).toBe(true);
    expect(info.need).toBe(5);
    expect(info.waiting).toEqual([{ seat: 1, count: 4 }]);
    expect(info.total).toBe(2);
  });

  it('别人要弃时 mine 为 false、need 为 0，但 waiting 里看得见他', () => {
    const { board, state } = afterSeven([{ wood: 2 }, { brick: 9 }]);
    const info = discardInfo(viewFor(board, state, 0))!;

    expect(info.mine).toBe(false);
    expect(info.need).toBe(0);
    expect(info.waiting).toEqual([{ seat: 1, count: 5 }]);
  });

  it('三人都要弃时 waiting 列出另外两个', () => {
    const { board, state } = afterSeven([{ wood: 9 }, { brick: 9 }, { sheep: 9 }]);
    const info = discardInfo(viewFor(board, state, 2))!;
    expect(info.mine).toBe(true);
    expect(info.need).toBe(5);
    expect(info.waiting.map((w) => w.seat)).toEqual([0, 1]);
  });
});

describe('牌单组合', () => {
  const hand: ResourceCount = { wood: 5, brick: 3, sheep: 0, wheat: 1, ore: 0 };

  it('初始为空，已选 0 张', () => {
    const pick = emptyPick();
    expect(pickedTotal(pick)).toBe(0);
    expect(pickRemaining(pick, 5)).toBe(5);
  });

  it('数量不足或超出都不能确认', () => {
    expect(canConfirm({ wood: 4 }, 5, hand)).toBe(false);
    expect(canConfirm({ wood: 5, brick: 1 }, 5, hand)).toBe(false);
    expect(canConfirm({ wood: 3, brick: 2 }, 5, hand)).toBe(true);
  });

  it('选的比手里多的组合不算数', () => {
    expect(canConfirm({ wheat: 2, wood: 3 }, 5, hand)).toBe(false);
  });

  it('need 为 0 时永远不能确认', () => {
    expect(canConfirm(emptyPick(), 0, hand)).toBe(false);
  });

  it('加牌不会超过持有量', () => {
    let pick = emptyPick();
    for (let i = 0; i < 9; i++) pick = adjustPick(pick, 'brick', 1, hand, 99);
    expect(pick.brick).toBe(3);
  });

  it('加牌不会让总数超过 need', () => {
    let pick = adjustPick(emptyPick(), 'wood', 1, hand, 1);
    pick = adjustPick(pick, 'brick', 1, hand, 1);
    expect(pickedTotal(pick)).toBe(1);
  });

  it('减到 0 的键会被删掉，不留 0 值', () => {
    let pick = adjustPick(emptyPick(), 'wood', 1, hand, 5);
    pick = adjustPick(pick, 'wood', -1, hand, 5);
    expect(Object.keys(pick)).toHaveLength(0);
  });

  it('减不到负数', () => {
    expect(adjustPick(emptyPick(), 'wood', -1, hand, 5).wood).toBeUndefined();
  });

  it('调整不会改动传入的牌单（纯函数）', () => {
    const base = { wood: 2 };
    adjustPick(base, 'brick', 1, hand, 5);
    expect(base).toEqual({ wood: 2 });
  });
});

describe('产出地块高亮', () => {
  it('只亮点数相同且没有强盗的地块', () => {
    const { board, state } = playPhase(2);
    const view = viewFor(board, state, 0);
    const sum = view.tiles.find((t) => t.number !== null && !t.hasRobber)!.number!;
    const keys = productionTiles(view, sum);

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const tile = view.tiles.find((t) => t.key === key)!;
      expect(tile.number).toBe(sum);
      expect(tile.hasRobber).toBe(false);
    }
    // 与其点数不同的地块一个都不能亮
    expect(view.tiles.filter((t) => t.number === sum && !t.hasRobber)).toHaveLength(keys.length);
  });

  it('掷出 7 不亮任何地块', () => {
    const { board, state } = playPhase(2);
    expect(productionTiles(viewFor(board, state, 0), 7)).toEqual([]);
  });

  it('点数越界一律不亮', () => {
    const { board, state } = playPhase(2);
    const view = viewFor(board, state, 0);
    for (const bad of [0, 1, 13, 99, -3]) expect(productionTiles(view, bad)).toEqual([]);
  });

  it('强盗所在地块被排除', () => {
    const { board, state } = playPhase(2);
    const s = structuredClone(state);
    const target = s.tiles[s.robberTile]!;
    // 找一个有点数的地块，把强盗挪上去，再用它的点数查高亮
    const withNumber = Object.entries(s.tiles).find(([, t]) => t.number !== null && t.number !== 7);
    if (!withNumber) return;
    const [key, tile] = withNumber;
    s.robberTile = key;
    const keys = productionTiles(viewFor(board, s, 0), tile.number!);
    expect(keys).not.toContain(key);
    expect(target).toBeTruthy();
  });

  it('还没掷骰时没有高亮', () => {
    const { board, state } = playPhase(2);
    expect(rollHighlight(viewFor(board, state, 0))).toEqual([]);
  });

  it('掷完之后的高亮与点数一致', () => {
    const { board, state } = afterSeven([{ wood: 2 }, { wood: 2 }]);
    const view = viewFor(board, state, 0);
    expect(rollHighlight(view)).toEqual([]);

    const { board: b2, state: s2 } = playPhase(2);
    const r = applyCommand(b2, s2, { type: 'ROLL_DICE', seat: 0, dice: [5, 4] });
    if (!r.ok) throw new Error('掷骰失败');
    expect(rollHighlight(viewFor(b2, r.state, 0))).toEqual(productionTiles(viewFor(b2, r.state, 0), 9));
  });
});

describe('界面凑出来的牌单，引擎必须真的接受（防止前端骗人）', () => {
  it('提示可确认的牌单，引擎都接受', () => {
    const { board, state } = afterSeven([
      { wood: 4, brick: 3, sheep: 2 },
      { wood: 1 },
    ]);
    const view = viewFor(board, state, 0);
    const info = discardInfo(view)!;
    expect(info.need).toBe(5);

    // 用界面上的「加一张」把牌单凑满，再逐张喂给引擎
    let pick = emptyPick();
    for (const res of DISCARD_ORDER) {
      const held = view.me.resources[res] ?? 0;
      // 上界取持有量，避开「额度用尽后 adjustPick 不再增长」导致的死循环
      for (let i = 0; i < held; i++) {
        if (pickedTotal(pick) >= info.need) break;
        pick = adjustPick(pick, res, 1, view.me.resources, info.need);
      }
    }
    expect(pickedTotal(pick)).toBe(info.need);
    expect(canConfirm(pick, info.need, view.me.resources)).toBe(true);

    const r = applyCommand(board, state, { type: 'DISCARD', seat: 0, resources: pick });
    expect(r.ok).toBe(true);
  });

  it('凑不满时引擎同样会拒绝，界面不该允许点确认', () => {
    const { board, state } = afterSeven([{ wood: 4, brick: 3, sheep: 2 }, {}]);
    const view = viewFor(board, state, 0);
    const info = discardInfo(view)!;

    const short = { wood: 2 };
    expect(canConfirm(short, info.need, view.me.resources)).toBe(false);

    const r = applyCommand(board, state, { type: 'DISCARD', seat: 0, resources: short });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('WRONG_DISCARD_COUNT');
  });

  it('每人弃完后弃牌锁真正解除（所有人都弃完才能继续）', () => {
    const { board, state: base } = playPhase(2);
    let state = setHands(base, [{ wood: 9 }, { brick: 8 }]);
    const roll = applyCommand(board, state, { type: 'ROLL_DICE', seat: 0, dice: [1, 6] });
    if (!roll.ok) throw new Error('掷骰失败');
    state = roll.state;

    // 我是 0 号，先弃 5 张；此时 1 号还欠 4 张，回合结束必须被挡
    const mine = viewFor(board, state, 0);
    const myInfo = discardInfo(mine)!;
    expect(myInfo.need).toBe(5);

    const d0 = applyCommand(board, state, {
      type: 'DISCARD', seat: 0, resources: { wood: myInfo.need },
    });
    expect(d0.ok).toBe(true);
    if (!d0.ok) return;

    const blocked = applyCommand(board, d0.state, { type: 'END_TURN', seat: 0 });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('DISCARD_PENDING');

    const other = discardInfo(viewFor(board, d0.state, 1))!;
    expect(other.mine).toBe(true);
    expect(other.need).toBe(4);

    const d1 = applyCommand(board, d0.state, {
      type: 'DISCARD', seat: 1, resources: { brick: other.need },
    });
    expect(d1.ok).toBe(true);
    if (!d1.ok) return;

    expect(discardInfo(viewFor(board, d1.state, 0))).toBeNull();
    // 弃牌锁确实解除了，但掷 7 的结算还差最后一步：挪强盗（R-42）
    expect(viewFor(board, d1.state, 0).pendingRobber).toBe(true);
    const end = applyCommand(board, d1.state, { type: 'END_TURN', seat: 0 });
    expect(end.ok).toBe(false);
    if (!end.ok) expect(end.reason).toBe('ROBBER_PENDING');

    const tile = board.geo.tileKeys.find((k) => k !== d1.state.robberTile)!;
    const moved = applyCommand(board, d1.state, { type: 'MOVE_ROBBER', seat: 0, tile });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.state.pendingRobber).toBe(false);
    expect(applyCommand(board, moved.state, { type: 'END_TURN', seat: 0 }).ok).toBe(true);
  });
});
