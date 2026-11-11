/**
 * 界面：只做「把视图画出来」和「把点击翻译成命令」。
 *
 * 这里不判断任何规则合法性 —— 按钮的可用状态只是提示，
 * 真正是否允许，由服务端裁决后回 REJECT。
 */

import {
  type GameEvent,
  type Geometry,
  type PlayerView,
  type Resource,
  type ResourceCount,
} from '@hexfront/engine';
import type { LobbyPlayer, OfferView, OfferSnapshot, RoomSettings } from '@hexfront/protocol';
import { initTooltips } from './tips.js';
import { describeEvent, playerName } from './format.js';
import {
  adjustPick,
  canConfirm,
  DISCARD_ORDER,
  discardInfo,
  emptyPick,
  pickedTotal,
  rollHighlight,
  type Pick,
} from './discard.js';
import {
  BUILD_ORDER,
  BUILD_LABEL,
  RESOURCE_LABEL,
  canAfford,
  costText,
  missingFor,
  overlayFor as buildOverlayFor,
  roadBuildingCandidates,
  type BuildMode,
} from './build.js';
import { geometryForTileKeys } from './geometry.js';
import type { ConnState, ReconcilePhase } from './net.js';
import { candidateEdges, candidateVertices, setupInfo, setupSeats } from './placement.js';
import { robberTiles, stealCandidates } from './robber.js';
import { pointFromKey, renderBoard, roadEndpoints, type BoardOverlay, type SceneHandle } from './scene.js';
import { isLight, PLAYER_HEX, TERRAIN_COLOR, TERRAIN_DEEP, TERRAIN_LIGHT, TERRAIN_NAME, TERRAIN_SHORT } from './theme.js';
import {
  BoardCamera, candidateStillValid, resolveHits,
  type BoardCandidate, type CameraBox,
} from './camera.js';
import { Panels, type PanelCallbacks, type PanelName } from './panels.js';
import { installShelfBridge, syncShelf } from './shelf.js';

const HAND_ORDER: Resource[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const DEV_ORDER = ['knight', 'victory', 'monopoly', 'plenty', 'roadbuilding'] as const;

function byId<T extends Element = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少节点 #${id}`);
  return node as unknown as T;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export interface UiCallbacks extends PanelCallbacks {
  onRoll(): void;
  onEndTurn(): void;
  onStart(): void;
  onJoin(name: string, roomId: string): void;
  onPlace(vertex: string, edge: string): void;
  onDiscard(resources: Partial<ResourceCount>): void;
  onBuild(kind: BuildMode, target: string): void;
  onOffer(to: number, give: Partial<ResourceCount>, get: Partial<ResourceCount>): void;
  /** 接受/拒绝/撤回一律带报价 ID：旧页面上的按钮不会误操作新报价 */
  onOfferAccept(offerId: string): void;
  onOfferReject(offerId: string): void;
  onOfferCancel(offerId: string): void;
  /** 掷 7 结算：把强盗挪到某地块，并从指定玩家手里随机抽 1 张（不传则不抽） */
  onMoveRobber(tile: string, stealFrom?: number): void;
  /** 改房间设置（开局前有效，服务端回推权威值） */
  onSettings(setupGrant: boolean): void;
}

interface LogLine {
  text: string;
  seq: number;
}

export class Ui {
  private readonly board = byId<SVGSVGElement>('board');
  private readonly tableEmpty = byId('table-empty');
  private readonly setupbar = byId('setupbar');
  private readonly players = byId('players');
  private readonly sidebox = byId('sidebox');
  private readonly logBox = byId('log');
  private readonly devcards = byId('devcards');
  private readonly roundbox = byId('roundbox');
  private readonly hand = byId('hand');
  private readonly die1 = byId('die1');
  private readonly die2 = byId('die2');
  private readonly btnRoll = byId<HTMLButtonElement>('btn-roll');
  private readonly btnEnd = byId<HTMLButtonElement>('btn-end');
  private readonly btnBuild = byId<HTMLButtonElement>('btn-build');
  private readonly btnTrade = byId<HTMLButtonElement>('btn-trade');
  private readonly turnAva = byId('turn-ava');
  private readonly turnText = byId('turn-text');
  private readonly phaseFlag = byId('phase-flag');
  private readonly mobilebar = byId('mobilebar');
  private readonly feedTag = byId('feed-tag');
  private readonly feedText = byId('feed-text');
  private readonly roomId = byId('room-id');
  private readonly connDot = byId('conn-dot');
  private readonly overlay = byId('overlay');
  private readonly sheet = byId('sheet');
  private readonly discardPanel = byId('discard');
  private readonly buildPanel = byId('build');
  private readonly tradePanel = byId('trade');
  private readonly offerBar = byId('offer');
  private readonly btnSettings = byId<HTMLButtonElement>('btn-settings');
  private readonly settingsPanel = byId('settings');
  private readonly settingsBox = byId<HTMLInputElement>('set-setup-grant');
  private readonly settingsNote = byId('settings-note');
  private readonly handTotal = byId('hand-total');
  private readonly robberbar = byId('robberbar');

  /** 阶段 D：新增面板层与棋盘相机，构造函数里创建（不能依赖参数属性的初始化顺序） */
  private readonly panels: Panels;
  private readonly camera: BoardCamera;
  private readonly boardStage = byId('board-stage');
  /** 面板发起的棋盘选点请求（骑士选地块 / 筑路选 1–2 条边） */
  private pickRequest: {
    kind: 'tile' | 'edges';
    purpose: string;
    keys: string[];
    done: (keys: string[]) => void;
  } | null = null;
  /** 正在等确认的本地选点；收到新 STATE 会复查是否仍合法 */
  private pendingKey: string | null = null;

  private geo: Geometry | null = null;
  private geoKey = '';
  private view: PlayerView | null = null;
  private log: LogLine[] = [];
  private lastDice = '';
  private seq = 0;
  private spinTimer: ReturnType<typeof setInterval> | null = null;
  /** 摆位时已点下、正等选边的那个村庄；纯界面状态，不进任何规则 */
  private pickedVertex: string | null = null;
  /** 掷 7 结算时已选中、正等挑人抽牌的地块；纯界面状态 */
  private pickedRobberTile: string | null = null;
  /** 摆位进度签名，用来判断「换人了」，换了就清掉半截操作 */
  private setupSig = '';
  /** 弃牌面板里当前勾选的牌单 */
  private pick: Pick = emptyPick();
  /** 弃牌场景签名：换回合 / 需求张数变了就清空选择 */
  private discardSig = '';
  /** 当前建造模式；null 表示不在放置状态 */
  private buildMode: BuildMode | null = null;
  /**
   * D-04：当前交互模式（本地 UI 状态），与 view.pendingRobber（规则待办）完全分开。
   * 'auto'   = 没有用户显式切换，按规则待办决定是否显示强盗热区
   * 'build'  = 用户主动进入建造/交易，棋盘给建造候选（强盗待办仍在，不会被清掉）
   * 'robber' = 用户主动返回强盗任务
   * 无论哪种模式，都不放宽服务端对 END_TURN / 发展卡的限制（paintActions 等仍按规则裁决）。
   */
  private interaction: 'auto' | 'build' | 'robber' = 'auto';
  /** 建造菜单是否展开（与 buildMode 互斥：选完就收起） */
  private buildMenuOpen = false;
  /** 交易面板是否展开 */
  private tradeOpen = false;
  /** 交易对象座位；-1 表示还没选 */
  private tradeTarget = -1;
  private givePick: Pick = emptyPick();
  private getPick: Pick = emptyPick();
  /** 当前挂在桌面上的报价（服务端广播，人人可见） */
  /** 完整报价列表（阶段 C 协议适配；阶段 D 会替换成列表 UI） */
  private offers: OfferView[] = [];
  /** 当前展示的那一条，按钮始终按它的 id 提交 */
  private offer: OfferView | null = null;
  /** 入场动画只放一次：后续每次 STATE 重绘都再播一遍的话，棋盘会一直闪 */
  private animated = { board: false, hand: false };

  /** 相机在 Panels 之后构造；它就绪前忽略来自横屏状态机的重算回调 */
  private cameraReady = false;

  constructor(private readonly cb: UiCallbacks) {
    initTooltips();
    installShelfBridge();   // 桌面纸雕底栏的可见按钮 → 既有逻辑按钮（规则入口不重复实现）
    this.panels = new Panels(this.cb, () => this.relayout());
    this.camera = new BoardCamera(
      this.boardStage, this.board,
      (x, y) => this.handleBoardTap(x, y),
      // 惰性读取旋转角度：模式切换后无需重建相机，下一次手势立刻用新角度
      () => this.panels.landscapeRotation,
    );
    this.cameraReady = true;

    this.btnRoll.addEventListener('click', () => {
      this.spinDice();
      this.cb.onRoll();
    });
    // 结束回合改成明确确认，并给出不能结束的具体原因（指南 6）
    this.btnEnd.addEventListener('click', () => this.panels.confirmEndTurn());
    this.btnBuild.addEventListener('click', () => this.toggleBuild());
    this.btnTrade.addEventListener('click', () => this.toggleTrade());
    byId('zoom-in').addEventListener('click', () => this.camera.zoomAt(1.25));
    byId('zoom-out').addEventListener('click', () => this.camera.zoomAt(1 / 1.25));
    byId('zoom-reset').addEventListener('click', () => this.camera.reset());

    this.btnSettings.addEventListener('click', () => this.settingsPanel.classList.toggle('hidden'));
    byId('settings-close').addEventListener('click', () => this.settingsPanel.classList.add('hidden'));
    this.settingsBox.addEventListener('change', () => this.cb.onSettings(this.settingsBox.checked));

    // 强盗结算条：事件委托，innerHTML 每次重画也不丢监听
    this.robberbar.addEventListener('click', (ev) => {
      const view = this.view;
      if (!view || !(ev.target instanceof Element)) return;
      const btn = ev.target.closest<HTMLElement>('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'reselect') {
        this.pickedRobberTile = null;
        this.refreshHints(view);
        this.paintRobberBar(view);
        return;
      }
      if (btn.dataset.action === 'return-robber') {
        this.returnToRobberTask();
        return;
      }
      if (btn.dataset.action === 'steal' && this.pickedRobberTile) {
        const raw = btn.dataset.seat;
        const seat = raw === undefined || raw === '' ? undefined : Number(raw);
        const tile = this.pickedRobberTile;
        this.pickedRobberTile = null;
        this.cb.onMoveRobber(tile, seat);
      }
    });

    // 旧 DOM 委托只作兜底；正常路径由相机在捕获阶段统一接管并吃掉拖动后的 click
    this.board.addEventListener('click', (ev) => this.onBoardClick(ev));

    const relayout = (): void => this.relayout();
    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', () => setTimeout(relayout, 120));
  }

  /**
   * ULS / 指南 5.1：旋转模式切换、方向变化、尺寸变化都重算几何，
   * 但只调 camera.measure() + 重画，绝不 reset() 相机，也不清 pendingKey /
   * pickedVertex / 弃牌草稿等「待确认选择」。
   */
  private relayout(): void {
    if (!this.cameraReady) return;
    this.camera.measure();
    if (this.view) {
      // 首次 STATE：render() 自己紧接着会 paintBoard，这里不重复重画，
      // 否则 animated.board 被提前置位会吞掉棋盘的入场动画。
      if (this.animated.board) this.paintBoard();
      this.panels.setView(this.view);
    }
  }

  // -------------------------------------------------------------- 连接状态

  setConnection(state: ConnState): void {
    this.connDot.classList.toggle('on', state === 'open');
    this.connDot.classList.toggle('off', state === 'dead');
    // WS OPEN 不等于已拿到可操作的完整房间状态（指南 10.1）
    if (state !== 'open') this.panels.setConnected(false);
    if (state === 'connecting' || state === 'reconnecting') {
      setText(this.feedTag, '连接');
      setText(this.feedText, state === 'reconnecting' ? '与服务器断开，正在恢复…' : '正在连接服务器…');
      setText(this.turnText, '连接中…');
      this.panels.say(state === 'reconnecting' ? '连接中断，正在恢复；会改变对局的操作已暂停' : '正在连接服务器', '连接');
    }
    if (state === 'dead') {
      setText(this.feedTag, '离线');
      setText(this.feedText, '无法恢复连接');
      this.panels.say('无法恢复连接，仍可看盘与查看帮助', '离线', true);
    }
  }

  /** 拿到完整视图后才算「已同步可操作」；由 main.ts 在 WELCOME/STATE 后调用 */
  setSynced(ok: boolean): void {
    this.panels.setConnected(ok);
  }

  /** D-06：回前台核对期间的清晰连接状态 */
  setReconciling(phase: ReconcilePhase, detail?: string): void {
    this.panels.setReconciling(phase, detail);
  }

  /** 拒绝原因 / 连接异常：既在操作附近弹出，也写进底栏，不靠 hover 或颜色 */
  flashReject(text: string): void {
    this.panels.toast(text);
    this.say(text, '拒绝');
  }

  /** 直接开合侧抽屉（自动化验收与运行时冒烟用） */
  openPanel(name: Exclude<PanelName, null>): void { this.panels.open(name); }
  closePanel(): void { this.panels.close(); }

  setRoom(roomId: string): void {
    setText(this.roomId, roomId.toUpperCase());
  }

  say(text: string, tag = '状态'): void {
    setText(this.feedTag, tag);
    setText(this.feedText, text);
  }

  // ------------------------------------------------------------------ 浮层

  showJoin(opts: { name: string; roomId: string; error?: string }): void {
    // ULS：入房 / 输入昵称与房间号阶段保持原生竖屏，避开软键盘错位
    this.panels.setInGame(false);
    this.overlay.classList.remove('hidden');
    this.sheet.innerHTML = `
      <h1>进入牌桌</h1>
      <p class="sub">同一 WiFi 下，把地址发给朋友，各开一个浏览器窗口就能开局。</p>
      <form id="join-form">
        <div class="field">
          <label for="f-name">你的名字</label>
          <input id="f-name" maxlength="16" autocomplete="off" enterkeyhint="next" placeholder="例如：小满" value="${escapeAttr(opts.name)}">
        </div>
        <div class="field">
          <label for="f-room">房间号</label>
          <input id="f-room" maxlength="24" autocomplete="off" enterkeyhint="go" placeholder="main" value="${escapeAttr(opts.roomId)}">
        </div>
        <button class="btn primary" type="submit">加入</button>
        <!-- A-4b：区分动作键（昵称「下一步」→ 房间号「前往」），并给出键盘直接加入的引导；
             只改属性与文案，不动布局（真机已证回车/软键盘均可提交）。 -->
        <div class="hint">输完按键盘上的『前往』即可加入</div>
        ${opts.error ? `<div class="err">${escapeHtml(opts.error)}</div>` : ''}
      </form>
      <div class="hint">
        同名重连会回到原座位；座位被占用时会被拒绝。房间满员（4 人）会自动开局。
      </div>
    `;
    const form = this.sheet.querySelector<HTMLFormElement>('#join-form')!;
    const nameInput = this.sheet.querySelector<HTMLInputElement>('#f-name')!;
    const roomInput = this.sheet.querySelector<HTMLInputElement>('#f-room')!;
    nameInput.focus();
    nameInput.select();
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = nameInput.value.trim();
      const roomId = roomInput.value.trim() || 'main';
      if (!name) {
        nameInput.focus();
        return;
      }
      this.cb.onJoin(name, roomId);
    });
  }

  showLobby(opts: {
    roomId: string;
    capacity: number;
    players: LobbyPlayer[];
    seat: number;
  }): void {
    // ULS：LOBBY 阶段（无 PlayerView）不旋转，等开局 STATE 到了再铺横屏
    this.panels.setInGame(false);
    this.overlay.classList.remove('hidden');
    const seats: string[] = [];
    for (let i = 0; i < opts.capacity; i++) {
      const p = opts.players.find((x) => x.seat === i);
      if (p) {
        const color = seatColor(i);
        seats.push(`
          <div class="seat">
            <div class="ava${color.light ? ' light' : ''}" style="--c:${color.hex}">${escapeHtml(p.name.slice(0, 1))}</div>
            <span class="who">${escapeHtml(p.name)}${i === opts.seat ? '（你）' : ''}</span>
            <span class="st ${p.connected ? 'on' : ''}">${p.connected ? '在线' : '离线'}</span>
          </div>`);
      } else {
        seats.push(`<div class="seat open"><span class="who">空位 ${i + 1}</span></div>`);
      }
    }
    const canStart = opts.players.length >= 2;

    this.sheet.innerHTML = `
      <h1>房间 ${escapeHtml(opts.roomId.toUpperCase())}</h1>
      <p class="sub">${opts.players.length} / ${opts.capacity} 人在座。人齐会自动开局，也可以现在就开始。</p>
      <div class="seatlist">${seats.join('')}</div>
      <button class="btn primary" id="btn-start" ${canStart ? '' : 'disabled'}>开始游戏</button>
      <div class="hint">${canStart ? '开局后按座位顺序摆位：先正序，再倒序。' : '至少需要 2 人。等朋友进来，或把地址发给他。'}</div>
    `;
    this.sheet.querySelector<HTMLButtonElement>('#btn-start')?.addEventListener('click', () => this.cb.onStart());
  }

  hideOverlay(): void {
    this.overlay.classList.add('hidden');
  }

  showFatal(message: string): void {
    // ULS：回到入房浮层时同样撤掉自转
    this.panels.setInGame(false);
    this.overlay.classList.remove('hidden');
    this.sheet.innerHTML = `
      <h1>进不去这张桌子</h1>
      <p class="sub">${escapeHtml(message)}</p>
      <button class="btn primary" id="btn-retry">换个名字</button>
      <div class="hint">常见原因：这个名字已经有人在用（同名会顶号，被挡下），或者房间已满、已经开局。</div>
    `;
    this.sheet.querySelector<HTMLButtonElement>('#btn-retry')?.addEventListener('click', () => this.showJoin({ name: '', roomId: 'main' }));
  }

  // ------------------------------------------------------------------ 渲染

  /** 服务端回推的权威房间设置；开局后锁定，客户端不自行改规则 */
  setSettings(settings: RoomSettings, locked: boolean): void {
    this.settingsBox.checked = settings.setupGrant;
    this.settingsBox.disabled = locked;
    setText(
      this.settingsNote,
      locked ? '本局已开局，规则锁定；下局开局前可修改。' : '开局前可修改；开局后本局锁定。',
    );
  }

  render(view: PlayerView, events: GameEvent[] = []): void {
    this.view = view;
    this.seq += 1;
    // ULS：WELCOME(带 view) / STATE 到达 = 已开局，竖屏时启用 CSS 自旋转底座
    this.panels.setInGame(true);

    // D-04：权威广播说了算 —— 强盗待办解除就回到 auto；有人未弃牌则暂停本地模式
    if (!view.pendingRobber || view.pendingDiscards.length > 0) {
      if (this.interaction !== 'auto') this.interaction = 'auto';
    }

    // 换人摆位了就丢掉半截操作：否则会出现「点过村庄、轮到别人」的幽灵状态
    const info = setupInfo(view);
    const sig = info ? `${info.step}:${info.seat}` : '';
    if (sig !== this.setupSig) {
      this.setupSig = sig;
      this.pickedVertex = null;
    }

    this.tableEmpty.classList.add('hidden');
    this.paintBoard();
    // 收到权威更新后复查本地选点：仍合法则保留，失效则清除并解释（指南 5.3）
    this.recheckPending(view);
    this.panels.setView(view);
    this.paintPlayers(view);
    this.paintSidebox(view);
    this.paintDevCards(view);
    this.paintRound(view);
    this.paintHand(view);
    this.paintTurn(view);
    this.paintActions(view);
    this.paintDice(view);
    this.paintSetupBar(view);
    this.paintRobberBar(view);
    this.paintDiscard(view);
    this.paintBuild();
    this.paintTrade(view);
    this.paintOfferBar(view);

    // 有事件就让事件占住底栏（它更新鲜）；没有事件才用摆位提示填空
    if (events.length > 0) this.pushEvents(events, view);
    else this.paintFeedHint(view);

    // 桌面纸雕底栏：把逻辑节点的状态/手牌同步到可见镜像（不改任何规则）
    syncShelf();
  }

  private ensureGeo(view: PlayerView): Geometry {
    const key = view.tiles.map((t) => t.key).join('|');
    if (!this.geo || key !== this.geoKey) {
      this.geo = geometryForTileKeys(view.tiles.map((t) => t.key));
      this.geoKey = key;
    }
    return this.geo;
  }

  private paintBoard(): void {
    if (!this.view) return;
    // 首帧之后就不再重播入场动画，否则每条 STATE 都会让整个岛闪一次
    if (this.animated.board) this.board.classList.add('no-anim');
    // 本次掷骰真正产出的地块：点数对得上且强盗不在上面（公开信息，视图里可推）
    const highlight = new Set(rollHighlight(this.view));
    const overlay = this.boardOverlay(this.view);
    const handle: SceneHandle = renderBoard(this.board, this.view, this.ensureGeo(this.view), overlay, highlight);
    // 相机只改 viewBox：SVG 内部重绘不会打断绑在舞台容器上的手势，也不重置镜头
    this.camera.measure();
    this.camera.setScene({ ...handle.box }, this.cameraCandidates(this.view, overlay));
    this.animated.board = true;
  }

  /** 合法候选的屏幕坐标由相机实时换算，不靠放大的透明圆硬撑热区（指南 5.2） */
  private cameraCandidates(view: PlayerView, overlay: BoardOverlay | undefined): BoardCandidate[] {
    const geo = this.ensureGeo(view);
    const out: BoardCandidate[] = [];
    for (const vk of overlay?.vertices ?? []) {
      const p = pointFromKey(vk, geo);
      if (p) out.push({ key: vk, kind: 'vertex', x: p.x, y: p.y, label: `路口 ${vk}` });
    }
    for (const ek of overlay?.edges ?? []) {
      const pts = roadEndpoints(ek, geo);
      if (pts) out.push({ key: ek, kind: 'edge', x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2, label: '道路' });
    }
    for (const tk of overlay?.tiles ?? []) {
      const t = geo.tiles[tk];
      if (t) out.push({ key: tk, kind: 'tile', x: t.x, y: t.y, label: `地块 ${tk}` });
    }
    return out;
  }

  private recheckPending(view: PlayerView): void {
    if (!this.pendingKey) return;
    const stillValid = candidateStillValid(
      this.cameraCandidates(view, this.boardOverlay(view)), this.pendingKey,
    );
    if (stillValid) return;
    this.pendingKey = null;
    this.panels.hideConfirm();
    this.panels.toast('该位置已失效，预览已撤销并说明原因');
    this.panels.say('服务端状态已更新，刚才的位置不再合法；没有替你改选别处', '提示');
  }

  /**
   * D-04：规则待办与交互模式分开 —— 只在「用户没有主动进入建造」时才把棋盘交给强盗。
   * 强盗待办（view.pendingRobber）始终保留，结束回合/发展卡限制由 paintActions
   * 与 panels.confirmEndTurn / renderRailActions 独立裁决，不因切模式而放行。
   */
  private robberTaskActive(view: PlayerView): boolean {
    return view.pendingRobber
      && view.pendingDiscards.length === 0
      && view.current === view.viewer;
  }

  private boardInteraction(view: PlayerView): 'pick' | 'setup' | 'build' | 'robber' | 'none' {
    if (this.pickRequest) return 'pick';
    if (setupInfo(view)?.active) return 'setup';
    if (this.buildMode) return 'build';                       // 显式建造优先于强盗待办
    if (this.interaction === 'build') return 'none';
    if (this.interaction === 'robber' && this.robberTaskActive(view)) return 'robber';
    if (this.interaction === 'auto' && this.robberTaskActive(view)) return 'robber';
    return 'none';
  }

  /** 棋盘热区唯一入口：摆位 → 建造 → 强盗，不再让强盗待办盖掉建造选点 */
  private boardOverlay(view: PlayerView): BoardOverlay | undefined {
    if (this.pickRequest) {
      const geo = this.ensureGeo(view);
      if (this.pickRequest.kind === 'tile') {
        return {
          vertices: [], edges: [], picked: null,
          tiles: geo.tileKeys.filter((k) => k !== view.robberTile),
          pickedTile: null,
        };
      }
      // D-03：第二条候选基于「假设第一条已建成」的合法状态，和引擎逐条放置一致
      return {
        vertices: [], edges: roadBuildingCandidates(view, geo, this.pickRequest.keys),
        picked: null,
      };
    }
    switch (this.boardInteraction(view)) {
      case 'setup': return this.setupOverlay(view);
      case 'build': return buildOverlayFor(view, this.ensureGeo(view), this.buildMode!);
      case 'robber': return {
        vertices: [], edges: [], picked: null,
        tiles: robberTiles(view, this.ensureGeo(view)),
        pickedTile: this.pickedRobberTile,
      };
      default: return undefined;
    }
  }

  /** 摆位热区：没轮到我就不给任何可点元素，省得点半天全是 REJECT */
  private setupOverlay(view: PlayerView): BoardOverlay | undefined {
    const info = setupInfo(view);
    if (!info?.active) return undefined;
    const geo = this.ensureGeo(view);
    if (this.pickedVertex) {
      return {
        vertices: [this.pickedVertex],
        edges: candidateEdges(view, geo, this.pickedVertex),
        picked: this.pickedVertex,
      };
    }
    return { vertices: candidateVertices(view, geo), edges: [], picked: null };
  }

  // ------------------------------------------------------- 相机点选与先预览再确认

  /** 相机在捕获阶段统一接管点击：按屏幕坐标找最近合法候选；拖动不会走到这里 */
  private handleBoardTap(clientX: number, clientY: number): void {
    // C7：借这次已有的游戏手势顺带尝试一次系统横屏；不 preventDefault、不 return，
    // 不改变也不消费本次点击的游戏语义（失败静默留在 CSS 自转）。
    this.panels.noticeGameGesture();
    if (!this.view) return;
    const resolved = resolveHits(this.camera.nearest(clientX, clientY));
    if (resolved.kind === 'none') return;
    // 前两名太接近：不替用户选，给两个明确按钮
    if (resolved.kind === 'ambiguous') {
      this.panels.showConfirm({
        title: '两个候选很接近',
        detail: '请明确选一个，不会自动替你挑',
        candidates: [
          { label: `A · ${resolved.first.label ?? resolved.first.key}`, onPick: () => this.applyHit(resolved.first) },
          { label: `B · ${resolved.second.label ?? resolved.second.key}`, onPick: () => this.applyHit(resolved.second) },
        ],
        onConfirm: () => {},
      });
      return;
    }
    this.applyHit(resolved.first);
  }

  private applyHit(c: BoardCandidate): void {
    const view = this.view;
    if (!view) return;

    // 面板发起的选点（骑士 / 筑路）；与 boardOverlay 共用同一份候选口径
    if (this.pickRequest) {
      const req = this.pickRequest;
      const geo = this.ensureGeo(view);
      if (req.kind === 'tile' && c.kind === 'tile') {
        if (!this.boardOverlay(view)?.tiles?.includes(c.key)) return;
        this.pickRequest = null;
        this.paintBoard();
        req.done([c.key]);
        return;
      }
      if (req.kind === 'edges' && c.kind === 'edge') {
        if (!roadBuildingCandidates(view, geo, req.keys).includes(c.key)) return;
        if (!req.keys.includes(c.key)) req.keys.push(c.key);
        this.paintBoard();   // 重画候选：第二条基于「假设第一条已建成」
        if (req.keys.length >= 2) {
          this.pickRequest = null;
          this.paintBoard();
          req.done(req.keys.slice());
          return;
        }
        this.panels.showConfirm({
          title: '已选 1 条路',
          detail: `${req.purpose}；可继续选第二条，也可以只提交这一条`,
          confirmText: '只要一条，提交',
          onConfirm: () => {
            this.pickRequest = null;
            this.paintBoard();
            req.done(req.keys.slice());
          },
          onCancel: () => this.panels.toast('继续点第二条路'),
        });
        return;
      }
      return;
    }

    const interaction = this.boardInteraction(view);

    // 掷 7 强盗结算：只有在「当前交互模式确实是移动强盗」时才接管棋盘
    if (interaction === 'robber') {
      if (c.kind !== 'tile') return;
      const tiles = robberTiles(view, this.ensureGeo(view));
      if (!tiles.includes(c.key)) return;
      this.pickedRobberTile = c.key;
      this.paintBoard();
      this.paintRobberBar(view);
      const n = stealCandidates(view, this.ensureGeo(view), c.key).length;
      this.say(n > 0 ? `选一位相邻玩家抽 1 张牌（${n} 位可选）` : '旁边没人有牌，确认放置即可', '强盗');
      return;
    }

    const info = setupInfo(view);
    if (info?.active) {
      if (c.kind === 'vertex') {
        if (c.key === this.pickedVertex) return;
        this.pickedVertex = c.key;
        this.paintBoard();
        this.say('村庄选好了，点相邻那条虚线放路', '摆位');
        return;
      }
      if (c.kind === 'edge') {
        if (!this.pickedVertex) { this.say('先点一个发亮的路口放村庄', '摆位'); return; }
        const vertex = this.pickedVertex;
        this.pendingKey = c.key;
        this.paintBoard();
        this.panels.showConfirm({
          title: `确认摆位：村庄 + 道路（第 ${info.step + 1}/${info.total} 步）`,
          detail: `路口 ${vertex} · 道路 ${c.key}；取消不会改变服务器`,
          onConfirm: () => {
            this.pendingKey = null;
            this.pickedVertex = null;
            this.paintBoard();
            this.cb.onPlace(vertex, c.key);
          },
          onCancel: () => { this.pendingKey = null; this.panels.toast('已撤销本地选择'); },
        });
      }
      return;
    }

    if (!this.buildMode) return;
    const mode = this.buildMode;
    if (c.kind !== (mode === 'road' ? 'edge' : 'vertex')) return;
    const miss = missingFor(view.me.resources, mode);
    this.pendingKey = c.key;
    this.paintBoard();
    this.panels.showConfirm({
      title: `在此建造${BUILD_LABEL[mode]}？`,
      detail: `成本 ${costText(mode)}${miss.length ? ` · 还缺 ${miss.map((r) => RESOURCE_LABEL[r]).join('、')}` : ''}`,
      disabled: miss.length > 0,
      onConfirm: () => {
        this.pendingKey = null;
        this.exitBuild();
        this.cb.onBuild(mode, c.key);
      },
      onCancel: () => { this.pendingKey = null; this.panels.toast('已撤销本地选择，服务器未发生变化'); },
    });
  }

  /** 供 panels 通过回调请求棋盘选点；会收起大抽屉，只留情境提示与确认条 */
  requestBoardPick(kind: 'tile' | 'edges', purpose: string, done: (keys: string[]) => void): void {
    this.pickRequest = { kind, purpose, keys: [], done };
    this.panels.close();
    this.paintBoard();
    this.panels.say(purpose, '选点', true);
  }

  /** 旧 DOM 事件委托只作兜底；相机已在捕获阶段吃掉所有棋盘 click */
  private onBoardClick(ev: MouseEvent): void {
    const view = this.view;
    if (!view) return;

    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;

    // D-04：兜底委托与相机路径使用同一个模式裁决，避免「按钮允许建造、棋盘却在挪强盗」
    if (this.boardInteraction(view) === 'robber') {
      const tileEl = target.closest('[data-tile]');
      const key = tileEl?.getAttribute('data-tile');
      if (!key || !robberTiles(view, this.ensureGeo(view)).includes(key)) return;
      this.pickedRobberTile = key;
      this.refreshHints(view);
      this.paintRobberBar(view);
      const n = stealCandidates(view, this.ensureGeo(view), key).length;
      this.say(n > 0 ? `选一位相邻玩家抽 1 张牌（${n} 位可选）` : '旁边没人有牌，确认放置即可', '强盗');
      return;
    }

    const info = setupInfo(view);
    if (info?.active) {
      const vertexEl = target.closest('[data-vertex]');
      if (vertexEl) {
        const key = vertexEl.getAttribute('data-vertex');
        if (!key || key === this.pickedVertex) return;
        this.pickedVertex = key;
        this.refreshHints(view);
        this.say('村庄选好了，点相邻那条虚线放路', '摆位');
        return;
      }

      const edgeEl = target.closest('[data-edge]');
      if (edgeEl) {
        const edge = edgeEl.getAttribute('data-edge');
        if (!edge) return;
        if (!this.pickedVertex) {
          // 只有选了村庄才会画边，走到这里说明界面没按预期渲染，给句人话而不是静默失败
          this.say('先点一个发亮的路口放村庄', '摆位');
          return;
        }
        const vertex = this.pickedVertex;
        this.pickedVertex = null;
        this.refreshHints(view);
        this.cb.onPlace(vertex, edge);
      }
      return;
    }

    if (!this.buildMode) return;
    const mode = this.buildMode;

    if (mode === 'road') {
      const edge = target.closest('[data-edge]')?.getAttribute('data-edge');
      if (!edge) return;
      this.exitBuild();
      this.cb.onBuild('road', edge);
      return;
    }

    const vertex = target.closest('[data-vertex]')?.getAttribute('data-vertex');
    if (!vertex) return;
    this.exitBuild();
    this.cb.onBuild(mode, vertex);
  }

  /** 退出建造模式：收面板、撤热区；若强盗待办还在就自动交还棋盘 */
  private exitBuild(): void {
    this.buildMode = null;
    this.buildMenuOpen = false;
    this.interaction = 'auto';
    this.paintBuild();
    if (this.view) {
      this.paintBoard();
      this.paintRobberBar(this.view);   // D-04：切回 auto 后把强盗任务入口刷新回来
    }
  }

  /** 用户主动「返回强盗任务」：只切本地模式，规则待办一直在 view 里，从未被清掉 */
  returnToRobberTask(): void {
    const view = this.view;
    if (!view || !this.robberTaskActive(view)) return;
    this.buildMode = null;
    this.buildMenuOpen = false;
    this.paintBuild();
    if (this.tradeOpen) {
      this.tradeOpen = false;
      this.paintTrade(view);
      this.panels.close();
    }
    this.interaction = 'robber';
    this.pickedRobberTile = null;
    this.paintBoard();
    this.paintRobberBar(view);
    this.say('已返回强盗任务：点棋盘上的地块放置强盗', '强盗');
  }

  /** 点「建造」：正在放置就取消，否则开合菜单 */
  private toggleBuild(): void {
    const view = this.view;
    if (!view || view.phase !== 'play') return;

    if (this.buildMode) {
      this.exitBuild();
      this.say('已取消建造', '建造');
      return;
    }

    // 用户主动切到建造：只切本地交互模式，不清除 view.pendingRobber 规则待办
    this.interaction = 'build';
    this.buildMenuOpen = !this.buildMenuOpen;
    this.paintBuild();
    this.paintRobberBar(view);   // D-04：同步提示「可返回强盗任务」
    // 建造菜单放进侧抽屉，避免小横屏上盖住棋盘
    if (this.buildMenuOpen) this.panels.open('build');
    else this.panels.close();
  }

  /** 供自动化验收使用：直接进入某种建造模式（等价于点面板上的那一项） */
  openBuild(mode: BuildMode): void {
    this.interaction = 'build';   // D-04：自动化入口同样切本地交互模式
    this.pickBuild(mode);
  }

  private pickBuild(mode: BuildMode): void {
    this.interaction = 'build';
    this.buildMode = mode;
    this.buildMenuOpen = false;
    this.paintBuild();
    // 桌面纸雕：选完建造类别后收起大抽屉，让右栏任务卡与棋盘高亮保持可见
    // （指南 4.1：执行建造时右侧说明步骤，棋盘继续可操作，避免大面板挡住目标）。
    this.panels.close();
    if (this.view) {
      this.paintBoard();
      this.paintRobberBar(this.view);   // D-04：棋盘切热区时同步强盗提示
    }
    this.say(`点一个发亮的位置放${BUILD_LABEL[mode]}`, '建造');
  }

  /** 建造菜单：三种建造、成本、以及缺什么（缺的资源标红并禁用）。
   *  D-04：pendingRobber 不再隐藏菜单（指南 8.2：弃完后建造/兑换/交易已恢复）。
   *  真正的禁止项只有「有人尚未弃牌」——由 paintActions 与服务端裁决。 */
  private paintBuild(): void {
    const view = this.view;

    if (!view || view.phase !== 'play' || view.pendingDiscards.length > 0 || !this.buildMenuOpen) {
      this.buildPanel.classList.add('hidden');
      if (this.buildPanel.innerHTML) this.buildPanel.innerHTML = '';
      return;
    }

    this.buildPanel.classList.remove('hidden');

    const hint = this.buildMode
      ? '正在放置，点棋盘上发亮的位置；再点「建造」可取消'
      : '选一项，然后在棋盘上点发亮的位置';

    const items = BUILD_ORDER.map((mode) => {
      const ok = canAfford(view.me.resources, mode);
      const label = ok
        ? costText(mode)
        : `缺 ${missingFor(view.me.resources, mode).map((r) => RESOURCE_LABEL[r]).join(' ')}`;
      return `
        <button class="bp-item${this.buildMode === mode ? ' on' : ''}" data-mode="${mode}" data-tip="build-${mode}" ${ok ? '' : 'disabled'}>
          <span class="bp-name">${BUILD_LABEL[mode]}</span>
          <span class="bp-cost${ok ? '' : ' bad'}">${label}</span>
        </button>`;
    }).join('');

    this.buildPanel.innerHTML = `
      <div class="bp-title">建造</div>
      ${items}
      <div class="bp-hint">${hint}</div>
    `;

    this.buildPanel.querySelectorAll<HTMLButtonElement>('.bp-item').forEach((btn) => {
      btn.addEventListener('click', () => this.pickBuild(btn.dataset.mode as BuildMode));
    });
  }

  // -------------------------------------------------------------- 交易

  /**
   * 服务端推来的报价快照（多条并存）。
   * 阶段 C 只做协议适配：优先显示指向自己的第一条，并在横幅上标出总数；
   * 完整的列表/详情抽屉属于阶段 D。
   */
  setOffers(snapshot: OfferSnapshot, viewer: number): void {
    this.offers = snapshot.offers.slice();
    const relevant = this.offers.filter((o) => o.to === viewer || o.from === viewer);
    const incoming = relevant.filter((o) => o.to === viewer);
    this.offer = incoming[0] ?? relevant[0] ?? this.offers[0] ?? null;
    // 完整列表、倒计时、冷却与收件人视角转换由 panels 负责（指南 7.4）
    this.panels.setOffers(snapshot);
    if (this.view) {
      this.paintTrade(this.view);
      this.paintOfferBar(this.view);
    }
    // 右栏「桌上的提议」数量镜像：OFFERS 快照到达也要同步（不只等 STATE 重绘）
    syncShelf();
  }

  /** 供自动化验收使用：直接展开交易面板 */
  openTrade(): void {
    if (!this.tradeOpen) this.toggleTrade();
  }

  private toggleTrade(): void {
    const view = this.view;
    if (!view || view.phase !== 'play') return;

    this.interaction = 'build';   // D-04：交易/兑换期间也不让强盗待办接管棋盘
    this.tradeOpen = !this.tradeOpen;
    if (this.tradeOpen) {
      // 三个面板同位置，开一个就关掉别的
      this.exitBuild();
      this.givePick = emptyPick();
      this.getPick = emptyPick();
      this.tradeTarget = -1;
    }
    this.paintTrade(view);
    this.paintRobberBar(view);   // D-04：交易期间也要保留「返回强盗任务」入口
    // 交易草稿放进侧抽屉：回合外也能打开（指南 P0：非当前玩家可向当前玩家报价）
    if (this.tradeOpen) this.panels.open('trade');
    else this.panels.close();
  }

  private bump(pick: Pick, res: Resource, delta: number, max: number): Pick {
    const next = Math.max(0, Math.min(max, (pick[res] ?? 0) + delta));
    const out: Pick = { ...pick };
    if (next === 0) delete out[res];
    else out[res] = next;
    return out;
  }

  /** 交易面板：选对象 + 两列资源（我给 / 我要），零对价也允许 */
  private paintTrade(view: PlayerView): void {
    // D-04：pendingRobber 不再禁用交易面板（指南 8.2）；弃牌锁仍暂停一切资源变更
    if (!this.tradeOpen || view.phase !== 'play' || view.pendingDiscards.length > 0) {
      this.tradePanel.classList.add('hidden');
      if (this.tradePanel.innerHTML) this.tradePanel.innerHTML = '';
      return;
    }
    this.tradePanel.classList.remove('hidden');

    const others = view.players.filter((p) => p.index !== view.viewer);
    if (this.tradeTarget < 0 || !others.some((p) => p.index === this.tradeTarget)) {
      this.tradeTarget = others[0]?.index ?? -1;
    }

    const who = others
      .map(
        (p) =>
          `<button data-to="${p.index}" class="${p.index === this.tradeTarget ? 'on' : ''}">${escapeHtml(p.name)}</button>`,
      )
      .join('');

    const column = (pick: Pick, key: 'give' | 'get'): string =>
      DISCARD_ORDER.map((res) => {
        const held = view.me.resources[res] ?? 0;
        const n = pick[res] ?? 0;
        const max = key === 'give' ? held : 99;
        return `
          <div class="tp-row">
            <div class="tp-res${res === 'wheat' ? ' light' : ''}" style="background:${TERRAIN_COLOR[res]}">${TERRAIN_SHORT[res]}</div>
            <button class="tp-step" data-key="${key}" data-res="${res}" data-delta="-1" ${n <= 0 ? 'disabled' : ''}>−</button>
            <span class="tp-num">${n}</span>
            <button class="tp-step" data-key="${key}" data-res="${res}" data-delta="1" ${n >= max ? 'disabled' : ''}>+</button>
          </div>`;
      }).join('');

    this.tradePanel.innerHTML = `
      <div class="tp-title">交易</div>
      <div class="tp-who">${who}</div>
      <div class="tp-cols">
        <div><div class="tp-col-title">我给</div>${column(this.givePick, 'give')}</div>
        <div><div class="tp-col-title">我要</div>${column(this.getPick, 'get')}</div>
      </div>
      <div class="tp-foot">
        <button class="btn ghost mini" id="trade-cancel">取消</button>
        <button class="btn primary mini" id="trade-send">发出</button>
      </div>
    `;

    this.tradePanel.querySelectorAll<HTMLButtonElement>('.tp-who button').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.tradeTarget = Number(btn.dataset.to);
        this.paintTrade(view);
      });
    });

    this.tradePanel.querySelectorAll<HTMLButtonElement>('.tp-step').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key as 'give' | 'get';
        const res = btn.dataset.res as Resource;
        const delta = Number(btn.dataset.delta);
        const max = key === 'give' ? (view.me.resources[res] ?? 0) : 99;
        if (key === 'give') this.givePick = this.bump(this.givePick, res, delta, max);
        else this.getPick = this.bump(this.getPick, res, delta, max);
        this.paintTrade(view);
      });
    });

    this.tradePanel
      .querySelector<HTMLButtonElement>('#trade-cancel')
      ?.addEventListener('click', () => {
        this.tradeOpen = false;
        this.paintTrade(view);
      });

    this.tradePanel
      .querySelector<HTMLButtonElement>('#trade-send')
      ?.addEventListener('click', () => {
        if (this.tradeTarget < 0) return;
        const give = { ...this.givePick };
        const get = { ...this.getPick };
        if (Object.keys(give).length === 0 && Object.keys(get).length === 0) {
          this.say('这笔交易什么都没写', '交易');
          return;
        }
        this.tradeOpen = false;
        this.givePick = emptyPick();
        this.getPick = emptyPick();
        this.paintTrade(view);
        this.cb.onOffer(this.tradeTarget, give, get);
      });
  }

  /** 桌面上的报价横幅：被报价方可接受/拒绝，发起方可撤回 */
  /**
   * 棋盤上的常驻入口只显示未处理数量，不堆多条横幅（指南 7.4）。
   * 列表 / 详情 / 固定位置的接受按钮都在侧抽屉里，由 panels 渲染。
   */
  private paintOfferBar(view: PlayerView): void {
    const n = this.offers.length;
    if (n === 0) {
      this.offerBar.classList.add('hidden');
      if (this.offerBar.innerHTML) this.offerBar.innerHTML = '';
      return;
    }
    const incoming = this.offers.filter((o) => o.to === view.viewer).length;
    this.offerBar.classList.remove('hidden');
    // 纸雕报价票摘要：数量来自服务端 OFFERS 快照；接受/拒绝/撤回在抽屉里按 offerId 处理。
    // 倒计时由 panels.tick() 用 expiresAt - serverNow() 渲染，绝不本地裁决或续期。
    const first = this.offers[0]!;
    const fromName = view.players[first.from]?.name ?? '玩家';
    this.offerBar.innerHTML = `
      <div class="offer-ticket" role="button" tabindex="0" aria-label="查看 ${n} 条待处理提议">
        <span class="ob-text"><b>交易 ${n}</b> · ${incoming ? `${incoming} 条等你处理` : '点击查看'}</span>
        <span class="ot-name">${escapeHtml(fromName)} 的提议</span>
        <span class="ob-actions"><button class="btn tiny" id="offer-open">查看报价</button></span>
      </div>
    `;
    // 整条横幅都可点（panels 已在 #offer 上做了委托）；这里不再绑定单条 ID 按钮，
    // 避免过期后「下一条的接受按钮」顶到手指下面。
  }

  /** 只重画棋盘与摆位条，不碰手牌/骰子，避免点一下闪一下 */
  private refreshHints(view: PlayerView): void {
    this.paintBoard();
    this.paintSetupBar(view);
    this.paintFeedHint(view);
  }

  /**
   * 掷 7 结算条（R-42）：弃牌没完不出现；出现后按「等待 / 选地块 / 挑人抽牌」三段走。
   * 抽牌是随机从对方手牌池里抽，界面只让人选「抽谁」，不展示牌面。
   */
  private paintRobberBar(view: PlayerView): void {
    const active = view.pendingRobber && view.pendingDiscards.length === 0;
    if (!active) {
      this.robberbar.classList.add('hidden');
      if (this.robberbar.innerHTML) this.robberbar.innerHTML = '';
      this.pickedRobberTile = null;
      return;
    }
    this.robberbar.classList.remove('hidden');

    if (view.current !== view.viewer) {
      this.robberbar.innerHTML = `
        <div class="rb-title">掷出 7 · 结算中</div>
        <div class="rb-desc">等待 ${escapeHtml(playerName(view, view.current))} 移动强盗…</div>`;
      return;
    }

    if (!this.pickedRobberTile) {
      const deferred = this.interaction !== 'robber' && this.interaction !== 'auto';
      this.robberbar.innerHTML = `
        <div class="rb-title">掷出 7 · 移动强盗</div>
        <div class="rb-desc">${deferred
          ? '你正在建造 / 交易 / 兑换；强盗待办仍保留，结束回合与发展卡仍禁用。点下面的按钮可返回强盗任务。'
          : '点棋盘上红框的地块放置强盗（不能留原地，可放沙漠、可放自己旁边）；这块地会一直停产，直到强盗被移走。'}</div>
        ${deferred ? '<div class="rb-row"><button class="rb-alt" data-action="return-robber">返回强盗任务</button></div>' : ''}`;
      return;
    }

    const candidates = stealCandidates(view, this.ensureGeo(view), this.pickedRobberTile);
    const who = candidates
      .map(
        (c) =>
          `<button class="rb-who" data-action="steal" data-seat="${c.seat}">${escapeHtml(c.name)}<i>${c.handSize} 张</i></button>`,
      )
      .join('');
    this.robberbar.innerHTML = `
      <div class="rb-title">从谁手里抽 1 张？</div>
      <div class="rb-desc">随机抽取，谁都看不到具体抽走了哪张。</div>
      <div class="rb-row">${who || '<span class="rb-empty">相邻玩家都没有手牌</span>'}</div>
      <div class="rb-row">
        <button class="rb-alt" data-action="steal">不抽牌，就放这里</button>
        <button class="rb-alt" data-action="reselect">换个地块</button>
      </div>`;
  }

  private paintSetupBar(view: PlayerView): void {
    const info = setupInfo(view);
    if (!info) {
      this.setupbar.classList.add('hidden');
      this.setupbar.innerHTML = '';
      return;
    }
    this.setupbar.classList.remove('hidden');

    // 每个点 = 一次摆放，颜色就是按蛇形顺序将要落子的那个人
    const dots = setupSeats(view)
      .map((seat, i) => {
        const player = view.players[seat];
        const hex = player ? PLAYER_HEX[player.color] : '#B9A48C';
        const done = i < info.step;
        const now = i === info.step;
        return `<i class="${done ? 'done' : ''}${now ? ' now' : ''}" style="--c:${hex}"></i>`;
      })
      .join('');

    const hint = info.active
      ? this.pickedVertex
        ? '点相邻那条虚线放路'
        : '点一个发亮的路口放村庄'
      : `等 ${escapeHtml(playerName(view, info.seat))} 摆位`;

    this.setupbar.innerHTML = `
      <div class="sb-head">
        <span class="sb-title">开局摆位 · 第 ${info.round} 轮</span>
        <span class="sb-count">${info.step} / ${info.total}</span>
      </div>
      <div class="sb-dots">${dots}</div>
      <div class="sb-hint${info.active ? ' mine' : ''}">${hint}</div>
    `;
  }

  private paintFeedHint(view: PlayerView): void {
    const info = setupInfo(view);
    if (!info) return;
    setText(this.feedTag, '摆位');
    if (info.active) {
      setText(
        this.feedText,
        this.pickedVertex
          ? '已选村庄：点相邻的虚线放路'
          : `轮到你摆位（第 ${info.round} 轮）：先点一个发亮的路口`,
      );
    } else {
      setText(this.feedText, `等 ${playerName(view, info.seat)} 摆位 · ${info.step}/${info.total}`);
    }
  }

  /**
   * 掷出 7 后的弃牌面板。
   *
   * 「谁该弃几张」是公开信息（视图里的 pendingDiscards），
   * 「弃哪几张」是玩家选择，凑齐后整单发给服务端裁决。
   */
  private paintDiscard(view: PlayerView): void {
    const info = discardInfo(view);

    if (!info) {
      this.discardPanel.classList.add('hidden');
      if (this.discardPanel.innerHTML) this.discardPanel.innerHTML = '';
      this.pick = emptyPick();
      this.discardSig = '';
      return;
    }

    // 换回合、换需求就清空已选，避免把上一轮的牌单带过来
    const sig = `${view.turn}:${info.need}:${info.total}`;
    if (sig !== this.discardSig) {
      this.discardSig = sig;
      this.pick = emptyPick();
    }

    this.discardPanel.classList.remove('hidden');

    // 不用我弃：只显示在等谁
    if (!info.mine) {
      const names = info.waiting
        .map((w) => `${playerName(view, w.seat)} ${w.count} 张`)
        .join('、');
      this.discardPanel.innerHTML = `
        <div class="dp-head"><span class="dp-title">等待弃牌</span></div>
        <div class="dp-wait">${escapeHtml(names)} 正在选择，弃完才能继续。</div>
      `;
      return;
    }

    const total = pickedTotal(this.pick);
    const done = total === info.need;

    const rows = DISCARD_ORDER.map((res) => {
      const held = view.me.resources[res] ?? 0;
      const picked = this.pick[res] ?? 0;
      const light = res === 'wheat';
      return `
        <div class="dp-row">
          <div class="dp-ico${light ? ' light' : ''}" style="background:${TERRAIN_COLOR[res]}">${TERRAIN_SHORT[res]}</div>
          <span class="dp-name">${TERRAIN_NAME[res]}</span>
          <button class="dp-step" data-res="${res}" data-delta="-1" ${picked <= 0 ? 'disabled' : ''}>−</button>
          <span class="dp-num">${picked}</span>
          <button class="dp-step" data-res="${res}" data-delta="1" ${picked >= held || done ? 'disabled' : ''}>+</button>
          <span class="dp-hold">持有 ${held}</span>
        </div>`;
    }).join('');

    this.discardPanel.innerHTML = `
      <div class="dp-head">
        <span class="dp-title">弃掉一半手牌</span>
        <span class="dp-count${done ? ' ok' : ''}">${total} / ${info.need}</span>
      </div>
      ${rows}
      <button class="btn primary dp-ok" id="discard-ok" ${done ? '' : 'disabled'}>确认弃牌</button>
    `;

    this.discardPanel.querySelectorAll<HTMLButtonElement>('.dp-step').forEach((btn) => {
      btn.addEventListener('click', () => {
        const res = btn.dataset.res as Resource;
        const delta = Number(btn.dataset.delta);
        this.pick = adjustPick(this.pick, res, delta, view.me.resources, info.need);
        this.paintDiscard(view);
      });
    });

    this.discardPanel
      .querySelector<HTMLButtonElement>('#discard-ok')
      ?.addEventListener('click', () => {
        if (!canConfirm(this.pick, info.need, view.me.resources)) return;
        this.cb.onDiscard({ ...this.pick });
        this.pick = emptyPick();
      });
  }

  private paintPlayers(view: PlayerView): void {
    // 晴湾纸雕玩家 chip：名字首字头像 + 分数 + 手牌/发展卡数 + 成就 pill + 当前高亮。
    // 只用 PlayerView 的公开字段（handSize / devCardCount / score / badges），
    // 别人的手牌种类、隐藏胜利点、发展卡内容绝不进入视图。
    const rows = view.players.map((p) => {
      const color = PLAYER_HEX[p.color];
      const light = isLight(p.color);
      const isCurrent = view.phase !== 'ended' && view.current === p.index;
      const warn = p.handSize >= 8;
      let bars = '';
      for (let i = 0; i < 10; i++) bars += `<i class="${i < p.score ? 'on' : ''}"></i>`;

      const badges: string[] = [];
      if (view.longestRoad?.player === p.index) {
        badges.push(`<span class="pbadge" title="最长路 ${view.longestRoad.length} 条">↝ 最长路 ${view.longestRoad.length}</span>`);
      }
      if (view.largestArmy?.player === p.index) {
        badges.push(`<span class="pbadge" title="最大军 ${view.largestArmy.count} 骑士">⚔ 最大军 ${view.largestArmy.count}</span>`);
      }

      return `
        <div class="player pchip${isCurrent ? ' active current' : ''}${p.index === view.viewer ? ' me' : ''}${warn ? ' warn' : ''}" style="--pc:${color}">
          <div class="ava pavatar${light ? ' light' : ''}" style="--c:${color}">${escapeHtml(p.name.slice(0, 1))}</div>
          <div class="pinfo">
            <div class="pname">${escapeHtml(p.name)}${p.index === view.viewer ? '<span class="me-tag">你</span>' : ''}</div>
            <div class="pmeta">
              <span class="metric" title="手牌张数">🂠 ${p.handSize}</span>
              <span class="metric" title="发展卡张数">▤ ${p.devCardCount}</span>
              ${p.playedKnights ? `<span class="metric" title="已打出骑士">⚔ ${p.playedKnights}</span>` : ''}
              ${badges.join('')}
            </div>
            <div class="ptrack" style="--c:${color}">${bars}</div>
          </div>
          <span class="phand" data-risk="${warn ? '1' : '0'}" aria-label="手牌 ${p.handSize} 张">${p.handSize}</span>
          <div class="pscore">${p.score}<small>分</small></div>
        </div>`;
    });
    this.players.innerHTML = rows.join('');
  }

  private paintSidebox(view: PlayerView): void {
    const lr = view.longestRoad
      ? `<b>${escapeHtml(playerName(view, view.longestRoad.player))} · ${view.longestRoad.length} 条</b>`
      : '<b>无人</b>';
    const la = view.largestArmy
      ? `<b>${escapeHtml(playerName(view, view.largestArmy.player))} · ${view.largestArmy.count} 骑士</b>`
      : '<b>无人</b>';
    const risk = view.me.handSize >= 8 ? 'style="color:#C8503F;"' : '';
    this.sidebox.innerHTML = `
      <div class="row"><span>最长路</span>${lr}</div>
      <div class="row"><span>最大军</span>${la}</div>
      <div class="row"><span>牌堆剩余</span><b>${view.devDeckCount} 张</b></div>
      <div class="row"><span>你的手牌</span><b ${risk}>${view.me.handSize} 张${view.me.handSize >= 8 ? ' · 掷 7 要弃一半' : ''}</b></div>
    `;
  }

  private paintDevCards(view: PlayerView): void {
    const counts = new Map<string, number>();
    for (const entry of view.me.devCards) counts.set(entry.card, (counts.get(entry.card) ?? 0) + 1);
    const label: Record<string, string> = {
      knight: '骑士',
      victory: '胜利点',
      monopoly: '垄断',
      plenty: '丰饶',
      roadbuilding: '筑路',
    };
    this.devcards.innerHTML = DEV_ORDER.map((card) => {
      const n = counts.get(card) ?? 0;
      return `<div class="devcard" data-tip="dev-${card}"><b>${label[card]}</b><span class="${n === 0 ? 'zero' : ''}">${n}</span></div>`;
    }).join('');
    // 底栏发展卡堆只显示总张数，不公开牌型（隐藏信息）
    this.devcards.dataset.count = String(view.me.devCards.length);
  }

  private paintRound(view: PlayerView): void {
    const rolled = view.hasRolled ? '<b style="color:#6C8F4A;">已掷</b>' : '<b style="color:#C8503F;">尚未掷</b>';
    this.roundbox.innerHTML = `
      <div class="row"><span>回合</span><b>第 ${view.turn} 回合</b></div>
      <div class="row"><span>掷骰</span>${rolled}</div>
      <div class="row"><span>手牌</span><b>${view.me.handSize} 张</b></div>
    `;
  }

  private paintHand(view: PlayerView): void {
    // 晴湾纸雕资源卡：地形色顶条 + 资源图标 + 中文名 + 大号数量 + 港口标签。
    // 数量唯一来源是 view.me.resources（服务端权威）；零资源灰化但不隐藏，牌位稳定。
    const cnt = HAND_ORDER.length;
    setText(this.handTotal, `${view.me.handSize} 张`);
    if (this.animated.hand) this.hand.classList.add('no-anim');
    // 港口比例：只有「自己的建筑恰好占在港口边的端点」时才算拥有该港（公开信息）。
    // 单纯遍历 view.ports 会把全桌所有港口都标到自己手牌上，属于呈现错误。
    const geo = this.ensureGeo(view);
    const portOf: Partial<Record<Resource, string>> = {};
    for (const slot of view.ports) {
      if (slot.port.kind !== 'specific') continue;
      const edge = geo.edges[slot.edge];
      if (!edge) continue;
      const mine = [edge.a, edge.b].some((vk) => view.buildings[vk]?.owner === view.viewer);
      if (mine) portOf[slot.port.resource] = '2:1';
    }
    this.hand.innerHTML = HAND_ORDER.map((res, i) => {
      const n = view.me.resources[res] ?? 0;
      const off = i - (cnt - 1) / 2;
      const rot = (off * 5.5).toFixed(1);
      const lift = Math.abs(off) * 5;
      const light = res === 'wheat';
      const port = portOf[res];
      return `
        <div class="card res-card${n === 0 ? ' empty' : ''}" data-res="${res}"
             style="--rc:${TERRAIN_COLOR[res]};--rcl:${TERRAIN_LIGHT[res]};--rcd:${TERRAIN_DEEP[res]};--rot:${rot}deg;--lift:${lift}px;animation-delay:${i * 60}ms">
          <span class="port-tag${port ? '' : ' hidden'}">${port ?? ''}</span>
          <div class="cband res-ico${light ? ' light' : ''}" style="background:${TERRAIN_COLOR[res]}">${resourceGlyph(res)}</div>
          <div class="res-name cname">${TERRAIN_NAME[res]}</div>
          <div class="cnum res-count">${n}</div>
        </div>`;
    }).join('');
    this.animated.hand = true;
  }

  private paintTurn(view: PlayerView): void {
    const current = view.players[view.current];
    const color = current ? PLAYER_HEX[current.color] : '#B9A48C';
    this.turnAva.style.setProperty('--c', color);
    this.turnAva.classList.toggle('light', current ? isLight(current.color) : false);
    setText(this.turnAva, current ? current.name.slice(0, 1) : '·');

    if (view.phase === 'setup' && view.setup) {
      const perRound = view.players.length;
      const round = view.setup.step < perRound ? 1 : 2;
      setText(this.turnText, `摆位 · 第 ${round} 轮 · 轮到 ${playerName(view, view.setup.seat)}`);
      setText(this.phaseFlag, `摆位 ${view.setup.step} / ${perRound * 2}`);
    } else if (view.phase === 'ended') {
      setText(this.turnText, view.winner !== null ? `${playerName(view, view.winner)} 获胜` : '对局结束');
      setText(this.phaseFlag, '已结束');
    } else {
      setText(this.turnText, view.current === view.viewer ? `你的回合 · 第 ${view.turn} 回合` : `${playerName(view, view.current)} 的回合`);
      setText(this.phaseFlag, view.hasRolled ? '可行动' : '待掷骰');
    }

    this.mobilebar.innerHTML = view.players
      .map((p) => {
        const hex = PLAYER_HEX[p.color];
        return `<div class="mav${isLight(p.color) ? ' light' : ''}" style="--c:${hex}">${escapeHtml(p.name.slice(0, 1))}<i>${p.score}</i></div>`;
      })
      .join('');
  }

  private paintActions(view: PlayerView): void {
    const myTurn = view.phase === 'play' && view.current === view.viewer;
    // 弃牌锁期间服务端只接受 DISCARD；掷 7 结算未完成时只接受 MOVE_ROBBER
    const locked = view.pendingDiscards.length > 0;
    const robberPending = view.pendingRobber && !locked;

    this.btnRoll.disabled = !(myTurn && !view.hasRolled && !locked && !robberPending);
    this.btnEnd.disabled = !(myTurn && view.hasRolled && !locked && !robberPending);
    this.btnEnd.title = robberPending ? '掷出 7 后必须先把强盗挪走'
      : locked ? '还有人尚未弃牌'
        : !view.hasRolled ? '先掷骰子才能结束回合' : '';
    // 变体 V-1：掷骰只是「本回合必须发生」，不限定发生在哪个阶段。
    // 指南 8.2：弃完、强盗待移动时建造与交易已恢复，只有发展卡/结束回合仍禁。
    this.btnBuild.disabled = !(myTurn && !locked);
    // 指南 P0：回合外也能向当前玩家报价；只受弃牌锁约束，不受是否轮到自己约束。
    this.btnTrade.disabled = !(!locked);
  }

  private paintDice(view: PlayerView): void {
    const sig = view.dice ? `${view.dice[0]}-${view.dice[1]}` : '';
    if (sig === this.lastDice) return;
    this.lastDice = sig;
    setText(this.die1, view.dice ? String(view.dice[0]) : '?');
    setText(this.die2, view.dice ? String(view.dice[1]) : '?');
  }

  private spinDice(): void {
    for (const die of [this.die1, this.die2]) {
      die.classList.remove('rolling');
      void die.offsetWidth;
      die.classList.add('rolling');
    }
    if (this.spinTimer) clearInterval(this.spinTimer);
    let ticks = 0;
    this.spinTimer = setInterval(() => {
      setText(this.die1, String(1 + Math.floor(Math.random() * 6)));
      setText(this.die2, String(1 + Math.floor(Math.random() * 6)));
      if (++ticks < 10) return;
      // 动画只是表演，落定后必须回到服务端给的点数，否则屏幕上会留着一对假骰子
      clearInterval(this.spinTimer!);
      this.spinTimer = null;
      this.lastDice = '';
      if (this.view) this.paintDice(this.view);
    }, 65);
  }

  private pushEvents(events: GameEvent[], view: PlayerView): void {
    for (const ev of events) {
      const text = describeEvent(ev, view);
      if (!text) continue;
      this.log.unshift({ text, seq: this.seq });
    }
    this.log = this.log.slice(0, 8);
    this.logBox.innerHTML = this.log
      .map((line, i) => `<div class="logitem"><span class="lt">${i === 0 ? '刚刚' : `${i} 步前`}</span><span>${escapeHtml(line.text)}</span></div>`)
      .join('');
    const top = this.log[0];
    if (top) {
      setText(this.feedTag, '动态');
      setText(this.feedText, top.text);
    }
  }
}

/**
 * 资源图形（inline SVG）：原型 Board.resourceIcon 的纸雕简化版。
 * 图形 + 中文名 + 颜色三重表达，不依赖 emoji 或单一颜色。
 */
function resourceGlyph(res: Resource): string {
  const s = 'viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"';
  switch (res) {
    case 'wood': return `<svg ${s}><path d="M5 8.5 12 5l7 3.5-7 3.5Z"/><path d="M5 8.5v7L12 19l7-3.5v-7"/><path d="M12 12v7"/><circle cx="12" cy="8.5" r="1.4"/></svg>`;
    case 'brick': return `<svg ${s}><rect x="3.5" y="6" width="8" height="5" rx="1"/><rect x="12.5" y="6" width="8" height="5" rx="1"/><rect x="8" y="13" width="8" height="5" rx="1"/><path d="M6.5 6v5M16.5 6v5M12 13v5"/></svg>`;
    case 'sheep': return `<svg ${s}><path d="M6 10a3 3 0 0 1 3-3 3 3 0 0 1 3 1 3 3 0 0 1 3-1 3 3 0 0 1 3 3 3 3 0 0 1-1 5H8a3 3 0 0 1-2-5Z"/><circle cx="9" cy="12" r=".8" fill="currentColor" stroke="none"/><path d="M9 15v3M15 15v3"/></svg>`;
    case 'wheat': return `<svg ${s}><path d="M12 21V6"/><path d="M12 9 8 6M12 9l4-3M12 14 8 11M12 14l4-3"/><path d="M12 6c-2-1-2-3 0-4 2 1 2 3 0 4Z"/></svg>`;
    case 'ore': return `<svg ${s}><path d="M4 15 8 6l5 3 3-4 4 10Z"/><path d="M8 6l1 9M13 9l-1 6M16 5l-1 10"/></svg>`;
    default: return '';
  }
}

function seatColor(seat: number): { hex: string; light: boolean } {
  const order: Array<'red' | 'blue' | 'white' | 'orange'> = ['red', 'blue', 'white', 'orange'];
  const color = order[seat % order.length]!;
  return { hex: PLAYER_HEX[color], light: isLight(color) };
}

function escapeHtml(raw: string): string {
  return raw.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function escapeAttr(raw: string): string {
  return escapeHtml(raw);
}
