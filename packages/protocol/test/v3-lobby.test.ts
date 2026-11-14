/**
 * 文档 23 L-1/L-2/L-4：协议 v3 新消息契约。
 * 覆盖：房主配置、准备、排序、地图快照、计时/代放、旧客户端拒绝策略。
 */

import { describe, expect, it } from 'vitest';
import {
  HOST_GRACE_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PROTOCOL_VERSION,
  SETUP_STEP_MS,
  decodeClientMessage,
  decodeServerMessage,
  encode,
  encodeClient,
  type ClientMessage,
  type LobbyConfig,
  type MapSnapshot,
  type ServerMessage,
  type SetupTimer,
} from '../src/index.js';

const lobby: LobbyConfig = {
  hostSeat: 0,
  targetPlayers: 6,
  board: 'ext',
  boardChoice: 'auto',
  recommendedBoard: 'ext',
  configVersion: 3,
  actionOrder: [2, 0, 3, 1, 5, 4],
  ready: [true, true, true, true, true, true],
  changedBy: 0,
  changeReason: 'SET_PLAYER_COUNT',
  canStart: true,
  startBlockReason: null,
};

const map: MapSnapshot = {
  kind: 'ext',
  rows: [3, 4, 5, 6, 5, 4, 3],
  tiles: [{ key: '0,0', terrain: 'wood', number: 6 }],
  ports: [{ edge: 'a|b', port: { kind: 'generic' } }],
  robberTile: '0,2',
  seed: 'seed-1',
  generatorVersion: 1,
  boardVersion: 3,
};

const timer: SetupTimer = { step: 4, seat: 2, deadline: 1000 + SETUP_STEP_MS, startedAt: 1000, serverTime: 1000 };

describe('数值契约', () => {
  it('每次放置独立 180 秒、人数 4–8、房主断线宽限 60 秒', () => {
    expect(SETUP_STEP_MS).toBe(180_000);
    expect(MIN_PLAYERS).toBe(4);
    expect(MAX_PLAYERS).toBe(8);
    expect(HOST_GRACE_MS).toBe(60_000);
  });
  it('协议版本为 4（文档 24）', () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });
});

describe('客户端 → 服务端：F2 人数与地图拆成独立意图', () => {
  it('SET_PLAYER_COUNT / SET_BOARD 往返各自只带一件事', () => {
    const a: ClientMessage = { t: 'SET_PLAYER_COUNT', targetPlayers: 8, configVersion: 3 };
    const b: ClientMessage = { t: 'SET_BOARD', board: 'base', configVersion: 3 };
    expect(decodeClientMessage(encodeClient(a))).toEqual(a);
    expect(decodeClientMessage(encodeClient(b))).toEqual(b);
  });

  it('旧 SET_ROOM_CONFIG 不再被解析（杜绝顺手把当前盘当手动选）', () => {
    expect(decodeClientMessage('{"t":"SET_ROOM_CONFIG","board":"ext"}')).toBeNull();
    expect(decodeClientMessage('{"t":"SET_ROOM_CONFIG","targetPlayers":6}')).toBeNull();
  });

  it('SET_BOARD 非法 board 视为畸形；SET_PLAYER_COUNT 缺人数视为畸形', () => {
    expect(decodeClientMessage('{"t":"SET_BOARD","board":"37grid"}')).toBeNull();
    expect(decodeClientMessage('{"t":"SET_PLAYER_COUNT"}')).toBeNull();
  });

  it('READY / REROLL_MAP / RANDOMIZE_ORDER / START 往返一致', () => {
    for (const msg of [
      { t: 'READY', ready: true },
      { t: 'REROLL_MAP', configVersion: 3 },
      { t: 'RANDOMIZE_ORDER', configVersion: 3 },
      { t: 'START', configVersion: 3 },
    ] as ClientMessage[]) {
      expect(decodeClientMessage(encodeClient(msg))).toEqual(msg);
    }
  });

  it('READY 非 boolean 视为畸形', () => {
    expect(decodeClientMessage('{"t":"READY","ready":"yes"}')).toBeNull();
  });

  it('SET_ORDER 必须是整数数组，携带 configVersion', () => {
    const msg: ClientMessage = { t: 'SET_ORDER', order: [2, 0, 3, 1], configVersion: 4 };
    expect(decodeClientMessage(encodeClient(msg))).toEqual(msg);
    expect(decodeClientMessage('{"t":"SET_ORDER","order":[0,"x"]}')).toBeNull();
    expect(decodeClientMessage('{"t":"SET_ORDER"}')).toBeNull();
  });

  it('configVersion 只接受有限非负数，畸形字段被丢弃', () => {
    expect(decodeClientMessage('{"t":"START","configVersion":-1}')).toEqual({ t: 'START' });
    expect(decodeClientMessage('{"t":"START","configVersion":"3"}')).toEqual({ t: 'START' });
  });
});

describe('服务端 → 客户端：权威快照与计时', () => {
  it('LOBBY 带大厅配置与地图快照', () => {
    const msg: ServerMessage = { t: 'LOBBY', roomId: 'main', capacity: 6, players: [], lobby, map };
    expect(decodeServerMessage(encode(msg))).toMatchObject({ t: 'LOBBY', capacity: 6 });
    const d = decodeServerMessage(encode(msg));
    expect(d && d.t === 'LOBBY' && d.lobby.targetPlayers).toBe(6);
    expect(d && d.t === 'LOBBY' && d.map.seed).toBe('seed-1');
  });

  it('LOBBY_CONFIG 带操作者与原因，供「谁改的」展示', () => {
    const msg: ServerMessage = { t: 'LOBBY_CONFIG', lobby, map, changedBy: 0, reason: 'REROLL_MAP' };
    expect(decodeServerMessage(encode(msg))).toMatchObject({ t: 'LOBBY_CONFIG', changedBy: 0, reason: 'REROLL_MAP' });
  });

  it('WELCOME 带 lobby/map/timer/settings 权威快照', () => {
    const msg: ServerMessage = {
      t: 'WELCOME', roomId: 'main', seat: 0, capacity: 6, players: [], view: null,
      snapshot: { offers: [], version: 0, serverTime: 1000, nextSendAt: {} }, stateSeq: 0,
      lobby, map, timer, settings: { setupGrant: true },
    };
    const d = decodeServerMessage(encode(msg));
    expect(d && d.t === 'WELCOME' && d.lobby?.hostSeat).toBe(0);
    expect(d && d.t === 'WELCOME' && d.map?.kind).toBe('ext');
    expect(d && d.t === 'WELCOME' && d.timer?.deadline).toBe(1000 + SETUP_STEP_MS);
  });

  it('STATE 附带当前步骤计时（重连也能拿到 deadline）', () => {
    const msg: ServerMessage = { t: 'STATE', seq: 9, events: [], view: {} as never, timer };
    const d = decodeServerMessage(encode(msg));
    expect(d && d.t === 'STATE' && d.timer?.step).toBe(4);
  });

  it('SETUP_TIMER 与 SETUP_AUTO_PLACED 可解码', () => {
    expect(decodeServerMessage(encode({ t: 'SETUP_TIMER', timer }))).toMatchObject({ t: 'SETUP_TIMER' });
    const auto: ServerMessage = {
      t: 'SETUP_AUTO_PLACED', seat: 2, step: 4, vertex: 'v', edge: 'e', reason: 'TIMEOUT',
    };
    expect(decodeServerMessage(encode(auto))).toMatchObject({ t: 'SETUP_AUTO_PLACED', reason: 'TIMEOUT' });
  });

  it('REJECT 能回显新的大厅层错误码', () => {
    for (const reason of ['NOT_HOST', 'NOT_ALL_READY', 'CONFIG_VERSION_MISMATCH', 'NO_LEGAL_PLACEMENT']) {
      expect(decodeServerMessage(encode({ t: 'REJECT', reason }))).toMatchObject({ t: 'REJECT', reason });
    }
  });
});

describe('F1 显式创建 / 加入分离', () => {
  it('CREATE 带人数往返保留；JOIN 不带人数', () => {
    const msg: ClientMessage = { t: 'CREATE', roomId: 'p8', name: '甲', v: 4, players: 8 };
    expect(decodeClientMessage(encodeClient(msg))).toEqual(msg);
    const join: ClientMessage = { t: 'JOIN', roomId: 'p8', name: '乙', v: 4 };
    expect(decodeClientMessage(encodeClient(join))).toEqual(join);
    // 旧客户端把 players 混进 JOIN 时人数必须被丢弃，且不能隐式创建
    expect(decodeClientMessage('{"t":"JOIN","roomId":"p8","name":"乙","players":8}'))
      .toEqual({ t: 'JOIN', roomId: 'p8', name: '乙' });
  });

  it('CREATE 的畸形人数被丢弃；ROOM_NOT_FOUND / ROOM_EXISTS 可回传', () => {
    expect(decodeClientMessage('{"t":"CREATE","players":"8"}'))
      .toEqual({ t: 'CREATE', roomId: 'main', name: '' });
    for (const reason of ['ROOM_NOT_FOUND', 'ROOM_EXISTS']) {
      expect(decodeServerMessage(encode({ t: 'JOIN_FAILED', reason })))
        .toMatchObject({ t: 'JOIN_FAILED', reason });
    }
  });
});

describe('旧客户端拒绝策略', () => {
  it('JOIN 缺少 v 仍可解析成「不带 v」，由服务端判 PROTOCOL_MISMATCH', () => {
    const d = decodeClientMessage('{"t":"JOIN","roomId":"main","name":"甲"}');
    expect(d).toEqual({ t: 'JOIN', roomId: 'main', name: '甲' });
    expect(d && 'v' in d).toBe(false);
    expect(decodeServerMessage(encode({ t: 'JOIN_FAILED', reason: 'PROTOCOL_MISMATCH' })))
      .toMatchObject({ t: 'JOIN_FAILED', reason: 'PROTOCOL_MISMATCH' });
  });

  it('仍拒绝未知/畸形消息，不静默当成新消息', () => {
    expect(decodeClientMessage('{"t":"DROP_TABLE"}')).toBeNull();
    expect(decodeServerMessage('{"t":"OFFER","offer":null}')).toBeNull();
  });
});
