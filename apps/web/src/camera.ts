/**
 * 棋盘相机与手势（重构指南 5.1 / 5.2）。
 *
 * 设计要点：相机作用在 SVG 的 viewBox 上，而不是往 SVG 里塞 <g transform>。
 * 这样 scene.ts 的绘制逻辑完全不用改，scene 每次 STATE 重建内部 DOM 也不会打断手势。
 *
 * D-01：棋盘输入层 = SVG 本身，绝不再是 .board-stage。
 * 舞台里的缩放工具、确认条、摆位/强盗/弃牌/报价浮层都是 SVG 的**兄弟节点**，
 * 它们的 pointer/click 不会穿过 SVG，因此：
 *   - 按钮点击不进入手势流程（不会顺带选中附近棋盘候选）；
 *   - 捕获阶段的 click 抑制只作用于棋盘输入层，吃不掉按钮自己的处理函数。
 * .board-stage 仍只用于测量视口尺寸（getBoundingClientRect），不接收输入。
 *
 * ULS：整个 #shell 可能被 CSS rotate(±90deg) 铺成横屏。此时
 * getBoundingClientRect() 的宽高互换、坐标轴交换，所有 clientX/clientY 都必须
 * 先经 clientToLocal() 反解回未变换的舞台坐标；measure() 用 measureRotated()
 * 把 W/H 换回来。旋转由 Panels 的状态标记驱动，getter 惰性求值，不重建相机。
 *
 * worldToScreen 的解析式（推导见 docs/14-phase-d.md）：
 *   s = baseS * zoom，baseS = min(W/box.width, H/box.height)
 *   screen.x = (world.x - cx) * s + W/2 + panX
 * 缩放围绕手势中心时，先反解该点的世界坐标，再用新 zoom 反推 pan。
 */

export interface CameraBox { x: number; y: number; width: number; height: number }

export type CandidateKind = 'vertex' | 'edge' | 'tile';

export interface BoardCandidate {
  key: string;
  kind: CandidateKind;
  /** 世界坐标（与 scene.ts 的 geo 同一坐标系） */
  x: number;
  y: number;
  label?: string;
}

export interface Hit {
  candidate: BoardCandidate;
  dist: number;
}

/**
 * ULS：CSS 自旋转下「客户端坐标 ↔ 未变换舞台坐标」的换算。
 *
 * 关键事实：元素被 rotate(±90deg) 后，getBoundingClientRect() 返回的是**变换后**
 * 的轴对齐包围盒，宽高互换（r.width = 局部高、r.height = 局部宽），而且
 * clientX-r.left / clientY-r.top 不再是元素的局部坐标。若继续用旧减法，
 * 棋盘命中会整体旋转 90° 并镜像 —— 这是自转方案最大的技术风险。
 *
 * 画布几何（Vw=竖屏视口宽、Vh=竖屏视口高，transform-origin: 0 0）：
 *   cw : translateX(Vw) rotate(90deg)   → client = (Vw - y, x)
 *   ccw: translateY(Vh) rotate(-90deg)  → client = (y, Vh - x)
 * 把舞台局部框 [bx,bx+bw]×[by,by+bh] 代入，可只用 AABB 消去 Vw/Vh：
 *   cw : r.left=Vw-by-bh, r.top=bx, r.width=bh, r.height=bw
 *        → local = (cy-r.top, r.left+r.width-cx)
 *   ccw: r.left=by, r.top=Vh-bx-bw, r.width=bh, r.height=bw
 *        → local = (r.top+r.height-cy, cx-r.left)
 * 纯函数，测试用真实几何反解验证；旋转不改变距离，8px 拖动阈值/双指缩放不受影响。
 */
export type LandscapeRotation = 0 | 90 | -90;

export interface RectLike { left: number; top: number; width: number; height: number }

export function clientToLocal(
  r: RectLike, clientX: number, clientY: number, rotation: LandscapeRotation,
): { x: number; y: number } {
  if (rotation === 90) return { x: clientY - r.top, y: r.left + r.width - clientX };
  if (rotation === -90) return { x: r.top + r.height - clientY, y: clientX - r.left };
  return { x: clientX - r.left, y: clientY - r.top };
}

/** clientToLocal 的逆运算：把舞台局部坐标还原成可传给 zoomAt 的客户端坐标 */
export function localToClient(
  r: RectLike, x: number, y: number, rotation: LandscapeRotation,
): { clientX: number; clientY: number } {
  if (rotation === 90) return { clientX: r.left + r.width - y, clientY: r.top + x };
  if (rotation === -90) return { clientX: r.left + y, clientY: r.top + r.height - x };
  return { clientX: r.left + x, clientY: r.top + y };
}

/** 旋转后 AABB 宽高互换，舞台真实宽高要换回来，否则 viewBox 与命中会整体错位 */
export function measureRotated(
  r: RectLike, rotation: LandscapeRotation,
): { W: number; H: number } {
  const rotated = rotation !== 0;
  return {
    W: Math.max(1, rotated ? r.height : r.width),
    H: Math.max(1, rotated ? r.width : r.height),
  };
}

export const DRAG_THRESHOLD_PX = 8;   // 超过这个位移就算拖动，抬手不触发建造
export const MAX_HIT_PX = 32;         // 最近合法候选的屏幕距离上限
export const AMBIGUITY_PX = 12;       // 前两名差距小于此值 → 交给用户明确选择
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3.2;

/**
 * D-01：界面控件边界。带 data-board-ui 的浮层容器，以及任何原生可交互控件，
 * 一律不进入棋盘手势流程，也绝不能被捕获阶段的 click 抑制吃掉。
 * 这是一条显式契约：新增舞台内浮层时标上 data-board-ui 即可，不依赖调用顺序。
 */
export const BOARD_UI_SELECTOR =
  '[data-board-ui], button, a[href], input, select, textarea, [role="button"]';

/** 事件是否来自 UI 控件（或其子树）。纯函数，单测直接驱动真实 pointer 序列验证。 */
export function isUiControlTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest(BOARD_UI_SELECTOR) !== null;
}

export interface CameraSnapshot {
  zoom: number;
  panX: number;
  panY: number;
  W: number;
  H: number;
}

export interface Projection {
  readonly scale: number;
  worldToScreen(p: { x: number; y: number }): { x: number; y: number };
  screenToWorld(p: { x: number; y: number }): { x: number; y: number };
  viewBox(): { x: number; y: number; w: number; h: number };
}

/**
 * 相机投影（纯函数，单测直接覆盖）：
 *   s = min(W/box.width, H/box.height) * zoom
 *   screen = (world - boxCenter) * s + viewportCenter + pan
 * zoom=1 / pan=0 时 viewBox 恰好等于 scene.ts 算出的原始包围盒。
 */
export function makeProjection(
  box: CameraBox, W: number, H: number, zoom: number, panX: number, panY: number,
): Projection {
  const base = Math.min(W / box.width, H / box.height);
  const s = base * zoom;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return {
    scale: s,
    worldToScreen: (p) => ({ x: (p.x - cx) * s + W / 2 + panX, y: (p.y - cy) * s + H / 2 + panY }),
    screenToWorld: (p) => ({ x: (p.x - W / 2 - panX) / s + cx, y: (p.y - H / 2 - panY) / s + cy }),
    viewBox: () => ({
      x: cx - (W / 2 + panX) / s,
      y: cy - (H / 2 + panY) / s,
      w: W / s,
      h: H / s,
    }),
  };
}

/** 缩放后保持手势中心对应的世界点不动，反推新的平移量 */
export function panForZoomAround(
  world: { x: number; y: number }, screen: { x: number; y: number },
  box: CameraBox, W: number, H: number, nextZoom: number,
): { panX: number; panY: number } {
  const s = Math.min(W / box.width, H / box.height) * nextZoom;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return {
    panX: screen.x - W / 2 - (world.x - cx) * s,
    panY: screen.y - H / 2 - (world.y - cy) * s,
  };
}

export type HitResolution =
  | { kind: 'none' }
  | { kind: 'single'; first: BoardCandidate }
  | { kind: 'ambiguous'; first: BoardCandidate; second: BoardCandidate };

/** 最近候选的裁决：太远忽略，前两名太接近就交给用户明确选，绝不自动替选 */
export function resolveHits(hits: readonly Hit[]): HitResolution {
  const a = hits[0];
  if (!a || a.dist > MAX_HIT_PX) return { kind: 'none' };
  const b = hits[1];
  if (b && b.dist <= MAX_HIT_PX && b.dist - a.dist < AMBIGUITY_PX) {
    return { kind: 'ambiguous', first: a.candidate, second: b.candidate };
  }
  return { kind: 'single', first: a.candidate };
}

/** 收到权威更新后复查本地选点：仍合法则保留，失效则清除并解释 */
export function candidateStillValid(candidates: readonly BoardCandidate[], key: string | null): boolean {
  return key !== null && candidates.some((c) => c.key === key);
}

export class BoardCamera {
  private box: CameraBox | null = null;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private W = 1;
  private H = 1;
  private candidates: BoardCandidate[] = [];
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: {
    last: { x: number; y: number };
    moved: number;
    multi: boolean;
    pinchDist: number;
    pinchMid: { x: number; y: number } | null;
  } | null = null;
  private suppressClick = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly svg: SVGSVGElement,
    private readonly onTap: (clientX: number, clientY: number) => void,
    /** ULS：当前 CSS 自旋转角度（0/90/-90）。由 Ui 从 Panels 的状态标记读取，
     *  惰性求值 —— 模式切换后无需重建相机，下一次手势立刻用新角度。 */
    private readonly getRotation: () => LandscapeRotation = () => 0,
  ) {
    // 所有输入只绑在棋盘输入层（SVG）。舞台内的浮层是 SVG 的兄弟节点，
    // 它们的事件不会穿过这里 —— 这是「棋盘输入区 / UI 控件」的硬边界。
    svg.addEventListener('pointerdown', this.handleDown);
    svg.addEventListener('pointermove', this.handleMove);
    svg.addEventListener('pointerup', this.handleUp);
    svg.addEventListener('pointercancel', this.handleCancel);
    svg.addEventListener('lostpointercapture', this.handleCancel);
    svg.addEventListener('wheel', this.handleWheel, { passive: false });
    // 捕获阶段只接管棋盘层的 click：拖动后的 click 必须被吃掉，
    // 但绝不能波及浮层按钮（它们根本不在这个事件路径上）。
    svg.addEventListener('click', this.handleClickCapture, true);
    window.addEventListener('blur', this.handleBlur);
  }

  get state(): CameraSnapshot {
    return { zoom: this.zoom, panX: this.panX, panY: this.panY, W: this.W, H: this.H };
  }

  /** 每次 render 后调用：更新几何包围盒与合法候选 */
  setScene(box: CameraBox, candidates: BoardCandidate[]): void {
    this.box = box;
    this.candidates = candidates;
    this.apply();
  }

  setCandidates(candidates: BoardCandidate[]): void {
    this.candidates = candidates;
  }

  measure(): void {
    const r = this.host.getBoundingClientRect();
    const { W, H } = measureRotated(r, this.getRotation());
    this.W = W;
    this.H = H;
    this.apply();
  }

  private projection(): Projection | null {
    if (!this.box) return null;
    return makeProjection(this.box, this.W, this.H, this.zoom, this.panX, this.panY);
  }

  private apply(): void {
    const proj = this.projection();
    if (!proj) return;
    const vb = proj.viewBox();
    this.svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    this.svg.setAttribute('width', String(this.W));
    this.svg.setAttribute('height', String(this.H));
  }

  worldToScreen(p: { x: number; y: number }): { x: number; y: number } {
    return this.projection()?.worldToScreen(p) ?? { x: 0, y: 0 };
  }

  screenToWorld(p: { x: number; y: number }): { x: number; y: number } {
    return this.projection()?.screenToWorld(p) ?? { x: 0, y: 0 };
  }

  /** 按实际屏幕变换找最近合法候选，返回按距离排序的命中列表 */
  nearest(clientX: number, clientY: number): Hit[] {
    const p = clientToLocal(this.host.getBoundingClientRect(), clientX, clientY, this.getRotation());
    return this.candidates
      .map((c) => {
        const s = this.worldToScreen(c);
        return { candidate: c, dist: Math.hypot(s.x - p.x, s.y - p.y) };
      })
      .sort((a, b) => a.dist - b.dist);
  }

  /** 缩放围绕手势中心；按钮缩放则围绕视口中心 */
  zoomAt(factor: number, clientX?: number, clientY?: number): void {
    if (!this.box) return;
    let px = this.W / 2;
    let py = this.H / 2;
    if (clientX !== undefined && clientY !== undefined) {
      const p = clientToLocal(this.host.getBoundingClientRect(), clientX, clientY, this.getRotation());
      px = p.x;
      py = p.y;
    }
    const world = this.screenToWorld({ x: px, y: py });
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
    if (next === this.zoom) return;
    const pan = panForZoomAround(world, { x: px, y: py }, this.box, this.W, this.H, next);
    this.panX = pan.panX;
    this.panY = pan.panY;
    this.zoom = next;
    this.apply();
  }

  reset(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.apply();
  }

  destroy(): void {
    this.svg.removeEventListener('pointerdown', this.handleDown);
    this.svg.removeEventListener('pointermove', this.handleMove);
    this.svg.removeEventListener('pointerup', this.handleUp);
    this.svg.removeEventListener('pointercancel', this.handleCancel);
    this.svg.removeEventListener('lostpointercapture', this.handleCancel);
    this.svg.removeEventListener('wheel', this.handleWheel);
    this.svg.removeEventListener('click', this.handleClickCapture, true);
    window.removeEventListener('blur', this.handleBlur);
  }

  // -------------------------------------------------------------------------

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    return clientToLocal(this.host.getBoundingClientRect(), e.clientX, e.clientY, this.getRotation());
  }

  private handleDown = (e: PointerEvent): void => {
    // 显式边界：即便将来有人把控件挪进 SVG，也不会误当成棋盘手势
    if (isUiControlTarget(e.target)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 新手势开始：清掉上一次可能残留的「吃 click」标记，避免它波及随后的按钮点击
    if (this.pointers.size === 0) this.suppressClick = false;
    try { this.svg.setPointerCapture(e.pointerId); } catch { /* 不支持就忽略 */ }
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.gesture = { last: p, moved: 0, multi: false, pinchDist: 0, pinchMid: null };
    } else {
      const pts = [...this.pointers.values()];
      const [a, b] = pts;
      this.gesture = {
        ...(this.gesture ?? { last: p, moved: 0, multi: false, pinchDist: 0, pinchMid: null }),
        multi: true,
        pinchDist: a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
        pinchMid: a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null,
      };
    }
  };

  private handleMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId) || !this.gesture) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const [a, b] = pts;
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const r = this.host.getBoundingClientRect();
      if (this.gesture.pinchDist > 0) {
        // mid 是「未变换舞台」里的局部坐标，必须按当前旋转反解回客户端坐标再交给 zoomAt
        const c = localToClient(r, mid.x, mid.y, this.getRotation());
        this.zoomAt(dist / this.gesture.pinchDist, c.clientX, c.clientY);
      }
      if (this.gesture.pinchMid) {
        this.panX += mid.x - this.gesture.pinchMid.x;
        this.panY += mid.y - this.gesture.pinchMid.y;
        this.apply();
      }
      this.gesture.pinchDist = dist;
      this.gesture.pinchMid = mid;
      this.gesture.multi = true;
      return;
    }
    const dx = p.x - this.gesture.last.x;
    const dy = p.y - this.gesture.last.y;
    this.gesture.moved += Math.hypot(dx, dy);
    if (this.gesture.moved > DRAG_THRESHOLD_PX) {
      this.panX += dx;
      this.panY += dy;
      this.apply();
    }
    this.gesture.last = p;
  };

  private handleUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    const wasSingle = this.pointers.size === 1;
    this.pointers.delete(e.pointerId);
    try { this.svg.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    const g = this.gesture;
    if (g && wasSingle && !g.multi && g.moved <= DRAG_THRESHOLD_PX) {
      this.onTap(e.clientX, e.clientY);
      this.suppressClick = true; // 吃掉随后的原生 click，避免 DOM 委托重复处理
    } else if (g && (g.multi || g.moved > DRAG_THRESHOLD_PX)) {
      this.suppressClick = true;
    }
    if (this.pointers.size === 0) this.gesture = null;
    else if (this.pointers.size === 1) {
      const p = [...this.pointers.values()][0]!;
      this.gesture = { last: p, moved: DRAG_THRESHOLD_PX + 1, multi: true, pinchDist: 0, pinchMid: null };
    }
  };

  private handleCancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.gesture = null;
  };

  private handleBlur = (): void => {
    this.pointers.clear();
    this.gesture = null;
    this.suppressClick = false;
  };

  private handleWheel = (e: WheelEvent): void => {
    // 浮层/表单区域保留原生滚动与输入，不当成棋盘缩放手势（指南 5.1）
    if (isUiControlTarget(e.target)) return;
    e.preventDefault();
    this.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  };

  /** 该事件目标是否落在棋盘输入层（SVG 本身或它的子元素）内 */
  private isBoardInputTarget(target: EventTarget | null): boolean {
    if (target === this.svg) return true;
    const contains = (this.svg as Element).contains;
    return typeof contains === 'function' && !!(target && contains.call(this.svg, target as Node));
  }

  private handleClickCapture = (e: MouseEvent): void => {
    if (!this.suppressClick) return;
    // 只吃棋盘输入层产生的 click（拖动后的误点击 / 点选后避免 DOM 委托重复处理）。
    // UI 控件上的 click 一律放行 —— D-01 的根因就是旧实现在这里无条件 stopPropagation。
    const boardClick = this.isBoardInputTarget(e.target) && !isUiControlTarget(e.target);
    this.suppressClick = false;
    if (!boardClick) return;
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();
  };
}
