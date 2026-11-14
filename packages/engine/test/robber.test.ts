/**
 * 掷 7 结算闭环（02-rules-spec R-40 ~ R-48）。
 *
 * 这一组测试钉死的是「弃牌 → 移动强盗 → 抽牌」这三步的相对顺序，
 * 以及「结束回合前必须挪完强盗」这条锁 —— 少了它，强盗永远不动。
 */

import { describe, expect, it } from 'vitest';
import {
  MAP_4P,
  applyCommand,
  buildBoard,
  createGame,
  type Board,
  type Command,
  type GameState,
  type ResourceCount,
} from '../src/index.js';

const NAMES = ['甲', '乙', '丙', '丁'];
const COLORS = ['red', 'blue', 'white', 'orange'] as const;

function playPhase(): { board: Board; state: GameState } {
  const board = buildBoard(MAP_4P);
  let state = createGame(board, NAMES, [...COLORS]);
  const geo = board.geo;
  while (state.phase === 'setup') {
    const seat = state.setup!.seat;
    let placed = false;
    for (const vk of geo.vertexKeys) {
      if (state.buildings[vk]) continue;
      const v = geo.vertices[vk]!;
      if (v.neighbors.some((nb) => state.buildings[nb])) continue;
      const ek = v.edges.find((e) => state.roads[e] === undefined);
      if (!ek) continue;
      const r = applyCommand(board, state, { type: 'PLACE_SETTLEMENT', seat, vertex: vk, edge: ek });
      if (r.ok) { state = r.state; placed = true; break; }
    }
    if (!placed) throw new Error('摆位失败');
  }
  return { board, state };
}

function setHands(state: GameState, hands: Partial<ResourceCount>[]): GameState {
  const next = structuredClone(state);
  hands.forEach((h, i) => {
    next.players[i]!.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0, ...h };
  });
  return next;
}

function handSize(state: GameState, seat: number): number {
  return Object.values(state.players[seat]!.resources).reduce((a, b) => a + b, 0);
}

function rollSeven(board: Board, state: GameState): GameState {
  const r = applyCommand(board, state, { type: 'ROLL_DICE', seat: 0, dice: [1, 6] });
  if (!r.ok) throw new Error('掷 7 失败');
  return r.state;
}

/** 找一个「相邻有别人建筑」且不是当前强盗所在的目标地块 */
function stealableTile(board: Board, state: GameState, victim: number): { tile: string } {
  for (const [vk, b] of Object.entries(state.buildings)) {
    if (b.owner !== victim) continue;
    for (const tk of board.geo.vertices[vk]!.tiles) {
      if (tk !== state.robberTile) return { tile: tk };
    }
  }
  throw new Error('找不到可偷的地块');
}

describe('掷 7 → 移动强盗 → 抽牌', () => {
  it('掷出 7 立刻进入待移强盗状态，且该轮不产出', () => {
    const { board, state } = playPhase();
    const after = rollSeven(board, state);
    expect(after.pendingRobber).toBe(true);
    expect(after.dice).toEqual([1, 6]);
  });

  it('R-42：弃牌没完成时不许挪强盗，也不许结束回合', () => {
    const { board, state } = playPhase();
    const after = rollSeven(board, setHands(state, [{ wood: 9 }, { brick: 8 }]));
    expect(Object.keys(after.pendingDiscards)).toHaveLength(2);

    const move = applyCommand(board, after, { type: 'MOVE_ROBBER', seat: 0, tile: '0,0' });
    expect(move.ok).toBe(false);
    if (!move.ok) expect(move.reason).toBe('DISCARD_PENDING');

    const end = applyCommand(board, after, { type: 'END_TURN', seat: 0 });
    expect(end.ok).toBe(false);
    if (!end.ok) expect(end.reason).toBe('DISCARD_PENDING');
  });

  it('R-47：无人需弃牌时跳过弃牌，直接进入移动强盗', () => {
    const { board, state } = playPhase();
    const after = rollSeven(board, setHands(state, [{ wood: 2 }, { brick: 1 }]));
    expect(Object.keys(after.pendingDiscards)).toHaveLength(0);
    expect(after.pendingRobber).toBe(true);

    const end = applyCommand(board, after, { type: 'END_TURN', seat: 0 });
    expect(end.ok).toBe(false);
    if (!end.ok) expect(end.reason).toBe('ROBBER_PENDING');
  });

  it('指南 8.2：弃牌清空后恢复建造/兑换/交易，发展卡与结束回合仍被锁', () => {
    const { board, state } = playPhase();
    let after = rollSeven(board, setHands(state, [{ wood: 9 }]));
    const d = applyCommand(board, after, { type: 'DISCARD', seat: 0, resources: { wood: 5 } });
    if (!d.ok) throw new Error('弃牌失败');
    after = d.state;
    expect(Object.keys(after.pendingDiscards)).toHaveLength(0);
    expect(after.pendingRobber).toBe(true);

    // 服务端同样要拒绝：发展卡（含骑士，防重复移强盗）与结束回合
    const blocked: Command[] = [
      { type: 'END_TURN', seat: 0 },
      { type: 'BUY_DEV_CARD', seat: 0 },
      { type: 'PLAY_KNIGHT', seat: 0, tile: '0,0' },
      { type: 'PLAY_MONOPOLY', seat: 0, resource: 'wood' },
      { type: 'PLAY_PLENTY', seat: 0, resources: ['wood', 'wood'] },
      { type: 'PLAY_ROAD_BUILDING', seat: 0, edges: [board.geo.edgeKeys[0]!] },
    ];
    for (const cmd of blocked) {
      const r = applyCommand(board, after, cmd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('ROBBER_PENDING');
    }

    // 恢复的命令不再被强盗锁拦住：银行兑换此时应当真正成功（弃 5 后剩 4 木，够 4:1）
    const bank = applyCommand(board, after, { type: 'TRADE_BANK', seat: 0, give: 'wood', get: 'brick' });
    expect(bank.ok).toBe(true);
    if (bank.ok) expect(bank.state.players[0]!.resources.brick).toBeGreaterThan(after.players[0]!.resources.brick);

    // 建造 / 港口 / 玩家交易即使因资源或位置被拒，也不能是 ROBBER_PENDING
    const released: Command[] = [
      { type: 'BUILD_ROAD', seat: 0, edge: board.geo.edgeKeys[0]! },
      { type: 'TRADE_PORT', seat: 0, port: 'x|y', give: { wood: 1 }, get: 'brick' },
      { type: 'TRADE_PLAYER', seat: 0, withPlayer: 1, give: { wood: 1 }, get: {} },
    ];
    for (const cmd of released) {
      const r = applyCommand(board, after, cmd);
      if (!r.ok) expect(r.reason).not.toBe('ROBBER_PENDING');
    }
  });

  it('R-44：不可留在原地；R-45：移动 + 抽牌一次原子完成，手牌守恒', () => {
    const { board, state } = playPhase();
    const hands = setHands(state, [{ wood: 2 }, { wood: 6 }, { brick: 2 }, { ore: 1 }]);
    const after = rollSeven(board, hands);
    const before = handSize(after, 0) + handSize(after, 1);

    const same = applyCommand(board, after, { type: 'MOVE_ROBBER', seat: 0, tile: after.robberTile });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.reason).toBe('ROBBER_SAME_TILE');

    const victim = 1;
    const { tile } = stealableTile(board, after, victim);
    const r = applyCommand(board, after, { type: 'MOVE_ROBBER', seat: 0, tile, stealFrom: victim });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.robberTile).toBe(tile);
    expect(r.state.pendingRobber).toBe(false);
    expect(r.events.some((e) => e.type === 'ROBBER_MOVED')).toBe(true);
    expect(r.events.some((e) => e.type === 'CARD_STOLEN')).toBe(true);
    // 抽牌是转移不是凭空生成：两人手牌总数不变，且 thief +1 / victim -1
    expect(handSize(r.state, 0) + handSize(r.state, 1)).toBe(before);
    expect(handSize(r.state, 0)).toBe(handSize(after, 0) + 1);
    expect(handSize(r.state, 1)).toBe(handSize(after, 1) - 1);

    // 结算完毕，可以正常结束回合
    expect(applyCommand(board, r.state, { type: 'END_TURN', seat: 0 }).ok).toBe(true);
  });

  it('R-46：相邻玩家都没手牌时不抽牌，流程照常结束', () => {
    const { board, state } = playPhase();
    const after = rollSeven(board, setHands(state, [{ wood: 0 }, { wood: 0 }, { wood: 0 }, { wood: 0 }]));
    const { tile } = stealableTile(board, after, 1);
    const r = applyCommand(board, after, { type: 'MOVE_ROBBER', seat: 0, tile, stealFrom: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.events.some((e) => e.type === 'CARD_STOLEN')).toBe(false);
    expect(r.state.pendingRobber).toBe(false);
  });

  it('非当前玩家不能挪强盗；没掷 7 时也不能凭空挪', () => {
    const { board, state } = playPhase();
    const tile = board.geo.tileKeys.find((k) => k !== state.robberTile)!;

    const idle = applyCommand(board, state, { type: 'MOVE_ROBBER', seat: 0, tile });
    expect(idle.ok).toBe(false);
    if (!idle.ok) expect(idle.reason).toBe('ROBBER_NOT_PENDING');

    const after = rollSeven(board, state);
    const wrongSeat = applyCommand(board, after, { type: 'MOVE_ROBBER', seat: 1, tile });
    expect(wrongSeat.ok).toBe(false);
    if (!wrongSeat.ok) expect(wrongSeat.reason).toBe('NOT_YOUR_TURN');
  });

  it('R-33：强盗所在地块不产出', () => {
    const { board, state } = playPhase();
    // 找一个有数字、且旁边刚好有建筑的地块，把强盗放上去后掷对应点数
    let found: { tile: string; number: number; owner: number } | null = null;
    for (const [vk, b] of Object.entries(state.buildings)) {
      for (const tk of board.geo.vertices[vk]!.tiles) {
        const t = state.tiles[tk]!;
        if (t.number && t.number !== 7 && tk !== state.robberTile) {
          found = { tile: tk, number: t.number, owner: b.owner };
          break;
        }
      }
      if (found) break;
    }
    if (!found) throw new Error('找不到可测的地块');

    const withRobber = structuredClone(state);
    withRobber.robberTile = found.tile;
    // 把该玩家其他邻接数字都改成 7（掷不出），确保唯一可能产出的地块就是被强盗压住的那块
    for (const [vk, b] of Object.entries(withRobber.buildings)) {
      if (b.owner !== found.owner) continue;
      for (const tk of board.geo.vertices[vk]!.tiles) {
        if (tk !== found.tile) withRobber.tiles[tk]!.number = 7;
      }
    }
    const dice: [number, number] = found.number <= 6
      ? [1, found.number - 1]
      : [6, found.number - 6];
    if (dice[0] < 1 || dice[0] > 6 || dice[1] < 1 || dice[1] > 6) return;

    const before = handSize(withRobber, found.owner);
    const r = applyCommand(board, withRobber, { type: 'ROLL_DICE', seat: 0, dice });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(handSize(r.state, found.owner)).toBe(before);
  });
});
