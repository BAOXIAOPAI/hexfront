/**
 * 文档 23 L-1/L-2/L-4：房间大厅浮层。
 *
 * 独立模块，避免把「大厅 UI」塞进已经很大的 ui.ts 游戏渲染逻辑。
 * 只做展示与把点击翻译成回调；一切合法性由服务端裁决后回 REJECT。
 *
 * 内容：玩家席位与准备状态、**六边形棋盘地图预览**（地形/数字/港口/强盗）、
 * 资源质量提示、选地/回合顺序、房间设置、开始按钮、选地倒计时。
 *
 * 棋盘几何直接复用 @hexfront/engine 的 buildGeometry/cornersOf，
 * 与服务端、游戏内棋盘完全同构，不另写一套容易漂移的坐标推导。
 */

import { buildGeometry, cornersOf, HEX_SIZE, type Geometry } from '@hexfront/engine';
import type { BoardKind, LobbyConfig, LobbyPlayer, MapSnapshot, SetupTimer } from '@hexfront/protocol';

export interface LobbyHandlers {
  onReady(ready: boolean): void;
  /** F2：人数与手选地图分成两个独立意图，绝不一起提交 */
  onPlayerCount(targetPlayers: number, configVersion: number): void;
  onBoard(board: BoardKind, configVersion: number): void;
  onReroll(configVersion: number): void;
  onOrder(order: number[], configVersion: number): void;
  onRandomizeOrder(configVersion: number): void;
  onStart(configVersion: number): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]!);
}

const TERRAIN_NAME: Record<string, string> = {
  wood: '木', brick: '砖', sheep: '羊', wheat: '麦', ore: '矿', desert: '沙',
};
const TERRAIN_HEX: Record<string, string> = {
  wood: '#74A46B', brick: '#D07F57', sheep: '#ACCF7A', wheat: '#E7BE57', ore: '#98A6A5', desert: '#EBD39D',
};
const MARKS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
const COLOR_HEX = ['#C9503F', '#3B6FA0', '#B4741D', '#4C8B67', '#7A5A9E', '#2F8C8C', '#C2638A', '#5C6B7A'];

const RED_NUMBERS = new Set([6, 8]);
/** 点数 n 的理论产出权重（36 面骰中出现的次数），排除 7 */
const PIPS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
/** 五种资源参与「稀缺/富余」判断的顺序 */
const RESOURCE_ORDER: Array<{ key: string; label: string }> = [
  { key: 'wood', label: '木' }, { key: 'brick', label: '砖' }, { key: 'sheep', label: '羊' },
  { key: 'wheat', label: '麦' }, { key: 'ore', label: '矿' },
];

export interface LobbyState {
  roomId: string;
  seat: number;
  players: LobbyPlayer[];
  lobby: LobbyConfig;
  map: MapSnapshot;
  timer: SetupTimer | null;
}

export interface MapQuality {
  /** 各资源的理论产出权重（按点数加权，不只是地块数量） */
  weights: Record<string, number>;
  totalWeight: number;
  /** 相对五类资源均值偏低/偏高的资源（阈值 ±35%） */
  scarce: string[];
  abundant: string[];
  /** 是否整体接近均衡 */
  balanced: boolean;
  /** 一句话给玩家看的提示 */
  hint: string;
  /** 红点（6/8）地块数量 */
  redCount: number;
  /** 是否存在相邻红点（理论上生成器已禁止，这里再独立核验一次） */
  redAdjacent: boolean;
}

/**
 * 文档 23 §3：地图质量指标。
 * 对点数 n 用 `6-|7-n|` 累加到各类地形，检查资源产出权重分布。
 * 这是**质量指标**，不保证五类权重完全相等，也不是胜率承诺；
 * 只用来给玩家一句「此图可能缺矿」之类的直观提示。
 */
export function analyzeMapQuality(map: MapSnapshot): MapQuality {
  const weights: Record<string, number> = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  let totalWeight = 0;
  let redCount = 0;
  const redTiles: string[] = [];

  for (const t of map.tiles) {
    if (t.terrain === 'desert' || t.number === null) continue;
    const w = PIPS[t.number] ?? (6 - Math.abs(7 - t.number));
    weights[t.terrain] = (weights[t.terrain] ?? 0) + w;
    totalWeight += w;
    if (RED_NUMBERS.has(t.number)) { redCount++; redTiles.push(t.key); }
  }

  // 红点不共边：用地图快照的 rows 重建同一套几何判定
  let redAdjacent = false;
  if (redTiles.length > 1) {
    const geo = buildGeometry(map.rows);
    for (let i = 0; i < redTiles.length; i++) {
      const a = geo.tiles[redTiles[i]!];
      if (!a) continue;
      for (let j = i + 1; j < redTiles.length; j++) {
        const b = geo.tiles[redTiles[j]!];
        if (!b) continue;
        const du = Math.abs(a.u - b.u), dr = Math.abs(a.row - b.row);
        if ((dr === 0 && du === 2) || (dr === 1 && du === 1)) redAdjacent = true;
      }
    }
  }

  const values = RESOURCE_ORDER.map((r) => weights[r.key] ?? 0);
  const avg = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  const scarce: string[] = [];
  const abundant: string[] = [];
  for (const r of RESOURCE_ORDER) {
    const v = weights[r.key] ?? 0;
    if (avg > 0 && v < avg * 0.65) scarce.push(r.label);
    else if (avg > 0 && v > avg * 1.35) abundant.push(r.label);
  }
  const balanced = scarce.length === 0 && abundant.length === 0;

  let hint: string;
  if (balanced) {
    hint = '各类资源产出较均衡，开局选择余地大。';
  } else {
    const parts: string[] = [];
    if (scarce.length > 0) parts.push(`可能缺${scarce.join('、')}`);
    if (abundant.length > 0) parts.push(`${abundant.join('、')}相对充足`);
    hint = `${parts.join('，')}；抢位时可据此调整。（仅为理论产出权重，不保证实际掷骰结果）`;
  }
  if (redAdjacent) hint = '⚠ 检测到 6/8 相邻，地图生成异常，建议重抽。' + hint;

  return { weights, totalWeight, scarce, abundant, balanced, hint, redCount, redAdjacent };
}

/** 纯函数：地图预览摘要，供 UI 展示与测试断言「全员看到同一份」 */
export function mapSummary(map: MapSnapshot): string {
  const terrains: Record<string, number> = {};
  let deserts = 0;
  let reds = 0;
  for (const t of map.tiles) {
    terrains[t.terrain] = (terrains[t.terrain] ?? 0) + 1;
    if (t.terrain === 'desert') deserts++;
    else if (t.number !== null && RED_NUMBERS.has(t.number)) reds++;
  }
  const t = Object.entries(terrains).sort().map(([k, n]) => `${TERRAIN_NAME[k] ?? k}${n}`).join(' ');
  return `${map.tiles.length} 格 · ${t} · 红点${reds} · ${map.ports.length} 港 · 种子 ${map.seed.slice(0, 8)} · v${map.boardVersion}`;
}

// ---------------------------------------------------------------------------
// 六边形棋盘预览（SVG）
// ---------------------------------------------------------------------------

/**
 * 预览六边形半径必须与引擎 HEX_SIZE 一致：buildGeometry 的中心距是按 56 算的，
 * 若这里另用 27 去画，中心不缩放就会留出大片缝隙，破坏蜂窝拼接。
 * 整体缩放交给 SVG viewBox，坐标一律用引擎原生值。
 */
const PREVIEW_HEX = HEX_SIZE;
/** 港口标签宽 48px（中心 ±24）；留白必须大于半宽，否则最外侧标签会被 viewBox 裁掉 */
const PREVIEW_PAD = 46;

interface PreviewTile {
  key: string;
  cx: number;
  cy: number;
  terrain: string;
  number: number | null;
  hasRobber: boolean;
}

/** 从地图快照构造预览用的地块坐标（与引擎 buildGeometry 完全同构） */
function previewTiles(map: MapSnapshot): {
  tiles: PreviewTile[];
  width: number;
  height: number;
  minX: number;
  minY: number;
} {
  const geo: Geometry = buildGeometry(map.rows);
  const byKey = new Map(map.tiles.map((t) => [t.key, t]));
  const tiles: PreviewTile[] = geo.tileKeys.map((key) => {
    const g = geo.tiles[key]!;
    const def = byKey.get(key);
    return {
      key,
      cx: g.x,
      cy: g.y,
      terrain: def?.terrain ?? 'desert',
      number: def?.number ?? null,
      hasRobber: key === map.robberTile,
    };
  });

  // 计算包围盒，把负坐标平移到正区间。
  // 引擎 cornersOf 是 flat-top（角度 60i−30），顶点 x 极值 ±R·cos30、y 极值 ±R。
  const dx = PREVIEW_HEX * Math.sqrt(3) / 2;
  const dy = PREVIEW_HEX;
  const xs = tiles.flatMap((t) => [t.cx - dx, t.cx + dx]);
  const ys = tiles.flatMap((t) => [t.cy - dy, t.cy + dy]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return {
    tiles,
    width: maxX - minX + PREVIEW_PAD * 2,
    height: maxY - minY + PREVIEW_PAD * 2,
    minX, minY,
  };
}

/** 港口标签：放在对应边界边的外侧中点，随棋盘一起平移 */
function previewPorts(map: MapSnapshot, minX: number, minY: number): { x: number; y: number; label: string }[] {
  const geo = buildGeometry(map.rows);
  const out: { x: number; y: number; label: string }[] = [];
  for (const p of map.ports) {
    const e = geo.edges[p.edge];
    if (!e) continue;
    const a = geo.vertices[e.a], b = geo.vertices[e.b];
    if (!a || !b) continue;
    const label = p.port.kind === 'generic'
      ? '3:1'
      : `2:1${TERRAIN_NAME[p.port.resource] ?? ''}`;
    out.push({
      x: (a.x + b.x) / 2 - minX + PREVIEW_PAD,
      y: (a.y + b.y) / 2 - minY + PREVIEW_PAD,
      label,
    });
  }
  return out;
}

/**
 * 纯函数：把地图快照渲染成 SVG 字符串。
 * - 六边形按真实 (u,row) 网格排布，看得出棋盘形状与相邻关系
 * - 数字用 pips 点阵（6/8 红色加粗），沙漠画仙人掌式留白并标强盗
 * - 港口贴在真实沿岸边的中点，而不是一排文字标签
 */
export function renderMapSvg(map: MapSnapshot): string {
  const { tiles, width, height, minX, minY } = previewTiles(map);
  const ports = previewPorts(map, minX, minY);
  const tx = (x: number): number => x - minX + PREVIEW_PAD;
  const ty = (y: number): number => y - minY + PREVIEW_PAD;

  const hexes = tiles.map((t) => {
    const pts = cornersOf(tx(t.cx), ty(t.cy), PREVIEW_HEX)
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const fill = TERRAIN_HEX[t.terrain] ?? '#ccc';
    const isRed = t.number !== null && RED_NUMBERS.has(t.number);
    const numText = t.number === null ? '' : String(t.number);
    const pips = t.number === null ? '' : '·'.repeat(Math.min(PIPS[t.number] ?? 1, 5));
    const robber = t.hasRobber
      ? `<circle cx="${tx(t.cx)}" cy="${ty(t.cy) + 18}" r="11" fill="#2A4036" opacity=".82"/>
         <text x="${tx(t.cx)}" y="${ty(t.cy) + 22}" text-anchor="middle" font-size="12" fill="#FFF6E2">盗</text>`
      : '';
    return `
      <g class="lb-hex${isRed ? ' red' : ''}">
        <polygon points="${pts}" fill="${fill}" stroke="rgba(42,64,54,.45)" stroke-width="1.6"/>
        ${numText
          ? `<text x="${tx(t.cx)}" y="${ty(t.cy) + 2}" text-anchor="middle" dominant-baseline="middle"
                   font-size="${isRed ? 26 : 23}" font-weight="${isRed ? 800 : 700}"
                   fill="${isRed ? '#9E2B1E' : '#23372F'}" font-family="ui-rounded, system-ui, sans-serif">${numText}</text>
             <text x="${tx(t.cx)}" y="${ty(t.cy) + 22}" text-anchor="middle"
                   font-size="11" fill="${isRed ? '#9E2B1E' : '#4A5B4E'}" letter-spacing="2">${pips}</text>`
          : `<text x="${tx(t.cx)}" y="${ty(t.cy) - (t.hasRobber ? 10 : 2)}" text-anchor="middle" dominant-baseline="middle"
                   font-size="24" fill="#8A7448">⌁</text>`}
        ${robber}
        <title>${esc(`${t.key} ${TERRAIN_NAME[t.terrain] ?? t.terrain} ${numText || '沙漠'}${t.hasRobber ? ' · 强盗' : ''}`)}</title>
      </g>`;
  }).join('');

  const portLabels = ports.map((p) => `
    <g class="lb-port-pin">
      <rect x="${p.x - 24}" y="${p.y - 11}" width="48" height="22" rx="11"
            fill="#FFF6E2" stroke="#C9B48F" stroke-width="1.2"/>
      <text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="12"
            font-weight="700" fill="#5A4A32">${esc(p.label)}</text>
    </g>`).join('');

  return `<svg class="lb-board" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}"
               width="100%" role="img" aria-label="${esc(`${map.tiles.length} 格${map.kind === 'ext' ? '扩展' : '标准'}棋盘预览`)}">
    ${hexes}${portLabels}
  </svg>`;
}

/** 纯函数：蛇形预览，展示「正序 + 倒序」，末位连续两次仍各是独立步骤 */
export function snakePreview(order: readonly number[], names: readonly (string | undefined)[]): string {
  const label = (s: number): string => names[s] ?? `座位 ${s + 1}`;
  const forward = order.map(label).join(' → ');
  const reverse = order.slice().reverse().map(label).join(' → ');
  return `${forward} ⇄ ${reverse}`;
}

/**
 * 倒计时剩余秒数（服务端权威 deadline，客户端只展示）。
 * serverTime 是服务端发快照时的时刻；用「本地收到时刻 - serverTime」估算时钟偏差，
 * 不按本地绝对时间直接减，避免两端时钟不一致导致提前/延后。
 */
export function remainingSeconds(timer: SetupTimer, receivedAt: number, now: number): number {
  const skew = now - receivedAt;
  return Math.max(0, Math.ceil((timer.deadline - (timer.serverTime + skew)) / 1000));
}

export class LobbyView {
  private state: LobbyState | null = null;
  private handlers: LobbyHandlers;
  private sheet: HTMLElement;
  private overlay: HTMLElement;
  /** 收到快照的本地时刻，用于估算客户端与服务端时钟偏差 */
  private receivedAt = 0;

  constructor(sheet: HTMLElement, overlay: HTMLElement, handlers: LobbyHandlers) {
    this.sheet = sheet;
    this.overlay = overlay;
    this.handlers = handlers;
    // 事件委托：innerHTML 每次重画也不丢监听
    this.sheet.addEventListener('click', (ev) => this.onClick(ev));
    this.sheet.addEventListener('change', (ev) => this.onChange(ev));
  }

  /** 服务端推来权威快照时调用；重连/刷新拿到的是同一份数据 */
  setState(state: LobbyState): void {
    this.state = state;
    this.receivedAt = Date.now();
    this.overlay.classList.remove('hidden');
    this.render();
  }

  hide(): void {
    this.overlay.classList.add('hidden');
  }

  /** 只更新倒计时，不整块重画（避免打断输入/滚动）；刷新/重连由服务端 deadline 保证不重置 */
  tick(now: number): void {
    const s = this.state;
    if (!s || !s.timer) return;
    const left = remainingSeconds(s.timer, this.receivedAt, now);
    const node = this.sheet.querySelector<HTMLElement>('[data-timer]');
    if (node) {
      const m = Math.floor(left / 60);
      const sec = left % 60;
      node.textContent = `${m}:${String(sec).padStart(2, '0')}`;
      node.classList.toggle('urgent', left <= 60);
    }
  }

  private onChange(ev: Event): void {
    const target = ev.target as { id?: string; value?: string } | null;
    // 用鸭子类型而非 instanceof HTML*Element：测试用的 mini-dom 也能驱动同一段逻辑
    if (!target || typeof target.id !== 'string' || typeof target.value !== 'string') return;
    const s = this.state;
    if (!s) return;
    // F2：改人数只发人数（服务端自动按推荐换盘）；改地图只发地图（明确手选）。
    // 绝不把当前盘当成手动选择一起提交（这是 F2 缺陷的根因）。
    if (target.id === 'lb-players') {
      this.handlers.onPlayerCount(Number(target.value), s.lobby.configVersion);
    } else if (target.id === 'lb-board') {
      this.handlers.onBoard(target.value as BoardKind, s.lobby.configVersion);
    }
  }

  private onClick(ev: Event): void {
    if (!(ev.target instanceof Element)) return;
    const s = this.state;
    if (!s) return;
    const btn = ev.target.closest<HTMLElement>('[data-act]');
    if (!btn || btn.hasAttribute('disabled')) return;
    const act = btn.dataset.act;
    const v = s.lobby.configVersion;
    switch (act) {
      case 'ready':
        this.handlers.onReady(!(s.players.find((p) => p.seat === s.seat)?.ready ?? false));
        break;
      case 'reroll':
        this.handlers.onReroll(v);
        break;
      case 'random-order':
        this.handlers.onRandomizeOrder(v);
        break;
      case 'start':
        this.handlers.onStart(v);
        break;
      case 'order-up':
      case 'order-down': {
        const idx = Number(btn.dataset.idx);
        const swap = act === 'order-up' ? idx - 1 : idx + 1;
        const order = s.lobby.actionOrder.slice();
        if (swap >= 0 && swap < order.length) {
          [order[idx], order[swap]] = [order[swap]!, order[idx]!];
          this.handlers.onOrder(order, v);
        }
        break;
      }
    }
  }

  private render(): void {
    const s = this.state;
    if (!s) return;
    const { lobby, map, players, seat, roomId, timer } = s;
    const isHost = lobby.hostSeat === seat;
    const me = players.find((p) => p.seat === seat);
    const names = players.map((p) => p.name);
    const crowded = lobby.board !== lobby.recommendedBoard;

    const seats: string[] = [];
    for (let i = 0; i < lobby.targetPlayers; i++) {
      const p = players.find((x) => x.seat === i);
      const hex = COLOR_HEX[i % COLOR_HEX.length]!;
      const mark = MARKS[i % MARKS.length]!;
      if (p) {
        seats.push(`
          <div class="lb-seat">
            <span class="lb-ava" style="--c:${hex}">${esc(mark)}</span>
            <span class="lb-who">${esc(p.name)}${i === seat ? '（你）' : ''}${i === lobby.hostSeat ? ' · 房主' : ''}</span>
            <span class="lb-st ${p.connected ? 'on' : ''}">${p.connected ? '在线' : '离线'}</span>
            <span class="lb-rd ${p.ready ? 'yes' : ''}">${p.ready ? '已准备' : '未准备'}</span>
          </div>`);
      } else {
        seats.push(`<div class="lb-seat open"><span class="lb-ava ghost">${mark}</span><span class="lb-who">空位 ${i + 1}</span></div>`);
      }
    }

    // 地图预览：真正的六边形棋盘（与引擎同构几何），港口贴在沿岸边，强盗标在沙漠
    const boardSvg = renderMapSvg(map);
    const quality = analyzeMapQuality(map);
    const weightBars = RESOURCE_ORDER.map((r) => {
      const v = quality.weights[r.key] ?? 0;
      const pct = quality.totalWeight > 0 ? Math.round((v / quality.totalWeight) * 500) : 0;
      const scarce = quality.scarce.includes(r.label);
      return `<div class="lb-weight${scarce ? ' scarce' : ''}">
        <span class="lb-weight-name">${r.label}</span>
        <span class="lb-weight-track"><i style="width:${Math.min(100, pct)}%;background:${TERRAIN_HEX[r.key] ?? '#ccc'}"></i></span>
        <span class="lb-weight-val">${v}</span>
      </div>`;
    }).join('');

    const orderRows = lobby.actionOrder.map((s2, i) => `
      <div class="lb-order-row">
        <span class="lb-order-idx">${i + 1}</span>
        <span class="lb-order-name">${esc(names[s2] ?? `座位 ${s2 + 1}`)}</span>
        ${isHost && !lobby.canStart ? `
          <button class="lb-mini" data-act="order-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="lb-mini" data-act="order-down" data-idx="${i}" ${i === lobby.actionOrder.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
      </div>`).join('');

    const playerOptions = [4, 5, 6, 7, 8]
      .map((n) => `<option value="${n}" ${n === lobby.targetPlayers ? 'selected' : ''}>${n} 人</option>`)
      .join('');

    const timerHtml = timer
      ? `<div class="lb-timer"><span>本次放置剩余</span><b data-timer>--:--</b><small>每次独立 180 秒 · 超时系统代放</small></div>`
      : '';

    this.sheet.innerHTML = `
      <h1>房间 ${esc(roomId.toUpperCase())}</h1>
      <p class="sub">${players.length} / ${lobby.targetPlayers} 人在座 · 全员在线准备后由房主开始（不会自动开局）。</p>

      <div class="lb-section-title">玩家席位</div>
      <div class="lb-seats">${seats.join('')}</div>

      <div class="lb-section-title">地图预览 <small>同一份快照 · 操作者 ${esc(names[lobby.changedBy] ?? '系统')} · ${esc(lobby.changeReason)}</small></div>
      <div class="lb-map">
        <div class="lb-board-wrap">${boardSvg}</div>
        <div class="lb-legend">
          <span><i class="lg-red"></i>6 / 8 高产点（已保证互不相邻）</span>
          <span><i class="lg-robber"></i>强盗起点</span>
          <span><i class="lg-port"></i>沿岸港口</span>
        </div>
        <div class="lb-map-meta">${esc(mapSummary(map))}</div>
        <div class="lb-quality ${quality.balanced ? 'balanced' : 'skewed'}">
          <div class="lb-quality-head">${quality.balanced ? '资源产出评估 · 较均衡' : '资源产出评估 · 分布有偏'}</div>
          <div class="lb-quality-hint">${esc(quality.hint)}</div>
          <div class="lb-weights">${weightBars}</div>
          <div class="lb-quality-foot">按点数理论产出权重（6−|7−n|）统计，仅作抢位参考，不保证实际掷骰结果。</div>
        </div>
        ${crowded ? '<div class="lb-warn">当前人数与地图不匹配，棋盘会较拥挤；建议改用推荐地图。</div>' : ''}
        ${lobby.boardChoice === 'manual' ? '<div class="lb-tag">自定义地图</div>' : ''}
      </div>

      <div class="lb-section-title">选地 / 回合顺序 <small>开局后锁定</small></div>
      <div class="lb-snake">${esc(snakePreview(lobby.actionOrder, names))}</div>
      <div class="lb-order">${orderRows}</div>

      ${isHost ? `
        <div class="lb-config">
          <div class="lb-field"><label>目标人数</label><select id="lb-players">${playerOptions}</select></div>
          <div class="lb-field"><label>棋盘类型</label>
            <select id="lb-board">
              <option value="base" ${lobby.board === 'base' ? 'selected' : ''}>标准盘 · 19 格</option>
              <option value="ext" ${lobby.board === 'ext' ? 'selected' : ''}>扩展盘 · 30 格</option>
            </select>
          </div>
          <button class="btn ghost lb-btn" data-act="reroll">重新随机地图</button>
          <button class="btn ghost lb-btn" data-act="random-order">随机顺序</button>
        </div>` : '<div class="lb-tag">仅房主可修改人数、地图与顺序</div>'}

      ${timerHtml}

      <button class="btn primary lb-ready" data-act="ready">${me?.ready ? '取消准备' : '我准备好了'}</button>
      ${isHost ? `<button class="btn primary lb-start" data-act="start" ${lobby.canStart ? '' : 'disabled'}>开始游戏</button>` : ''}
      ${!lobby.canStart && lobby.startBlockReason
        ? `<div class="hint">暂不能开始：${esc(startBlockText(lobby.startBlockReason))}</div>`
        : '<div class="hint">满员 + 全员在线准备后，房主点击「开始游戏」。</div>'}
      <div class="hint">7–8 人属本项目自定义玩法，拥挤程度以试玩观察为准，不宣称官方支持。</div>
    `;
    this.tick(Date.now());
  }
}

function startBlockText(reason: string): string {
  const map: Record<string, string> = {
    NOT_ENOUGH_PLAYERS: '人数未达到目标人数',
    NOT_ALL_READY: '还有玩家未准备',
    PLAYERS_OFFLINE: '有玩家离线',
    GAME_ALREADY_STARTED: '本局已开始',
    BOARD_NOT_READY: '地图尚未就绪',
  };
  return map[reason] ?? reason;
}
