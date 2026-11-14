/**
 * 文档 24 F2：人数 × 棋盘联动、意图拆分、重复保存不洗图、生成失败完整回滚。
 *
 * 覆盖任务书 §4 验收清单（新建 6/7/8、4→6、5→8、8→4、手选地图、重复保存、
 * 非房主越权、生成失败回滚、多人同步、跨人数可完成性）。
 */
import { describe, expect, it } from 'vitest';
import type { MapSnapshot } from '../src/protocol.js';
import { Room } from '../src/room.js';
import { FakeSocket } from './helpers.js';

function room(capacity = 4) {
  const r = new Room('f2', { capacity, now: () => 1_000_000 });
  const sockets: FakeSocket[] = [];
  const names = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
  return {
    room: r,
    sockets,
    join(n: number) {
      for (let i = 0; i < n; i++) {
        const s = new FakeSocket(names[sockets.length]!);
        sockets.push(s);
        expect(r.join(names[sockets.length - 1]!, s).ok).toBe(true);
      }
    },
    version: () => r.lobbyConfig().configVersion,
    cfg: () => r.lobbyConfig(),
    map: () => r.map,
  };
}

/** 每个 socket 最近一次 LOBBY_CONFIG 的 lobby/map 都一致 */
function everyoneSeesSame(p: ReturnType<typeof room>): boolean {
  const cfgs = p.sockets.map((s) => s.sent.filter((m) => m.t === 'LOBBY_CONFIG').at(-1))
    .filter((m): m is Extract<typeof m, { t: 'LOBBY_CONFIG' }> => !!m && m.t === 'LOBBY_CONFIG');
  if (cfgs.length !== p.sockets.length) return false;
  const first = JSON.stringify({ lobby: cfgs[0]!.lobby, map: cfgs[0]!.map });
  return cfgs.every((c) => JSON.stringify({ lobby: c.lobby, map: c.map }) === first);
}

describe('F2 · 人数改变先应用推荐地图', () => {
  it('新建 6/7/8 人房间默认扩展盘；4/5 人默认标准盘', () => {
    for (const n of [4, 5]) expect(room(n).cfg().board).toBe('base');
    for (const n of [6, 7, 8]) expect(room(n).cfg().board).toBe('ext');
  });

  it('4→6、5→8、8→4 都按推荐换盘，且配置与实际棋盘快照一致', () => {
    for (const [from, to, expectKind] of [[4, 6, 'ext'], [5, 8, 'ext'], [8, 4, 'base']] as const) {
      const p = room(from);
      p.join(1);   // 房主入座（applyPlayerCount 要求 host）
      expect(p.cfg().board).toBe(from <= 5 ? 'base' : 'ext');
      const out = p.room.applyPlayerCount(0, to, p.version());
      expect(out.ok).toBe(true);
      expect(p.cfg().board).toBe(expectKind);
      expect(p.cfg().recommendedBoard).toBe(expectKind);
      expect(p.map().kind).toBe(expectKind);
      expect(p.map().tiles).toHaveLength(expectKind === 'ext' ? 30 : 19);
      expect(p.cfg().boardChoice).toBe('auto');   // 人数变化重置为 auto
      expect(p.cfg().configVersion).toBeGreaterThan(1);
    }
  });

  it('同一份 map 快照随 LOBBY_CONFIG 广播给全员（多人同步）', () => {
    const p = room(4);
    p.join(4);
    expect(p.room.applyPlayerCount(0, 8, p.version()).ok).toBe(true);
    expect(everyoneSeesSame(p)).toBe(true);
    const last = p.sockets[0]!.sent.filter((m) => m.t === 'LOBBY_CONFIG').at(-1)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((last as any).map.kind).toBe('ext');
  });

  it('仅重新提交相同人数：不递增版本、不洗地图、不清准备', () => {
    const p = room(4);
    p.join(4);
    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    const version = p.version();
    const seed = p.map().seed;

    expect(p.room.applyPlayerCount(0, 4, version).ok).toBe(true);
    expect(p.version()).toBe(version);
    expect(p.map().seed).toBe(seed);
    expect(p.cfg().ready.every((r) => r)).toBe(true);
  });

  it('明确手选地图标记 manual；之后人数改变重新应用推荐（保留手动改选权）', () => {
    const p = room(4);
    p.join(4);
    expect(p.room.applyBoard(0, 'ext', p.version()).ok).toBe(true);
    expect(p.cfg().board).toBe('ext');
    expect(p.cfg().boardChoice).toBe('manual');
    expect(p.map().kind).toBe('ext');

    // 人数改到 4（相同人数）在 manual 状态下也不应无故洗图
    const v = p.version(), seed = p.map().seed;
    expect(p.room.applyPlayerCount(0, 4, v).ok).toBe(true);
    expect(p.map().seed).toBe(seed);

    // 人数真的改变（4→6）→ 重新应用推荐 ext，boardChoice 回 auto
    expect(p.room.applyPlayerCount(0, 6, p.version()).ok).toBe(true);
    expect(p.cfg().board).toBe('ext');
    expect(p.cfg().boardChoice).toBe('auto');
  });

  it('非房主越权被拒绝，配置与地图都不变', () => {
    const p = room(4);
    p.join(4);
    const before = { v: p.version(), seed: p.map().seed, board: p.cfg().board };
    expect(p.room.applyPlayerCount(1, 8, p.version())).toMatchObject({ ok: false, reason: 'NOT_HOST' });
    expect(p.room.applyBoard(1, 'ext', p.version())).toMatchObject({ ok: false, reason: 'NOT_HOST' });
    expect({ v: p.version(), seed: p.map().seed, board: p.cfg().board }).toEqual(before);
  });

  it('不能把目标人数降到少于已入座人数；非法人数被拒绝', () => {
    const p = room(6);
    p.join(5);
    expect(p.room.applyPlayerCount(0, 4, p.version())).toMatchObject({ ok: false, reason: 'BAD_PLAYER_COUNT' });
    expect(p.room.applyPlayerCount(0, 9, p.version())).toMatchObject({ ok: false, reason: 'BAD_PLAYER_COUNT' });
    expect(p.cfg().targetPlayers).toBe(6);
  });

  it('配置变化清全员准备', () => {
    const p = room(4);
    p.join(4);
    for (let s = 0; s < 4; s++) p.room.setReady(s, true);
    expect(p.room.applyPlayerCount(0, 6, p.version()).ok).toBe(true);
    expect(p.cfg().ready.every((r) => r === false)).toBe(true);
  });
});

describe('F2 · 地图生成失败完整回滚', () => {
  it('生成失败返回 BOARD_NOT_READY，配置、地图、版本、准备全部保持原样', () => {
    // 构造时注入「后续地图生成失败」的工厂；房间初始地图仍由真实生成器构造。
    const r = new Room('f2-fail', {
      capacity: 4,
      now: () => 1_000_000,
      mapFactory: () => null,
    });
    const s = new FakeSocket('甲');
    expect(r.join('甲', s).ok).toBe(true);
    for (let i = 1; i < 4; i++) expect(r.join(['乙', '丙', '丁'][i - 1]!, new FakeSocket()).ok).toBe(true);
    for (let i = 0; i < 4; i++) r.setReady(i, true);

    const snap = () => ({
      v: r.lobbyConfig().configVersion,
      board: r.lobbyConfig().board,
      target: r.lobbyConfig().targetPlayers,
      choice: r.lobbyConfig().boardChoice,
      mapKind: r.map.kind,
      seed: r.map.seed,
      tiles: r.map.tiles.length,
      ready: r.lobbyConfig().ready.slice(),
    });
    const before = snap();

    const out = r.applyPlayerCount(0, 6, before.v);
    expect(out).toMatchObject({ ok: false, reason: 'BOARD_NOT_READY' });
    expect(snap()).toEqual(before);
    // 不能留下「配置是扩展盘、实际还是标准盘」
    expect(r.lobbyConfig().board).toBe(r.map.kind);
  });

  it('rerollMap 失败同样完整回滚，不递增版本、不洗掉准备', () => {
    const r = new Room('f2-fail2', { capacity: 4, now: () => 1_000_000, mapFactory: () => null });
    r.join('甲', new FakeSocket('甲'));
    for (let i = 0; i < 4; i++) r.setReady(i, true);
    const before = { v: r.lobbyConfig().configVersion, seed: r.map.seed };
    expect(r.rerollMap(0, before.v)).toMatchObject({ ok: false, reason: 'BOARD_NOT_READY' });
    expect({ v: r.lobbyConfig().configVersion, seed: r.map.seed }).toEqual(before);
  });
});

describe('F2 · 跨人数选图可完成性（保留不兼容组合可开始）', () => {
  it('4 人扩展盘 / 8 人标准盘都能构造并保留合法地图（不强制纠正）', () => {
    const small = new Room('f2-small', { capacity: 4 });
    small.join('甲', new FakeSocket('甲'));
    expect(small.applyBoard(0, 'ext', small.lobbyConfig().configVersion).ok).toBe(true);
    expect(small.map.kind).toBe('ext');
    expect(small.map.tiles).toHaveLength(30);

    const big = new Room('f2-big', { capacity: 8 });
    big.join('甲', new FakeSocket('甲'));
    expect(big.applyBoard(0, 'base', big.lobbyConfig().configVersion).ok).toBe(true);
    expect(big.map.kind).toBe('base');
    expect(big.map.tiles).toHaveLength(19);
  });
});

describe('F2 · 广播快照结构一致', () => {
  it('LOBBY_CONFIG 的 map 与 room.map 引用同一份内容', () => {
    const p = room(4);
    p.join(4);
    p.room.applyPlayerCount(0, 7, p.version());
    const last = p.sockets[0]!.sent.filter((m) => m.t === 'LOBBY_CONFIG').at(-1)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (last as any).map as MapSnapshot;
    expect(map).toEqual(p.map());
    expect(map.boardVersion).toBe(p.version());
  });
});
