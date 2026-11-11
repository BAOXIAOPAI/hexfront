/**
 * 入口：把「参数 → 连接 → 视图 → 界面 → 命令」串起来。
 *
 * 状态只有一份：服务端推来的 PlayerView。这里不复制、不缓存规则状态，
 * 界面上的每个数字都直接来自最近一次 STATE。
 */

import type { Command, PlayerView } from '@hexfront/engine';
import type { LobbyPlayer } from '@hexfront/protocol';
import { GameClient, wsUrlFor } from './net.js';
import { Ui } from './ui.js';

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
let roomId = normalizeRoom(params.get('room'));
let myName = (params.get('name') ?? '').trim();

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
  onStart: () => { if (canSubmit()) client?.start(); },
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
  onTradeBank: (give, get) => send({ type: 'TRADE_BANK', seat: mySeat, give, get }),
  onPortTransfer: (beneficiary, give, get) =>
    send({ type: 'PORT_TRANSFER', seat: mySeat, beneficiary, give, get }),
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
    remember();
    connect();
  },
});

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

  client = new GameClient(wsUrl, { roomId, name: myName }, {
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
          ui.setRoom(msg.roomId);
          // 恢复快照：只恢复未过期的报价，冷却以服务端时间为准
          ui.setOffers(msg.snapshot, mySeat);
          ui.setSynced(true);
          if (msg.view) {
            view = msg.view;
            ui.hideOverlay();
            ui.render(view, []);
            ui.say('已连上牌桌，等待下一步操作', '在线');
          } else {
            ui.showLobby({ roomId: msg.roomId, capacity, players: lobbyPlayers, seat: mySeat });
          }
          return;
        }
        case 'LOBBY': {
          capacity = msg.capacity;
          lobbyPlayers = msg.players;
          if (!view) {
            ui.showLobby({ roomId: msg.roomId, capacity, players: lobbyPlayers, seat: mySeat });
            ui.say(`等待开局 · ${lobbyPlayers.length}/${capacity} 人`);
          }
          return;
        }
        case 'SETTINGS': {
          ui.setSettings(msg.settings, msg.locked);
          return;
        }
        case 'STATE': {
          // 状态版本：乱序到达的旧广播不能覆盖已经画出来的新状态
          if (msg.seq < lastSeq) return;
          lastSeq = msg.seq;
          view = msg.view;
          ui.hideOverlay();
          ui.setSynced(true);
          ui.render(view, msg.events);
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
  };
  const base = map[reason] ?? `操作被拒绝（${reason}）`;
  return detail ? `${base}：${detail}` : base;
}

function fatalText(reason: string): string {
  const map: Record<string, string> = {
    ROOM_FULL: '房间满了（最多 4 人）',
    IN_PROGRESS: '这局已经开始了，中途不能加人',
    SEAT_TAKEN: '这个名字已经有人在用',
    ROOM_LIMIT: '服务器房间数已达上限',
    BAD_MESSAGE: '消息格式不对，可能是版本不一致',
    PROTOCOL_MISMATCH: '客户端与服务端协议版本不一致，请刷新页面',
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
  ui.showJoin({ name: '', roomId });
  ui.setConnection('idle');
}

// 调试与自动化验收用：把当前视图挂到 window 上，不参与任何逻辑
Object.defineProperty(window, '__hex', {
  get: () => ({ view, seat: mySeat, roomId, capacity, wsUrl, client }),
});
