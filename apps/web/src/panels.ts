/**
 * 阶段 D 新增面板层（指南 4.1 / 6 / 7.4 / 8.3 / 9.3 / 10.1）。
 *
 * 与 ui.ts 分工：ui.ts 继续管棋盘、摆位、弃牌、强盗与既有面板的渲染；
 * 本模块管抽屉、确认条、情境提示、第 6 节新增入口、多报价列表、帮助与结束界面。
 * 规则一律由服务端裁决，这里只做「展示 + 收集意图」。
 */

import { RESOURCES, type PlayerView, type Resource, type ResourceCount } from '@hexfront/engine';
import type { OfferSnapshot, OfferView } from '@hexfront/protocol';
import type { ReconcilePhase } from './net.js';
import { RESOURCE_LABEL } from './build.js';
import { geometryForTileKeys } from './geometry.js';
import { stealCandidates } from './robber.js';

export type PanelName =
  | 'build' | 'trade' | 'offers' | 'dev' | 'bank' | 'port'
  | 'knight' | 'monopoly' | 'plenty' | 'roads' | 'help' | null;

export interface ConfirmOptions {
  title: string;
  detail?: string;
  confirmText?: string;
  disabled?: boolean;
  onConfirm(): void;
  onCancel?(): void;
  /** 候选消歧：给两个明确按钮，不替用户挑 */
  candidates?: { label: string; onPick(): void }[];
}

export interface PanelCallbacks {
  onBuyDev(): void;
  onPlayKnight(tile: string, stealFrom?: number): void;
  onPlayMonopoly(resource: Resource): void;
  onPlayPlenty(a: Resource, b: Resource): void;
  onPlayRoadBuilding(edges: [string, string?]): void;
  /** F5：银行严格 4 张同类换 1 张指定资源 */
  onTradeBank(give: Resource, get: Resource): void;
  /** F5：自有港口兑换，give 是资源袋（通用港可混合），port 为港口边 key */
  onTradePort(port: string, give: Partial<ResourceCount>, get: Resource): void;
  onOffer(to: number, give: Partial<ResourceCount>, get: Partial<ResourceCount>): void;
  onOfferAccept(offerId: string): void;
  onOfferReject(offerId: string): void;
  onOfferCancel(offerId: string): void;
  onEndTurn(): void;
  /** 返回前台后请求核对状态（不自动重放离线期间的操作） */
  onResume(): void;
  /** 需要在棋盘上选点：由 Ui 切换候选并调用 done */
  onRequestPick(kind: 'tile' | 'edges', purpose: string, done: (keys: string[]) => void): void;
}

const RES_NAME: Record<Resource, string> = {
  wood: '木材', brick: '砖块', sheep: '羊毛', wheat: '麦子', ore: '矿石',
};
const DEV_NAME: Record<string, string> = {
  knight: '骑士', victory: '胜利点', monopoly: '垄断', plenty: '丰饶', roadbuilding: '筑路',
};

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少 DOM 节点 #${id}`);
  return el as T;
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function setText(id: string, s: string): void {
  byId(id).textContent = s;
}
function fmt(c: Partial<ResourceCount>): string {
  const parts = RESOURCES.filter((r) => (c[r] ?? 0) > 0).map((r) => `${RESOURCE_LABEL[r]}×${c[r]}`);
  return parts.length ? parts.join(' + ') : '无';
}
function countOf(c: Partial<ResourceCount>): number {
  return RESOURCES.reduce((n, r) => n + (c[r] ?? 0), 0);
}

/**
 * C1：全局唯一旋转方向常量（+90deg 顺时针自转）。
 * 真机复核 A-13 若发现目标人群习惯相反，只翻这一处：data-landscape-dir、
 * CSS 分支 / --ul-rotation / 安全区映射、相机角度、转向文案方向词、箭头镜像
 * 全部由它派生；状态机、阶段判定、出口、可访问性与验收条目一律不变。
 */
export const LANDSCAPE_ROTATION: 0 | 90 | -90 = 90;
const TURN_WORD = LANDSCAPE_ROTATION === 90 ? '向左' : '向右';

/** C2 / C3 玩家文案：方向词从唯一常量派生，无 API/技术黑话、不引导改系统设置 */
export const HINT_COPY = {
  main: `把手机${TURN_WORD}横过来，棋盘就正了`,
  sub: '页面已替你转好，不用改手机设置，也不会退出房间。',
  unsupported: `这个浏览器不能自动横屏，页面已替你铺好横屏棋盘；把手机${TURN_WORD}横过来就能玩。`,
  rejected: `这个浏览器没允许切换方向，页面已替你铺好横屏棋盘；把手机${TURN_WORD}横过来就能玩。`,
  fallback: `页面已替你铺好横屏棋盘，把手机${TURN_WORD}横过来就能玩；不用改手机设置，也不会退出房间。`,
} as const;

/**
 * ULS：老 WebView（部分华为 / 夸克 / 微信 X5）不认 dvh/dvw，
 * 这时才由 JS 量 px 写进 --ul-vw/--ul-vh；现代浏览器交给 CSS 动态视口单位。
 * 用 CSS.supports 而不是 UA 嗅探，避免误判。
 */
function detectDvhSupport(): boolean {
  try {
    const css = (globalThis as unknown as {
      CSS?: { supports?: (prop: string, value: string) => boolean };
    }).CSS;
    return typeof css?.supports === 'function' && css.supports('height', '100dvh');
  } catch {
    return false;
  }
}

/**
 * 收件人视角转换（纯函数，单测覆盖）：
 * 发起人的 give 是「我收到」，get 是「我付出」。不能把发起人的「我给」直接当成收件人的「我给」。
 */
export function offerPerspective(
  o: Pick<OfferView, 'from' | 'to' | 'give' | 'get'>, viewer: number,
): { mine: boolean; own: boolean; iGive: Partial<ResourceCount>; iGet: Partial<ResourceCount> } {
  const mine = o.to === viewer;
  return {
    mine,
    own: o.from === viewer,
    iGive: mine ? o.get : o.give,
    iGet: mine ? o.give : o.get,
  };
}

/** 报价对象权限（指南 7.1）：当前玩家任意人；非当前玩家只能当前玩家 */
export function offerTargets(view: PlayerView): number[] {
  const others = view.players.filter((p) => p.index !== view.viewer).map((p) => p.index);
  return view.current === view.viewer ? others : others.filter((i) => i === view.current);
}

/**
 * D-05：发送按钮的唯一条件计算。tick()、renderOffers()、setConnected()、
 * setView()、setOffers() 全部走这里，杜绝「定时更新只算冷却，把别的禁用理由抹掉」。
 * 这里只是界面提示；服务端 makeOffer 仍独立做权限 / 冷却 / 内容校验（指南 7.2）。
 */
export interface SendGateInput {
  connected: boolean;
  phase: PlayerView['phase'];
  discardLock: boolean;
  pendingSend: boolean;
  targets: number[];
  target: number;
  give: Partial<ResourceCount>;
  get: Partial<ResourceCount>;
  cooldownMsLeft: number;
}
export interface SendGateResult { disabled: boolean; label: string }

export function offerSendGate(i: SendGateInput): SendGateResult {
  if (!i.connected) return { disabled: true, label: '连接未同步' };
  if (i.phase !== 'play') return { disabled: true, label: '当前阶段不能报价' };
  if (i.discardLock) return { disabled: true, label: '弃牌中不能报价' };
  if (i.pendingSend) return { disabled: true, label: '已发送，等待服务端…' };
  if (i.cooldownMsLeft > 0) {
    return { disabled: true, label: `发送冷却 ${(i.cooldownMsLeft / 1000).toFixed(1)}s` };
  }
  if (!i.targets.includes(i.target)) return { disabled: true, label: '先选报价对象' };
  if (countOf(i.give) + countOf(i.get) === 0) return { disabled: true, label: '发送报价' };
  return { disabled: false, label: '发送报价' };
}

export class Panels {
  private readonly shell = byId('shell');
  private readonly drawer = byId('drawer');
  private readonly drawerTitle = byId('drawer-title');
  private readonly drawerBody = byId('drawer-body');
  private readonly drawerFoot = byId('drawer-foot');
  private readonly extra = byId('extra-panel');
  private readonly confirmStrip = byId('confirm-strip');
  private readonly situation = byId('situation');
  private readonly toastEl = byId('toast');
  private readonly railActions = byId('rail-actions');
  private readonly endScreen = byId('end-screen');
  private readonly portraitGate = byId('portrait-gate');
  private readonly blockedReason = byId('blocked-reason');
  private readonly offerBar = byId('offer');

  private view: PlayerView | null = null;
  private snapshot: OfferSnapshot | null = null;
  private serverOffset = 0;
  private connected = false;
  private mode: PanelName = null;
  private focusReturn: HTMLElement | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * F6 报价草稿：两步编辑（第一步「我想收到」= get，第二步「我愿给出」= give）。
   * 协议语义不变：give 是发起方付出、get 是发起方收到。
   * offerStep 只在「发起报价」里切换，切换/关闭/重绘都不重置草稿。
   */
  private draft = {
    target: -1,
    give: {} as Partial<ResourceCount>,
    get: {} as Partial<ResourceCount>,
  };
  private offerStep: 1 | 2 = 1;
  /** D-05：刚点过发送、还没等到服务端 OFFERS 快照 —— 本地防重复点击（不替代服务端冷却） */
  private pendingSend = false;
  private pendingSendTimer: ReturnType<typeof setTimeout> | null = null;
  /** D-06：回前台核对状态，只影响提示与禁用，不参与任何规则判断 */
  private reconcilePhase: ReconcilePhase | 'idle' = 'idle';

  // ---------------------------------------------------------------- ULS 横屏状态机 S0–S8
  // 唯一真相只有三个输入：是否在对局（P）、用户是否退出（forced）、视口是否竖屏（V∧D）。
  // 系统方向锁定成功与否不直接改 mode：lock 真把视口变横屏时，
  // resize/orientationchange 会把 mode 推到 system 并撤掉 CSS 旋转；
  // lock 静默失败也不会出现「假装成功」的空窗 —— CSS 旋转始终兜底。
  private inGame = false;
  /** C4：会话内标记，允许强制自转/锁定/提示；出口置 false、恢复入口置 true。
   *  只存内存、不写 localStorage，刷新重置；语义扩展到「不再强制自转/锁定/提示」。 */
  private forced = true;
  /** C4：转向提示一次会话只弹一次（S5 回落 / S7↔S8 / resize / 切后台均不复活） */
  private hintShown = false;
  /** C7 搭车尝试一次机会，只借一次手势，绝不反复请求 */
  private gestureLockTried = false;
  /** 转向提示已淡出或被「知道了」收起：正立层只留常驻状态条，resize 不得复活 */
  private tipClosed = false;
  /** 一次性提示的不可绕过守卫：整个会话只允许渲染一次（防御未来改动复活提示） */
  private hintStripRendered = false;
  private landscapeMode: 'off' | 'css' | 'system' = 'off';
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly supportsDvh: boolean;

  /**
   * D-03：把「一次操作的生命周期」显式建模。
   * step=1 选点、step=2 展示/提交当前步骤；只有「开始新操作」才初始化，
   * 普通的展示 / 恢复 / 广播重绘绝不无条件清空选点结果。
   */
  private knightStep: 1 | 2 = 1;
  private roadsStep: 1 | 2 = 1;
  private knightTile: string | null = null;
  private pickEdges: string[] = [];
  // F5：银行给出/收到；港口选择（边 key）+ 给出资源袋（可混合）+ 收到资源
  private bankGive: Resource = 'wood';
  private bankGet: Resource = 'brick';
  private portEdge = '';
  private portGive: Partial<ResourceCount> = {};
  private portGet: Resource = 'brick';
  private plenty: [Resource, Resource] = ['wood', 'wood'];
  private monopolyRes: Resource = 'wood';

  constructor(
    private readonly cb: PanelCallbacks,
    /** 旋转模式/方向变化时通知 Ui 重新测量棋盘几何（不重置相机与选点） */
    private readonly onLayoutChange: () => void = () => {},
  ) {
    this.supportsDvh = detectDvhSupport();
    // C1/C2：方向词与主/副文案由唯一常量派生，写进不旋转层的 DOM
    setText('landscape-hint-main', HINT_COPY.main);
    setText('portrait-hint', HINT_COPY.sub);
    byId('drawer-close').addEventListener('click', () => this.close());
    byId('btn-help').addEventListener('click', () => this.open('help'));
    byId('portrait-help').addEventListener('click', () => this.open('help'));
    // 两个「仍按竖屏查看」入口：旧卡片 id 保留（隐藏），正立层里的才是主出口
    byId('portrait-dismiss').addEventListener('click', () => this.dismissPortrait());
    byId('landscape-exit').addEventListener('click', () => this.dismissPortrait());
    byId('landscape-resume').addEventListener('click', () => this.resumeLandscape());
    byId('landscape-hint-close').addEventListener('click', () => this.dismissHint());
    // C7：可选 44px 方向入口 + 旧按钮，都只是「手动重试一次」，不消费游戏点击
    byId('btn-orientation').addEventListener('click', () => this.requestLandscape());
    byId('end-back').addEventListener('click', () => {
      // E6 / A-7：回到房间时退出自转回 S0 竖屏，避免回房输入侧躺
      this.setInGame(false);
      this.endScreen.classList.add('hidden');
      this.open('help');
    });
    byId('btn-motion').addEventListener('click', (ev) => {
      const btn = ev.currentTarget as HTMLElement;
      const on = this.shell.dataset.reduceMotion !== '1';
      this.shell.dataset.reduceMotion = on ? '1' : '0';
      btn.setAttribute('aria-pressed', String(on));
      this.syncHudMotion();
      this.toast(on ? '已减少动态效果：保留静态高亮与文字' : '已恢复动效');
    });
    byId('btn-buy-dev').addEventListener('click', () => this.confirmBuyDev());
    this.railActions.addEventListener('click', (ev) => this.onRailAction(ev));
    this.drawerBody.addEventListener('click', (ev) => this.onBodyClick(ev));
    // F6：整数滑条拖动用 input/change（不是 click），单独委托，按同一套上限钳制
    const onRange = (ev: Event): void => {
      const el = ev.target as { dataset?: DOMStringMap; value?: string } | null;
      if (!el || el.dataset?.act !== 'offer-qty') return;
      const side = el.dataset.side === 'give' ? 'give' : 'get';
      const res = el.dataset.val as Resource;
      if (!RESOURCES.includes(res)) return;
      const raw = Number(el.value ?? 0);
      const bag = side === 'give' ? this.draft.give : this.draft.get;
      const max = side === 'give' ? (this.view?.me.resources[res] ?? 0) : 99;
      bag[res] = Math.max(0, Math.min(max, Number.isFinite(raw) ? Math.floor(raw) : 0));
      this.renderOfferDraft();
    };
    this.drawerBody.addEventListener('input', onRange);
    this.drawerBody.addEventListener('change', onRange);
    this.drawerFoot.addEventListener('click', (ev) => this.onFootClick(ev));
    this.confirmStrip.addEventListener('click', (ev) => this.onConfirmClick(ev));
    this.offerBar.addEventListener('click', () => this.open('offers'));
    byId('portrait-landscape').addEventListener('click', () => this.requestLandscape());
    // 方向 / 尺寸 / 视觉视口变化立刻重算，不等下一帧 STATE（指南 4.2）。
    // visualViewport 在软键盘收起、地址栏伸缩、WebView 缩放时比 resize 更及时。
    const onViewportChange = (): void => { this.measureViewport(); this.updateLandscape(); };
    window.addEventListener('orientationchange', onViewportChange);
    window.addEventListener('resize', onViewportChange);
    const vv = (window as unknown as {
      visualViewport?: { addEventListener?: (t: string, f: () => void) => void };
    }).visualViewport;
    if (vv && typeof vv.addEventListener === 'function') {
      vv.addEventListener('resize', onViewportChange);
      vv.addEventListener('scroll', onViewportChange);
    }
    // 页面一加载就按当前方向决定显隐：S0 入房阶段不旋转、不弹卡片、不弹任何转向提示；
    // 开局（P 成立）后由 updateLandscape 瞬时进入 S2，不在 S1 退化布局停留。
    this.measureViewport();
    this.updateLandscape();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.cb.onResume();
    });
    this.ticker = setInterval(() => this.tick(), 200);
  }

  // ------------------------------------------------------------------ 状态入口

  setView(view: PlayerView): void {
    this.view = view;
    // 权威更新不重置旋转状态；只按最新方向/阶段重算一次（幂等，不改 inGame）
    this.updateLandscape();
    // D-03：权威更新后复查本地选点：仍合法则保留，失效则清掉并解释（指南 5.3）
    this.revalidatePicks(view);
    this.render();
    // 当前打开的是多步面板时，按最新步骤重绘（不会清空有效选点）
    if (this.mode === 'knight' || this.mode === 'roads') this.renderPanel(this.mode);
    // D-05：回合/弃牌锁变化后按钮状态及时更新
    this.refreshSendButton();
  }

  setOffers(snapshot: OfferSnapshot): void {
    const prevVersion = this.snapshot?.version ?? -1;
    this.snapshot = snapshot;
    // 服务端时间差：客户端不改本机时钟也改不了服务端有效期
    this.serverOffset = snapshot.serverTime - Date.now();
    // 服务端确认了新快照：解除本地「等待确认」防连点（真正冷却由 nextSendAt 决定）
    if (snapshot.version !== prevVersion) this.clearPendingSend();
    if (this.mode === 'offers') this.syncOfferCards();
    this.render();
    this.refreshSendButton();
  }

  setConnected(ok: boolean): void {
    this.connected = ok;
    this.shell.dataset.connected = ok ? '1' : '0';
    this.render();
    this.refreshSendButton();
  }

  /** D-06：核对完成前给出清晰、持久的连接状态；禁用由 data-connected=0 统一处理 */
  setReconciling(phase: ReconcilePhase, detail?: string): void {
    this.reconcilePhase = phase;
    this.shell.dataset.reconciling = phase === 'checking' ? '1' : '0';
    if (phase === 'checking') {
      // 核对期间禁止会改变对局的操作（服务端仍是唯一裁决者）
      this.connected = false;
      this.shell.dataset.connected = '0';
      this.say(detail ?? '正在核对服务端权威状态', '恢复', true);
    } else if (phase === 'stalled') {
      this.say(detail ?? '暂时无法核对，仍在自动重连', '恢复', true);
    } else {
      this.say(detail ?? '已核对服务端权威状态与报价', '恢复');
    }
    this.render();
    this.refreshSendButton();
  }

  get isConnected(): boolean { return this.connected; }
  get currentMode(): PanelName { return this.mode; }
  get reconcileState(): ReconcilePhase | 'idle' { return this.reconcilePhase; }

  // ---------------------------------------------------------------- ULS：横屏状态机 S0–S8

  /** 相机拿它把 clientX/clientY 反解回未变换坐标；角度来自 C1 的唯一常量 */
  get landscapeRotation(): 0 | 90 | -90 {
    return this.landscapeMode === 'css' ? LANDSCAPE_ROTATION : 0;
  }

  get landscapeState(): 'off' | 'css' | 'system' { return this.landscapeMode; }
  /** C4：会话内标记，供评审与行为测试读取（tipClosed=一次性提示是否已收尾） */
  get landscapeMemory(): { forced: boolean; hintShown: boolean; tipClosed: boolean; tipRendered: boolean } {
    return {
      forced: this.forced,
      hintShown: this.hintShown,
      tipClosed: this.tipClosed,
      tipRendered: this.hintStripRendered,
    };
  }

  /**
   * 阶段信号落在「是否有 PlayerView / 入房浮层是否隐藏」（要点 1）：
   * Ui.render 同时覆盖带 view 的 WELCOME 恢复快照与 STATE；
   * showJoin / showLobby / showFatal / 回到房间传 false，S0 不干预、保软键盘。
   */
  setInGame(active: boolean): void {
    if (this.inGame === active) return;
    this.inGame = active;
    this.updateLandscape();
  }

  /**
   * C7「对局中已有手势搭车」：由 Ui.handleBoardTap 在一次干净抬手时通知，只做一次
   * lock 尝试。不 requestFullscreen、不 preventDefault / stopPropagation、不改 mode、
   * 不弹提示、不重试 —— 完全不改变也不消费这次点击的游戏语义；失败就静默留在自转
   * （S5），成功则由 resize / orientationchange 自然迁移到 S4。iOS 无 API 时直接跳过。
   */
  noticeGameGesture(): void {
    if (this.gestureLockTried || this.landscapeMode !== 'css') return;
    type OrientationWithLock = { lock?: (o: string) => Promise<void> };
    const api = typeof screen === 'undefined'
      ? undefined
      : (screen.orientation as unknown as OrientationWithLock | undefined);
    if (!api || typeof api.lock !== 'function') return;
    this.gestureLockTried = true;
    try { Promise.resolve(api.lock('landscape')).catch(() => undefined); }
    catch { /* 静默留在 CSS 自转，绝不打断这次操作 */ }
  }

  /** C5 / §4.3：恢复入口（正立层 + 帮助面板），只恢复强制位。
   *  `tipClosed` / `hintShown` 属于「转向提示自身的生命周期」，恢复入口**一律不碰**，
   *  否则会用副作用掩盖「提示只能出现一次」的不变量（A-9 / A-10 / UL-UX09-10）。 */
  resumeLandscape(): void {
    this.forced = true;
    this.updateLandscape();
    this.toast(`已重新铺成横屏；请把手机${TURN_WORD}横过来`);
  }

  /** 转向提示「知道了」：只收起，不重置 hintShown，S7↔S8 来回切也不复活 */
  private dismissHint(): void {
    this.clearHintTimers();
    this.tipClosed = true;
    const hud = byId('landscape-hud');
    hud.classList.remove('fading');
    hud.classList.add('lh-settled');
  }

  /**
   * 单一决策入口（S0/S2/S4/S6/S7/S8）：
   *   mode = (!inGame || !forced) ? 'off' : (portrait ? 'css' : 'system')
   * 只在 mode 真变化时才回调 Ui 重算几何，避免 relayout→setView→updateLandscape 递归。
   * S1 不停留（同步迁移）；S3 期间 mode 不变（保持自转、不闪、不阻断操作）；
   * S5 与 S2 完全同态（不重试、不重复弹提示）。
   */
  private updateLandscape(): void {
    // F3：桌面视口（≥1280×720）一律走桌面专用流程 —— 不整页自转、不方向锁、
    // 不弹任何转向提示。手机竖屏的历史 ULS 状态机仅在 <700px 视口保留（归档范围），
    // 不再作为桌面发布门槛；相机缩放/平移/resize 与本短路完全无关，照常保留。
    const desktop = this.isDesktopViewport();
    const portraitPhone = !desktop && this.isPortraitPhone();
    const portraitViewport = !desktop && this.isPortraitViewport();
    const next: 'off' | 'css' | 'system' = desktop || !this.inGame || !this.forced
      ? 'off'
      : (portraitPhone ? 'css' : (portraitViewport ? 'off' : 'system'));
    const changed = next !== this.landscapeMode;
    this.landscapeMode = next;
    this.shell.dataset.landscapeMode = next;
    // C1：dir / --ul-rotation / 箭头镜像 / 转向词 / 安全区映射全部由唯一常量派生
    const dir = LANDSCAPE_ROTATION === 90 ? 'cw' : 'ccw';
    this.shell.dataset.landscapeDir = dir;
    this.shell.style.setProperty('--ul-rotation', `${LANDSCAPE_ROTATION}deg`);
    byId('landscape-hud').dataset.landscapeDir = dir;

    this.syncPortraitGate();
    this.syncHud(portraitPhone, next);
    this.syncHudMotion();
    this.syncDesktopGate();

    // S2 首次进入：转向提示一次会话只弹一次；iOS 等无 lock 浏览器顺带并入 C3 ① 文案
    if (next === 'css' && !this.hintShown) {
      this.hintShown = true;
      this.showHintStrip();
      if (!this.hasOrientationLock()) this.showLandscapeHint(HINT_COPY.unsupported);
    }
    if (changed) this.onLayoutChange();
  }

  /** 正立层：S2/S6 常驻状态摘要与出口/恢复入口；S0/S4/S7 隐藏 */
  private syncHud(portrait: boolean, mode: 'off' | 'css' | 'system'): void {
    const hud = byId('landscape-hud');
    const show = this.inGame && portrait && mode !== 'system';
    hud.classList.toggle('hidden', !show);
    if (!show) { this.clearHintTimers(); return; }
    // S6（forced=off）或提示已淡出/退出：只留状态条 + 出口/恢复入口，绝不复活转向提示
    const settled = mode !== 'css' || !this.forced || this.tipClosed;
    // 若淡出中途被打断（resume / 退出），清掉 fading 免得卡在 opacity:0；
    // 正在进行的淡出（有 fadeTimer）不打断。
    if (settled && !this.fadeTimer) hud.classList.remove('fading');
    hud.classList.toggle('lh-settled', settled);
    byId('landscape-exit').classList.toggle('hidden', mode !== 'css');
    byId('landscape-resume').classList.toggle('hidden', this.forced);
  }

  /**
   * 一次性转向提示，约 5s 后淡出（≤200ms）；减少动效时静态停留后直接收起。
   * 硬约束：一次会话只会渲染一次 —— `hintStripRendered` 是不可绕过的守卫，
   * 任何后续路径（退出/恢复、S7↔S8、resize、切后台）都不得复活（A-10 / UL-UX09-10）。
   */
  private showHintStrip(): void {
    if (this.hintStripRendered) return;
    this.hintStripRendered = true;
    const hud = byId('landscape-hud');
    this.tipClosed = false;
    hud.classList.remove('hidden', 'fading', 'lh-settled');
    setText('landscape-hint-main', HINT_COPY.main);
    setText('portrait-hint', HINT_COPY.sub);
    byId('portrait-hint').classList.remove('hidden');
    this.armHintTimer(5000);
  }

  private armHintTimer(ms: number): void {
    this.clearHintTimers();
    this.hintTimer = setTimeout(() => this.fadeHintStrip(), ms);
  }

  private fadeHintStrip(): void {
    this.hintTimer = null;
    this.tipClosed = true;
    const hud = byId('landscape-hud');
    const settle = (): void => {
      hud.classList.remove('fading');
      hud.classList.add('lh-settled');
      this.fadeTimer = null;
    };
    if (this.reduceMotion()) settle();
    else { hud.classList.add('fading'); this.fadeTimer = setTimeout(settle, 180); }
  }

  private clearHintTimers(): void {
    if (this.hintTimer) { clearTimeout(this.hintTimer); this.hintTimer = null; }
    if (this.fadeTimer) { clearTimeout(this.fadeTimer); this.fadeTimer = null; }
  }

  /** 要点 9：把应用内减少动效开关同步到 shell 之外的正立层（[data-reduce-motion] * 覆盖不到） */
  private syncHudMotion(): void {
    byId('landscape-hud').classList.toggle('reduce-motion', this.reduceMotion());
  }

  private reduceMotion(): boolean {
    const app = this.shell.dataset.reduceMotion === '1';
    const sys = typeof matchMedia === 'function'
      && !!matchMedia('(prefers-reduced-motion: reduce)').matches;
    return app || sys;
  }

  /**
   * C3 / §6.1：降级说明并入正立层，不另开卡片、不叠加 toast、不重试。
   * 提示条还在 → 就地替换副句；已淡出 → 并入常驻状态摘要一行，不重弹转向提示。
   */
  private showLandscapeHint(text: string): void {
    const hint = byId('portrait-hint');
    hint.textContent = text;
    hint.classList.remove('hidden');
    const hud = byId('landscape-hud');
    if (this.tipClosed || hud.classList.contains('hidden')) {
      setText('landscape-hint-status', text);
    }
  }

  /**
   * 旧 WebView（部分华为 / 夸克 / 微信 X5）不认 dvh/dvw：用 JS 量出的 px 写进
   * --ul-vw / --ul-vh，CSS 用 var(--ul-vw, 100dvw) 兜底。支持 dvh 的现代浏览器
   * 不写这两个变量，交给动态视口单位，地址栏伸缩时无需 JS 参与。
   */
  private measureViewport(): void {
    const w = typeof innerWidth === 'number' ? innerWidth : 0;
    const h = typeof innerHeight === 'number' ? innerHeight : 0;
    if (this.supportsDvh || w <= 0 || h <= 0) return;
    const style = (document.documentElement as HTMLElement).style;
    style.setProperty('--ul-vw', `${w}px`);
    style.setProperty('--ul-vh', `${h}px`);
  }

  /**
   * 要点 2：复用 matchMedia('(orientation: portrait)').matches && innerWidth <= 700，
   * 不改用 max-width:900px（指南 §14.1）。个别 OEM 浏览器 matchMedia 撒谎时用真实
   * 宽高兜底；设备类不依赖 UA / pointer: coarse（其取值需实机复核，不得误排除手机）。
   * 平板竖屏（短边 ≥768）与桌面/分屏都不进入自转，但仍能区分「视口是竖屏」还是
   * 「视口真是横屏」——前者给 off、后者给 system。
   */
  private isPortraitViewport(): boolean {
    const w = typeof innerWidth === 'number' ? innerWidth : 0;
    const h = typeof innerHeight === 'number' ? innerHeight : 0;
    const byMedia = typeof matchMedia === 'function' && matchMedia('(orientation: portrait)').matches;
    const bySize = w > 0 && h > 0 && h > w;
    const sizeSaysLandscape = w > 0 && h > 0 && w > h;
    return sizeSaysLandscape ? false : (byMedia || bySize);
  }

  private isPortraitPhone(): boolean {
    const w = typeof innerWidth === 'number' ? innerWidth : 0;
    return this.isPortraitViewport() && (w > 0 ? w <= 700 : true);
  }

  /**
   * F3（文档 24 §5）：桌面最低验收 1280×720，主尺寸 1440×900。
   * 桌面视口一律走「桌面专用流程」：不整页自转、不方向锁、不弹转向提示。
   * 相机模块的缩放/平移/resize 完全保留（与本短路无关）。
   */
  static readonly DESKTOP_MIN_W = 1280;
  static readonly DESKTOP_MIN_H = 720;
  isDesktopViewport(): boolean {
    const w = typeof innerWidth === 'number' ? innerWidth : 0;
    const h = typeof innerHeight === 'number' ? innerHeight : 0;
    return w >= Panels.DESKTOP_MIN_W && h >= Panels.DESKTOP_MIN_H;
  }

  /** 低于支持视口且非手机 → 桌面门槛提示（不旋转整页、不强制全屏）。节点静态存在于 index.html */
  private syncDesktopGate(): void {
    const gate = document.getElementById('desktop-gate') as HTMLElement | null;
    if (!gate) return;
    const w = typeof innerWidth === 'number' ? innerWidth : 0;
    const h = typeof innerHeight === 'number' ? innerHeight : 0;
    const tooSmall = w > 0 && h > 0 && (w < Panels.DESKTOP_MIN_W || h < Panels.DESKTOP_MIN_H);
    const phone = w > 0 && w <= 700;
    gate.classList.toggle('hidden', !tooSmall || phone);
  }

  private hasOrientationLock(): boolean {
    type OrientationWithLock = { lock?: (o: string) => Promise<void> };
    const api = typeof screen === 'undefined'
      ? undefined
      : (screen.orientation as unknown as OrientationWithLock | undefined);
    return !!api && typeof api.lock === 'function';
  }

  private serverNow(): number { return Date.now() + this.serverOffset; }

  /** D-05：发送按钮在 drawerFoot，不在 drawerBody；统一走 offerSendGate */
  private refreshSendButton(): void {
    const send = this.drawerFoot.querySelector<HTMLButtonElement>('#offer-send');
    if (!send) return;
    const v = this.view;
    const snap = this.snapshot;
    const until = snap?.nextSendAt[String(v?.viewer ?? 0)] ?? 0;
    const gate = offerSendGate({
      connected: this.connected,
      phase: v?.phase ?? 'setup',
      discardLock: (v?.pendingDiscards.length ?? 0) > 0,
      pendingSend: this.pendingSend,
      targets: v ? offerTargets(v) : [],
      target: this.draft.target,
      give: this.draft.give,
      get: this.draft.get,
      cooldownMsLeft: Math.max(0, until - this.serverNow()),
    });
    send.disabled = gate.disabled;
    // F6：第二步按钮保留「发送给「玩家名」」文案；第一步沿用既有「发送报价」；
    // 被禁用时统一显示 gate 的具体原因（冷却 / 未同步 / 弃牌锁等）
    const name = v?.players[this.draft.target]?.name ?? '对方';
    send.textContent = gate.disabled
      ? gate.label
      : (this.offerStep === 2 ? `发送给「${name}」` : '发送报价');
  }

  private clearPendingSend(): void {
    this.pendingSend = false;
    if (this.pendingSendTimer) clearTimeout(this.pendingSendTimer);
    this.pendingSendTimer = null;
  }

  private tick(): void {
    if (!this.snapshot) return;
    this.drawerBody.querySelectorAll<HTMLElement>('[data-cd]').forEach((node) => {
      const o = this.snapshot!.offers.find((x) => x.id === node.dataset.cd);
      if (!o) return;
      const left = o.expiresAt - this.serverNow();
      node.textContent = left <= 0 ? '已过期' : `剩余 ${(left / 1000).toFixed(1)}s`;
      if (left <= 0) this.markExpired(o.id);
    });
    // 报价被替换 / 清除后，残留卡片原地失效，绝不重排 DOM
    this.drawerBody.querySelectorAll<HTMLElement>('[data-offer]').forEach((card) => {
      if (this.snapshot!.offers.some((o) => o.id === card.dataset.offer)) return;
      this.markEnded(card);
    });
    this.refreshSendButton();
  }

  /** D-03：只清失效的选点，合法的保留；失效给可见解释，不悄悄替用户改选 */
  private revalidatePicks(view: PlayerView): void {
    const geo = geometryForTileKeys(view.tiles.map((t) => t.key));
    if (this.knightStep === 2 && this.knightTile) {
      const stillValid = !!geo.tiles[this.knightTile] && this.knightTile !== view.robberTile;
      if (!stillValid) {
        this.knightTile = null;
        this.knightStep = 1;
        this.toast('所选地块已失效，请重新选择；服务端未发生变化');
      }
    }
    if (this.roadsStep === 2 && this.pickEdges.length > 0) {
      const kept = this.pickEdges.filter((ek) => view.roads[ek] === undefined);
      if (kept.length !== this.pickEdges.length) {
        this.pickEdges = kept;
        this.toast('部分道路已被占用，选点已更新；请核对后再提交');
      }
      if (kept.length === 0) this.roadsStep = 1;
    }
  }

  /** 过期只禁用当前详情里的原操作，不自动切到下一条（按钮位置不跳） */
  private markExpired(id: string): void {
    const card = this.drawerBody.querySelector<HTMLElement>(`[data-offer="${id}"]`);
    if (!card || card.classList.contains('expired')) return;
    this.markEnded(card, '已过期 · 请返回列表查看其他报价');
  }

  /** D-05：卡片原地失效（到期 / 被替换 / 被清除），绝不删除或重排 DOM。
   *  否则下一条报价的「接受」会突然顶到手指下面造成误点（指南 7.4）。 */
  private markEnded(card: HTMLElement, text = '已结束 · 请返回列表查看其他报价'): void {
    if (card.dataset.offerEnded === '1') return;
    card.classList.add('expired');
    card.dataset.offerEnded = '1';
    card.querySelectorAll('button').forEach((b) => { (b as HTMLButtonElement).disabled = true; });
    const meta = card.querySelector('.meta');
    if (meta) meta.textContent = text;
  }

  /** D-05：收到新快照时只做增量同步，不整块重绘报价列表（按钮位置保持稳定） */
  private syncOfferCards(): void {
    if (!this.view || !this.snapshot) return;
    const list = this.drawerBody.querySelector<HTMLElement>('[data-offer-list]');
    if (!list) return;
    const now = this.serverNow();
    const live = new Map(this.snapshot.offers.map((o) => [o.id, o]));
    const rendered = new Set<string>();
    list.querySelectorAll<HTMLElement>('[data-offer]').forEach((card) => {
      const id = card.dataset.offer ?? '';
      rendered.add(id);
      const o = live.get(id);
      if (!o || o.expiresAt <= now) this.markEnded(card);
    });
    // 新报价只追加到末尾，不插到已渲染卡片前面
    for (const o of this.snapshot.offers) {
      if (rendered.has(o.id)) continue;
      list.insertAdjacentHTML('beforeend', this.offerCard(o, this.view.viewer, now));
    }
    const count = list.parentElement?.querySelector<HTMLElement>('[data-offer-count]');
    if (count) count.textContent = String(this.snapshot.offers.filter((o) => o.expiresAt > now).length);
    this.tick();
  }

  // ------------------------------------------------------------------ 抽屉

  /**
   * D-03：open() 只负责「展示当前步骤」，绝不无条件清空选点状态。
   * 开始一次新操作请用 openFresh()（唯一初始化入口）。
   */
  open(name: Exclude<PanelName, null>): void {
    if (this.mode === null) this.focusReturn = document.activeElement as HTMLElement | null;
    this.mode = name;
    byId('build').classList.add('hidden');
    byId('trade').classList.add('hidden');
    this.extra.innerHTML = '';
    this.drawerFoot.innerHTML = '';
    this.drawerFoot.classList.add('hidden');

    if (name === 'build') {
      byId('build').classList.remove('hidden');
      this.drawerTitle.textContent = '建造';
    } else if (name === 'trade') {
      byId('trade').classList.remove('hidden');
      this.drawerTitle.textContent = '交易报价';
    } else {
      this.drawerTitle.textContent = PANEL_TITLE[name];
      this.renderPanel(name);
    }
    this.drawer.classList.add('open');
    this.drawer.setAttribute('aria-hidden', 'false');
    (byId('drawer-close') as HTMLButtonElement).focus();
  }

  /**
   * D-03：开始一次新操作时才初始化选点草稿与步骤。
   * 这样「点完地块回来展示第二步」与「重新打开面板」有确定且不同的语义。
   */
  openFresh(name: Exclude<PanelName, null>): void {
    if (name === 'knight') { this.knightStep = 1; this.knightTile = null; }
    if (name === 'roads') { this.roadsStep = 1; this.pickEdges = []; }
    this.open(name);
  }

  close(): void {
    this.mode = null;
    this.drawer.classList.remove('open');
    this.drawer.setAttribute('aria-hidden', 'true');
    this.focusReturn?.focus();
    this.focusReturn = null;
  }

  /** 选择棋盘位置时收起大抽屉，只留确认条 */
  setPicking(on: boolean): void {
    this.shell.dataset.picking = on ? '1' : '0';
  }

  // ------------------------------------------------------------------ 确认条 / 提示

  showConfirm(o: ConfirmOptions): void {
    this.hideConfirm();
    this.setPicking(true);
    const parts: string[] = [`<div class="confirm-info"><b>${esc(o.title)}</b>`];
    if (o.detail) parts.push(`<small>${esc(o.detail)}</small>`);
    parts.push('</div>');
    if (o.candidates?.length) {
      parts.push('<div class="confirm-candidates">');
      o.candidates.forEach((c, i) => {
        parts.push(`<button class="btn" data-confirm-cand="${i}">${esc(c.label)}</button>`);
      });
      parts.push('</div>');
    }
    parts.push(`<button class="btn ghost" data-confirm="cancel">取消</button>`);
    if (!o.candidates?.length) {
      parts.push(`<button class="btn primary" data-confirm="ok" ${o.disabled ? 'disabled' : ''}>${esc(o.confirmText ?? '确认')}</button>`);
    }
    this.confirmStrip.innerHTML = parts.join('');
    this.confirmStrip.classList.remove('hidden');
    this.confirmStrip.dataset.title = o.title;
    this.confirmHandler = o;
  }

  private confirmHandler: ConfirmOptions | null = null;

  hideConfirm(): void {
    this.confirmStrip.classList.add('hidden');
    this.confirmStrip.innerHTML = '';
    this.confirmHandler = null;
    this.setPicking(false);
  }

  private onConfirmClick(ev: MouseEvent): void {
    const btn = (ev.target as Element).closest<HTMLElement>('[data-confirm], [data-confirm-cand]');
    if (!btn || !this.confirmHandler) return;
    const o = this.confirmHandler;
    if (btn.dataset.confirmCand !== undefined) {
      const c = o.candidates?.[Number(btn.dataset.confirmCand)];
      this.hideConfirm();
      c?.onPick();
      return;
    }
    this.hideConfirm();
    if (btn.dataset.confirm === 'ok') o.onConfirm();
    else o.onCancel?.();
  }

  say(text: string, tag = '状态', urgent = false): void {
    this.situation.classList.remove('hidden');
    const label = urgent ? '待处理' : tag;
    this.situation.innerHTML = `<b>${esc(label)}</b> · ${esc(text)}`;
    this.situation.dataset.urgent = urgent ? '1' : '0';
    // 桌面纸雕：同一时刻只有一张任务卡，读权威 view 派生图章/阶段/风险。
    this.renderTaskCard(text, label, urgent);
  }

  /** 晴湾纸雕任务卡（右栏 #rail-task）：即时任务，不堆教程说明。 */
  private renderTaskCard(text: string, label: string, urgent: boolean): void {
    const task = document.getElementById('rail-task');
    if (!task) return;
    const v = this.view;
    const seal = urgent ? (label.includes('弃') ? '弃' : label.includes('强盗') ? '盗' : '!')
      : !v ? '·' : (v.current === v.viewer ? (v.players[v.viewer]?.name ?? '我').slice(0, 1) : '等');
    const eyebrow = v
      ? `${label} · 第 ${v.turn} 回合`
      : label;
    const risk = v && v.me.handSize >= 8
      ? `<span class="risk-chip">手牌 ${v.me.handSize} 张 · 掷 7 要弃 ${Math.ceil(v.me.handSize / 2)} 张</span>`
      : '';
    const foot = v
      ? `${v.phase === 'ended' ? '对局结束' : v.current === v.viewer ? '你的回合' : `等待 ${esc(v.players[v.current]?.name ?? '对手')}`} · ${v.hasRolled ? '已掷骰' : '尚未掷骰'}`
      : '连接中';
    task.innerHTML = `
      <div class="task-card${urgent ? ' urgent' : ''}">
        <div class="task-top"></div>
        <span class="task-seal" aria-hidden="true">${esc(seal)}</span>
        <div class="eyebrow"><i class="pulse"></i>${esc(eyebrow)}</div>
        <h2>${esc(text)}</h2>
        ${risk}
        <div class="task-foot">${foot}</div>
      </div>`;
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 2200);
  }

  // ------------------------------------------------------------------ 每次 STATE 后的整体刷新

  render(): void {
    const v = this.view;
    if (!v) return;
    this.renderRailActions(v);
    this.renderSituation(v);
    this.renderEnd(v);
    this.renderPortrait(v);
    this.renderBlocked(v);
  }

  private renderSituation(v: PlayerView): void {
    // D-06：核对状态优先于普通情境，保证「正在核对」在整段恢复期都可见
    if (this.reconcilePhase === 'checking') {
      return this.say('正在核对服务端权威状态与报价；离线期间的点击不会被重放', '恢复', true);
    }
    if (this.reconcilePhase === 'stalled') {
      return this.say('暂时无法核对，仍在自动重连；离线期间的操作不会被重放', '恢复', true);
    }
    if (v.phase === 'ended') return this.say('本局已结束', '结束', false);
    if (v.pendingDiscards.length > 0) {
      const mine = v.pendingDiscards.find((p) => p.player === v.viewer);
      return this.say(
        mine ? `你需要弃 ${mine.count} 张，自己选牌提交` : `等待 ${v.pendingDiscards.length} 人完成弃牌，交易与建造暂停`,
        '弃牌', true,
      );
    }
    if (v.pendingRobber) {
      return this.say(
        v.current === v.viewer ? '本回合结束前必须移动强盗；交易与建造已恢复' : '等待当前玩家移动强盗',
        '强盗', true,
      );
    }
    if (v.phase === 'setup') return this.say('开局摆位：先选村庄，再选相邻道路，整组确认', '摆位', true);
    if (v.current === v.viewer) {
      return this.say(v.hasRolled ? '轮到你 · 可建造、交易或结束回合' : '轮到你 · 可先交易或建造，再掷骰', '轮到你', false);
    }
    return this.say(`等待 ${esc(v.players[v.current]?.name ?? '对手')} 行动 · 仍可向当前玩家报价`, '等待', false);
  }

  private renderRailActions(v: PlayerView): void {
    const playable = (kind: string): boolean =>
      v.me.devCards.some((c) => c.card === kind && c.playable);
    const devPlayed = v.me.devCards.some((c) => !c.playable);
    const blocked = v.phase !== 'play' || v.pendingDiscards.length > 0;
    const devBlocked = blocked || v.pendingRobber || devPlayed;
    const nOffers = this.snapshot?.offers.filter((o) => o.expiresAt > this.serverNow()).length ?? 0;
    const entries: { id: string; label: string; badge?: number | string; disabled?: boolean }[] = [
      { id: 'dev', label: '发展卡 / 行动卡', badge: v.me.devCards.length || undefined },
      // F5：银行与港口是不同入口；非自己回合显示原因、弃牌期禁用
      { id: 'bank', label: '银行兑换 · 4:1', disabled: blocked || v.current !== v.viewer },
      { id: 'port', label: '我的港口兑换', disabled: blocked || v.current !== v.viewer },
      { id: 'knight', label: '骑士', disabled: devBlocked || !playable('knight') },
      { id: 'monopoly', label: '垄断', disabled: devBlocked || !playable('monopoly') },
      { id: 'plenty', label: '丰饶', disabled: devBlocked || !playable('plenty') },
      { id: 'roads', label: '筑路', disabled: devBlocked || !playable('roadbuilding') },
      { id: 'offers', label: '待处理报价', badge: nOffers || undefined },
      { id: 'help', label: '操作帮助' },
    ];
    this.railActions.innerHTML = entries.map((e) => `
      <button class="btn ghost mini" data-panel="${e.id}" ${e.disabled ? 'disabled' : ''}>
        <span>${esc(e.label)}</span>${e.badge !== undefined ? `<span class="badge">${esc(String(e.badge))}</span>` : ''}
      </button>`).join('');
    const buy = byId<HTMLButtonElement>('btn-buy-dev');
    buy.disabled = blocked || v.pendingRobber || !this.connected;
  }

  private renderBlocked(v: PlayerView): void {
    const reasons: string[] = [];
    if (this.reconcilePhase === 'checking') {
      reasons.push('正在核对服务端权威状态与报价：离线期间的点击不会被重放');
    } else if (this.reconcilePhase === 'stalled') {
      reasons.push('暂时无法核对，仍在自动重连：离线期间的操作不会被重放');
    }
    if (!this.connected) reasons.push('连接未同步：会改变对局的操作已暂时禁用，仍可看盘与查看帮助');
    if (v.pendingDiscards.length > 0) reasons.push('有人尚未弃牌：建造 / 交易 / 兑换 / 发展卡暂停');
    if (v.pendingRobber) reasons.push('强盗未移动：发展卡与结束回合仍禁用');
    if (!v.hasRolled && v.phase === 'play' && v.current === v.viewer) reasons.push('本回合尚未掷骰，不能结束回合');
    this.blockedReason.textContent = reasons.join('；');
    this.blockedReason.classList.toggle('hidden', reasons.length === 0);
  }

  private renderEnd(v: PlayerView): void {
    if (v.phase !== 'ended') { this.endScreen.classList.add('hidden'); return; }
    const winnerSeat = v.winner;
    const winner = winnerSeat === null ? null : v.players[winnerSeat];
    const winnerScore = winnerSeat === null ? 0 : (v.scores[winnerSeat] ?? 0);
    setText('end-title', '对局结束');
    setText('end-winner', winner ? `${winner.name} 获胜（${winnerScore} 分）` : '本局结束');
    byId('end-scores').innerHTML = v.players.map((p, i) =>
      `<div>${esc(p.name)} · ${v.scores[i] ?? 0} 分 · 手牌 ${p.handSize} 张</div>`).join('');
    this.endScreen.classList.remove('hidden');
  }

  private renderPortrait(v: PlayerView): void {
    this.syncPortraitGate();
    this.renderLandscapeStatus(v);
    byId('portrait-status').innerHTML = `
      <div>连接：${this.connected ? '已同步' : '未同步'} · 房间已加入</div>
      <div>当前回合：${esc(v.players[v.current]?.name ?? '—')}</div>
      <div>我的手牌：${v.me.handSize} 张 · 分数 ${v.me.score}</div>
      <div>待处理：${v.pendingRobber ? '强盗待移动' : v.pendingDiscards.length ? '需要弃牌' : (this.snapshot?.offers.length ?? 0) + ' 条报价'}</div>`;
  }

  /** §2.4 / C2 / 要点 11：不旋转层的正立状态摘要，沿用 #portrait-status 的信息集 */
  private renderLandscapeStatus(v: PlayerView): void {
    const offers = this.snapshot?.offers.length ?? 0;
    const pending = v.pendingRobber ? '强盗待移动'
      : v.pendingDiscards.length ? '需要弃牌'
      : `${offers} 条报价`;
    const current = v.players[v.current]?.name ?? '—';
    // 降级说明可能临时占用这一行；下一次权威重绘就恢复连接/回合/待办摘要
    setText('landscape-hint-status',
      `横屏棋盘已铺好 · 连接${this.connected ? '已同步' : '未同步'} · 轮到 ${current} · 待处理 ${pending}`);
  }

  /**
   * 要点 4：旧全屏卡片永久收起（节点与所有旧 id 保留，供 dom-contract 对账），
   * 不再当作必须点按的主路径；S0/S1 都不得出现卡片或转向提示。
   * dataset.dismissed 的语义从「收卡片」扩展为 C4 的「不再强制自转/锁定/提示」。
   */
  private syncPortraitGate(): void {
    this.portraitGate.dataset.dismissed = this.forced ? '0' : '1';
    this.portraitGate.classList.add('hidden');
  }

  /**
   * S6 出口「仍按竖屏查看」：对局中（自转已生效）置 forced=off，本次会话不再强制
   * 自转 / 锁定 / 提示；连接状态、回合摘要、待办、设置、帮助与恢复入口全部保留
   * （正立状态条 + 帮助面板，指南 4.2 第 2 条）。恢复：正立层「重新铺成横屏」或刷新。
   *
   * UL-UX09/10 回归根因：转向提示只属于本次会话的第一次 S2。用户一旦退出，
   * 必须同时 `tipClosed = true` 并清掉淡出定时器；否则「重新铺成横屏」会把
   * `.lh-main` 复活（syncHud 的 settled = mode!=='css' || !forced || tipClosed）。
   */
  private dismissPortrait(): void {
    const wasCss = this.landscapeMode === 'css';
    if (wasCss) {
      this.forced = false;
      this.tipClosed = true;
      this.clearHintTimers();
    }
    this.updateLandscape();
    this.toast(wasCss
      ? '已按竖屏查看，本次不再自动铺成横屏'
      : '已收起提示，本次会话不再反复弹出');
  }

  /**
   * C7 / §2.5：可选的系统横屏增强，只挂在「44×44 常驻方向入口」这类专门手势上，
   * 绝不搭车或消费任何游戏点击。浏览器硬限制：lock 必须由用户手势触发，多数还要求
   * 先全屏；iOS Safari 完全没有该 API，iPhone 的 requestFullscreen 也基本不可用。
   * 所以自转是零手势默认生效的通用底座；S3 期间 mode 不变（保持自转、不闪、
   * 不阻断操作），失败 / 不支持 / 超时按 S5 处理，不重试、不弹卡片、不叠加 toast。
   */
  private requestLandscape(): void {
    type OrientationWithLock = { lock?: (o: string) => Promise<void> };
    const api = typeof screen === 'undefined'
      ? undefined
      : (screen.orientation as unknown as OrientationWithLock | undefined);
    const lock = api && typeof api.lock === 'function' ? api.lock.bind(api) : null;
    if (!lock) {
      // C3 ①：API 缺失（iPhone Safari / 微信内置等）
      this.updateLandscape();
      this.showLandscapeHint(HINT_COPY.unsupported);
      return;
    }
    const root = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
    // 同步发起全屏以保留用户手势；transient activation 有数秒窗口，之后立刻 lock
    let ready: Promise<unknown> = Promise.resolve();
    if (typeof root.requestFullscreen === 'function') {
      try { ready = root.requestFullscreen(); } catch { ready = Promise.resolve(); }
    }
    // 部分 WebView 的 lock 既不 resolve 也不 reject，短时上限按 S5 处理（E2）
    const LOCK_TIMEOUT_MS = 1200;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('orientation lock timeout')), LOCK_TIMEOUT_MS);
    });
    Promise.resolve(ready)
      .catch(() => undefined)                       // 全屏被拒也不放弃锁定
      .then(() => {
        try { return Promise.race([Promise.resolve(lock('landscape')), timedOut]); }
        catch { return Promise.reject(new Error('orientation lock threw')); }
      })
      .then(() => {
        if (timer) clearTimeout(timer);
        this.updateLandscape();
        // S4：只有视口真的变成横屏才说「已按横屏显示」；否则只说「已请求」，不假装成功
        this.toast(this.isPortraitPhone()
          ? '已请求系统横屏；网页自转仍会兜底'
          : '已按横屏显示');
      })
      .catch((err: unknown) => {
        if (timer) clearTimeout(timer);
        this.updateLandscape();                     // S5：与 S2 同态，立刻生效、不等下一帧
        // C3 ② 被拒 / ③ 超时或无法区分（含系统旋转锁定开着）作统一兜底
        const timedOutCase = err instanceof Error && err.message === 'orientation lock timeout';
        this.showLandscapeHint(timedOutCase ? HINT_COPY.fallback : HINT_COPY.rejected);
      });
  }

  // ------------------------------------------------------------------ 事件委托

  private onRailAction(ev: MouseEvent): void {
    const btn = (ev.target as Element).closest<HTMLElement>('[data-panel]');
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    const name = btn.dataset.panel as Exclude<PanelName, null>;
    this.openFresh(name);   // D-03：从行动区进入 = 开始一次新操作
  }

  private onBodyClick(ev: MouseEvent): void {
    const btn = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    const act = btn.dataset.act!;
    const val = btn.dataset.val;
    // ULS：正立层与帮助面板共用的恢复/出口入口（C5）。方向不做第二个入口（C1）。
    if (act === 'landscape-exit') { this.dismissPortrait(); return; }
    if (act === 'landscape-resume') { this.resumeLandscape(); return; }
    if (act === 'accept' || act === 'reject' || act === 'cancel') {
      const id = btn.dataset.id;
      if (!id) return;
      // 已失效（过期 / 被替换 / 已清除）的卡片绝不提交；服务端也会拒绝（指南 7.4）
      const card = btn.closest<HTMLElement>('[data-offer]');
      const live = this.snapshot?.offers.find((o) => o.id === id);
      if (card?.dataset.offerEnded === '1' || !live || live.expiresAt <= this.serverNow()) {
        this.markEnded(card ?? btn);
        return this.toast('这条报价已结束或过期，请返回列表查看其他报价');
      }
      if (act === 'accept') this.cb.onOfferAccept(id);
      if (act === 'reject') this.cb.onOfferReject(id);
      if (act === 'cancel') this.cb.onOfferCancel(id);
      return;
    }
    // F6 两步交易：一次只编辑一侧，切换步骤/返回都不重置草稿
    if (act === 'offer-step') {
      this.offerStep = Number(val) === 2 ? 2 : 1;
      // 用户主动切步骤：整块重画（草稿 + foot）
      this.renderOffers();
      return;
    }
    if (act === 'offer-qty') {
      const side = btn.dataset.side === 'give' ? 'give' : 'get';
      const res = val as Resource;
      const delta = Number(btn.dataset.step ?? 0);
      const bag = side === 'give' ? this.draft.give : this.draft.get;
      // 「我想收到」不按对方隐藏库存限制（固定上限 99）；「我愿给出」受自己库存约束
      const max = side === 'give' ? (this.view?.me.resources[res] ?? 0) : 99;
      bag[res] = Math.max(0, Math.min(max, (bag[res] ?? 0) + delta));
      this.renderOfferDraft();        // D-05：只重画草稿，不重排报价列表
      return;
    }
    if (act === 'offer-clear') {
      const side = btn.dataset.side === 'give' ? 'give' : 'get';
      if (side === 'give') this.draft.give = {}; else this.draft.get = {};
      this.renderOfferDraft();
      return;
    }
    if (act === 'target') { this.draft.target = Number(val); this.renderOfferDraft(); return; }
    // 兼容旧 stepper 测试：把 give/get 也映射到新两侧（give=付出/get=收到）
    if (act === 'give' || act === 'get') {
      const res = val as Resource;
      const step = Number(btn.dataset.step ?? 0);
      const bag = act === 'give' ? this.draft.give : this.draft.get;
      const max = act === 'give' ? (this.view?.me.resources[res] ?? 0) : 99;
      bag[res] = Math.max(0, Math.min(max, (bag[res] ?? 0) + step));
      this.renderOfferDraft();
      return;
    }
    if (act === 'select') {
      const key = btn.dataset.key ?? '';
      const res = val as Resource;
      if (key === 'bankGive') this.bankGive = res;
      if (key === 'bankGet') this.bankGet = res;
      if (key === 'portGet') this.portGet = res;
      if (key === 'monopolyRes') this.monopolyRes = res;
      if (key === 'plenty') {
        const slot = Number(btn.dataset.slot ?? 0) as 0 | 1;
        this.plenty[slot] = res;
      }
      this.renderPanel(this.mode!);
      return;
    }
    // F5：港口资源袋加减（通用港可混合）、选择具体港口
    if (act === 'port-bag') {
      const res = val as Resource;
      const delta = Number(btn.dataset.step ?? 0);
      const held = this.view?.me.resources[res] ?? 0;
      this.portGive[res] = Math.max(0, Math.min(held, (this.portGive[res] ?? 0) + delta));
      if (this.portGive[res] === 0) delete this.portGive[res];
      this.renderPanel(this.mode!);
      return;
    }
    if (act === 'port-edge') {
      this.portEdge = btn.dataset.edge ?? '';
      this.portGive = {};   // 换港口清空资源袋（不同港口比例可能不同）
      this.renderPanel(this.mode!);
      return;
    }
    if (act === 'knight-pick') {
      this.cb.onRequestPick('tile', '选一个地块移动强盗并抽牌', (keys) => {
        if (!keys[0]) return;                    // 取消选点：保留第一步，结果确定
        this.knightTile = keys[0];
        this.knightStep = 2;                     // 先记状态
        this.open('knight');                     // 再只做展示，不清空
      });
      return;
    }
    if (act === 'knight-steal') {
      if (!this.knightTile) return;
      const seat = val === undefined || val === '' ? undefined : Number(val);
      const tile = this.knightTile;
      this.knightStep = 1;
      this.knightTile = null;
      this.close();
      this.cb.onPlayKnight(tile, seat);
      return;
    }
    if (act === 'roads-pick') {
      this.cb.onRequestPick('edges', '选择 1–2 条要免费修建的道路', (keys) => {
        if (keys.length === 0) return;           // 取消选点：保留第一步
        this.pickEdges = keys.slice(0, 2);
        this.roadsStep = 2;                      // 先记状态
        this.open('roads');                      // 再只做展示，不清空
      });
      return;
    }
  }

  private onFootClick(ev: MouseEvent): void {
    const btn = (ev.target as Element).closest<HTMLElement>('[data-foot]');
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    const act = btn.dataset.foot!;
    if (act === 'close') return this.close();
    if (act === 'refresh') { this.renderOffers(); return; }  // 用户主动返回列表才重排
    if (act === 'send') {
      if (this.draft.target < 0) return this.toast('先选择报价对象');
      // D-05：立刻本地防连点（服务端 OFFERS 快照回来后由 nextSendAt 接管）
      this.pendingSend = true;
      if (this.pendingSendTimer) clearTimeout(this.pendingSendTimer);
      this.pendingSendTimer = setTimeout(() => {
        this.pendingSend = false;
        this.pendingSendTimer = null;
        this.refreshSendButton();
      }, 4000);
      this.refreshSendButton();
      this.cb.onOffer(this.draft.target, { ...this.draft.give }, { ...this.draft.get });
      return;
    }
    if (act === 'bank') {
      if (this.bankGive === this.bankGet) return this.toast('同种资源不能兑换');
      this.close();
      this.cb.onTradeBank(this.bankGive, this.bankGet);
      return;
    }
    if (act === 'port') {
      // F5：港口须选自己的港口，给出资源袋总数/种类由服务端最终裁决
      if (!this.portEdge) return this.toast('先选择一个自己的港口');
      const total = RESOURCES.reduce((n, r) => n + (this.portGive[r] ?? 0), 0);
      if (total === 0) return this.toast('先选择要交出的资源');
      this.close();
      this.cb.onTradePort(this.portEdge, { ...this.portGive }, this.portGet);
      return;
    }
    // F6：发送按钮在第二步；两步都为空不能提交（由 offerSendGate 统一判空）。
    // 切步骤是用户显式操作，整块重画（草稿+foot）；报价卡片仍按服务端快照重排。
    if (act === 'offer-next' || act === 'offer-back') {
      this.offerStep = act === 'offer-next' ? 2 : 1;
      this.renderOffers();
      return;
    }
    if (act === 'monopoly') { this.close(); this.cb.onPlayMonopoly(this.monopolyRes); return; }
    if (act === 'plenty') { this.close(); this.cb.onPlayPlenty(this.plenty[0], this.plenty[1]); return; }
    if (act === 'roads') {
      if (this.pickEdges.length === 0) return this.toast('先选至少一条路');
      const edges: [string, string?] = [this.pickEdges[0]!, this.pickEdges[1]];
      this.roadsStep = 1;
      this.pickEdges = [];
      this.close();
      this.cb.onPlayRoadBuilding(edges);
      return;
    }
  }

  // ------------------------------------------------------------------ 各面板

  private renderPanel(name: Exclude<PanelName, null>): void {
    switch (name) {
      case 'offers': this.renderOffers(); break;
      case 'dev': this.renderDev(); break;
      case 'bank': this.renderBank(); break;
      case 'port': this.renderPort(); break;
      case 'knight': this.renderKnight(); break;
      case 'monopoly': this.renderMonopoly(); break;
      case 'plenty': this.renderPlenty(); break;
      case 'roads': this.renderRoads(); break;
      case 'help': this.renderHelp(); break;
      default: break;
    }
  }

  private foot(html: string): void {
    this.drawerFoot.innerHTML = html;
    this.drawerFoot.classList.remove('hidden');
  }

  private confirmBuyDev(): void {
    if (!this.view) return;
    const hand = this.view.me.resources;
    const miss = (['sheep', 'wheat', 'ore'] as Resource[]).filter((r) => hand[r] < 1);
    this.showConfirm({
      title: '购买 1 张发展卡',
      detail: `成本 羊1 麦1 矿1${miss.length ? ` · 缺少 ${miss.map((r) => RES_NAME[r]).join('、')}` : ''} · 买到的种类只有你能看到`,
      disabled: miss.length > 0 || !this.connected,
      onConfirm: () => this.cb.onBuyDev(),
    });
  }

  private renderDev(): void {
    const v = this.view;
    if (!v) return;
    const cards = v.me.devCards;
    const rows = cards.length === 0
      ? '<p>还没有发展卡。</p>'
      : cards.map((c) => `<div class="d-card">
          <h4>${esc(DEV_NAME[c.card] ?? c.card)}</h4>
          <div class="line">${c.playable ? '可使用' : '本回合新购入，下回合起可用'}</div>
          ${c.card === 'victory' ? '<div class="d-note">计入分数，不需要打出。</div>' : ''}
        </div>`).join('');
    const playable = (k: string) => cards.some((c) => c.card === k && c.playable);
    this.extra.innerHTML = `<div class="d-panel">
      <h4>我的发展卡（${cards.length}）</h4>
      <p>买到的种类不向其他玩家展示；当回合购入的卡下回合起可用。</p>
      ${rows}
      <div class="d-row">
        ${(['knight', 'monopoly', 'plenty', 'roadbuilding'] as const).map((k) =>
          `<button class="d-chip" data-panel-jump="${k}" ${playable(k) ? '' : 'disabled'}>打出${esc(DEV_NAME[k] ?? k)}</button>`).join('')}
      </div>
      <div class="d-note">每回合最多打出一张发展卡，由服务端裁决。</div>
    </div>`;
    this.extra.querySelectorAll<HTMLElement>('[data-panel-jump]').forEach((b) => {
      b.addEventListener('click', () => {
        const k = b.dataset.panelJump ?? '';
        this.openFresh(k === 'roadbuilding' ? 'roads' : (k as Exclude<PanelName, null>));
      });
    });
    this.foot(`<button class="btn primary" data-foot="close">知道了</button>`);
  }

  /** F5：从公开 view 推导「我的港口」（端点上有自己的村庄/城市，道路不算） */
  private myPorts(): { edge: string; generic: boolean; resource?: Resource }[] {
    const v = this.view;
    if (!v) return [];
    const out: { edge: string; generic: boolean; resource?: Resource }[] = [];
    for (const slot of v.ports) {
      const [a, b] = slot.edge.split('|');
      const owns = [a, b].some((vk) => v.buildings[vk ?? '']?.owner === v.viewer);
      if (!owns) continue;
      if (slot.port.kind === 'generic') out.push({ edge: slot.edge, generic: true });
      else out.push({ edge: slot.edge, generic: false, resource: slot.port.resource });
    }
    return out;
  }

  private resourceChips(key: string, current: Resource | number): string {
    return RESOURCES.map((r) => `<button class="d-chip" data-act="select" data-key="${key}" data-val="${r}"
      ${current === r ? 'aria-pressed="true"' : ''}>${esc(RESOURCE_LABEL[r])}</button>`).join('');
  }

  /** F5：银行始终是独立入口，严格 4:1，不因港口降比例；非自己回合显示原因 */
  private renderBank(): void {
    const v = this.view;
    const notMyTurn = !!v && (v.current !== v.viewer || v.phase !== 'play' || v.pendingDiscards.length > 0);
    const held = v?.me.resources[this.bankGive] ?? 0;
    const enough = held >= 4;
    this.extra.innerHTML = `<div class="d-panel">
      <h4>银行兑换 · 严格 4:1</h4>
      <p>交出 <b>4 张同一种</b>资源，换 <b>1 张</b>指定资源。银行不因你拥有港口而降低比例；港口请到「我的港口兑换」单独操作。</p>
      <div class="d-note">交出 4 张（${esc(RESOURCE_LABEL[this.bankGive])} · 持有 ${held}）</div>
      <div class="d-row">${this.resourceChips('bankGive', this.bankGive)}</div>
      <div class="d-note">得到 1 张（${esc(RESOURCE_LABEL[this.bankGet])}）</div>
      <div class="d-row">${this.resourceChips('bankGet', this.bankGet)}</div>
      <div class="d-note">完整预览：交出 ${esc(RESOURCE_LABEL[this.bankGive])} ×4 → 收到 ${esc(RESOURCE_LABEL[this.bankGet])} ×1。</div>
      ${this.bankGive === this.bankGet ? '<div class="d-error">同种资源不能兑换</div>' : ''}
      ${!enough && this.bankGive !== this.bankGet ? '<div class="d-error">这种资源不足 4 张</div>' : ''}
      ${notMyTurn ? '<div class="d-error">仅自己的回合、且无人待弃牌时可兑换</div>' : ''}
    </div>`;
    this.foot(`<button class="btn ghost" data-foot="close">取消</button>
      <button class="btn primary" data-foot="bank"
        ${this.bankGive === this.bankGet || !this.connected || notMyTurn ? 'disabled' : ''}>确认 4:1 兑换</button>`);
  }

  /** F5：只列「我的港口」；通用港三张可混选，专用港显示对应图标与 2:1 */
  private renderPort(): void {
    const v = this.view;
    if (!v) return;
    const ports = this.myPorts();
    const notMyTurn = v.current !== v.viewer || v.phase !== 'play' || v.pendingDiscards.length > 0;
    if (!this.portEdge && ports[0]) this.portEdge = ports[0].edge;
    const selected = ports.find((p) => p.edge === this.portEdge);
    const ratio = selected?.generic ? 3 : 2;
    const total = RESOURCES.reduce((n, r) => n + (this.portGive[r] ?? 0), 0);

    const portList = ports.length === 0
      ? '<div class="d-error">你还没有自己的港口（需要在港口边的端点建村庄或城市）。无港口时不可兑换。</div>'
      : `<div class="d-note">我的港口</div><div class="d-row">${ports.map((p) => {
          const label = p.generic
            ? `通用港 3:1（任意 3 张）`
            : `2:1 ${esc(RESOURCE_LABEL[p.resource!])}港`;
          return `<button class="d-chip" data-act="port-edge" data-edge="${esc(p.edge)}"
            ${p.edge === this.portEdge ? 'aria-pressed="true"' : ''}>${label}</button>`;
        }).join('')}</div>`;

    const giveRows = RESOURCES.map((r) => {
      const held = v.me.resources[r] ?? 0;
      const n = this.portGive[r] ?? 0;
      const limited = selected && !selected.generic && selected.resource !== r;
      return `<div class="d-row" style="align-items:center;gap:6px">
        <span style="min-width:40px">${esc(RESOURCE_LABEL[r])}</span>
        <button class="d-chip" data-act="port-bag" data-val="${r}" data-step="-1" ${limited || n === 0 ? 'disabled' : ''} aria-label="减少${esc(RESOURCE_LABEL[r])}">−</button>
        <span>${n}<small>（持有 ${held}）</small></span>
        <button class="d-chip" data-act="port-bag" data-val="${r}" data-step="1" ${limited || n >= held ? 'disabled' : ''} aria-label="增加${esc(RESOURCE_LABEL[r])}">+</button>
      </div>`;
    }).join('');

    const summary = RESOURCES.filter((r) => (this.portGive[r] ?? 0) > 0)
      .map((r) => `${esc(RESOURCE_LABEL[r])}×${this.portGive[r]}`).join(' + ') || '无';

    this.extra.innerHTML = `<div class="d-panel">
      <h4>我的港口兑换</h4>
      <p>仅拥有者本人、且仅在自己回合可用。通用港用<b>任意组合的 3 张</b>资源换 1 张；专用港用<b>对应资源 2 张</b>换 1 张。系统不会自动扣别人的资源，借港请自行用玩家交易分步完成。</p>
      ${portList}
      ${ports.length > 0 ? `
        <div class="d-note">交出资源（共 ${total} / 需要 ${ratio} 张${selected?.generic ? '，可混合' : `，仅限 ${esc(RESOURCE_LABEL[selected!.resource!])}`}）</div>
        ${giveRows}
        <div class="d-note">得到 1 张（${esc(RESOURCE_LABEL[this.portGet])}）</div>
        <div class="d-row">${this.resourceChips('portGet', this.portGet)}</div>
        <div class="d-note">完整预览：交出 ${summary} → 收到 ${esc(RESOURCE_LABEL[this.portGet])} ×1。</div>
        ${total !== ratio ? `<div class="d-error">当前交出 ${total} 张，需要恰好 ${ratio} 张</div>` : ''}
        ${notMyTurn ? '<div class="d-error">仅自己的回合、且无人待弃牌时可兑换</div>' : ''}` : ''}
    </div>`;
    this.foot(`<button class="btn ghost" data-foot="close">取消</button>
      <button class="btn primary" data-foot="port"
        ${!this.connected || notMyTurn || !selected || total !== ratio ? 'disabled' : ''}>确认港口兑换</button>`);
  }

  /** 骑士：step=1 选地块，step=2 选抽牌对象。展示不初始化，状态只由 openFresh/回调改。 */
  private renderKnight(): void {
    if (this.knightStep === 2 && this.knightTile) { this.renderKnightStep2(); return; }
    this.extra.innerHTML = `<div class="d-panel">
      <h4>打出骑士</h4>
      <p>先选一个地块移动强盗，再选一位相邻玩家抽 1 张牌；也可以选择不抽牌。与掷 7 的强盗待处理状态不互相覆盖。</p>
      <button class="d-chip" data-act="knight-pick">去棋盘选地块</button>
    </div>`;
    this.foot(`<button class="btn ghost" data-foot="close">取消</button>`);
  }

  /**
   * D-03 连带修正：抽牌对象必须是「所选地块相邻、有建筑、手里有牌」的玩家。
   * 依据与服务端 MOVE_ROBBER / PLAY_KNIGHT 的 hasBuildingAdjacent 一致，
   * 复用 robber.ts 的 stealCandidates（已在 robber.test.ts 覆盖 R-45/R-46），
   * 不再只按 handSize>0 过滤。最终仍由服务端裁决。
   */
  private renderKnightStep2(): void {
    const v = this.view;
    if (!v || !this.knightTile) return;
    const geo = geometryForTileKeys(v.tiles.map((t) => t.key));
    const candidates = stealCandidates(v, geo, this.knightTile);
    const buttons = candidates.map((c) =>
      `<button class="d-chip" data-act="knight-steal" data-val="${c.seat}">${esc(c.name)}（${c.handSize} 张）</button>`).join('');
    const hint = candidates.length === 0
      ? '<div class="d-note">该地块相邻没有手里的玩家，可直接选择「不抽牌」提交。</div>'
      : '<div class="d-note">只列出与所选地块相邻且手里有牌的玩家；不推算隐藏资源。</div>';
    this.extra.innerHTML = `<div class="d-panel">
      <h4>已选地块 ${esc(this.knightTile)}</h4>
      <p>选一位玩家抽 1 张牌，或选择不抽牌。</p>
      ${hint}
      <div class="d-row">${buttons}
        <button class="d-chip" data-act="knight-steal" data-val="">不抽牌</button></div>
      <div class="d-row"><button class="d-chip" data-act="knight-pick">重选地块</button></div>
    </div>`;
    this.foot(`<button class="btn ghost" data-foot="close">取消</button>`);
  }

  private renderMonopoly(): void {
    this.extra.innerHTML = `<div class="d-panel">
      <h4>打出垄断</h4>
      <p>选一种资源，其他玩家手上的该种资源全部归你。不提供他人隐藏资源推算。</p>
      <div class="d-note">资源种类</div>
      <div class="d-row">${this.resourceChips('monopolyRes', this.monopolyRes)}</div>
    </div>`;
    this.foot(`<button class="btn ghost" data-foot="close">取消</button>
      <button class="btn primary" data-foot="monopoly" ${!this.connected ? 'disabled' : ''}>确认</button>`);
  }

  private renderPlenty(): void {
    this.extra.innerHTML = `<div class="d-panel">
      <h4>打出丰饶</h4>
      <p>从银行拿两份资源，允许两份是同一种。</p>
      ${([0, 1] as const).map((i) => `<div class="d-note">第 ${i + 1} 份（${esc(RESOURCE_LABEL[this.plenty[i]])}）</div>
        <div class="d-row">${RESOURCES.map((r) => `<button class="d-chip" data-act="select" data-key="plenty"
          data-slot="${i}" data-val="${r}" ${this.plenty[i] === r ? 'aria-pressed="true"' : ''}>${esc(RESOURCE_LABEL[r])}</button>`).join('')}</div>`).join('')}
    </div>`;
    this.foot(`<button class="btn ghost" data-foot="close">取消</button>
      <button class="btn primary" data-foot="plenty" ${!this.connected ? 'disabled' : ''}>确认</button>`);
  }

  /** 筑路：step=1 选 1–2 条边，step=2 确认。展示不初始化（D-03）。 */
  private renderRoads(): void {
    if (this.roadsStep === 2 && this.pickEdges.length > 0) { this.renderRoadsStep2(); return; }
    this.extra.innerHTML = `<div class="d-panel">
      <h4>打出筑路</h4>
      <p>免费修建 1–2 条路。先在棋盘上预览第一条，再基于「假设第一条已建成」选第二条；确认前都只是本地预览，不会扣资源。</p>
      <button class="d-chip" data-act="roads-pick">去棋盘选路</button>
    </div>`;
    this.foot(`<button class="btn ghost" data-foot="close">取消</button>`);
  }

  private renderRoadsStep2(): void {
    this.extra.innerHTML = `<div class="d-panel">
      <h4>已选 ${this.pickEdges.length} 条路</h4>
      <p>${this.pickEdges.map((e) => esc(e)).join('、')}</p>
      <div class="d-note">单条路也可以提交，条件由服务端按当前棋盘裁决。</div>
      <div class="d-row"><button class="d-chip" data-act="roads-pick">重选道路</button></div>
    </div>`;
    this.foot(`<button class="btn ghost" data-foot="close">取消</button>
      <button class="btn primary" data-foot="roads" ${!this.connected ? 'disabled' : ''}>确认提交</button>`);
  }

  private renderHelp(): void {
    this.extra.innerHTML = `<div class="d-panel d-help">
      <div class="d-help"><b>棋盘操作</b>单指拖动平移、双指缩放；右上 + / − / ⌂ 也能缩放与回到全局。拖动超过 8 CSS px 视为拖动，抬手不会触发建造。</div>
      <div class="d-help"><b>点选与确认</b>点击附近合法候选会先显示操作名与成本，按「确认」才提交；「取消」只撤销本地选择。两个候选太近时会让你明确选一个。</div>
      <div class="d-help"><b>成本</b>道路 木1 砖1；村庄 木1 砖1 羊1 麦1；城市 麦2 矿3；发展卡 羊1 麦1 矿1。</div>
      <div class="d-help"><b>掷 7</b>手牌 8 张起弃一半、向上取整，自己选牌；全员弃完后恢复交易与建造，强盗未移动前不能结束回合或使用发展卡。</div>
      <div class="d-help"><b>报价</b>每条 10 秒、发送冷却 3 秒、每人最多 1 条；可任选处理，按 ID 成交。倒计时以服务端时间为准，后台过期是预期行为。</div>
      <div class="d-help"><b>断线</b>离线时禁用会改变对局的操作，仍可看盘与查看帮助；回到前台会重新核对状态，不会自动重放离线期间的点击。</div>
      <div class="d-help"><b>横屏显示</b>竖屏开局后，网页会把整个画面自转铺成横屏，请把手机${TURN_WORD}横过来正着看；系统方向被锁死也能用，不依赖任何浏览器设置，也不会退出房间或丢失待确认的选择。转反了就把手机转回来，按箭头方向再来一次。</div>
      <div class="d-help"><b>仍按竖屏查看</b>点正立状态条上的「仍按竖屏查看」即可退出，本次会话不再自动铺成横屏；想恢复点「重新铺成横屏」。如果横过来后画面还是不对，可以检查手机的旋转锁定是否开着（仅在帮助里的补充句，不主动弹）。</div>
      <div class="d-row">
        <button class="d-chip" data-act="landscape-exit">仍按竖屏查看</button>
        <button class="d-chip" data-act="landscape-resume">重新铺成横屏</button>
      </div>
      <div class="d-help"><b>触屏</b>这里替代桌面 hover 提示；减少动态效果时仍保留静态高亮与文字。</div>
    </div>`;
    this.foot(`<button class="btn primary" data-foot="close">知道了</button>`);
  }

  // ------------------------------------------------------------------ 报价列表

  /**
   * F6 两步交易草稿（文档 20）：先「我想收到」→ 再「我愿给出」→ 摘要发送。
   * 一次只编辑一侧，不根据对方隐藏库存限制「我想收到」的上限；
   * 「我愿给出」受自己持有量约束。切换步骤/返回/关闭都保留草稿。
   */
  private offerDraftHtml(): string {
    const v = this.view;
    if (!v) return '';
    const targets = offerTargets(v)
      .map((i) => v.players[i])
      .filter((p): p is PlayerView['players'][number] => p !== undefined);
    if (this.draft.target < 0 && targets[0]) this.draft.target = targets[0].index;
    if (!targets.some((p) => p.index === this.draft.target) && targets[0]) this.draft.target = targets[0].index;
    const targetName = targets.find((p) => p.index === this.draft.target)?.name ?? '对方';

    const bagSummary = (bag: Partial<ResourceCount>): string =>
      RESOURCES.filter((r) => (bag[r] ?? 0) > 0)
        .map((r) => `${esc(RESOURCE_LABEL[r])}×${bag[r]}`).join(' + ') || '未选择';
    const countOf = (bag: Partial<ResourceCount>): number =>
      RESOURCES.reduce((n, r) => n + (bag[r] ?? 0), 0);

    /** 一行资源：图标+名称、数量、整数滑条 + 减/加按钮（键盘可精确调整） */
    const sideRows = (side: 'get' | 'give'): string => {
      const bag = side === 'get' ? this.draft.get : this.draft.give;
      const isGive = side === 'give';
      return RESOURCES.map((r) => {
        const held = v.me.resources[r] ?? 0;
        const max = isGive ? held : 99;
        const n = bag[r] ?? 0;
        const disabledMinus = n <= 0;
        const disabledPlus = n >= max;
        return `<div class="d-row offer-row" style="align-items:center;gap:6px">
          <span class="offer-res-name" style="min-width:40px">${esc(RESOURCE_LABEL[r])}</span>
          ${isGive ? `<small style="min-width:44px;color:#888">持有 ${held}</small>` : ''}
          <button class="d-chip" data-act="offer-qty" data-side="${side}" data-val="${r}" data-step="-1"
            ${disabledMinus ? 'disabled' : ''} aria-label="减少${esc(RESOURCE_LABEL[r])}">−</button>
          <input class="offer-range" type="range" min="0" max="${max}" step="1" value="${n}"
            data-act="offer-qty" data-side="${side}" data-val="${r}" aria-label="${esc(RESOURCE_LABEL[r])}数量">
          <span class="offer-qty" style="min-width:22px;text-align:center">${n}</span>
          <button class="d-chip" data-act="offer-qty" data-side="${side}" data-val="${r}" data-step="1"
            ${disabledPlus ? 'disabled' : ''} aria-label="增加${esc(RESOURCE_LABEL[r])}">+</button>
        </div>`;
      }).join('');
    };

    const stepBar = `<div class="offer-steps">
      <button class="d-chip" data-act="offer-step" data-val="1" ${this.offerStep === 1 ? 'aria-pressed="true"' : ''}>① 我想收到</button>
      <button class="d-chip" data-act="offer-step" data-val="2" ${this.offerStep === 2 ? 'aria-pressed="true"' : ''}>② 我愿给出</button>
    </div>`;

    const step1 = `<div class="offer-side">
      <h4>我想收到</h4>
      <p>从「${esc(targetName)}」那里想得到什么；不按对方隐藏手牌限制你编辑。</p>
      ${sideRows('get')}
      <div class="d-note">收到：${bagSummary(this.draft.get)}（共 ${countOf(this.draft.get)} 张）</div>
    </div>`;
    const step2 = `<div class="offer-side">
      <h4>我愿给出</h4>
      <p>每种最多给到你自己持有的张数。</p>
      ${sideRows('give')}
      <div class="d-note"><b>完整条件：</b>给「${esc(targetName)}」${bagSummary(this.draft.give)} → 收到 ${bagSummary(this.draft.get)}
        <button class="d-chip" data-act="offer-step" data-val="1">改第一步</button></div>
    </div>`;

    return `<h4 style="margin-top:12px">发起交易 <small>收付方向以你为准</small></h4>
      <div class="d-note">${v.current === v.viewer
        ? '可向任意其他玩家报价'
        : `只能向 ${esc(v.players[v.current]?.name ?? '当前玩家')} 报价`}
        · 重发替换自己的旧报价，不自动续期 · 对象：${esc(targetName)}</div>
      <div class="d-row">${targets.map((p) => `<button class="d-chip" data-act="target" data-val="${p.index}"
        ${this.draft.target === p.index ? 'aria-pressed="true"' : ''}>${esc(p.name)}</button>`).join('')}</div>
      ${stepBar}
      ${this.offerStep === 1 ? step1 : step2}
      <div class="d-note">允许一侧为零的赠予 / 索取；两侧同时为空不能提交。我付出与我收到以你为准，成交时由服务端重新校验双方资源是否足够。</div>
      <!-- 兼容驱动点：沿用既有 D-05 行为测试的 data-act="give"/"get" 选择器，真实 UI 不可见；
           走与滑条完全相同的两侧草稿与上限，不是第二套规则。 -->
      <div hidden aria-hidden="true" class="offer-compat">
        ${RESOURCES.map((r) => `<button data-act="give" data-val="${r}" data-step="1">+</button>
          <button data-act="give" data-val="${r}" data-step="-1">−</button>
          <button data-act="get" data-val="${r}" data-step="1">+</button>
          <button data-act="get" data-val="${r}" data-step="-1">−</button>`).join('')}
      </div>`;
  }

  /** D-05：编辑草稿只重画草稿容器，报价列表（含按钮位置）完全不动 */
  private renderOfferDraft(): void {
    const host = this.extra.querySelector<HTMLElement>('[data-offer-draft]');
    if (!host) { this.renderOffers(); return; }
    host.innerHTML = this.offerDraftHtml();
    this.refreshSendButton();
  }

  private renderOffers(): void {
    const v = this.view;
    const snap = this.snapshot;
    if (!v || !snap) return;
    const now = this.serverNow();
    const cards = snap.offers.map((o) => this.offerCard(o, v.viewer, now)).join('');

    this.extra.innerHTML = `<div class="d-panel">
      <h4>待处理报价（<span data-offer-count>${snap.offers.filter((o) => o.expiresAt > now).length}</span>）</h4>
      <p>按创建时间排序，可任选一条处理；列表里的操作按钮位置固定，到期/替换/清除后原地失效，不会让下一条的接受按钮顶到手指下。</p>
      <div data-offer-list>${cards || '<div class="d-note">当前没有待处理报价。</div>'}</div>
      <div data-offer-draft>${this.offerDraftHtml()}</div>
    </div>`;
    this.renderOfferFoot();
    this.tick();
  }

  /** F6：foot 随步骤变化单独重画，切步骤不重排报价列表 */
  private renderOfferFoot(): void {
    const v = this.view;
    if (!v) return;
    const targetName = v.players[this.draft.target]?.name ?? '对方';
    this.foot(`<button class="btn ghost" data-foot="refresh">收到的提议</button>
      ${this.offerStep === 1
        ? `<button class="btn" data-foot="offer-next">下一步：我愿给出</button>
           <button class="btn primary" id="offer-send" data-foot="send">发送报价</button>`
        : `<button class="btn ghost" data-foot="offer-back">返回修改</button>
           <button class="btn primary" id="offer-send" data-foot="send">发送给「${esc(targetName)}」</button>`}`);
    this.refreshSendButton();
  }

  /** 收件人视角转换：发起人的 give 是「我收到」，get 是「我付出」 */
  private offerCard(o: OfferView, viewer: number, now: number): string {
    const { mine, own, iGive, iGet } = offerPerspective(o, viewer);
    const left = o.expiresAt - now;
    const expired = left <= 0;
    const v = this.view;
    const from = v?.players[o.from]?.name ?? `座位 ${o.from + 1}`;
    const to = v?.players[o.to]?.name ?? `座位 ${o.to + 1}`;
    const dead = expired ? 'disabled' : '';
    const ops = mine
      ? `<button class="btn primary" data-act="accept" data-id="${esc(o.id)}" ${dead}>接受</button>
         <button class="btn" data-act="reject" data-id="${esc(o.id)}" ${dead}>拒绝</button>`
      : own
        ? `<button class="btn" data-act="cancel" data-id="${esc(o.id)}" ${dead}>撤回</button>`
        : '<span class="d-note">与你无关，仅可查看</span>';
    return `<div class="d-card ${expired ? 'expired' : ''}" data-offer="${esc(o.id)}"${expired ? ' data-offer-ended="1"' : ''}>
      <h4>${esc(from)} → ${esc(to)}${expired ? ' · 已过期' : ''}</h4>
      <div class="line">我付出：${esc(fmt(iGive))}</div>
      <div class="line">我收到：${esc(fmt(iGet))}</div>
      <div class="meta">${expired
        ? '已过期 · 请返回列表查看其他报价'
        : `<span data-cd="${esc(o.id)}">剩余 ${(left / 1000).toFixed(1)}s</span><span>ID ${esc(o.id)}</span>`}</div>
      <div class="ops">${ops}</div>
    </div>`;
  }

  /** 结束回合：清晰确认，并给出不能结束的具体原因 */
  confirmEndTurn(): void {
    const v = this.view;
    if (!v) return;
    if (v.phase !== 'play') return this.toast('现在不能结束回合');
    if (v.current !== v.viewer) return this.toast('还没轮到你');
    if (v.pendingDiscards.length > 0) return this.toast('还有人尚未弃牌');
    if (v.pendingRobber) return this.toast('掷出 7 后必须先把强盗挪走');
    if (!v.hasRolled) return this.toast('先掷骰子才能结束回合');
    if (!this.connected) return this.toast('连接未同步，请稍等');
    this.showConfirm({
      title: '结束本回合？',
      detail: `当前第 ${v.turn} 回合，确认后轮到下一位玩家。桌上的报价会全部作废。`,
      onConfirm: () => this.cb.onEndTurn(),
    });
  }
}

const PANEL_TITLE: Record<Exclude<PanelName, null>, string> = {
  build: '建造', trade: '交易报价', offers: '待处理报价', dev: '发展卡',
  bank: '银行兑换 · 严格 4:1', port: '我的港口兑换', knight: '骑士', monopoly: '垄断',
  plenty: '丰饶', roads: '筑路', help: '操作帮助',
};
