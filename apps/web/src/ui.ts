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
  type BuildMode,
} from './build.js';
import { geometryForTileKeys } from './geometry.js';
import type { ConnState } from './net.js';
import { candidateEdges, candidateVertices, setupInfo, setupSeats } from './placement.js';
import { robberTiles, stealCandidates } from './robber.js';
import { renderBoard, type BoardOverlay } from './scene.js';
import { isLight, PLAYER_HEX, TERRAIN_COLOR, TERRAIN_NAME, TERRAIN_SHORT } from './theme.js';

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

export interface UiCallbacks {
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

  constructor(private readonly cb: UiCallbacks) {
    initTooltips();
    this.btnRoll.addEventListener('click', () => {
      this.spinDice();
      this.cb.onRoll();
    });
    this.btnEnd.addEventListener('click', () => this.cb.onEndTurn());
    this.btnBuild.addEventListener('click', () => this.toggleBuild());
    this.btnTrade.addEventListener('click', () => this.toggleTrade());

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
      if (btn.dataset.action === 'steal' && this.pickedRobberTile) {
        const raw = btn.dataset.seat;
        const seat = raw === undefined || raw === '' ? undefined : Number(raw);
        const tile = this.pickedRobberTile;
        this.pickedRobberTile = null;
        this.cb.onMoveRobber(tile, seat);
      }
    });

    // 热区是整块 SVG 重画的，所以监听挂在 svg 上做事件委托，重画不会丢监听
    this.board.addEventListener('click', (ev) => this.onBoardClick(ev));

    window.addEventListener('resize', () => {
      if (this.view) this.paintBoard();
    });
  }

  // -------------------------------------------------------------- 连接状态

  setConnection(state: ConnState): void {
    this.connDot.classList.toggle('on', state === 'open');
    this.connDot.classList.toggle('off', state === 'dead');
    if (state === 'connecting' || state === 'reconnecting') {
      setText(this.feedTag, '连接');
      setText(this.feedText, state === 'reconnecting' ? '与服务器断开，正在重连…' : '正在连接服务器…');
      setText(this.turnText, '连接中…');
    }
    if (state === 'dead') {
      setText(this.feedTag, '离线');
      setText(this.feedText, '连接被拒绝');
    }
  }

  setRoom(roomId: string): void {
    setText(this.roomId, roomId.toUpperCase());
  }

  say(text: string, tag = '状态'): void {
    setText(this.feedTag, tag);
    setText(this.feedText, text);
  }

  // ------------------------------------------------------------------ 浮层

  showJoin(opts: { name: string; roomId: string; error?: string }): void {
    this.overlay.classList.remove('hidden');
    this.sheet.innerHTML = `
      <h1>进入牌桌</h1>
      <p class="sub">同一 WiFi 下，把地址发给朋友，各开一个浏览器窗口就能开局。</p>
      <form id="join-form">
        <div class="field">
          <label for="f-name">你的名字</label>
          <input id="f-name" maxlength="16" autocomplete="off" placeholder="例如：小满" value="${escapeAttr(opts.name)}">
        </div>
        <div class="field">
          <label for="f-room">房间号</label>
          <input id="f-room" maxlength="24" autocomplete="off" placeholder="main" value="${escapeAttr(opts.roomId)}">
        </div>
        <button class="btn primary" type="submit">加入</button>
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

    // 换人摆位了就丢掉半截操作：否则会出现「点过村庄、轮到别人」的幽灵状态
    const info = setupInfo(view);
    const sig = info ? `${info.step}:${info.seat}` : '';
    if (sig !== this.setupSig) {
      this.setupSig = sig;
      this.pickedVertex = null;
    }

    this.tableEmpty.classList.add('hidden');
    this.paintBoard();
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
    renderBoard(this.board, this.view, this.ensureGeo(this.view), this.boardOverlay(this.view), highlight);
    this.animated.board = true;
  }

  /** 掷 7 结算优先；其次摆位；再到建造模式 */
  private boardOverlay(view: PlayerView): BoardOverlay | undefined {
    // R-42：全员弃完牌后，掷骰者必须先挪强盗。此时棋盘只给地块热区
    if (view.pendingRobber && view.pendingDiscards.length === 0) {
      if (view.current !== view.viewer) return undefined;
      return {
        vertices: [],
        edges: [],
        picked: null,
        tiles: robberTiles(view, this.ensureGeo(view)),
        pickedTile: this.pickedRobberTile,
      };
    }
    const setup = this.setupOverlay(view);
    if (setup) return setup;
    if (this.buildMode) return buildOverlayFor(view, this.ensureGeo(view), this.buildMode);
    return undefined;
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

  private onBoardClick(ev: MouseEvent): void {
    const view = this.view;
    if (!view) return;

    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;

    // 掷 7 结算：先点地块，再由结算条挑一位玩家抽牌
    if (view.pendingRobber && view.pendingDiscards.length === 0) {
      if (view.current !== view.viewer) return;
      const tileEl = target.closest('[data-tile]');
      const key = tileEl?.getAttribute('data-tile');
      if (!key) return;
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

  /** 退出建造模式：收面板、撤热区 */
  private exitBuild(): void {
    this.buildMode = null;
    this.buildMenuOpen = false;
    this.paintBuild();
    if (this.view) this.paintBoard();
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

    this.buildMenuOpen = !this.buildMenuOpen;
    this.paintBuild();
  }

  /** 供自动化验收使用：直接进入某种建造模式（等价于点面板上的那一项） */
  openBuild(mode: BuildMode): void {
    this.pickBuild(mode);
  }

  private pickBuild(mode: BuildMode): void {
    this.buildMode = mode;
    this.buildMenuOpen = false;
    this.paintBuild();
    if (this.view) this.paintBoard();
    this.say(`点一个发亮的位置放${BUILD_LABEL[mode]}`, '建造');
  }

  /** 建造菜单：三种建造、成本、以及缺什么（缺的资源标红并禁用） */
  private paintBuild(): void {
    const view = this.view;

    if (!view || view.phase !== 'play' || view.pendingRobber || !this.buildMenuOpen) {
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
    if (this.view) {
      this.paintTrade(this.view);
      this.paintOfferBar(this.view);
    }
  }

  /** 供自动化验收使用：直接展开交易面板 */
  openTrade(): void {
    if (!this.tradeOpen) this.toggleTrade();
  }

  private toggleTrade(): void {
    const view = this.view;
    if (!view || view.phase !== 'play') return;

    this.tradeOpen = !this.tradeOpen;
    if (this.tradeOpen) {
      // 三个面板同位置，开一个就关掉别的
      this.exitBuild();
      this.givePick = emptyPick();
      this.getPick = emptyPick();
      this.tradeTarget = -1;
    }
    this.paintTrade(view);
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
    if (!this.tradeOpen || view.phase !== 'play' || view.pendingRobber) {
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
  private paintOfferBar(view: PlayerView): void {
    const offer = this.offer;
    if (!offer) {
      this.offerBar.classList.add('hidden');
      if (this.offerBar.innerHTML) this.offerBar.innerHTML = '';
      return;
    }

    this.offerBar.classList.remove('hidden');

    const desc = (res: Partial<ResourceCount>): string => {
      const parts = DISCARD_ORDER.filter((r) => (res[r] ?? 0) > 0).map(
        (r) => `${RESOURCE_LABEL[r]}${res[r]}`,
      );
      return parts.length > 0 ? parts.join(' ') : '无';
    };

    const mine = offer.to === view.viewer;
    const own = offer.from === view.viewer;
    const actions = mine
      ? '<button id="offer-accept" class="primary">接受</button><button id="offer-reject">拒绝</button>'
      : own
        ? '<button id="offer-cancel">撤回</button>'
        : '';

    const more = this.offers.length > 1 ? ` · 共 ${this.offers.length} 条待处理` : '';
    this.offerBar.innerHTML = `
      <span class="ob-text"><b>${escapeHtml(playerName(view, offer.from))}</b> 给 <b>${desc(offer.give)}</b>，要 <b>${desc(offer.get)}</b> · 对 ${escapeHtml(playerName(view, offer.to))}${more}</span>
      <span class="ob-actions">${actions}</span>
    `;

    // 每个按钮都钉死当前展示报价的 ID：报价被替换/过期后，旧按钮不会指向新报价
    this.offerBar
      .querySelector<HTMLButtonElement>('#offer-accept')
      ?.addEventListener('click', () => this.cb.onOfferAccept(offer.id));
    this.offerBar
      .querySelector<HTMLButtonElement>('#offer-reject')
      ?.addEventListener('click', () => this.cb.onOfferReject(offer.id));
    this.offerBar
      .querySelector<HTMLButtonElement>('#offer-cancel')
      ?.addEventListener('click', () => this.cb.onOfferCancel(offer.id));
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
      this.robberbar.innerHTML = `
        <div class="rb-title">掷出 7 · 移动强盗</div>
        <div class="rb-desc">点棋盘上红框的地块放置强盗（不能留原地，可放沙漠、可放自己旁边）；这块地会一直停产，直到强盗被移走。</div>`;
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
    const rows = view.players.map((p) => {
      const color = PLAYER_HEX[p.color];
      const light = isLight(p.color);
      const isCurrent = view.phase !== 'ended' && view.current === p.index;
      let bars = '';
      for (let i = 0; i < 10; i++) bars += `<i class="${i < p.score ? 'on' : ''}"></i>`;

      const flags: string[] = [];
      if (isCurrent) flags.push('<span class="flag">当前</span>');
      if (view.longestRoad?.player === p.index) flags.push('<span class="flag dim">最长路</span>');
      if (view.largestArmy?.player === p.index) flags.push('<span class="flag dim">最大军</span>');

      return `
        <div class="player${isCurrent ? ' active' : ''}${p.index === view.viewer ? ' me' : ''}">
          <div class="ava${light ? ' light' : ''}" style="--c:${color}">${escapeHtml(p.name.slice(0, 1))}</div>
          <div class="pinfo">
            <div class="pname">${escapeHtml(p.name)}${flags.join('')}</div>
            <div class="pmeta">手牌 ${p.handSize} 张 · 发展卡 ${p.devCardCount}${p.playedKnights ? ` · 骑士 ${p.playedKnights}` : ''}</div>
            <div class="ptrack" style="--c:${color}">${bars}</div>
          </div>
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
    const cnt = HAND_ORDER.length;
    setText(this.handTotal, `${view.me.handSize} 张`);
    if (this.animated.hand) this.hand.classList.add('no-anim');
    this.hand.innerHTML = HAND_ORDER.map((res, i) => {
      const n = view.me.resources[res] ?? 0;
      const off = i - (cnt - 1) / 2;
      const rot = (off * 5.5).toFixed(1);
      const lift = Math.abs(off) * 5;
      const light = res === 'wheat';
      return `
        <div class="card${n === 0 ? ' empty' : ''}" style="--rot:${rot}deg;--lift:${lift}px;animation-delay:${i * 60}ms">
          <div class="cband${light ? ' light' : ''}" style="background:${TERRAIN_COLOR[res]}">${TERRAIN_SHORT[res]}</div>
          <div class="cnum">${n}</div>
          <div class="cname">${TERRAIN_NAME[res]}</div>
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
    // 变体 V-1：掷骰只是「本回合必须发生」，不限定发生在哪个阶段。
    // 建造与交易都不要求先掷骰，只认「自己的回合 + 没有结算锁」。
    this.btnBuild.disabled = !(myTurn && !locked && !robberPending);
    this.btnTrade.disabled = !(myTurn && !locked && !robberPending);
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
