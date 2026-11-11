/**
 * 阶段 D：index.html 与视图层的 DOM 契约。
 *
 * ui.ts / panels.ts / camera.ts 里的 byId() 在缺少节点时会直接抛错导致白屏。
 * 这条测试把所有静态 id 引用与 index.html 对账，重排布局后能立刻发现漏掉的节点。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));

const SOURCES = ['src/ui.ts', 'src/panels.ts', 'src/camera.ts', 'src/main.ts'];
const references = new Map<string, string[]>();
for (const rel of SOURCES) {
  const code = readFileSync(path.join(ROOT, rel), 'utf8');
  const ids = new Set<string>();
  for (const m of code.matchAll(/byId(?:<[^>]*>)?\(\s*'([^']+)'/g)) ids.add(m[1]!);
  for (const m of code.matchAll(/getElementById\(\s*'([^']+)'/g)) ids.add(m[1]!);
  references.set(rel, [...ids]);
}

describe('index.html 与视图层的 DOM 契约', () => {
  it('所有静态 id 引用都能在 index.html 找到', () => {
    const missing: string[] = [];
    for (const [file, ids] of references) {
      for (const id of ids) if (!declared.has(id)) missing.push(`${file} → #${id}`);
    }
    expect(missing).toEqual([]);
  });

  it('阶段 D 的关键结构节点齐备', () => {
    for (const id of [
      'shell', 'board-stage', 'board', 'cam-tools', 'zoom-in', 'zoom-out', 'zoom-reset',
      'situation', 'confirm-strip', 'toast', 'rail-actions', 'drawer', 'drawer-body',
      'extra-panel', 'portrait-gate', 'end-screen', 'btn-help', 'btn-motion',
      // 旧 ui.ts 依赖的节点必须继续存在
      'players', 'hand', 'devcards', 'log', 'die1', 'die2', 'btn-roll', 'btn-end',
      'btn-build', 'btn-trade', 'setupbar', 'robberbar', 'discard', 'build', 'trade', 'offer',
      'settings', 'set-setup-grant', 'settings-close', 'overlay', 'sheet',
    ]) {
      expect(declared.has(id), `缺少 #${id}`).toBe(true);
    }
  });

  it('布局层与安全区、触控目标、竖屏/减少动效都在 CSS 里定义', () => {
    const css = readFileSync(path.join(ROOT, 'src/layout.css'), 'utf8');
    expect(css).toContain('100dvh');
    expect(css).toContain('env(safe-area-inset-top)');
    expect(css).toContain('--d-tap: 44px');
    expect(css).toContain('touch-action: none');
    expect(css).toContain('@media (orientation: portrait)');
    expect(css).toContain('prefers-reduced-motion');
  });

  it('index.html 同时引入画风样式与新布局样式，且顺序正确', () => {
    const i = html.indexOf('/src/styles.css');
    const j = html.indexOf('/src/layout.css');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(html).toContain('viewport-fit=cover');
  });
});
