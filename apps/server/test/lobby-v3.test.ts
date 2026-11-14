/**
 * 文档 23 L-1/L-2/L-4：房间人数、房主权限、准备、手动开始、地图快照、排序、计时与代放。
 * 全部使用可控时钟，不真实等待 180 秒。
 */

import { describe, expect, it } from 'vitest';
import { buildBoard, MAP_4P, setupSeatOrder } from '@hexfront/engine';
import {
  HOST_GRACE_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  SETUP_STEP_MS,
  type ServerMessage,
} from '../src/protocol.js';
import { Room, recommendedBoard } from '../src/room.js';
import { FakeSocket, driveSetup, findSetupSpot, FIXTURE_ROOM_OPTIONS } from './helpers.js';

type LobbyConfigMsg = Extract<ServerMessage, { t: 'LOBBY_CONFIG' }>;
type TimerMsg = Extract<ServerMessage, { t: 'SETUP_TIMER' }>;
type AutoMsg = Extract<ServerMessage, { t: 'SETUP_AUTO_PLACED' }>;
type LobbyMsg = Extract<ServerMessage, { t: 'LOBBY' }>;

function lastOf<T extends ServerMessage['t']>(s: FakeSocket, t: T): Extract<ServerMessage, { t: T }> | undefined {
  return s.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t).at(-1);
}

/** 产品式房间：4–8 人、不自动开局、必须准备 */
function productRoom(opts: { capacity?: number; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: 1_000_000 };
  const room = new Room('p', {
    capacity: opts.capacity ?? MIN_PLAYERS,
    now: () => clock.t,
  });
  const sockets: FakeSocket[] = [];
  const names = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
  return {
    room, sockets, clock,
    join(n = 1) {
      for (let i = 0; i < n; i++) {
        const s = new FakeSocket(names[sockets.length]!);
        sockets.push(s);
        expect(room.join(names[sockets.length - 1]!, s).ok).toBe(true);
      }
    },
    version: () => room.lobbyConfig().configVersion,
  };
}

describe('人数与地图推荐（L-0 E / L-3）', () => {
  it('推荐规则：4–5 人标准盘，6–8 人扩展盘', () => {
    expect(recommendedBoard(4)).toBe('base');
    expect(recommendedBoard(5)).toBe('base');
    expect(recommendedBoard(6)).toBe('ext');
    expect(recommendedBoard(7)).toBe('ext');
    expect(recommendedBoard(8)).toBe('ext');
  });

  it('房主开局前设定目标人数 4–8；非法值被拒绝', () => {
    const p = productRoom();
    p.join(4);
    expect(p.room.lobbyConfig().targetPlayers).toBe(4);
    expect(p.room.configure(0, { targetPlayers: 8 }, p.version()).ok).toBe(true);
    expect(p.room.lobbyConfig().targetPlayers).toBe(8);
    expect(p.room.configure(0, { targetPlayers: 3 }, p.version())).toEqual({ ok: false, reason: 'BAD_PLAYER_COUNT' });
    expect(p.room.configure(0, { targetPlayers: 9 }, p.version())).toEqual({ ok: false, reason: 'BAD_PLAYER_COUNT' });
    expect(MAX_PLAYERS).toBe(8);
    expect(MIN_PLAYERS).toBe(4);
  });

  it('不能把目标人数降到少于已入座人数（不静默踢人）', () => {
    const p = productRoom({ capacity: 6 });
    p.join(5);
    expect(p.room.configure(0, { targetPlayers: 4 }, p.version())).toEqual({ ok: false, reason: 'BAD_PLAYER_COUNT' });
    expect(p.room.playerCount).toBe(5);
  });

  it('人数变化在 auto 模式下按推荐换盘，手动改选标记 custom', () => {
    const p = productRoom();
    p.join(4);
    expect(p.room.lobbyConfig().board).toBe('base');
    expect(p.room.configure(0, { targetPlayers: 6 }, p.version()).ok).toBe(true);
    expect(p.room.lobbyConfig().board).toBe('ext');
    expect(p.room.lobbyConfig().recommendedBoard).toBe('ext');
    expect(p.room.configure(0, { board: 'base' }, p.version()).ok).toBe(true);
    expect(p.room.lobbyConfig().boardChoice).toBe('manual');
    expect(p.room.lobbyConfig().board).toBe('base');
  });
});

describe('房主权限（L-1）', () => {
  it('首位创建者成为房主；非房主改配置/排序/重抽/开始均被拒绝', () => {
    const p = productRoom();
    p.join(4);
    const v = p.version();
    expect(p.room.lobbyConfig().hostSeat).toBe(0);
    expect(p.room.configure(1, { targetPlayers: 5 }, v)).toEqual({ ok: false, reason: 'NOT_HOST' });
    expect(p.room.rerollMap(1, v)).toEqual({ ok: false, reason: 'NOT_HOST' });
    expect(p.room.setOrder(1, [1, 0, 2, 3], v)).toEqual({ ok: false, reason: 'NOT_HOST' });
    expect(p.room.randomizeOrder(1, v)).toEqual({ ok: false, reason: 'NOT_HOST' });
    expect(p.room.start(1, v)).toEqual({ ok: false, reason: 'NOT_HOST' });
    expect(p.room.setSettings({ setupGrant: false }, 1)).toBe(false);
  });

  it('房主断线保留身份与开始锁定；60 秒后移交给最早入房且在线者', () => {
    const p = productRoom();
    p.join(4);
    p.room.setReady(0, true);
    p.room.setReady(1, true);
    p.room.setReady(2, true);
    p.room.setReady(3, true);
    expect(p.room.lobbyConfig().canStart).toBe(true);

    p.room.leave(0); // 房主断线
    expect(p.room.lobbyConfig().hostSeat).toBe(0);      // 宽限期内保留
    expect(p.room.lobbyConfig().canStart).toBe(false);  // 开始锁定（有人离线）
    p.clock.t += HOST_GRACE_MS - 1;
    p.room.advanceClock();
    expect(p.room.lobbyConfig().hostSeat).toBe(0);
    p.clock.t += 2;
    p.room.advanceClock();
    expect(p.room.lobbyConfig().hostSeat).toBe(1);      // 移交给最早入房且在线者
    expect(p.room.lobbyConfig().canStart).toBe(false);  // 仍因离线不可开始
  });

  it('原房主重连不夺回已移交的权限', () => {
    const p = productRoom();
    p.join(4);
    p.room.leave(0);
    p.clock.t += HOST_GRACE_MS + 1;
    p.room.advanceClock();
    expect(p.room.lobbyConfig().hostSeat).toBe(1);
    p.room.reconnect(0, new FakeSocket('back'));
    expect(p.room.lobbyConfig().hostSeat).toBe(1);
  });
});

describe('准备与手动开始（L-1，取消满员自动开局）', () => {
  it('最后一人加入不自动开局；全员准备后房主点击开始', () => {
    const p = productRoom();
    p.join(4);
    expect(p.room.started).toBe(false);               // 满员也不自动开局
    expect(p.room.lobbyConfig().canStart).toBe(false);
    expect(p.room.start(0, p.version())).toEqual({ ok: false, reason: 'NOT_ALL_READY' });

    for (let s = 0; s < 4; s++) expect(p.room.setReady(s, true).ok).toBe(true);
    expect(p.room.lobbyConfig().canStart).toBe(true);
    expect(p.room.start(0, p.version()).ok).toBe(true);
    expect(p.room.started).toBe(true);
    expect(p.room.game!.phase).toBe('setup');
  });

  it('配置变化清空全员准备，昵称/在线更新不清准备', () => {
    const p = productRoom();
    p.join(4);
    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    expect(p.room.lobbyConfig().ready).toEqual([true, true, true, true]);

    p.room.configure(0, { targetPlayers: 5 }, p.version());
    expect(p.room.lobbyConfig().ready.every((r) => r === false)).toBe(true);
    expect(p.room.lobbyConfig().configVersion).toBeGreaterThan(1);

    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    p.room.leave(3);                                  // 在线状态变化
    expect(p.room.lobbyConfig().ready[3]).toBe(true); // 不无故清准备
    p.room.reconnect(3, p.sockets[3]!);
    expect(p.room.lobbyConfig().ready[3]).toBe(true);
  });

  it('重复开始被拒绝；并发旧版本 START 被拒绝', () => {
    const p = productRoom();
    p.join(4);
    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    const v = p.version();
    expect(p.room.start(0, v).ok).toBe(true);
    // Room 层用 StartResult 的 ALREADY_STARTED；server.ts 映射成 REJECT 的 GAME_ALREADY_STARTED
    expect(p.room.start(0, v)).toEqual({ ok: false, reason: 'ALREADY_STARTED' });
    expect(p.room.start(0, v - 1)).toEqual({ ok: false, reason: 'ALREADY_STARTED' });
  });

  it('配置版本不一致的 START 被拒绝（原子锁定）', () => {
    const p = productRoom();
    p.join(4);
    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    const stale = p.version();
    p.room.rerollMap(0, stale);                       // 配置变更，版本 +1、清准备
    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    expect(p.room.start(0, stale)).toEqual({ ok: false, reason: 'CONFIG_VERSION_MISMATCH' });
    expect(p.room.start(0, p.version()).ok).toBe(true);
  });

  it('已开始不能加人、改配置、重排、重抽地图', () => {
    const p = productRoom();
    p.join(4);
    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    p.room.start(0, p.version());
    expect(p.room.join('壬', new FakeSocket())).toEqual({ ok: false, reason: 'IN_PROGRESS' });
    expect(p.room.configure(0, { targetPlayers: 5 }, p.version())).toEqual({ ok: false, reason: 'GAME_ALREADY_STARTED' });
    expect(p.room.rerollMap(0, p.version())).toEqual({ ok: false, reason: 'GAME_ALREADY_STARTED' });
    expect(p.room.setOrder(0, [1, 0, 2, 3], p.version())).toEqual({ ok: false, reason: 'GAME_ALREADY_STARTED' });
    expect(p.room.randomizeOrder(0, p.version())).toEqual({ ok: false, reason: 'GAME_ALREADY_STARTED' });
  });
});

describe('地图快照与一致性（L-2）', () => {
  it('WELCOME/LOBBY 带同一份地图快照；重抽后版本与操作者可见', () => {
    const p = productRoom();
    p.join(4);
    p.room.sync();
    const lobby = lastOf(p.sockets[0]!, 'LOBBY') as LobbyMsg | undefined;
    expect(lobby?.map).toBeDefined();
    expect(lobby?.map.tiles.length).toBe(19);
    expect(lobby?.map.seed).not.toBe('');

    const before = lobby!.map.seed;
    const v = p.version();
    p.room.rerollMap(0, v);
    const cfg = lastOf(p.sockets[0]!, 'LOBBY_CONFIG') as LobbyConfigMsg | undefined;
    expect(cfg?.changedBy).toBe(0);
    expect(cfg?.reason).toBe('REROLL_MAP');
    expect(cfg?.map.boardVersion).toBeGreaterThan(lobby!.map.boardVersion);
    // 全员看到同一份预览
    for (const s of p.sockets) {
      const c = lastOf(s, 'LOBBY_CONFIG') as LobbyConfigMsg | undefined;
      expect(c?.map).toEqual(cfg?.map);
    }
    void before;
  });

  it('扩展盘快照有 30 格、2 沙漠、11 港，强盗在沙漠', () => {
    const room = new Room('ext', { capacity: 6 });
    const map = room.map;
    expect(map.kind).toBe('ext');
    expect(map.rows).toEqual([3, 4, 5, 6, 5, 4, 3]);
    expect(map.tiles).toHaveLength(30);
    expect(map.tiles.filter((t) => t.terrain === 'desert')).toHaveLength(2);
    expect(map.ports).toHaveLength(11);
    expect(map.tiles.find((t) => t.key === map.robberTile)?.terrain).toBe('desert');
  });

  it('地图种子不为空且与骰子随机源无关（生成器只用 seed 造地图）', () => {
    const a = new Room('seed-a', { capacity: 4, seed: 'fixed-seed' });
    const b = new Room('seed-b', { capacity: 4, seed: 'fixed-seed' });
    expect(a.map.seed).toBe(b.map.seed);
    expect(a.map.tiles).toEqual(b.map.tiles);
    expect(a.map.ports).toEqual(b.map.ports);
    expect(a.map.robberTile).toBe(b.map.robberTile);
  });
});

describe('排序与身份隔离（L-4）', () => {
  it('手动/随机排序生成合法排列；开局后锁进 GameState.actionOrder', () => {
    const p = productRoom();
    p.join(4);
    expect(p.room.setOrder(0, [2, 0, 3, 1], p.version()).ok).toBe(true);
    expect(p.room.lobbyConfig().actionOrder).toEqual([2, 0, 3, 1]);
    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    p.room.start(0, p.version());
    expect(p.room.game!.actionOrder).toEqual([2, 0, 3, 1]);
    expect(p.room.game!.setup!.seat).toBe(2);
    expect(p.room.game!.current).toBe(2);
  });

  it('非法排列被拒绝，不改现有顺序', () => {
    const p = productRoom();
    p.join(4);
    const before = p.room.lobbyConfig().actionOrder;
    expect(p.room.setOrder(0, [0, 1, 1, 3], p.version())).toEqual({ ok: false, reason: 'BAD_ORDER' });
    expect(p.room.setOrder(0, [0, 1, 2], p.version())).toEqual({ ok: false, reason: 'BAD_ORDER' });
    expect(p.room.lobbyConfig().actionOrder).toEqual(before);
  });

  it('排序不改玩家身份与私有视图', () => {
    const p = productRoom();
    p.join(4);
    p.room.setOrder(0, [3, 1, 0, 2], p.version());
    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    p.room.start(0, p.version());
    const g = p.room.game!;
    expect(g.players.map((x) => x.name)).toEqual(['甲', '乙', '丙', '丁']);
    expect(g.players.map((x) => x.index)).toEqual([0, 1, 2, 3]);
    // 每个 seat 的视图 viewer 与 me.index 一致
    for (let s = 0; s < 4; s++) {
      const v = p.room.viewOf(s)!;
      expect(v.viewer).toBe(s);
      expect(v.me.index).toBe(s);
      expect(v.actionOrder).toEqual([3, 1, 0, 2]);
    }
  });

  it('乱序重连不串座', () => {
    const p = productRoom();
    p.join(4);
    p.room.setOrder(0, [3, 1, 0, 2], p.version());
    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    p.room.start(0, p.version());
    p.room.leave(2);
    const reconnected = p.room.join('丙', new FakeSocket('丙-back'));
    expect(reconnected.ok).toBe(true);
    if (reconnected.ok) expect(reconnected.seat).toBe(2);
    expect(p.room.viewOf(2)!.viewer).toBe(2);
    expect(p.room.viewOf(2)!.me.name).toBe('丙');
  });
});

describe('选地计时与超时合法代放（L-4，指南 §7）', () => {
  /** 4 人产品房，已开局；用可控时钟 */
  function setupRoom() {
    const p = productRoom();
    p.join(4);
    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    p.room.start(0, p.version());
    return p;
  }

  it('每个步骤独立 180 秒，进入新步骤重新起算，上一步剩余不累积', () => {
    const p = setupRoom();
    const t0 = p.clock.t;
    const timer0 = lastOf(p.sockets[0]!, 'SETUP_TIMER') as TimerMsg | undefined;
    expect(timer0).toBeDefined();
    expect(timer0!.timer.deadline - timer0!.timer.startedAt).toBe(SETUP_STEP_MS);
    expect(timer0!.timer.step).toBe(0);

    // 走 100 秒后当前玩家提交，下一步重新获得完整 180 秒
    p.clock.t = t0 + 100_000;
    const seat = p.room.game!.setup!.seat;
    const spot = findSetupSpot(p.room, p.room.game!)!;
    expect(p.room.command(seat, { type: 'PLACE_SETTLEMENT', seat, ...spot }).ok).toBe(true);
    const timer1 = lastOf(p.sockets[0]!, 'SETUP_TIMER') as TimerMsg | undefined;
    expect(timer1!.timer.step).toBe(1);
    expect(timer1!.timer.startedAt).toBe(t0 + 100_000);
    expect(timer1!.timer.deadline - timer1!.timer.startedAt).toBe(SETUP_STEP_MS);
  });

  it('等待别人不消耗自己的时间；轮到自己断线计时继续', () => {
    const p = setupRoom();
    const t0 = p.clock.t;
    p.clock.t = t0 + 179_000;                       // 差 1 秒到期
    expect(p.room.advanceClock()).toBe(false);      // 未超时不代放
    expect(p.room.game!.buildings).toEqual({});
    p.room.leave(p.room.game!.setup!.seat);         // 轮到的人断线
    p.clock.t = t0 + SETUP_STEP_MS;
    expect(p.room.advanceClock()).toBe(true);       // 断线不暂停，照常代放
    expect(Object.keys(p.room.game!.buildings).length).toBe(1);
  });

  it('超时由系统随机合法代放：走同一规则入口，广播原因与结果', () => {
    const p = setupRoom();
    const step = p.room.game!.setup!.step;
    const seat = p.room.game!.setup!.seat;
    const before = Object.keys(p.room.game!.buildings).length;
    p.clock.t += SETUP_STEP_MS;
    expect(p.room.advanceClock()).toBe(true);
    const g = p.room.game!;
    expect(Object.keys(g.buildings).length).toBe(before + 1);
    expect(Object.keys(g.roads).length).toBe(before + 1);
    // 代放的建筑归当前该放的 seat
    expect(Object.values(g.buildings).some((b) => b.owner === seat)).toBe(true);
    const auto = lastOf(p.sockets[0]!, 'SETUP_AUTO_PLACED') as AutoMsg | undefined;
    expect(auto?.reason).toBe('TIMEOUT');
    expect(auto?.seat).toBe(seat);
    expect(auto?.step).toBe(step);
    // 广播的结果与实际状态一致
    expect(g.buildings[auto!.vertex]).toBeDefined();
    expect(g.roads[auto!.edge]).toBe(seat);
  });

  it('超时代放后进入下一步重新计时；末位连续两次各有一份 180 秒', () => {
    const p = setupRoom();
    const order = setupSeatOrder(4);
    for (let i = 0; i < order.length; i++) {
      const step = p.room.game!.setup!.step;
      const seat = p.room.game!.setup!.seat;
      expect(seat).toBe(order[i]);
      const timer = lastOf(p.sockets[0]!, 'SETUP_TIMER') as TimerMsg | undefined;
      expect(timer!.timer.step).toBe(step);
      expect(timer!.timer.deadline - timer!.timer.startedAt).toBe(SETUP_STEP_MS);
      p.clock.t += SETUP_STEP_MS;
      expect(p.room.advanceClock()).toBe(true);
      // 每一步的计时器都是独立的 180 秒预算（不累积、不共享）
      const nextTimer = lastOf(p.sockets[0]!, 'SETUP_TIMER') as TimerMsg | undefined;
      if (p.room.game!.phase === 'setup') {
        expect(nextTimer!.timer.step).toBe(step + 1);
        expect(nextTimer!.timer.deadline - nextTimer!.timer.startedAt).toBe(SETUP_STEP_MS);
      }
    }
    // 末位连续两次放置（order[3]、order[4]）确实是同一个 seat
    expect(order[3]).toBe(order[4]);
    expect(p.room.game!.phase).toBe('play');
    expect(p.room.currentTimer).toBeNull();
    expect(Object.keys(p.room.game!.buildings)).toHaveLength(8);
    expect(Object.keys(p.room.game!.roads)).toHaveLength(8);
  });

  it('deadline 到达后的迟到提交被拒绝，并返回最新状态', () => {
    const p = setupRoom();
    const seat = p.room.game!.setup!.seat;
    const spot = findSetupSpot(p.room, p.room.game!)!;
    p.clock.t += SETUP_STEP_MS + 1;
    const out = p.room.command(seat, { type: 'PLACE_SETTLEMENT', seat, ...spot });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('SETUP_TIMEOUT_REJECTED');
    // 系统已经代放，且只放了一次
    expect(Object.keys(p.room.game!.buildings)).toHaveLength(1);
  });

  it('抢在 deadline 前提交会取消超时任务，不会重复代放', () => {
    const p = setupRoom();
    const seat = p.room.game!.setup!.seat;
    const spot = findSetupSpot(p.room, p.room.game!)!;
    p.clock.t += SETUP_STEP_MS - 1;
    expect(p.room.command(seat, { type: 'PLACE_SETTLEMENT', seat, ...spot }).ok).toBe(true);
    p.clock.t += 1; // 旧 deadline 到了，但步骤已推进
    expect(p.room.advanceClock()).toBe(false);
    expect(Object.keys(p.room.game!.buildings)).toHaveLength(1);
    expect(p.room.currentTimer!.step).toBe(1);
  });

  it('第二次落子规则：代放也按既有 setupGrant 发放资源', () => {
    const p = setupRoom();
    const order = setupSeatOrder(4);
    // 前 4 次（第一轮）用手动提交快速走完，再超时代放第二轮，验证资源发放入口
    for (let i = 0; i < 4; i++) {
      const seat = p.room.game!.setup!.seat;
      const spot = findSetupSpot(p.room, p.room.game!)!;
      p.room.command(seat, { type: 'PLACE_SETTLEMENT', seat, ...spot });
    }
    // 此时进入第二轮；代放一次应触发 RESOURCES_GAINED（setupGrant 默认开）
    const seat = p.room.game!.setup!.seat;
    const before = { ...p.room.game!.players[seat]!.resources };
    p.clock.t += SETUP_STEP_MS;
    p.room.advanceClock();
    const after = p.room.game!.players[seat]!.resources;
    const gained = (['wood', 'brick', 'sheep', 'wheat', 'ore'] as const)
      .some((r) => after[r] > (before[r] ?? 0));
    expect(gained).toBe(true);
    void order;
  });

  it('无合法候选时暂停开局并广播明确错误，不伪造建筑', () => {
    // 用 8 人 + 19 格盘：先手动把棋盘摆到几乎无空位太复杂，
    // 这里直接构造一个「全部顶点不可用」的极端状态来验证兜底路径。
    const p = productRoom();
    p.join(4);
    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    p.room.start(0, p.version());
    const g = p.room.game!;
    // 把所有顶点标记为「被占」，让代放找不到合法点
    for (const vk of p.room.board.geo.vertexKeys) g.buildings[vk] = { owner: 0, city: false };
    p.clock.t += SETUP_STEP_MS;
    expect(p.room.advanceClock()).toBe(false);
    const rejects = p.sockets[0]!.rejects.filter((r) => r.reason === 'NO_LEGAL_PLACEMENT');
    expect(rejects.length).toBeGreaterThan(0);
    expect(p.room.currentTimer).toBeNull(); // 暂停，不再空转
  });
});

describe('夹具边界（文档 23 L-1 明确保留）', () => {
  it('产品默认 4 人、不自动开局、需要准备；夹具开关只影响测试', () => {
    const p = productRoom();
    p.join(2);
    expect(p.room.started).toBe(false);
    expect(p.room.start(0, p.version()).ok).toBe(false);
    const fixture = new Room('f', { ...FIXTURE_ROOM_OPTIONS, capacity: 2 });
    fixture.join('甲', new FakeSocket());
    fixture.join('乙', new FakeSocket());
    expect(fixture.started).toBe(true); // 仅夹具满员自动开局；产品默认值未放宽
  });
});
