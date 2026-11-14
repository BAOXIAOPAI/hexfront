/**
 * 入口：把「参数 → 连接 → 视图 → 界面 → 命令」串起来。
 *
 * 状态只有一份：服务端推来的 PlayerView。这里不复制、不缓存规则状态，
 * 界面上的每个数字都直接来自最近一次 STATE。
 */

import type { Command, PlayerView } from '@hexfront/engine';
import type {
  BoardKind, LobbyConfig, LobbyPlayer, MapSnapshot, RoomSettings, SetupTimer,
} from '@hexfront/protocol';
import { GameClient, wsUrlFor } from './net.js';
import { Ui } from './ui.js';
import { LobbyView, type LobbyState } from './lobby.js';
import { copyText, inviteUrl, isValidRoomId, normalizeRoomId, randomRoomId } from './invite.js';

const params = new URLSearchParams(location.search);
const sharecode = params.get('sharecode');
const wsUrl = wsUrlFor({ origin: location.origin, sharecode });

let client: GameClient | null = null;
let view: PlayerView | null = null;
/** 权威状态版本：拒绝乱序/过期的 STATE 覆盖新状态（指南 10.1） */
let lastSeq = 0;
let mySeat = 0;
let capacity = 4;
let lobbyPlayers: LobbyPlayer[] = [];
/**
 * 文档 23 邀请链接：URL 带 ?room= 时（朋友点开邀请链接 / 刷新）必须原样沿用，
 * 绝不能用随机号覆盖，否则朋友会进到另一个空房间。
 * 只有直接打开首页、URL 完全没有 room 时，才生成一个随机号备用。
 */
const hadRoomParam = params.has('room') && isValidRoomId(params.get('room') ?? '');
let roomId = hadRoomParam
  ? normalizeRoomId(params.get('room'))
  : randomRoomId();
let myName = (params.get('name') ?? '').trim();

// 文档 23：大厅/地图/计时的权威快照，全部来自服务端，客户端只展示
let lobbyConfig: LobbyConfig | null = null;
let mapSnapshot: MapSnapshot | null = null;
let setupTimer: SetupTimer | null = null;
let roomSettingsV3: RoomSettings = { setupGrant: true };
/** 创建房间时房主选定的目标人数（4–8），随 CREATE 由 URL/表单传入 */
let createTargetPlayers = clampPlayers(Number(params.get('players')) || 4);
/** F1：仅「创建房间」的首条链路携带人数与 CREATE 意图；WELCOME 后清掉，重连只发 JOIN */
let pendingCreatePlayers: number | undefined;
/** F1：本次连接是创建还是加入；创建成功后由 WELCOME 降级，重连绝不重复创建 */
let joinIntent: 'create' | 'join' = 'join';

function clampPlayers(n: number): number {
  return Math.max(4, Math.min(8, Math.floor(Number.isFinite(n) ? n : 4)));
}

const lobbyView = new LobbyView(
  document.getElementById('sheet')!,
  document.getElementById('overlay')!,
  {
    onReady: (ready) => { if (canSubmit()) client?.ready(ready); },
    // F2：人数与手选地图是两条独立消息，绝不一起提交（避免把当前盘误记为手动选择）
    onPlayerCount: (players, version) => { if (canSubmit()) client?.setPlayerCount(players, version); },
    onBoard: (board, version) => { if (canSubmit()) client?.setBoard(board, version); },
    onReroll: (version) => { if (canSubmit()) client?.rerollMap(version); },
    onOrder: (order, version) => { if (canSubmit()) client?.setOrder(order, version); },
    onRandomizeOrder: (version) => { if (canSubmit()) client?.randomizeOrder(version); },
    onStart: (version) => { if (canSubmit()) client?.start(version); },
  },
);

/** 把当前权威快照喂给大厅浮层；只在未开局时显示 */
function paintLobby(): void {
  if (!lobbyConfig || !mapSnapshot || view) return;
  lobbyView.setState({
    roomId, seat: mySeat, players: lobbyPlayers,
    lobby: lobbyConfig, map: mapSnapshot, timer: setupTimer,
  });
}

/** 仅自动化验收用：进入房间后自动展开某种建造模式 */
const rawBuild = params.get('build');
const buildParam = rawBuild === 'road' || rawBuild === 'settlement' || rawBuild === 'city' ? rawBuild : null;
let buildAutoApplied = false;
let tradeAutoApplied = false;

function normalizeRoom(raw: string | null): string {
  const id = (raw ?? 'main').trim().toLowerCase();
  return /^[a-z0-9_-]{1,24}$/.test(id) ? id : 'main';
}

const ui = new Ui({
  onRoll: () => send({ type: 'ROLL_DICE', seat: mySeat }),
  onEndTurn: () => send({ type: 'END_TURN', seat: mySeat }),
  onPlace: (vertex, edge) => send({ type: 'PLACE_SETTLEMENT', seat: mySeat, vertex, edge }),
  onDiscard: (resources) => send({ type: 'DISCARD', seat: mySeat, resources }),
  onBuild: (kind, target) => {
    if (kind === 'road') send({ type: 'BUILD_ROAD', seat: mySeat, edge: target });
    else if (kind === 'settlement') send({ type: 'BUILD_SETTLEMENT', seat: mySeat, vertex: target });
    else send({ type: 'BUILD_CITY', seat: mySeat, vertex: target });
  },
  onOffer: (to, give, get) => { if (canSubmit()) client?.makeOffer(to, give, get); },
  onOfferAccept: (offerId) => { if (canSubmit()) client?.acceptOffer(offerId); },
  onOfferReject: (offerId) => { if (canSubmit()) client?.rejectOffer(offerId); },
  onOfferCancel: (offerId) => { if (canSubmit()) client?.cancelOffer(offerId); },
  onStart: () => { if (canSubmit()) client?.start(lobbyConfig?.configVersion); },
  onSettings: (setupGrant) => { if (canSubmit()) client?.send({ t: 'SET_SETTINGS', setupGrant }); },
  onMoveRobber: (tile, stealFrom) =>
    send({ type: 'MOVE_ROBBER', seat: mySeat, tile, ...(stealFrom === undefined ? {} : { stealFrom }) }),
  // ---- 阶段 D 新增的第 6 节入口 ----
  onBuyDev: () => send({ type: 'BUY_DEV_CARD', seat: mySeat }),
  onPlayKnight: (tile, stealFrom) =>
    send({ type: 'PLAY_KNIGHT', seat: mySeat, tile, ...(stealFrom === undefined ? {} : { stealFrom }) }),
  onPlayMonopoly: (resource) => send({ type: 'PLAY_MONOPOLY', seat: mySeat, resource }),
  onPlayPlenty: (a, b) => send({ type: 'PLAY_PLENTY', seat: mySeat, resources: [a, b] }),
  onPlayRoadBuilding: (edges) => send({ type: 'PLAY_ROAD_BUILDING', seat: mySeat, edges }),
  // F5：银行严格 4:1；自有港口用资源袋 + 港口边，均仅自己回合可用（服务端裁决）
  onTradeBank: (give, get) => send({ type: 'TRADE_BANK', seat: mySeat, give, get }),
  onTradePort: (port, give, get) => send({ type: 'TRADE_PORT', seat: mySeat, port, give, get }),
  onRequestPick: (kind, purpose, done) => ui.requestBoardPick(kind, purpose, done),
  // D-06：受控重连 + 探活超时兜底。核对完成前 setSynced(false)，
  // 不自动重放离线期间的建造 / 接受报价等旧意图，过期报价不续期。
  onResume: () => {
    if (client) client.resume();
    else ui.say('连接已断开，正在恢复；离线期间的点击不会被重放', '恢复');
  },
  onJoin: (name, room) => {
    myName = name;
    roomId = normalizeRoom(room);
    // F1：加入绝不隐式创建；房间不存在由服务端回 ROOM_NOT_FOUND
    joinIntent = 'join';
    pendingCreatePlayers = undefined;
    remember();
    connect();
  },
  // F1：显式创建，创建者即房主；人数只随这一次 CREATE 带上
  onCreate: (name, room, players) => {
    myName = name;
    roomId = normalizeRoom(room);
    createTargetPlayers = clampPlayers(players);
    pendingCreatePlayers = createTargetPlayers;
    joinIntent = 'create';
    remember();
    connect();
  },
  // 邀请链接：换一个随机房间号（点开链接进来的人也能主动换，等同于另建新房）
  onRerollRoom: () => {
    roomId = randomRoomId();
    return roomId;
  },
  onRoomIdChange: (id) => {
    if (isValidRoomId(id)) roomId = id.trim().toLowerCase();
  },
  onCopyInvite: (id) => {
    const url = inviteUrl(isValidRoomId(id) ? id : roomId);
    void copyText(url).then((ok) => {
      if (ok) ui.say('邀请链接已复制，发给朋友即可', '邀请');
      else {
        ui.flashReject('复制失败，请手动选中链接复制');
        ui.say(`邀请链接：${url}`, '邀请');
      }
    });
  },
});

/** 倒计时：每秒只更新数字，刷新/重连由服务端 deadline 保证不重置 */
setInterval(() => {
  lobbyView.tick(Date.now());
  ui.tickSetupTimer(Date.now());
}, 1000);

/** 最近一次提交时刻：断线发生在「提交后、确认前」时用来提示正在核对结果 */
let lastSubmitAt = 0;

/** 核对完成前一律不提交会改变对局的意图；不排队、不重放（指南 10.1 / D-06） */
function canSubmit(): boolean {
  if (!client || client.state !== 'open' || client.isReconciling) {
    ui.flashReject(client?.isReconciling
      ? '正在核对服务端状态，刚才的操作没有发送；核对完成后请重新操作'
      : '连接未就绪，操作没有发送；请等待恢复后重新操作');
    return false;
  }
  return true;
}

function send(cmd: Command): void {
  if (!canSubmit()) return;
  lastSubmitAt = Date.now();
  client!.command(cmd);
}

function remember(): void {
  // 刷新页面后仍能回到原座位：身份写在 URL 上
  const next = new URLSearchParams(location.search);
  next.set('name', myName);
  next.set('room', roomId);
  history.replaceState(null, '', `${location.pathname}?${next.toString()}`);
}

function connect(): void {
  client?.close();
  view = null;
  lastSeq = 0;
  ui.setRoom(roomId);

  client = new GameClient(
    wsUrl,
    { roomId, name: myName, players: pendingCreatePlayers, intent: joinIntent },
    {
    onState: (state) => {
      if (state !== 'reconnecting' || !client?.isReconciling) ui.setConnection(state);
      // WebSocket OPEN 不等于已拿到可操作的完整房间状态
      ui.setSynced(false);
      // 提交后、确认前断线：明确提示「正在核对结果、不会自动重发」。
      // 恢复流程重连时同样要给这句提示（指南 10.1 / D-06）。
      if (state !== 'open' && Date.now() - lastSubmitAt < 8000) {
        ui.flashReject('连接中断，正在核对刚才的操作结果；不会自动重发');
      }
    },
    onFatal: (reason) => ui.showFatal(fatalText(reason)),
    onDrop: () => ui.flashReject('连接未就绪，操作没有发送；请等待恢复后重新操作'),
    onReconcile: (phase, detail) => {
      ui.setReconciling(phase, detail);
      if (phase === 'synced') {
        ui.setSynced(true);
        ui.say('已核对服务端权威状态与未过期报价；离线期间的操作没有重放', '恢复');
      }
    },
    onMessage: (msg) => {
      switch (msg.t) {
        case 'WELCOME': {
          mySeat = msg.seat;
          capacity = msg.capacity;
          roomId = msg.roomId;
          lobbyPlayers = msg.players;
          lastSeq = msg.stateSeq;
          lobbyConfig = msg.lobby;
          mapSnapshot = msg.map;
          setupTimer = msg.timer;
          roomSettingsV3 = msg.settings;
          ui.setRoom(msg.roomId);
          // 恢复快照：只恢复未过期的报价，冷却以服务端时间为准
          ui.setOffers(msg.snapshot, mySeat);
          ui.setSettings(roomSettingsV3, !!msg.view);
          ui.setSynced(true);
          // F1：创建链路已完成，人数只随 CREATE 带过一次；重连一律 JOIN（net.markJoined 已降级 intent）
          pendingCreatePlayers = undefined;
          joinIntent = 'join';
          ui.setSetupTimer(setupTimer);
          if (msg.view) {
            view = msg.view;
            lobbyView.hide();
            ui.hideOverlay();
            ui.render(view, []);
            ui.setSetupTimer(setupTimer);
            ui.say('已连上牌桌，等待下一步操作', '在线');
          } else {
            paintLobby();
            ui.say(`等待开局 · ${lobbyPlayers.length}/${capacity} 人`, '房间');
          }
          return;
        }
        case 'LOBBY': {
          capacity = msg.capacity;
          lobbyPlayers = msg.players;
          lobbyConfig = msg.lobby;
          mapSnapshot = msg.map;
          if (!view) {
            paintLobby();
            ui.say(`等待开局 · ${lobbyPlayers.length}/${capacity} 人`);
          }
          return;
        }
        case 'LOBBY_CONFIG': {
          lobbyConfig = msg.lobby;
          mapSnapshot = msg.map;
          if (!view) paintLobby();
          return;
        }
        case 'SETTINGS': {
          roomSettingsV3 = msg.settings;
          ui.setSettings(msg.settings, msg.locked);
          return;
        }
        case 'SETUP_TIMER': {
          setupTimer = msg.timer;
          ui.setSetupTimer(setupTimer);
          if (!view) paintLobby();
          else ui.say('选地计时已更新', '计时');
          return;
        }
        case 'SETUP_AUTO_PLACED': {
          ui.say(`玩家 ${msg.seat + 1} 超时，系统已代放`, '代放');
          return;
        }
        case 'STATE': {
          // 状态版本：乱序到达的旧广播不能覆盖已经画出来的新状态
          if (msg.seq < lastSeq) return;
          lastSeq = msg.seq;
          view = msg.view;
          setupTimer = msg.timer;
          lobbyView.hide();
          ui.hideOverlay();
          ui.setSynced(true);
          ui.render(view, msg.events);
          ui.setSetupTimer(setupTimer);
          // 仅供自动化验收：?build=road|settlement|city 进入即展开对应建造模式
          if (!buildAutoApplied && buildParam) {
            buildAutoApplied = true;
            // 放到下一帧：同帧内重画棋盘会和本轮的渲染抢 DOM
            requestAnimationFrame(() => ui.openBuild(buildParam));
          }
          if (!tradeAutoApplied && params.get('trade') === '1') {
            tradeAutoApplied = true;
            requestAnimationFrame(() => ui.openTrade());
          }
          return;
        }
        case 'REJECT': {
          // 拒绝原因同时出现在操作附近的提示条与底栏，不只在隐藏日志里
          ui.flashReject(rejectText(msg.reason, msg.detail));
          return;
        }
        case 'OFFERS': {
          ui.setOffers(msg.snapshot, mySeat);
          const count = msg.snapshot.offers.length;
          if (count === 0) {
            ui.say('报价已结束', '交易');
          } else {
            const first = msg.snapshot.offers[0]!;
            ui.say(`${playerNameOf(first.from)} 向 ${playerNameOf(first.to)} 报价 · 共 ${count} 条`, '交易');
          }
          return;
        }
        default:
          return;
      }
    },
  });

  client.connect();
}

function playerNameOf(seat: number): string {
  return view?.players[seat]?.name ?? `座位 ${seat + 1}`;
}

function rejectText(reason: string, detail?: string): string {
  const map: Record<string, string> = {
    WRONG_PHASE: '现在不能这么做',
    NOT_YOUR_TURN: '还没轮到你',
    UNKNOWN_VERTEX: '那里不是路口',
    UNKNOWN_EDGE: '那里不是路',
    UNKNOWN_TILE: '没有这个地块',
    OCCUPIED: '这个位置已经有建筑',
    TOO_CLOSE: '离已有建筑太近',
    EDGE_TAKEN: '这条边已经有路',
    EDGE_NOT_ADJACENT: '路必须挨着新建的村庄',
    ALREADY_ROLLED: '本回合已经掷过',
    NOT_YET_ROLLED: '先掷骰子才能结束回合',
    INSUFFICIENT_RESOURCES: '资源不够',
    BUILD_LIMIT: '这种建筑已经用完',
    NOT_CONNECTED: '必须连着自己的路',
    NOT_YOUR_BUILDING: '这不是你的建筑',
    NOT_A_VILLAGE: '只有村庄能升级',
    CARD_NOT_AVAILABLE: '这张卡现在不能用',
    DEV_ALREADY_PLAYED: '本回合已经打过发展卡',
    DECK_EMPTY: '发展卡牌堆空了',
    INVALID_TARGET: '目标不合法',
    ROBBER_SAME_TILE: '强盗必须换个地块',
    NOT_INVOLVED: '这笔交易与你无关',
    EMPTY_TRADE: '交易内容为空',
    SAME_TARGET: '不能和自己交易',
    NO_PORT: '你没有这个港口',
    NOTHING_TO_DISCARD: '没有需要弃的牌',
    WRONG_DISCARD_COUNT: '弃牌数量不对',
    DISCARD_PENDING: '还有人在弃牌',
    OFFER_EXPIRED: '报价已过期，请返回列表',
    OFFER_NOT_FOUND: '报价不存在或已被处理',
    OFFER_NOT_FOR_YOU: '这条报价不是给你的',
    OFFER_COOLDOWN: '发送太频繁，请稍等再发',
    OFFER_FORBIDDEN: '现在不能向这位玩家报价',
    OFFER_REPLACED: '报价已被发起人的新报价替换',
    GAME_ENDED: '本局已结束',
    RATE_LIMITED: '请求过于频繁，请稍等',
    ROBBER_PENDING: '掷出 7 后必须先把强盗挪走',
    ROBBER_NOT_PENDING: '现在不需要移动强盗（要打骑士卡）',
    GAME_NOT_STARTED: '还没开局',
    NOT_SEATED: '你不在座位上',
    UNKNOWN_COMMAND: '无法识别的操作',
    NOT_HOST: '只有房主能修改房间设置、排序或开始游戏',
    NOT_ALL_READY: '还有玩家没准备',
    NOT_ENOUGH_PLAYERS: '人数未达到房间设定的人数',
    PLAYERS_OFFLINE: '有玩家离线，不能开始',
    CONFIG_VERSION_MISMATCH: '房间配置已变化，请按最新大厅状态重试',
    BOARD_NOT_READY: '地图尚未就绪，请稍后重抽',
    NO_LEGAL_PLACEMENT: '已无合法摆放点，开局暂停',
    SETUP_TIMEOUT_REJECTED: '本次放置已超时，请按最新状态操作',
  };
  const base = map[reason] ?? `操作被拒绝（${reason}）`;
  return detail ? `${base}：${detail}` : base;
}

function fatalText(reason: string): string {
  const map: Record<string, string> = {
    ROOM_FULL: '房间满了（人数由房主开局前设定）',
    IN_PROGRESS: '这局已经开始了，中途不能加人',
    SEAT_TAKEN: '这个名字已经有人在用',
    ROOM_LIMIT: '服务器房间数已达上限',
    BAD_MESSAGE: '消息格式不对，可能是版本不一致',
    PROTOCOL_MISMATCH: '客户端与服务端协议版本不一致，请刷新页面',
    // F1：加入不存在房间 / 创建重名房间
    ROOM_NOT_FOUND: '这个房间还不存在，请让房主先创建，或检查邀请链接里的房间号',
    ROOM_EXISTS: '这个房间号已经被创建了，换一个房间号或加入该房间',
  };
  return map[reason] ?? `无法入座（${reason}）`;
}

// ---------------------------------------------------------------- 启动

if (myName) {
  // 带 ?name= 进来的（分享链接 / 刷新）：直接坐回原座位
  ui.hideOverlay();
  ui.say('正在连接服务器…', '连接');
  remember();
  connect();
} else {
  ui.showJoin({
    name: '', roomId, players: createTargetPlayers,
    inviteUrl: inviteUrl(roomId),
    inviteUrlFor: (id) => inviteUrl(id),
  });
  ui.setConnection('idle');
}

// 调试与自动化验收用：把当前视图挂到 window 上，不参与任何逻辑
Object.defineProperty(window, '__hex', {
  get: () => ({ view, seat: mySeat, roomId, capacity, wsUrl, client }),
});
