/**
 * A-4b：入房表单的软键盘可提交性 —— 只改属性与引导文案，不动布局。
 *
 * 真机结论（quality-lead / Android Edge 372×668，华为 ADY_AL00）：
 * - 硬件回车（keycode 66）在 #f-name 内直接提交并成功入房；
 * - 纯软键盘：Gboard 因缺 enterkeyhint 两个框都显示「下一步」，第 1 次点把焦点移到
 *   房间号、面板上移使「加入」可见，第 2 次点提交成功。
 * 所以 A-4 不是布局缺陷，只需把动作键语义区分（昵称 next → 房间号 go）并加一句引导。
 * 本文件锁定：属性正确、引导存在、布局未被改动、提交逻辑不受影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MiniDocument, fire, installGlobals, makeWindow } from './fixtures/mini-dom.js';
import { Ui, type UiCallbacks } from '../src/ui.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let doc: MiniDocument;
let restore: () => void;
let calls: Record<string, ReturnType<typeof vi.fn>>;
let ui: Ui;

beforeEach(() => {
  doc = new MiniDocument(HTML);
  restore = installGlobals(doc, makeWindow());
  // 预置 onJoin：空名字时表单会在调用前 return，若不预置 Proxy 不会创建 spy
  calls = { onJoin: vi.fn() };
  const cb = new Proxy(calls, { get: (t, k: string) => (t[k] ??= vi.fn()) }) as unknown as UiCallbacks;
  ui = new Ui(cb);
});

afterEach(() => { restore(); });

function el(id: string) { return doc.getElementById(id)!; }

describe('A-4b · 入房表单：动作键语义与引导（不改布局）', () => {
  it('昵称 enterkeyhint=next、房间号 enterkeyhint=go，并复用现有小字样式给出引导', () => {
    ui.showJoin({ name: '', roomId: 'main' });
    expect(el('f-name').getAttribute('enterkeyhint')).toBe('next');
    expect(el('f-room').getAttribute('enterkeyhint')).toBe('go');
    const form = el('join-form');
    expect(form.textContent).toContain('输完按键盘上的『前往』即可加入');
    expect(form.querySelector('.hint')).toBeTruthy();          // 复用现有 .hint 小字样式
    expect(form.querySelector('button[type="submit"]')).toBeTruthy();
    expect(el('f-name').getAttribute('enterkeyhint')).not.toBe('go'); // 两个框不能都是 go
  });

  it('布局没有被改动：仍是单层 overlay/sheet + 一个表单，未新增滚动/高度变量', () => {
    ui.showJoin({ name: '', roomId: 'main' });
    // 结构不变
    expect(el('overlay').querySelector('#sheet')).toBeTruthy();
    expect(el('sheet').querySelector('#join-form')).toBeTruthy();
    // 没有引入 --vvh / visualViewport 高度变量（本轮明确取消滚动兜底）
    const style = doc.documentElement.style as unknown as Record<string, unknown>;
    expect(style['--vvh']).toBeUndefined();
    const css = readFileSync(path.join(ROOT, 'src/layout.css'), 'utf8');
    expect(css).not.toContain('--vvh');
    // styles.css 的 overlay/sheet 关键规则未被本仓库其它改动覆盖掉
    const base = readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
    expect(base).toMatch(/\.overlay\s*\{[^}]*position:\s*fixed/s);
    expect(base).toMatch(/\.sheet\s*\{[^}]*width:\s*min\(420px,\s*100%\)/s);
  });

  it('提交逻辑不受影响：填名字 + 房间号后提交仍按原样回调 onJoin', () => {
    ui.showJoin({ name: '', roomId: 'main' });
    const name = el('f-name') as unknown as { value: string };
    const room = el('f-room') as unknown as { value: string };
    name.value = '  小满  ';
    room.value = 'qa-ul';
    fire(el('join-form'), 'submit', {});
    expect(calls['onJoin']).toHaveBeenCalledWith('小满', 'qa-ul');
  });

  it('房间号留空仍回落 main；空名字不提交（原行为不变）', () => {
    ui.showJoin({ name: '', roomId: 'main' });
    const name = el('f-name') as unknown as { value: string };
    const room = el('f-room') as unknown as { value: string };
    name.value = '';
    room.value = '';
    fire(el('join-form'), 'submit', {});
    expect(calls['onJoin']).not.toHaveBeenCalled();
    name.value = '阿甲';
    fire(el('join-form'), 'submit', {});
    expect(calls['onJoin']).toHaveBeenCalledWith('阿甲', 'main');
  });
});
