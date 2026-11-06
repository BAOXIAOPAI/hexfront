/**
 * 入口：把「参数 → 连接 → 视图 → 界面 → 命令」串起来。
 *
 * 状态只有一份：服务端推来的 PlayerView。这里不复制、不缓存规则状态，
 * 界面上的每个数字都直接来自最近一次 STATE。
 */

import type { Command, PlayerView } from '@hexfront/engine';
import type { LobbyPlayer, TradeOfferView } from '@hexfront/protocol';
import { GameClient, wsUrlFor } from './net.js';
import { Ui } from './ui.js';

const params = new URLSearchParams(location.search);
const sharecode = params.get('sharecode');
const wsUrl = wsUrlFor({ origin: location.origin, sharecode });

let client: GameClient | null = null;
let view: PlayerView | null = null;
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
  onOffer: (to, give, get) => client?.makeOffer(to, give, get),
  onOfferAccept: () => client?.acceptOffer(),
  onOfferReject: () => client?.rejectOffer(),
  onOfferCancel: () => client?.cancelOffer(),
  onStart: () => client?.start(),
  onSettings: (setupGrant) => client?.send({ t: 'SET_SETTINGS', setupGrant }),
  onMoveRobber: (tile, stealFrom) =>
    send({ type: 'MOVE_ROBBER', seat: mySeat, tile, ...(stealFrom === undefined ? {} : { stealFrom }) }),
  onJoin: (name, room) => {
    myName = name;
    roomId = normalizeRoom(room);
    remember();
    connect();
  },
});

function send(cmd: Command): void {
  if (!client) return;
  client.command(cmd);
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
  ui.setRoom(roomId);

  client = new GameClient(wsUrl, { roomId, name: myName }, {
    onState: (state) => ui.setConnection(state),
    onFatal: (reason) => ui.showFatal(fatalText(reason)),
    onMessage: (msg) => {
      switch (msg.t) {
        case 'WELCOME': {
          mySeat = msg.seat;
          capacity = msg.capacity;
          roomId = msg.roomId;
          lobbyPlayers = msg.players;
          ui.setRoom(msg.roomId);
          if (msg.view) {
            view = msg.view;
            ui.hideOverlay();
            ui.setOffer(msg.offer);
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
          view = msg.view;
          ui.hideOverlay();
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
          ui.say(rejectText(msg.reason, msg.detail), '拒绝');
          return;
        }
        case 'OFFER': {
          ui.setOffer(msg.offer);
          if (msg.offer) {
            const from = playerNameOf(msg.offer.from);
            const to = playerNameOf(msg.offer.to);
            ui.say(`${from} 向 ${to} 报价`, '交易');
          } else {
            ui.say('报价已结束', '交易');
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
