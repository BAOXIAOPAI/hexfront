/**
 * 阶段 D 修复的行为测试用极简 DOM。
 *
 * 为什么不引入 jsdom：工作区依赖里没有 jsdom，而本轮授权只允许改
 * apps/web/src/**、index.html、test/**，不能改 package.json / lockfile。
 * 这个 shim 只实现被测代码真正用到的 API（真实事件捕获/冒泡、innerHTML 解析、
 * dataset/classList、querySelector、getBoundingClientRect、pointer capture 等），
 * 让「真实 pointerdown → pointerup → click」这类序列可以在任何环境稳定复现。
 * 它不是浏览器替代品：布局与视觉仍由 quality-lead 的浏览器复验负责。
 */

export interface Rect { left: number; top: number; width: number; height: number }

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

interface Listener { fn: (e: MiniEvent) => void; capture: boolean }

export class MiniEvent {
  type: string;
  target: MiniElement | null = null;
  currentTarget: MiniElement | null = null;
  defaultPrevented = false;
  private stopped = false;
  private immediate = false;
  [key: string]: unknown;

  constructor(type: string, props: Record<string, unknown> = {}) {
    this.type = type;
    Object.assign(this, props);
  }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.stopped = true; }
  stopImmediatePropagation(): void { this.stopped = true; this.immediate = true; }
  get isStopped(): boolean { return this.stopped; }
  get isImmediate(): boolean { return this.immediate; }
}

export class MiniClassList {
  constructor(private readonly owner: MiniElement) {}
  add(...names: string[]): void {
    const set = new Set(this.owner.className.split(/\s+/).filter(Boolean));
    for (const n of names) set.add(n);
    this.owner.className = [...set].join(' ');
  }
  remove(...names: string[]): void {
    const set = new Set(this.owner.className.split(/\s+/).filter(Boolean));
    for (const n of names) set.delete(n);
    this.owner.className = [...set].join(' ');
  }
  toggle(name: string, force?: boolean): boolean {
    const has = this.contains(name);
    const want = force === undefined ? !has : force;
    if (want) this.add(name); else this.remove(name);
    return want;
  }
  contains(name: string): boolean {
    return this.owner.className.split(/\s+/).filter(Boolean).includes(name);
  }
}

const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    const key = m[1]!;
    out[key] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

function camel(key: string): string {
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export class MiniElement {
  tagName: string;
  readonly doc: MiniDocument;
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = new MiniClassList(this);
  children: MiniElement[] = [];
  parent: MiniElement | null = null;
  private listeners = new Map<string, Listener[]>();
  private _text = '';
  private _html = '';
  disabled = false;
  value = '';
  checked = false;
  offsetWidth = 0;
  offsetHeight = 0;
  clientWidth = 844;
  clientHeight = 390;
  rect: Rect = { left: 0, top: 0, width: 844, height: 390 };
  style = {
    setProperty(this: Record<string, unknown>, k: string, v: string): void { this[k] = v; },
  } as Record<string, unknown> & { setProperty(k: string, v: string): void };
  focusCalls = 0;
  captured: number[] = [];
  released: number[] = [];
  title = '';

  constructor(tagName: string, doc: MiniDocument) {
    this.tagName = tagName.toUpperCase();
    this.doc = doc;
  }

  get id(): string { return this.attributes.id ?? ''; }
  get className(): string { return this.attributes.class ?? ''; }
  set className(v: string) { this.attributes.class = v; }
  get parentElement(): MiniElement | null { return this.parent; }

  get textContent(): string {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this._text = v;
    for (const c of this.children) c.parent = null;
    this.children = [];
    this._html = '';
  }

  get innerHTML(): string { return this._html; }
  set innerHTML(html: string) {
    this._html = html;
    this._text = '';
    for (const c of this.children) c.parent = null;
    this.children = parseFragment(html, this.doc);
    for (const c of this.children) c.parent = this;
  }

  insertAdjacentHTML(where: string, html: string): void {
    this._html += html;
    const nodes = parseFragment(html, this.doc);
    for (const n of nodes) n.parent = this;
    if (where === 'afterbegin') this.children = [...nodes, ...this.children];
    else this.children.push(...nodes);
  }

  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  removeAttribute(name: string): void { delete this.attributes[name]; }
  hasAttribute(name: string): boolean { return name in this.attributes; }

  addEventListener(type: string, fn: (e: MiniEvent) => void, capture: boolean | object = false): void {
    const cap = typeof capture === 'boolean' ? capture : !!(capture as { capture?: boolean }).capture;
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture: cap });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (e: MiniEvent) => void, capture: boolean | object = false): void {
    const cap = typeof capture === 'boolean' ? capture : !!(capture as { capture?: boolean }).capture;
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((l) => l.fn !== fn || l.capture !== cap));
  }

  dispatchEvent(ev: MiniEvent): boolean {
    const path: MiniElement[] = [];
    for (let n: MiniElement | null = this; n; n = n.parent) path.push(n);
    path.reverse(); // root → target
    ev.target = this;
    for (const node of path) {
      ev.currentTarget = node;
      for (const l of node.listeners.get(ev.type) ?? []) {
        if (!l.capture) continue;
        l.fn(ev);
        if (ev.isImmediate) break;
      }
      if (ev.isStopped) return !ev.defaultPrevented;
    }
    for (const node of [...path].reverse()) {
      ev.currentTarget = node;
      for (const l of node.listeners.get(ev.type) ?? []) {
        if (l.capture) continue;
        l.fn(ev);
        if (ev.isImmediate) break;
      }
      if (ev.isStopped) return !ev.defaultPrevented;
    }
    return !ev.defaultPrevented;
  }

  contains(node: MiniElement | null): boolean {
    if (!node) return false;
    for (let n: MiniElement | null = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
  closest(selector: string): MiniElement | null {
    for (let n: MiniElement | null = this; n; n = n.parent) {
      if (matchesAny(n, selector)) return n;
    }
    return null;
  }
  querySelector(selector: string): MiniElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): MiniElement[] {
    const out: MiniElement[] = [];
    const visit = (n: MiniElement): void => {
      for (const c of n.children) {
        if (matchesAny(c, selector)) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
  focus(): void { this.focusCalls += 1; this.doc.activeElement = this; }
  select(): void { /* no-op */ }
  getBoundingClientRect(): Rect & { right: number; bottom: number } {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height,
    };
  }
  setPointerCapture(id: number): void { this.captured.push(id); }
  releasePointerCapture(id: number): void { this.released.push(id); }
}

function makeText(text: string, doc: MiniDocument, parent: MiniElement): MiniElement {
  const n = new MiniElement('#text', doc);
  n.parent = parent;
  n.textContent = text;
  return n;
}

/** 解析 HTML 片段，返回顶层节点；用临时容器承载，避免污染目标 children */
function parseFragment(html: string, doc: MiniDocument): MiniElement[] {
  const holder = new MiniElement('#fragment', doc);
  const stack: MiniElement[] = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(clean)) !== null) {
    const text = clean.slice(last, m.index);
    if (text.trim()) {
      const host = stack[stack.length - 1] ?? holder;
      host.children.push(makeText(text, doc, host));
    }
    last = TAG_RE.lastIndex;
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tagName === tag.toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }
    const el = new MiniElement(tag, doc);
    el.attributes = parseAttrs(m[3] ?? '');
    for (const [k, v] of Object.entries(el.attributes)) {
      if (k.startsWith('data-')) el.dataset[camel(k.slice(5))] = v;
      if (k === 'disabled') el.disabled = true;
      if (k === 'value') el.value = v;
      if (k === 'checked') el.checked = true;
    }
    const host = stack[stack.length - 1] ?? holder;
    el.parent = host;
    host.children.push(el);
    if (!m[4] && !VOID_TAGS.has(tag)) stack.push(el);
  }
  const tail = clean.slice(last);
  if (tail.trim()) {
    const host = stack[stack.length - 1] ?? holder;
    host.children.push(makeText(tail, doc, host));
  }
  return holder.children;
}

// ---- 选择器：支持 tag / #id / .class / [attr] / [attr="v"] 复合 + 后代 + 逗号分组 ----
const COMPOUND_RE = /(^[a-zA-Z][\w:-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;

function matchCompound(node: MiniElement, compound: string): boolean {
  COMPOUND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let saw = false;
  while ((m = COMPOUND_RE.exec(compound)) !== null) {
    saw = true;
    const tag = m[1]; const id = m[2]; const cls = m[3]; const attr = m[4]; const val = m[5];
    if (tag && tag !== '*' && node.tagName !== tag.toUpperCase()) return false;
    if (id && node.id !== id) return false;
    if (cls && !node.classList.contains(cls)) return false;
    if (attr) {
      const actual = attr.startsWith('data-')
        ? node.dataset[camel(attr.slice(5))]
        : attr === 'class' ? node.className : node.attributes[attr];
      if (actual === undefined) return false;
      if (val !== undefined && actual !== val) return false;
    }
  }
  return saw;
}

function matchesSelector(node: MiniElement, selector: string): boolean {
  const parts = selector.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  if (!matchCompound(node, parts[parts.length - 1]!)) return false;
  let ancestor = node.parent;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (ancestor) {
      if (matchCompound(ancestor, parts[i]!)) { found = true; ancestor = ancestor.parent; break; }
      ancestor = ancestor.parent;
    }
    if (!found) return false;
  }
  return true;
}

function matchesAny(node: MiniElement, selector: string): boolean {
  return selector.split(',').some((s) => matchesSelector(node, s));
}

export class MiniDocument {
  root: MiniElement;
  activeElement: MiniElement | null = null;
  visibilityState: 'visible' | 'hidden' = 'visible';
  private listeners = new Map<string, ((e: MiniEvent) => void)[]>();
  body: MiniElement;

  constructor(html: string) {
    this.root = new MiniElement('html', this);
    const body = new MiniElement('body', this);
    body.parent = this.root;
    this.root.children.push(body);
    this.body = body;
    const stripped = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<head[\s\S]*?<\/head>/i, '');
    const inner = stripped.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
    body.children = parseFragment(inner, this);
    for (const c of body.children) c.parent = body;
  }

  get documentElement(): MiniElement { return this.root; }
  getElementById(id: string): MiniElement | null {
    const walk = (n: MiniElement): MiniElement | null => {
      if (n.id === id) return n;
      for (const c of n.children) { const r = walk(c); if (r) return r; }
      return null;
    };
    return walk(this.root);
  }
  createElement(tag: string): MiniElement { return new MiniElement(tag, this); }
  querySelector(s: string): MiniElement | null { return this.root.querySelector(s); }
  querySelectorAll(s: string): MiniElement[] { return this.root.querySelectorAll(s); }
  addEventListener(type: string, fn: (e: MiniEvent) => void): void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn); this.listeners.set(type, l);
  }
  removeEventListener(type: string, fn: (e: MiniEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  dispatchEvent(ev: MiniEvent): void {
    ev.target = this.root;
    for (const fn of this.listeners.get(ev.type) ?? []) fn(ev);
  }
}

export interface MiniWindow {
  matchMedia(q: string): { matches: boolean; media: string; addListener(): void; removeListener(): void;
    addEventListener(): void; removeEventListener(): void };
  addEventListener(type: string, fn: (e: MiniEvent) => void, capture?: boolean | object): void;
  removeEventListener(type: string, fn: (e: MiniEvent) => void, capture?: boolean | object): void;
  dispatchEvent(ev: MiniEvent): void;
  innerWidth: number;
  innerHeight: number;
}

export function makeWindow(): MiniWindow {
  const listeners = new Map<string, ((e: MiniEvent) => void)[]>();
  return {
    innerWidth: 844,
    innerHeight: 390,
    // 触屏口径：hover 提示不启用，避免测试里额外 DOM 行为
    matchMedia: (q: string) => ({
      matches: false, media: q, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
    }),
    addEventListener(type, fn) {
      const l = listeners.get(type) ?? []; l.push(fn); listeners.set(type, l);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    dispatchEvent(ev) { for (const fn of listeners.get(ev.type) ?? []) fn(ev); },
  };
}

/** 把 shim 挂到 globalThis；返回还原函数 */
export function installGlobals(doc: MiniDocument, win: MiniWindow): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  const keys = ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node',
    'MiniEvent', 'matchMedia', 'location', 'history', 'innerWidth', 'innerHeight',
    'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'];
  for (const k of keys) saved[k] = g[k];
  g['window'] = win;
  g['document'] = doc;
  g['Element'] = MiniElement;
  g['HTMLElement'] = MiniElement;
  g['SVGElement'] = MiniElement;
  g['Node'] = MiniElement;
  g['MiniEvent'] = MiniEvent;
  g['matchMedia'] = win.matchMedia;
  g['location'] = { search: '?name=tester&room=main', pathname: '/', origin: 'http://localhost:5173' };
  g['history'] = { replaceState: () => undefined };
  g['innerWidth'] = 844;
  g['innerHeight'] = 390;
  g['requestAnimationFrame'] = (fn: () => void) => { fn(); return 1; };
  g['cancelAnimationFrame'] = () => undefined;
  g['getComputedStyle'] = () => ({ getPropertyValue: () => '' });
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete g[k]; else g[k] = saved[k];
    }
  };
}

/** 造一个模拟 Pointer/Mouse 事件；走真实 dispatchEvent 捕获/冒泡链 */
export function fire(target: MiniElement, type: string, props: Record<string, unknown> = {}): MiniEvent {
  const ev = new MiniEvent(type, {
    bubbles: true, cancelable: true, clientX: 0, clientY: 0,
    pointerId: 1, pointerType: 'mouse', button: 0, deltaY: 0, ...props,
  });
  target.dispatchEvent(ev);
  return ev;
}
