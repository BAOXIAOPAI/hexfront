"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  Anchor, ArrowDownToLine, ArrowLeftRight, Building2, Check,
  Hammer, Handshake, House, Landmark, Minus, Plus, Route,
  ScrollText, Undo2, X,
} from "lucide-react";

const TABLE_RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"] as const;
type TableResource = (typeof TABLE_RESOURCES)[number];
export type TableResourceBag = Record<string, number>;
export type TableBuildKind = "road" | "settlement" | "city" | "development";
export type TableTradeKind = "bank" | "port" | "players";
const RESOURCE_META: Record<TableResource, { name: string; color: string }> = {
  wood: { name: "木材", color: "#6c9e77" },
  brick: { name: "砖块", color: "#c88268" },
  sheep: { name: "羊毛", color: "#a9b77c" },
  wheat: { name: "麦穗", color: "#d4b773" },
  ore: { name: "矿石", color: "#8b9db7" },
};
const bagCount = (bag: TableResourceBag) => TABLE_RESOURCES.reduce((sum, resource) => sum + Math.max(0, bag[resource] || 0), 0);
const resourceStyle = (resource: TableResource, extra: Record<string, string | number> = {}) => ({
  "--table-resource": RESOURCE_META[resource].color, ...extra,
}) as CSSProperties;

function ResourceIcon({ resource, className = "" }: { resource: TableResource; className?: string }) {
  // Plain SVG image files deliberately preserve the asset's transparent silhouette.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={`table-resource-icon ${className}`} src={`/assets/${resource}.svg`} width={32} height={32} alt="" draggable={false} />;
}

export type TableCardReturnResult = boolean | void | Promise<boolean | void>;

export interface TableCardsProps {
  staged: TableResourceBag;
  onReturn: (resource: string) => TableCardReturnResult;
  onClear: () => void;
  burning?: boolean;
  disabled?: boolean;
  onDragStart?: (event: ReactPointerEvent<HTMLButtonElement>, resource: string) => void;
  onDragMove?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onDragEnd?: (event: ReactPointerEvent<HTMLButtonElement>) => TableCardReturnResult;
}

/** A personal staging tray; its parent owns drop handling and all game actions. */
export function TableCards({ staged, onReturn, onClear, burning = false, disabled = false, onDragStart, onDragMove, onDragEnd }: TableCardsProps) {
  const resources = TABLE_RESOURCES.filter(resource => (staged[resource] || 0) > 0);
  const total = bagCount(staged);
  return <section className={`table-tray ${total ? "table-tray-filled" : "table-tray-empty"} ${burning ? "table-tray-burning" : ""}`} aria-label="我的桌面资源" aria-busy={burning}>
    <div className="table-tray-heading">
      <span><span className="table-status-dot" />我的桌面 <small>仅自己可见</small></span>
      {total > 0 && <button type="button" className="table-clear" onClick={onClear} disabled={disabled || burning} aria-label="将桌面所有资源拿回手中"><Undo2 size={12} /><span>全部拿回</span></button>}
    </div>
    {total === 0 ? <div className="table-tray-placeholder"><ArrowDownToLine size={21} strokeWidth={1.3} /><span>把手牌拖到地图上</span><small>先摆好，再决定如何使用</small></div> : <>
      <div className="table-staged-cards" aria-label={`已摆出 ${total} 张资源牌`}>
        {resources.map((resource, index) => <button type="button" className="table-staged-card" key={resource} style={resourceStyle(resource, { "--table-card-index": index, "--table-card-angle": `${(index - (resources.length - 1) / 2) * 3}deg` })} disabled={disabled || burning} onClick={onDragStart ? undefined : () => onReturn(resource)} onPointerDown={onDragStart ? event => onDragStart(event, resource) : undefined} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd} onKeyDown={onDragStart ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onReturn(resource); } } : undefined} title={`${RESOURCE_META[resource].name} ${staged[resource]} 张 · 拖回手中，或点一下拿回一张`} aria-label={`拿回一张${RESOURCE_META[resource].name}，桌面共有${staged[resource]}张`}>
          <span className="table-card-corner" aria-hidden="true">✧</span>
          <ResourceIcon resource={resource} />
          <span className="table-card-name">{RESOURCE_META[resource].name}</span>
          <span className="table-card-count"><small>×</small>{staged[resource]}</span>
          <span className="table-card-return"><Undo2 size={11} />拿回一张</span>
          {burning && <span className="table-card-embers" aria-hidden="true">{Array.from({ length: 8 }, (_, n) => <i key={n} style={{ "--table-ember": n } as CSSProperties} />)}</span>}
        </button>)}
      </div>
      <div className="table-tray-caption" aria-live="polite">{burning ? <><span className="table-burning-spark">✦</span>资源正在消耗</> : <>已摆出 <b>{total}</b> 张 <span>· 拖回手中，或点一下拿回</span></>}</div>
    </>}
  </section>;
}

type ScatteredCard = { id: number; resource: TableResource; x: number; y: number; angle: number };
type ScatterLedger = { signature: string; nextId: number; resources: Record<TableResource, ScatteredCard[]>; preferredRemoval: { id: number; resource: TableResource } | null };
const SCATTER_ANCHORS = [
  [83, 74, -13], [167, 20, 7], [244, 69, -6], [302, 16, 14],
  [27, 24, -16], [203, 86, 4], [122, 40, -3], [343, 78, 11],
  [68, 4, 5], [270, 38, -12], [155, 89, 12], [319, 51, -4],
] as const;
const stagedQuantity = (staged: TableResourceBag, resource: TableResource) => Number.isFinite(staged[resource]) ? Math.max(0, Math.floor(staged[resource])) : 0;
function scatterHash(id: number) {
  let value = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 16), 0xc2b2ae35);
  return ((value ^ (value >>> 13)) >>> 0) / 4294967296;
}
function scatterPosition(id: number) {
  const [x, y, angle] = SCATTER_ANCHORS[(id - 1) % SCATTER_ANCHORS.length];
  const layer = Math.floor((id - 1) / SCATTER_ANCHORS.length);
  return {
    x: Math.max(8, Math.min(352, x + (scatterHash(id * 3) - .5) * 12 + (layer % 3 - 1) * 3)),
    y: Math.max(4, Math.min(91, y + (scatterHash(id * 3 + 1) - .5) * 8)),
    angle: angle + (scatterHash(id * 3 + 2) - .5) * 5,
  };
}
function reconcileScatter(previous: ScatterLedger | null, staged: TableResourceBag, signature: string): ScatterLedger {
  let nextId = previous?.nextId ?? 1;
  const resources = {} as Record<TableResource, ScatteredCard[]>;
  for (const resource of TABLE_RESOURCES) {
    const quantity = stagedQuantity(staged, resource);
    const existing = previous?.resources[resource] ?? [];
    const selected = previous?.preferredRemoval;
    // A direct return removes that exact physical card. Other quantity changes
    // remove the tail, while all surviving cards retain their IDs and positions.
    const candidates = quantity < existing.length && selected?.resource === resource
      ? existing.filter(card => card.id !== selected.id)
      : existing;
    const cards = candidates.slice(0, quantity);
    while (cards.length < quantity) {
      const id = nextId++;
      cards.push({ id, resource, ...scatterPosition(id) });
    }
    resources[resource] = cards;
  }
  return { signature, nextId, resources, preferredRemoval: null };
}

export type ScatteredCardsProps = TableCardsProps;

/** Physical cards retain their IDs and coordinates until that resource is returned. */
export function ScatteredCards({ staged, onReturn, burning = false, disabled = false, onDragStart, onDragMove, onDragEnd }: ScatteredCardsProps) {
  const signature = TABLE_RESOURCES.map(resource => stagedQuantity(staged, resource)).join(":");
  const [ledger, setLedger] = useState<ScatterLedger>(() => reconcileScatter(null, staged, signature));
  const pointerCard = useRef<{ id: number; pointerId: number } | null>(null);
  // A guarded render update synchronizes props before commit. It is immutable,
  // deterministic, and safe when React retries a render; no ref is mutated here.
  if (ledger.signature !== signature) setLedger(reconcileScatter(ledger, staged, signature));
  const cards = TABLE_RESOURCES.flatMap(resource => ledger.resources[resource]).sort((a, b) => a.id - b.id);
  function clearPreference(id: number) {
    setLedger(previous => previous.preferredRemoval?.id === id ? { ...previous, preferredRemoval: null } : previous);
  }
  function returnPhysicalCard(card: ScatteredCard, callback: () => TableCardReturnResult) {
    // Remember the ID before the parent can synchronously update its counts.
    setLedger(previous => ({ ...previous, preferredRemoval: { id: card.id, resource: card.resource } }));
    try {
      const result = callback();
      if (result && typeof result === "object" && "then" in result) {
        void result.then(accepted => { if (accepted === false) clearPreference(card.id); }, () => clearPreference(card.id));
      } else if (result === false) clearPreference(card.id);
    } catch (error) {
      clearPreference(card.id);
      throw error;
    }
  }
  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>, card: ScatteredCard) {
    if (event.button !== 0 || disabled || burning) return;
    pointerCard.current = { id: card.id, pointerId: event.pointerId };
    onDragStart?.(event, card.resource);
  }
  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>, card: ScatteredCard) {
    const tracked = pointerCard.current;
    pointerCard.current = null;
    if (event.type === "pointercancel" || !tracked || tracked.id !== card.id || tracked.pointerId !== event.pointerId) {
      clearPreference(card.id);
      const result = onDragEnd?.(event);
      if (result && typeof result === "object" && "then" in result) void result.catch(() => undefined);
      return;
    }
    returnPhysicalCard(card, () => onDragEnd?.(event));
  }
  return <div className={`table-scattered-cards ${burning ? "table-tray-burning" : ""}`} aria-label={`地图上摆放的 ${cards.length} 张个人资源牌`} aria-busy={burning}>
    {cards.map(card => <button type="button" className="table-staged-card table-scattered-card" key={card.id} data-table-card-id={card.id} data-resource={card.resource} style={resourceStyle(card.resource, {
      "--table-scatter-x": `${card.x / 410 * 100}%`, "--table-scatter-y": `${card.y}px`, "--table-card-angle": `${card.angle}deg`, "--table-scatter-order": card.id,
    })} disabled={disabled || burning} onClick={onDragStart ? undefined : () => returnPhysicalCard(card, () => onReturn(card.resource))} onPointerDown={onDragStart ? event => beginDrag(event, card) : undefined} onPointerMove={onDragMove} onPointerUp={onDragStart ? event => finishDrag(event, card) : undefined} onPointerCancel={onDragStart ? event => finishDrag(event, card) : undefined} onKeyDown={onDragStart ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); returnPhysicalCard(card, () => onReturn(card.resource)); } } : undefined} title={`${RESOURCE_META[card.resource].name} · 拖回手中，或点一下拿回`} aria-label={`拿回这张${RESOURCE_META[card.resource].name}`}>
      <span className="table-card-corner" aria-hidden="true">✧</span>
      <ResourceIcon resource={card.resource} />
      <span className="table-card-name">{RESOURCE_META[card.resource].name}</span>
      <span className="table-card-return"><Undo2 size={10} />拿回手中</span>
      {burning && <span className="table-card-embers" aria-hidden="true">{Array.from({ length: 8 }, (_, n) => <i key={n} style={{ "--table-ember": n } as CSSProperties} />)}</span>}
    </button>)}
  </div>;
}

export interface StagingSummaryProps {
  staged: TableResourceBag;
}

export function StagingSummary({ staged }: StagingSummaryProps) {
  const total = bagCount(staged);
  return <section className={`table-staging-summary ${total ? "table-summary-filled" : "table-summary-empty"}`} aria-label="桌面资源概览">
    <div className="table-summary-heading"><span><span className="table-status-dot" />我的桌面</span><small>仅自己可见</small></div>
    {total === 0 ? <div className="table-summary-placeholder"><ArrowDownToLine size={23} strokeWidth={1.2} /><span>把手牌拖到地图上</span><small>先摆好，再决定如何使用</small></div> : <>
      <div className="table-summary-total" aria-live="polite"><span>已放 <b>{total}</b> 张资源牌</span></div>
      <div className="table-summary-resources" aria-label="桌面各类资源数量">{TABLE_RESOURCES.map(resource => <div key={resource} className={`table-summary-resource ${staged[resource] > 0 ? "table-summary-resource-present" : ""}`} style={resourceStyle(resource)} title={RESOURCE_META[resource].name}><ResourceIcon resource={resource} /><b aria-label={`${RESOURCE_META[resource].name} ${staged[resource] || 0} 张`}>{staged[resource] || 0}</b></div>)}</div>
      <p className="table-summary-hint">确认前可换牌，也可拖回手中</p>
    </>}
  </section>;
}

export interface RadialActionsProps {
  buildEnabled: boolean;
  tradeEnabled: boolean;
  buildOptions: Record<TableBuildKind, boolean>;
  bankEnabled: boolean;
  portEnabled: boolean;
  playersEnabled: boolean;
  onBuild: (kind: TableBuildKind) => void;
  onTrade: (kind: TableTradeKind) => void;
  disabled?: boolean;
  status?: string;
}

const BUILD_CHOICES = [
  { kind: "road" as const, label: "道路", Icon: Route, hint: "连接新的土地" },
  { kind: "settlement" as const, label: "村庄", Icon: House, hint: "建立新的据点" },
  { kind: "city" as const, label: "城市", Icon: Building2, hint: "让村庄更繁荣" },
  { kind: "development" as const, label: "发展牌", Icon: ScrollText, hint: "发现新的机会" },
];
const TRADE_CHOICES = [
  { kind: "bank" as const, label: "银行", Icon: Landmark, hint: "与银行兑换" },
  { kind: "port" as const, label: "港口", Icon: Anchor, hint: "使用你的港口" },
  { kind: "players" as const, label: "玩家", Icon: Handshake, hint: "与其他玩家交换" },
];

function fanOptionStyle(index: number, count: number): CSSProperties {
  const angle = (-60 + index * 120 / (count - 1)) * Math.PI / 180;
  return {
    "--table-option-index": index,
    "--fan-x": Math.sin(angle),
    "--fan-y": Math.cos(angle),
  } as CSSProperties;
}

export function RadialActions({ buildEnabled, tradeEnabled, buildOptions, bankEnabled, portEnabled, playersEnabled, onBuild, onTrade, disabled = false, status }: RadialActionsProps) {
  const [open, setOpen] = useState<"build" | "trade" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const activeMenu = disabled ? null : open === "build" && buildEnabled ? "build" : open === "trade" && tradeEnabled ? "trade" : null;
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(null); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, [open]);
  const tradeAvailability = { bank: bankEnabled, port: portEnabled, players: playersEnabled };
  return <div ref={root} className={`table-radial-actions ${activeMenu ? "table-radial-open" : ""} ${status ? "table-radial-has-status" : ""}`}>
    <div className="table-radial-cluster">
      {activeMenu === "build" && <div className="table-radial-menu table-radial-build-menu" aria-label="选择建造项目">
        <span className="table-radial-orbit" aria-hidden="true" />
        {BUILD_CHOICES.map(({ kind, label, Icon, hint }, index) => <button type="button" key={kind} className="table-radial-option" style={fanOptionStyle(index, BUILD_CHOICES.length)} disabled={!buildOptions[kind]} title={`${hint}${!buildOptions[kind] ? " · 当前不可用" : ""}`} onClick={() => { setOpen(null); onBuild(kind); }}><Icon size={21} strokeWidth={1.4} /><span>{label}</span></button>)}
      </div>}
      <button type="button" className={`table-radial-trigger table-build-trigger ${activeMenu === "build" ? "table-trigger-open" : ""}`} disabled={disabled || !buildEnabled} aria-label={activeMenu === "build" ? "收起建造选项" : "展开建造选项"} aria-expanded={activeMenu === "build"} onClick={() => setOpen(activeMenu === "build" ? null : "build")}>
        {activeMenu === "build" ? <X size={23} strokeWidth={1.4} /> : <Hammer size={23} strokeWidth={1.4} />}<span>建造</span><span className="table-trigger-ring" aria-hidden="true" />
      </button>
    </div>
    <span className="table-radial-divider" aria-hidden="true" />
    <div className="table-radial-cluster">
      {activeMenu === "trade" && <div className="table-radial-menu table-radial-trade-menu" aria-label="选择交易方式">
        <span className="table-radial-orbit" aria-hidden="true" />
        {TRADE_CHOICES.map(({ kind, label, Icon, hint }, index) => <button type="button" key={kind} className="table-radial-option" style={fanOptionStyle(index, TRADE_CHOICES.length)} disabled={!tradeAvailability[kind]} title={`${hint}${!tradeAvailability[kind] ? " · 当前不可用" : ""}`} onClick={() => { setOpen(null); onTrade(kind); }}><Icon size={21} strokeWidth={1.4} /><span>{label}</span></button>)}
      </div>}
      <button type="button" className={`table-radial-trigger table-trade-trigger ${activeMenu === "trade" ? "table-trigger-open" : ""}`} disabled={disabled || !tradeEnabled} aria-label={activeMenu === "trade" ? "收起交易选项" : "展开交易选项"} aria-expanded={activeMenu === "trade"} onClick={() => setOpen(activeMenu === "trade" ? null : "trade")}>
        {activeMenu === "trade" ? <X size={23} strokeWidth={1.4} /> : <ArrowLeftRight size={23} strokeWidth={1.4} />}<span>交易</span><span className="table-trigger-ring" aria-hidden="true" />
      </button>
    </div>
    {status && <p className="table-radial-status" role="status">{status}</p>}
  </div>;
}

export interface ResourceOfferProps {
  resources: TableResourceBag;
  title: string;
  subtitle?: string;
  confirmed?: boolean;
}

export function ResourceOffer({ resources, title, subtitle, confirmed = false }: ResourceOfferProps) {
  const shown = TABLE_RESOURCES.filter(resource => (resources[resource] || 0) > 0);
  return <section className={`table-offer ${confirmed ? "table-offer-confirmed" : ""}`} aria-label={title}>
    <div className="table-offer-label"><span>{confirmed && <Check size={13} />}{title}</span>{subtitle && <small>{subtitle}</small>}</div>
    <div className="table-offer-cards">
      {shown.length === 0 ? <span className="table-offer-none">暂无资源</span> : shown.map(resource => <div className="table-offer-card" key={resource} style={resourceStyle(resource)} title={`${RESOURCE_META[resource].name} ${resources[resource]} 张`}><ResourceIcon resource={resource} /><span>{RESOURCE_META[resource].name}</span><b><small>×</small>{resources[resource]}</b></div>)}
    </div>
  </section>;
}

export interface ResourcePickerProps {
  value: TableResourceBag;
  onChange: (value: TableResourceBag) => void;
  maxTotal: number;
  blockedResources?: string[];
  bank?: TableResourceBag;
  infinite?: boolean;
}

export function ResourcePicker({ value, onChange, maxTotal, blockedResources = [], bank, infinite = false }: ResourcePickerProps) {
  const total = bagCount(value);
  const limit = Number.isFinite(maxTotal) ? Math.max(0, Math.floor(maxTotal)) : 0;
  function change(resource: TableResource, direction: -1 | 1) {
    const current = Math.max(0, value[resource] || 0);
    if (direction === -1 && current > 0) onChange({ ...value, [resource]: current - 1 });
    if (direction === 1 && !blockedResources.includes(resource) && total < limit && (infinite || bank === undefined || current < (bank[resource] || 0))) onChange({ ...value, [resource]: current + 1 });
  }
  return <section className="table-resource-picker" aria-label="选择想要获得的资源">
    <div className="table-picker-heading"><span>想要获得</span><span className={total === limit && limit > 0 ? "table-picker-complete" : ""} aria-live="polite">{total === limit && limit > 0 && <Check size={11} />}<b>{total}</b><span>/ {limit} 张</span></span></div>
    <div className="table-picker-resources">
      {TABLE_RESOURCES.map(resource => {
        const amount = Math.max(0, value[resource] || 0);
        const blocked = blockedResources.includes(resource);
        const stock = bank?.[resource] ?? 0;
        const canAdd = !blocked && total < limit && (infinite || bank === undefined || amount < stock);
        return <div key={resource} className={`table-picker-resource ${blocked ? "table-picker-blocked" : ""} ${amount > 0 ? "table-picker-selected" : ""}`} style={resourceStyle(resource)}>
          <div className="table-picker-icon"><ResourceIcon resource={resource} /></div>
          <span className="table-picker-name">{RESOURCE_META[resource].name}</span>
          <div className="table-picker-stepper"><button type="button" onClick={() => change(resource, -1)} disabled={amount <= 0} aria-label={`减少一张${RESOURCE_META[resource].name}`}><Minus size={12} /></button><output aria-label={`${RESOURCE_META[resource].name}数量`}>{amount}</output><button type="button" onClick={() => change(resource, 1)} disabled={!canAdd} aria-label={`增加一张${RESOURCE_META[resource].name}`}><Plus size={12} /></button></div>
          <small className="table-picker-stock">{blocked ? "已在给出" : infinite ? "库存不限" : bank ? `库存 ${stock}` : "选择数量"}</small>
        </div>;
      })}
    </div>
  </section>;
}
