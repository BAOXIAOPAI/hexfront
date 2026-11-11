/**
 * D-02 + 报告第 10 节布局收尾的行为测试。
 *
 * 不依赖浏览器布局引擎：用一个小型 CSS 级联求值器，把 styles.css + layout.css
 * 按真实引入顺序、特异性和媒体查询求值，验证在三个横屏尺寸下
 * 「top + bottom 同时生效导致拉伸」的叠加被真正消掉，以及顶栏/资源卡/底部按钮
 * 的高度与文字约束。这是级联行为测试，不是「HTML 里有按钮」式静态断言。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STYLES = readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
const LAYOUT = readFileSync(path.join(ROOT, 'src/layout.css'), 'utf8');

interface Rule {
  selectors: string[];
  decls: Map<string, { value: string; important: boolean }>;
  order: number;
  media: string | null;
}

interface Viewport { w: number; h: number; orientation: 'landscape' | 'portrait' }

const VIEWPORTS: Record<string, Viewport> = {
  '667×375': { w: 667, h: 375, orientation: 'landscape' },
  '844×390': { w: 844, h: 390, orientation: 'landscape' },
  '932×430': { w: 932, h: 430, orientation: 'landscape' },
};

/** 极简 CSS 解析：支持 @media / @keyframes（跳过）/ 声明块 / 注释 */
function parse(css: string, offset: number): { rules: Rule[]; next: number } {
  const rules: Rule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  let order = offset;
  const walk = (media: string | null): void => {
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      i = j;
      if (head.startsWith('@media')) {
        const saved = i;
        // 递归解析媒体块内部声明
        const inner = parse(body, order);
        order = inner.next;
        for (const r of inner.rules) r.media = media ? `${media} and ${head.slice(6).trim()}` : head.slice(6).trim();
        rules.push(...inner.rules);
        i = saved;
        continue;
      }
      if (head.startsWith('@')) continue;   // @keyframes / @font-face 等跳过
      const decls = new Map<string, { value: string; important: boolean }>();
      for (const part of body.split(';')) {
        const c = part.indexOf(':');
        if (c < 0) continue;
        const prop = part.slice(0, c).trim().toLowerCase();
        let value = part.slice(c + 1).trim();
        const important = value.includes('!important');
        value = value.replace(/!important/g, '').trim();
        if (prop && value) decls.set(prop, { value, important });
      }
      // 展开 inset 简写（复位块用 inset:auto 一次性清掉四个方向）
      const inset = decls.get('inset');
      if (inset) {
        for (const side of ['top', 'right', 'bottom', 'left']) {
          if (!decls.has(side)) decls.set(side, inset);
        }
      }
      rules.push({ selectors: head.split(',').map((s) => s.trim()).filter(Boolean), decls, order: order++, media });
    }
  };
  walk(null);
  return { rules, next: order };
}

const ALL_RULES = [...parse(STYLES, 0).rules, ...parse(LAYOUT, 100000).rules];

function specificity(sel: string): number {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length;
  const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const tags = (sel.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 10000 + cls * 100 + tags;
}

function mediaMatches(media: string | null, vp: Viewport): boolean {
  if (!media) return true;
  return media.split(/\s+and\s+/).every((cond) => {
    const c = cond.trim().replace(/^\(|\)$/g, '');
    const m = /^(min|max)-(width|height)\s*:\s*(\d+)(px)?$/.exec(c);
    if (m) {
      const value = Number(m[3]);
      const actual = m[2] === 'width' ? vp.w : vp.h;
      return m[1] === 'min' ? actual >= value : actual <= value;
    }
    const o = /^orientation\s*:\s*(\w+)$/.exec(c);
    if (o) return o[1] === vp.orientation;
    if (c.includes('prefers-reduced-motion') || c.includes('hover:')) return false;
    return true;
  });
}

/** 描述待求值元素及其祖先 class/标签链，从外到内 */
interface Desc { tag: string; classes: string[]; attrs?: Record<string, string> }

function compoundMatches(desc: Desc, compound: string): boolean {
  const re = /(^[a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m: RegExpExecArray | null;
  let saw = false;
  re.lastIndex = 0;
  while ((m = re.exec(compound)) !== null) {
    saw = true;
    const tag = m[1]; const id = m[2]; const cls = m[3]; const attr = m[4]; const val = m[5];
    if (tag && tag !== '*' && desc.tag !== tag.toLowerCase()) return false;
    if (id && desc.attrs?.id !== id) return false;
    if (cls && !desc.classes.includes(cls)) return false;
    if (attr) {
      const actual = desc.attrs?.[attr] ?? (attr === 'class' ? desc.classes.join(' ') : undefined);
      if (actual === undefined) return false;
      if (val !== undefined && actual !== val) return false;
    }
  }
  return saw;
}

function selectorMatches(chain: Desc[], selector: string): boolean {
  const parts = selector.trim().split(/\s+/);
  let idx = chain.length - 1;
  for (let p = parts.length - 1; p >= 0; p--) {
    let found = false;
    while (idx >= 0) {
      if (compoundMatches(chain[idx]!, parts[p]!)) { found = true; idx--; break; }
      idx--;
    }
    if (!found) return false;
  }
  return true;
}

/** 按 引入顺序 → 媒体匹配 → 特异性 求最终声明 */
function computed(chain: Desc[], vp: Viewport): Map<string, string> {
  const out = new Map<string, { value: string; rank: number; important: boolean }>();
  for (const rule of ALL_RULES) {
    if (!mediaMatches(rule.media, vp)) continue;
    const sel = rule.selectors.find((s) => selectorMatches(chain, s));
    if (!sel) continue;
    const spec = specificity(sel);
    for (const [prop, { value, important }] of rule.decls) {
      const prev = out.get(prop);
      // 级联顺序：!important > 特异性 > 源码顺序
      const rank = spec * 1_000_000 + rule.order;
      if (!prev || (important && !prev.important) || (important === prev.important && rank >= prev.rank)) {
        out.set(prop, { value, rank, important });
      }
    }
  }
  return new Map([...out].map(([k, v]) => [k, v.value]));
}

const shell: Desc = { tag: 'div', classes: ['shell'] };
const stage: Desc = { tag: 'section', classes: ['board-stage'] };
function bar(cls: string, extra: Record<string, string> = {}): Desc[] {
  return [shell, stage, { tag: 'div', classes: [cls], attrs: extra }];
}

describe('D-02 · 三个横屏尺寸下浮层为紧凑条，不形成纵向遮挡', () => {
  for (const [label, vp] of Object.entries(VIEWPORTS)) {
    it(`${label}：setupbar / robberbar 的 top+bottom 不能同时生效`, () => {
      for (const cls of ['setupbar', 'robberbar']) {
        const c = computed(bar(cls), vp);
        const top = c.get('top') ?? 'auto';
        const bottom = c.get('bottom') ?? 'auto';
        expect(top, `${cls} top 应固定在 8px`).toBe('8px');
        expect(
          top !== 'auto' && bottom !== 'auto' && top !== '0' && bottom !== '0',
          `${cls} 同时有 top=${top} 与 bottom=${bottom} 会被拉伸成覆盖棋盘的大面板`,
        ).toBe(false);
        expect(c.get('height') ?? 'auto').toBe('auto');
        expect(c.get('min-width') ?? '0').toBe('0');
        expect(c.get('max-height')).toBeTruthy();   // 有高度约束，不能无限高
        expect(c.get('bottom') ?? 'auto').toBe('auto');
      }
    });

    it(`${label}：弃牌面板贴底、有高度约束，且含按钮区域可点击`, () => {
      const c = computed(bar('discard-panel'), vp);
      expect(c.get('bottom')).toBe('8px');
      expect(c.get('top') ?? 'auto').toBe('auto');
      expect(c.get('transform') ?? 'none').toBe('none');
      expect(c.get('animation') ?? 'none').toBe('none');  // dpIn 的 fill-mode 不能再覆盖 transform
      expect(c.get('max-height')).toBeTruthy();
      expect(c.get('pointer-events')).toBe('auto');       // 加减/提交按钮可点
      expect(c.get('display')).toBe('flex');
    });

    it(`${label}：报价条与摆位/强盗条的定位不互相污染`, () => {
      const offer = computed(bar('offer-bar'), vp);
      expect(offer.get('left')).toBe('8px');
      expect(offer.get('transform') ?? 'none').toBe('none');
      expect(offer.get('animation') ?? 'none').toBe('none');
      expect(offer.get('pointer-events')).toBe('auto');
    });
  }

  it('纯说明浮层不拦截地图输入，含按钮浮层保持可点击', () => {
    const vp = VIEWPORTS['844×390']!;
    expect(computed(bar('setupbar', { 'data-info-only': '' }), vp).get('pointer-events')).toBe('none');
    expect(computed(bar('robberbar'), vp).get('pointer-events')).toBe('auto');
    expect(computed(bar('discard-panel'), vp).get('pointer-events')).toBe('auto');
  });

  it('初次动画结束后与后续 STATE 更新后布局一致：浮层禁用会改 transform 的入场动画', () => {
    const vp = VIEWPORTS['844×390']!;
    for (const cls of ['setupbar', 'robberbar', 'discard-panel', 'offer-bar']) {
      const c = computed(bar(cls), vp);
      expect(c.get('animation') ?? 'none', `${cls} 不应有 dpIn 残留 transform`).toBe('none');
    }
  });

  it('layout.css 的复位选择器特异性高于 styles.css 的旧定位与 @media 补丁', () => {
    const old = parse(STYLES, 0).rules.filter((r) => r.selectors.some((s) => s === '.setupbar' || s === '.robberbar'));
    const reset = parse(LAYOUT, 100000).rules.find((r) => r.selectors.some((s) => s.includes('.board-stage .setupbar')));
    expect(reset).toBeTruthy();
    const resetSpec = specificity(reset!.selectors.find((s) => s.includes('.board-stage .setupbar'))!);
    for (const r of old) {
      expect(specificity(r.selectors[0]!)).toBeLessThan(resetSpec);
    }
    expect(reset!.decls.has('inset') || reset!.decls.has('bottom')).toBe(true);
  });
});

describe('第 10 节 · 顶栏 / 资源卡 / 底部按钮收尾', () => {
  const vp = VIEWPORTS['844×390']!;

  it('顶栏高度被硬约束，玩家卡片不超过顶栏、长昵称与长房间号省略', () => {
    const hdr = computed([shell, { tag: 'header', classes: ['hdr'] }], vp);
    expect(hdr.get('height')).toBe('100%');
    expect(hdr.get('overflow')).toBe('hidden');
    const strip = computed([shell, { tag: 'header', classes: ['hdr'] }, { tag: 'div', classes: ['player-strip'] }], vp);
    expect(strip.get('overflow')).toBe('hidden');
    expect(strip.get('max-height')).toBe('100%');
    const player = computed([shell, { tag: 'header', classes: ['hdr'] },
      { tag: 'div', classes: ['player-strip'] }, { tag: 'div', classes: ['player'] }], vp);
    expect(player.get('max-height')).toBeTruthy();
    expect(player.get('max-width')).toBe('25%');       // 四位玩家并排
    const pname = computed([shell, { tag: 'header', classes: ['hdr'] },
      { tag: 'div', classes: ['player-strip'] }, { tag: 'div', classes: ['player'] },
      { tag: 'div', classes: ['pinfo'] }, { tag: 'div', classes: ['pname'] }], vp);
    expect(pname.get('text-overflow')).toBe('ellipsis');
    expect(pname.get('white-space')).toBe('nowrap');
    const room = computed([shell, { tag: 'header', classes: ['hdr'] },
      { tag: 'div', classes: ['conn-chip'] }, { tag: 'b', classes: [], attrs: { id: 'room-id' } }], vp);
    expect(room.get('text-overflow')).toBe('ellipsis');
    // 玩家条里保留手牌数徽标（不能把公开手牌数藏没）
    expect(LAYOUT).toContain('.player-strip .player .phand');
    expect(readFileSync(path.join(ROOT, 'src/ui.ts'), 'utf8')).toContain('class="phand"');
  });

  it('资源卡改成紧凑图标+数量：无倾斜/入场动画，大数量不撑高右栏', () => {
    const card = computed([shell, { tag: 'aside', classes: ['rail'] },
      { tag: 'div', classes: ['rail-scroll'] }, { tag: 'div', classes: ['handrow'] },
      { tag: 'div', classes: ['card'] }], vp);
    expect(card.get('transform') ?? 'none').toBe('none');
    expect(card.get('animation') ?? 'none').toBe('none');
    expect(card.get('max-height')).toBe('30px');
    expect(card.get('height')).toBe('30px');
    const num = computed([shell, { tag: 'aside', classes: ['rail'] },
      { tag: 'div', classes: ['rail-scroll'] }, { tag: 'div', classes: ['handrow'] },
      { tag: 'div', classes: ['card'] }, { tag: 'div', classes: ['cnum'] }], vp);
    expect(num.get('white-space')).toBe('nowrap');
    expect(num.get('text-overflow')).toBe('ellipsis');
  });

  it('底部固定行动按钮文字完整可读：不换行，短横屏改两列布局', () => {
    const btn = computed([shell, { tag: 'aside', classes: ['rail'] },
      { tag: 'div', classes: ['rail-pinned'] }, { tag: 'div', classes: ['pinned-row'] },
      { tag: 'button', classes: ['btn'] }], vp);
    expect(btn.get('white-space')).toBe('nowrap');
    expect(btn.get('min-width')).toBe('0');
    const row = computed([shell, { tag: 'aside', classes: ['rail'] },
      { tag: 'div', classes: ['rail-pinned'] }, { tag: 'div', classes: ['pinned-row'] }], vp);
    expect(row.get('display')).toBe('grid');            // max-height:430 媒体查询生效
    expect(row.get('grid-template-columns')).toContain('repeat(2');
  });

  it('其余断点仍按指南 13.1 定义（竖屏 / 平板 / 桌面 / 减少动效）', () => {
    expect(LAYOUT).toContain('@media (orientation: portrait)');
    expect(LAYOUT).toContain('@media (min-width: 1100px)');
    expect(LAYOUT).toContain('prefers-reduced-motion');
    expect(LAYOUT).toContain('100dvh');
    expect(LAYOUT).toContain('env(safe-area-inset-top)');
    const portrait = computed(bar('setupbar'), { w: 390, h: 844, orientation: 'portrait' });
    expect(portrait.get('top')).toBe('8px');            // 竖屏也不被拉伸
    const wide = computed(bar('robberbar'), { w: 1366, h: 768, orientation: 'landscape' });
    expect(wide.get('bottom') ?? 'auto').toBe('auto');
  });
});
