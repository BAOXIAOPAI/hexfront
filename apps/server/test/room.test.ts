import { describe, expect, it } from 'vitest';
import { buildBoard, MAP_4P } from '@hexfront/engine';
import { Room, RoomRegistry, normalizeRoomId } from '../src/room.js';
import { FakeSocket, driveSetup, FIXTURE_ROOM_OPTIONS } from './helpers.js';
import type { ServerMessage } from '../src/protocol.js';

// 验收需要可复现的骰子；真实环境默认关闭（见 room.command 里的剥离逻辑）
process.env.HEXFONT_FAKE_DICE = '1';

function twoSeatRoom(): { room: Room; a: FakeSocket; b: FakeSocket } {
  // 固定棋盘：旧交易/视角断言依赖确定性资源发放，不受随机地图影响
  const room = new Room('r1', {
    ...FIXTURE_ROOM_OPTIONS, capacity: 2, board: buildBoard(MAP_4P),
  });
  const a = new FakeSocket('a');
  const b = new FakeSocket('b');
  expect(room.join('阿甲', a).ok).toBe(true);
  expect(room.join('阿乙', b).ok).toBe(true);
  return { room, a, b };
}

describe('骰子不可由客户端指定', () => {
  it('关闭验收开关后，客户端传的 dice 会被剥离', () => {
    const prev = process.env.HEXFONT_FAKE_DICE;
    delete process.env.HEXFONT_FAKE_DICE;
    try {
      const { room } = twoSeatRoom();
      // 两人房满员即自动开局，无需再 start
      driveSetup(room);

      const rolls: number[][] = [];
      for (let i = 0; i < 5; i++) {
        const v = room.viewOf(0)!;
        room.command(v.current, { type: 'ROLL_DICE', seat: v.current, dice: [1, 1] } as never);
        const rolled = room.viewOf(0)!;
        expect(rolled.dice).not.toBeNull();
        rolls.push(rolled.dice!);
        room.command(rolled.current, { type: 'END_TURN', seat: rolled.current } as never);
      }

      // 五次全被抓到是 [1,1] 的概率 (1/36)^5，可忽略
      expect(rolls.some((d) => d[0] !== 1 || d[1] !== 1)).toBe(true);
    } finally {
      process.env.HEXFONT_FAKE_DICE = prev;
    }
  });
});

describe('交易报价（阶段 C：ID + 快照）', () => {
  function ready(): { room: Room; a: FakeSocket; b: FakeSocket } {
    const { room, a, b } = twoSeatRoom();
    driveSetup(room);
    const g = room.game!;
    g.players[0]!.resources.wood = 3;
    g.players[1]!.resources.wheat = 2;
    return { room, a, b };
  }
  function idOf(outcome: { ok: boolean; offerId?: string }): string {
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.offerId) throw new Error('报价未创建');
    return outcome.offerId;
  }

  it('挂出报价后双方都收到 OFFERS 快照', () => {
    const { room, a, b } = ready();
    a.clear();
    b.clear();

    const id = idOf(room.makeOffer(0, 1, { wood: 2 }, { wheat: 1 }));
    for (const s of [a, b]) {
      const msg = s.sent.find((m) => m.t === 'OFFERS');
      expect(msg).toMatchObject({ t: 'OFFERS', reason: 'CREATED', offerId: id });
    }
    expect(room.offerSnapshot.offers[0]).toMatchObject({
      id, from: 0, to: 1, give: { wood: 2 }, get: { wheat: 1 },
    });
  });

  it('被报价方按 ID 接受后执行交易', () => {
    const { room } = ready();
    const id = idOf(room.makeOffer(0, 1, { wood: 2 }, { wheat: 1 }));

    expect(room.acceptOffer(1, id).ok).toBe(true);
    expect(room.game!.players[0]!.resources.wood).toBe(1);
    expect(room.game!.players[0]!.resources.wheat).toBe(1);
    expect(room.game!.players[1]!.resources.wood).toBe(2);
    expect(room.offerSnapshot.offers).toHaveLength(0);
  });

  it('发起方不能替对方接受，且旧 ID 不能再被处理', () => {
    const { room } = ready();
    const id = idOf(room.makeOffer(0, 1, { wood: 2 }, { wheat: 1 }));
    const out = room.acceptOffer(0, id);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('OFFER_NOT_FOR_YOU');
    expect(room.offerSnapshot.offers).toHaveLength(1);
  });

  it('拒绝与撤回都按 ID 生效', () => {
    const { room } = ready();
    const id = idOf(room.makeOffer(0, 1, { wood: 2 }, { wheat: 1 }));
    expect(room.rejectOffer(1, id).ok).toBe(true);
    expect(room.offerSnapshot.offers).toHaveLength(0);

    const id2 = idOf(room.makeOffer(1, 0, { wheat: 1 }, { wood: 1 }));
    expect(room.cancelOffer(1, id2).ok).toBe(true);
    expect(room.offerSnapshot.offers).toHaveLength(0);
  });

  it('资源不够时接受被拒，报价仍留着', () => {
    const { room } = ready();
    const id = idOf(room.makeOffer(0, 1, { wood: 99 }, {}));
    const out = room.acceptOffer(1, id);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('INSUFFICIENT_RESOURCES');
    expect(room.offerSnapshot.offers).toHaveLength(1);
  });

  it('零对价合法（赠予牌）', () => {
    const { room } = ready();
    const id = idOf(room.makeOffer(0, 1, { wood: 3 }, {}));
    expect(room.acceptOffer(1, id).ok).toBe(true);
    expect(room.game!.players[0]!.resources.wood).toBe(0);
    expect(room.game!.players[1]!.resources.wood).toBe(3);
  });

  it('清洗非法资源字段，全空则拒绝建价', () => {
    const { room } = ready();
    const out = room.makeOffer(0, 1, { wood: -5, gold: 3 } as never, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('BAD_OFFER');
    expect(room.offerSnapshot.offers).toHaveLength(0);
  });

  it('不能和自己交易', () => {
    const { room } = ready();
    expect(room.makeOffer(0, 0, { wood: 1 }, {}).ok).toBe(false);
  });

  it('结束回合后报价作废', () => {
    const { room } = ready();
    idOf(room.makeOffer(0, 1, { wood: 1 }, {}));
    room.command(0, { type: 'ROLL_DICE', seat: 0, dice: [2, 3] });
    expect(room.command(0, { type: 'END_TURN', seat: 0 }).ok).toBe(true);
    expect(room.offerSnapshot.offers).toHaveLength(0);
  });
});

describe('入座', () => {
  it('按顺序分配座位', () => {
    const room = new Room('r', { ...FIXTURE_ROOM_OPTIONS, capacity: 4 });
    const seats = ['甲', '乙', '丙'].map((n) => {
      const r = room.join(n, new FakeSocket(n));
      return r.ok ? r.seat : -1;
    });
    expect(seats).toEqual([0, 1, 2]);
    expect(room.playerCount).toBe(3);
  });

  it('满员后拒绝新玩家', () => {
    // 不自动开局，才能单独验证「房间容量已满」这一分支
    const room = new Room('r', { capacity: 2, minPlayers: 2, skipReadyCheck: true });
    room.join('甲', new FakeSocket());
    room.join('乙', new FakeSocket());
    const third = room.join('丙', new FakeSocket());
    expect(third).toEqual({ ok: false, reason: 'ROOM_FULL' });
  });

  it('满员自动开局', () => {
    const { room } = twoSeatRoom();
    expect(room.started).toBe(true);
    expect(room.game?.players).toHaveLength(2);
    expect(room.game?.phase).toBe('setup');
  });

  it('未满员时房主也不能开始；满员后仍需准备，不自动开局', () => {
    // 文档 23 L-1：取消满员自动开局、必须满目标人数且全员准备。
    // 这里用「不自动开局」的产品式夹具验证这条边界。
    const room = new Room('r', { capacity: 4, minPlayers: 4 });
    room.join('甲', new FakeSocket());
    room.join('乙', new FakeSocket());
    expect(room.started).toBe(false);
    expect(room.start(0, room.lobbyConfig().configVersion)).toEqual({ ok: false, reason: 'NOT_ENOUGH_PLAYERS' });
    expect(room.started).toBe(false);

    room.join('丙', new FakeSocket());
    room.join('丁', new FakeSocket());
    // 满员但没有准备：仍不能开始，也没有自动开局
    expect(room.started).toBe(false);
    expect(room.start(0, room.lobbyConfig().configVersion)).toEqual({ ok: false, reason: 'NOT_ALL_READY' });
    expect(room.started).toBe(false);
  });

  it('少于产品最少人数不允许开局', () => {
    const room = new Room('r', { capacity: 4, minPlayers: 4 });
    room.join('甲', new FakeSocket());
    expect(room.start(0, room.lobbyConfig().configVersion)).toEqual({ ok: false, reason: 'NOT_ENOUGH_PLAYERS' });
  });

  it('同名重连回到原座位', () => {
    const room = new Room('r', { ...FIXTURE_ROOM_OPTIONS, capacity: 4 });
    const a = new FakeSocket();
    expect(room.join('甲', a).ok).toBe(true);
    room.leave(0);
    expect(room.connectedCount).toBe(0);

    const again = room.join('甲', new FakeSocket());
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.seat).toBe(0);
      expect(again.reclaimed).toBe(true);
    }
    expect(room.playerCount).toBe(1);
  });

  it('同名但原座位在线时不允许顶号', () => {
    const room = new Room('r', { ...FIXTURE_ROOM_OPTIONS, capacity: 4 });
    room.join('甲', new FakeSocket('a1'));
    const hijack = room.join('甲', new FakeSocket('a2'));
    expect(hijack).toEqual({ ok: false, reason: 'SEAT_TAKEN' });
  });

  it('断线保留座位，只是标记为离线', () => {
    const { room, a, b } = twoSeatRoom();
    room.leave(1);
    expect(room.playerCount).toBe(2);
    expect(room.lobbyPlayers().find((p) => p.seat === 1)?.connected).toBe(false);
    // 广播只发给还连着的人
    a.clear();
    b.clear();
    room.sync();
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
  });
});

describe('命令裁决', () => {
  it('未开局时拒绝命令', () => {
    const room = new Room('r', { ...FIXTURE_ROOM_OPTIONS, capacity: 4 });
    const a = new FakeSocket();
    room.join('甲', a);
    const out = room.command(0, { type: 'ROLL_DICE', seat: 0, dice: [1, 2] });
    expect(out).toEqual({ ok: false, reason: 'GAME_NOT_STARTED' });
    expect(a.rejects[0]?.reason).toBe('GAME_NOT_STARTED');
  });

  it('座位以连接为准，伪造 seat 无法替别人行动', () => {
    const { room } = twoSeatRoom();
    driveSetup(room);
    expect(room.game?.current).toBe(0);

    // 1 号位伪装成 0 号位掷骰
    const out = room.command(1, { type: 'ROLL_DICE', seat: 0, dice: [3, 4] });
    expect(out).toEqual({ ok: false, reason: 'NOT_YOUR_TURN' });
    expect(room.game?.dice).toBeNull();
  });

  it('非法命令只回给发起人', () => {
    const { room, a, b } = twoSeatRoom();
    driveSetup(room);
    a.clear();
    b.clear();

    room.command(1, { type: 'ROLL_DICE', seat: 1, dice: [1, 1] });
    room.sync();

    expect(a.rejects).toHaveLength(0);
    expect(b.rejects).toHaveLength(1);
  });

  it('合法命令广播给房间内每个人，视角各不相同', () => {
    const { room, a, b } = twoSeatRoom();
    driveSetup(room);
    a.clear();
    b.clear();

    const out = room.command(0, { type: 'ROLL_DICE', seat: 0, dice: [2, 3] });
    expect(out.ok).toBe(true);
    const events = out.ok ? out.events : [];
    room.sync(events);

    expect(a.states).toHaveLength(1);
    expect(b.states).toHaveLength(1);

    const sa = a.lastState!;
    const sb = b.lastState!;
    expect(sa.seq).toBe(sb.seq);
    expect(sa.view.viewer).toBe(0);
    expect(sb.view.viewer).toBe(1);
    expect(sa.view.dice).toEqual([2, 3]);
    expect(sa.view.hasRolled).toBe(true);
    expect(sa.events.some((e) => e.type === 'DICE_ROLLED')).toBe(true);
  });

  it('视角隔离：别人的手牌内容根本不存在', () => {
    const { room, a } = twoSeatRoom();
    driveSetup(room);
    a.clear();
    room.command(0, { type: 'ROLL_DICE', seat: 0, dice: [2, 3] });
    room.sync();

    const view = a.lastState!.view;
    const others = view.players.filter((p) => p.index !== view.viewer);
    expect(others.length).toBeGreaterThan(0);
    for (const p of others) {
      expect(Object.prototype.hasOwnProperty.call(p, 'resources')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(p, 'devCards')).toBe(false);
      expect(typeof p.handSize).toBe('number');
    }
    // 自己的手牌字段存在
    expect(view.me.resources).toBeDefined();
  });

  it('未入座的连接不能发命令', () => {
    const { room } = twoSeatRoom();
    const out = room.command(9, { type: 'END_TURN', seat: 9 });
    expect(out).toEqual({ ok: false, reason: 'NOT_SEATED' });
  });
});

describe('房间号', () => {
  it('规范化大小写与空白', () => {
    expect(normalizeRoomId('  Demo-1 ')).toBe('demo-1');
  });

  it('拒绝非法字符与超长', () => {
    expect(normalizeRoomId('a b')).toBeNull();
    expect(normalizeRoomId('中文房')).toBeNull();
    expect(normalizeRoomId('x'.repeat(25))).toBeNull();
  });

  it('登记表复用同一房间，并限制房间总量', () => {
    const reg = new RoomRegistry({ ...FIXTURE_ROOM_OPTIONS, capacity: 2, maxRooms: 1 });
    const first = reg.getOrCreate('a');
    expect(first).not.toBeNull();
    expect(reg.getOrCreate('a')).toBe(first);
    expect(reg.getOrCreate('b')).toBeNull();
  });
});

describe('广播报文', () => {
  it('未开局推 LOBBY，开局后推 STATE', () => {
    const room = new Room('r', { ...FIXTURE_ROOM_OPTIONS, capacity: 4 });
    const a = new FakeSocket();
    room.join('甲', a);
    room.sync();
    const lobby = a.sent.find((m: ServerMessage) => m.t === 'LOBBY');
    expect(lobby).toBeDefined();

    room.join('乙', new FakeSocket());
    room.join('丙', new FakeSocket());
    room.join('丁', new FakeSocket());
    // 夹具：4 人满员自动开局；产品默认由房主手动开始
    expect(room.started).toBe(true);
    a.clear();
    room.sync();
    expect(a.states).toHaveLength(1);
    expect(a.states[0]!.view.phase).toBe('setup');
  });
});

describe('房间级设置：开局前可改、开局后锁定', () => {
  it('设置被写进 GameState，开局后不可再改', () => {
    const room = new Room('settings', { ...FIXTURE_ROOM_OPTIONS, capacity: 4 });
    const a = new FakeSocket('a');
    const b = new FakeSocket('b');
    expect(room.join('甲', a).ok).toBe(true);
    expect(room.settingsLocked).toBe(false);
    // 文档 23：只有房主能改房间级设置
    expect(room.setSettings({ setupGrant: false }, 0)).toBe(true);
    expect(room.roomSettings.setupGrant).toBe(false);

    expect(room.join('乙', b).ok).toBe(true);
    room.join('丙', new FakeSocket('c'));
    room.join('丁', new FakeSocket('d'));
    expect(room.started).toBe(true); // 夹具满员自动开局
    expect(room.game!.setupGrant).toBe(false);
    expect(room.settingsLocked).toBe(true);
    expect(room.setSettings({ setupGrant: true }, 0)).toBe(false);
    expect(room.roomSettings.setupGrant).toBe(false);
  });

  it('广播把权威设置推给所有在座玩家，locked 随开局变化', () => {
    const room = new Room('settings2', { ...FIXTURE_ROOM_OPTIONS, capacity: 4 });
    const a = new FakeSocket('a');
    const b = new FakeSocket('b');
    room.join('甲', a);
    room.join('乙', b);
    room.setSettings({ setupGrant: false }, 0);
    room.broadcastSettings();
    for (const s of [a, b]) {
      const msg = s.sent.filter((m) => m.t === 'SETTINGS').at(-1);
      expect(msg).toMatchObject({ t: 'SETTINGS', settings: { setupGrant: false }, locked: false });
    }
    room.join('丙', new FakeSocket('c'));
    room.join('丁', new FakeSocket('d'));
    expect(room.started).toBe(true); // 夹具满员自动开局
    a.clear();
    b.clear();
    room.broadcastSettings();
    for (const s of [a, b]) {
      const msg = s.sent.filter((m) => m.t === 'SETTINGS').at(-1);
      expect(msg).toMatchObject({ locked: true });
    }
  });
});
