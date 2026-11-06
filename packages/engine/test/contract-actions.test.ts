/**
 * 重构指南阶段 A：第 8 节「掷 7 → 弃牌 → 强盗」行动矩阵的规则契约。
 *
 * 现状用真实断言固化；目标行为用 it.todo 列出，阶段 C 实现后逐条转成真实断言。
 *
 * ⚠️ 与现有 test/robber.test.ts:106「弃牌清空后，除 MOVE_ROBBER 外一律被锁」冲突：
 * 指南 8.2 已确认，全员弃完后要恢复建造/银行/借港/玩家交易，只继续禁用发展卡与结束回合。
 * 阶段 C 修改 engine.ts:69 的前置锁时，必须同步更新那条旧断言（指南 14.8 允许改旧测试）。
 */

import { describe, expect, it } from 'vitest';
import {
  MAP_4P,
  RESOURCES,
  applyCommand,
  buildBoard,
  createGame,
  discardCount,
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
  while (state.phase === 'setup') {
    const seat = state.setup!.seat;
    let placed = false;
    for (const vk of board.geo.vertexKeys) {
      if (state.buildings[vk]) continue;
      const v = board.geo.vertices[vk]!;
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

function rollSeven(board: Board, state: GameState): GameState {
  const r = applyCommand(board, state, { type: 'ROLL_DICE', seat: 0, dice: [1, 6] });
  if (!r.ok) throw new Error('掷 7 失败');
  return r.state;
}

/** 让所有需要弃牌的人各提交自己选的牌；弃哪几张由玩家决定，这里按资源顺序取够数 */
function finishDiscards(board: Board, state: GameState): GameState {
  let s = state;
  while (Object.keys(s.pendingDiscards).length > 0) {
    const seat = Number(Object.keys(s.pendingDiscards)[0]);
    let left = s.pendingDiscards[seat]!;
    const chosen: Partial<ResourceCount> = {};
    for (const r of RESOURCES) {
      const take = Math.min(s.players[seat]!.resources[r], left);
      if (take > 0) chosen[r] = take;
      left -= take;
      if (left === 0) break;
    }
    const out = applyCommand(board, s, { type: 'DISCARD', seat, resources: chosen });
    if (!out.ok) throw new Error(`弃牌失败: ${out.reason}`);
    s = out.state;
  }
  return s;
}

describe('第 8.1 节：弃牌数量与自选（已实现，作为回归基线）', () => {
  it('8 张起弃一半并向上取整：7→0、8→4、9→5、10→5', () => {
    expect(discardCount(7)).toBe(0);
    expect(discardCount(8)).toBe(4);
    expect(discardCount(9)).toBe(5);
    expect(discardCount(10)).toBe(5);
  });

  it('9 张时由玩家自己选具体弃哪几张，不是系统随机代弃', () => {
    const { board, state } = playPhase();
    const after = rollSeven(board, setHands(state, [{ wood: 9 }]));
    expect(after.pendingDiscards[0]).toBe(5);

    const out = applyCommand(board, after, {
      type: 'DISCARD', seat: 0, resources: { wood: 2, ore: 0, sheep: 0, wheat: 0, brick: 0 },
    });
    expect(out.ok).toBe(false); // 数量不足不能提交
    const exact = applyCommand(board, after, { type: 'DISCARD', seat: 0, resources: { wood: 5 } });
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.state.players[0]!.resources.wood).toBe(4);
  });
});

describe('第 8.2 节行动矩阵：阶段 A 现状固化', () => {
  it('有人尚未弃牌：只允许 DISCARD，其余命令一律 DISCARD_PENDING（与矩阵一致）', () => {
    const { board, state } = playPhase();
    const after = rollSeven(board, setHands(state, [{ wood: 9 }, { brick: 8 }]));
    expect(Object.keys(after.pendingDiscards)).toHaveLength(2);

    const blocked: Command[] = [
      { type: 'BUILD_ROAD', seat: 0, edge: board.geo.edgeKeys[0]! },
      { type: 'TRADE_BANK', seat: 0, give: 'wood', get: 'brick' },
      { type: 'TRADE_PLAYER', seat: 0, withPlayer: 1, give: { wood: 1 }, get: {} },
      { type: 'PORT_TRANSFER', seat: 0, beneficiary: 1, give: 'wood', get: 'brick' },
      { type: 'BUY_DEV_CARD', seat: 0 },
      { type: 'PLAY_KNIGHT', seat: 0, tile: '0,0' },
      { type: 'MOVE_ROBBER', seat: 0, tile: '0,0' },
      { type: 'END_TURN', seat: 0 },
    ];
    for (const cmd of blocked) {
      const r = applyCommand(board, after, cmd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('DISCARD_PENDING');
    }
  });

  it('弃完、强盗待移动：现状是「除 MOVE_ROBBER 外全部锁死」，与指南 8.2 目标矩阵冲突', () => {
    const { board, state } = playPhase();
    const after = finishDiscards(board, rollSeven(board, setHands(state, [{ wood: 9 }])));
    expect(Object.keys(after.pendingDiscards)).toHaveLength(0);
    expect(after.pendingRobber).toBe(true);

    // 指南要求放行：建造 / 银行 / 借港 / 玩家交易
    // 现状：这四条也被 engine.ts:69 的 ROBBER_PENDING 前置锁拦住
    const shouldBeAllowedByGuide: Command[] = [
      { type: 'BUILD_ROAD', seat: 0, edge: board.geo.edgeKeys[0]! },
      { type: 'TRADE_BANK', seat: 0, give: 'wood', get: 'brick' },
      { type: 'PORT_TRANSFER', seat: 0, beneficiary: 1, give: 'wood', get: 'brick' },
      { type: 'TRADE_PLAYER', seat: 0, withPlayer: 1, give: { wood: 1 }, get: {} },
    ];
    for (const cmd of shouldBeAllowedByGuide) {
      const r = applyCommand(board, after, cmd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('ROBBER_PENDING');
    }

    // 指南要求继续禁止：发展卡 / 结束回合（现状一致）
    const shouldStayBlocked: Command[] = [
      { type: 'BUY_DEV_CARD', seat: 0 },
      { type: 'PLAY_KNIGHT', seat: 0, tile: '0,0' },
      { type: 'END_TURN', seat: 0 },
    ];
    for (const cmd of shouldStayBlocked) {
      const r = applyCommand(board, after, cmd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('ROBBER_PENDING');
    }
  });

  it('强盗移动完成后恢复正常，结束回合不再被强盗锁拦住（回归）', () => {
    const { board, state } = playPhase();
    const after = rollSeven(board, setHands(state, [{ wood: 2 }]));
    const tile = board.geo.tileKeys.find((k) => k !== after.robberTile)!;
    const moved = applyCommand(board, after, { type: 'MOVE_ROBBER', seat: 0, tile });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.state.pendingRobber).toBe(false);
    expect(applyCommand(board, moved.state, { type: 'END_TURN', seat: 0 }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 阶段 C 待实现：对应指南 8.2 与 13.2 的验收条目
// ---------------------------------------------------------------------------

describe('第 8.2 节目标矩阵（阶段 C）', () => {
  it.todo('弃完、强盗待移动时放行建造 / 银行 / 借港 / 玩家交易，且服务端与前端一致');
  it.todo('弃完、强盗待移动时服务端仍拒绝发展卡与 END_TURN，不能只靠前端禁用按钮');
  it.todo('同步更新 test/robber.test.ts:106 中「TRADE_BANK 被锁」的断言，保留其余回归保护');
  it.todo('强盗待办可暂时收起去交易/建造再回来处理，结束回合前必须完成强盗结算');
  it.todo('有人尚未弃牌时服务端拒绝创建或接受报价；弃牌构成不泄露给其他玩家');
  it.todo('游戏结束优先于普通面板并清空报价，不用 UI 锁死已结束对局');
});
