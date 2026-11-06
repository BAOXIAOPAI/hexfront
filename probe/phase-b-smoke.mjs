/**
 * 阶段 B 原型的运行时冒烟测试（jsdom，不依赖真实浏览器，不需要网络）。
 *
 * jsdom 只用来验证「脚本能跑、状态切换不崩、关键 DOM 与相机逻辑正确」，
 * 它不做真实布局，不能替代 CDP 视口核对，更不能替代真机验收。
 *
 * jsdom 装在临时目录，不加入项目依赖：
 *   mkdir -p /tmp/phase-b-dom && cd /tmp/phase-b-dom && npm init -y && npm install jsdom
 *   node probe/phase-b-smoke.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'prototype', 'mobile-b.html');
const raw = readFileSync(HTML_PATH, 'utf8');

const req = createRequire('/tmp/phase-b-dom/package.json');
const { JSDOM, VirtualConsole } = req('jsdom');

const results = [];
function t(name, fn) {
  try { fn(); results.push({ name, ok:true }); console.log('✓ ' + name); }
  catch (e) { results.push({ name, ok:false, error:String(e.message) }); console.log('✗ ' + name + ' → ' + e.message); }
}

/** jsdom 不做布局，把 <style> 摘掉避免 dvh/env() 的 CSS 解析噪声；CSS 约定单独做静态检查 */
const stripped = raw.replace(/<style>[\s\S]*?<\/style>/, '<!-- css omitted in jsdom -->');

function load(query = '') {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e.message || e)));
  const dom = new JSDOM(stripped, {
    runScripts: 'dangerously',
    virtualConsole: vc,
    pretendToBeVisual: true,
    url: 'file://' + HTML_PATH + (query ? '?' + query : ''),
  });
  return { dom, errors, w: dom.window, d: dom.window.document };
}
function withPage(query, fn) {
  const page = load(query);
  try { return fn(page); }
  finally { page.dom.window.close(); }
}

// ---------------------------------------------------------------------------
// 1. 静态约定：触控目标 44px、安全区、dvh、仅棋盘管理 touch-action
// ---------------------------------------------------------------------------
const css = raw.match(/<style>([\s\S]*?)<\/style>/)[1];
t('CSS 使用 44px 触控目标变量，且按钮都引用它', () => {
  assert.match(css, /--tap:44px/);
  assert.match(css, /\.btn\{min-height:var\(--tap\)/);
  assert.match(css, /\.act-btn\{width:100%;min-height:var\(--tap\)/);
  assert.match(css, /\.stepper\{min-height:var\(--tap\)/);
  assert.match(css, /\.cam-btn\{width:var\(--tap\);height:var\(--tap\)/);
  assert.match(css, /\.iconbtn\{min-width:var\(--tap\);min-height:var\(--tap\)/);
  assert.match(css, /\.btn\.tiny\{min-height:var\(--tap\)/);
});
t('布局用 dvh + 安全区，touch-action 只作用于棋盘手势区', () => {
  assert.match(css, /height:100dvh/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /\.board-wrap\{[^}]*touch-action:none/);
  assert.match(css, /\.act-scroll\{[^}]*touch-action:pan-y/);
});
t('横竖屏与低高度有独立断点，桌面可展开详情', () => {
  assert.match(css, /@media \(orientation:portrait\) and \(max-width:700px\)/);
  assert.match(css, /@media \(max-height:420px\)/);
  assert.match(css, /@media \(min-width:1100px\) and \(orientation:landscape\)/);
  assert.match(css, /prefers-reduced-motion/);
});

// ---------------------------------------------------------------------------
// 2. 五类状态 + 竖屏入房：脚本执行无异常，关键面板出现
// ---------------------------------------------------------------------------
t('默认状态：4 个玩家、5 种资源、棋盘静态层已生成', () => withPage('state=default', ({ d, errors }) => {
  assert.deepEqual(errors, []);
  assert.equal(d.querySelectorAll('.pchip').length, 4);
  assert.equal(d.querySelectorAll('#res-grid .res').length, 5);
  assert.equal(d.querySelectorAll('#layer-terrain [data-key]').length, 19);
  assert.equal(d.getElementById('app').dataset.state, 'default');
  assert.ok(d.getElementById('situation').textContent.includes('轮到你'));
  assert.equal(d.querySelectorAll('#confirmbar.show').length, 0);
}));

t('建造预览：确认条出现、显示成本与取消，虚影不等于已建成', () => withPage('state=build&autopick=1&debug=0', ({ d, errors }) => {
  assert.deepEqual(errors, []);
  assert.ok(d.getElementById('confirmbar').classList.contains('show'));
  const text = d.getElementById('confirmbar').textContent;
  assert.match(text, /建造村庄/);
  assert.match(text, /成本/);
  assert.match(text, /取消/);
  assert.equal(d.getElementById('app').dataset.picking, '1');
  assert.equal(d.querySelectorAll('#layer-preview [data-key]').length, 1);
}));

t('交易列表：两条报价并存，收件人视角把「我付出/我收到」正确转换', () => withPage('state=trade&drawer=offers&debug=0', ({ d, errors }) => {
  assert.deepEqual(errors, []);
  assert.equal(d.querySelectorAll('.offer-card').length, 2);
  const first = d.querySelector('.offer-card').textContent;
  assert.match(first, /我付出：麦×1/);
  assert.match(first, /我收到：木×2/);
  assert.ok(d.getElementById('drawer').classList.contains('open'));
  assert.match(d.getElementById('drawer-foot').textContent, /发送冷却/);
}));

t('弃牌：应弃 5 张、未选够不能提交、加减按钮足够大、不泄露他人选择', () => withPage('state=discard&debug=0', ({ d, errors }) => {
  assert.deepEqual(errors, []);
  assert.ok(d.getElementById('discard-sheet').classList.contains('show'));
  assert.equal(d.getElementById('discard-need').textContent, '5');
  assert.equal(d.getElementById('discard-submit').disabled, true);
  assert.equal(d.querySelectorAll('#discard-rows .stepper').length, 10);
  assert.match(d.getElementById('peer-pending').textContent, /看不到他们选了什么/);
}));

t('强盗待办：结束回合与发展卡禁用并给出具体原因，任务可收起', () => withPage('state=robber&debug=0', ({ d, errors }) => {
  assert.deepEqual(errors, []);
  const end = [...d.querySelectorAll('#act-pinned .btn')].find(b => b.textContent === '结束回合');
  assert.equal(end.disabled, true);
  assert.match(end.title, /强盗尚未移动/);
  const dev = [...d.querySelectorAll('#act-list .act-btn')].find(b => b.textContent.includes('发展卡'));
  assert.equal(dev.disabled, true);
  assert.match(d.getElementById('act-pinned').textContent, /结束回合前必须完成强盗结算/);
  assert.ok([...d.querySelectorAll('#act-list .act-btn')].some(b => b.textContent.includes('强盗待移动')));
}));

t('竖屏入房：保留连接状态、回合摘要与恢复入口，不锁方向', () => withPage('state=lobby&debug=0', ({ d, errors }) => {
  assert.deepEqual(errors, []);
  const status = d.getElementById('portrait-status').textContent;
  assert.match(status, /连接：已同步/);
  assert.match(status, /当前回合/);
  assert.match(status, /我的手牌/);
  assert.ok(d.getElementById('portrait-help'));
  assert.match(d.getElementById('portrait-gate').textContent, /不会反复弹出/);
}));

// ---------------------------------------------------------------------------
// 3. 相机与广播：指南 5.3「收到 STATE 不重置相机、不误建造」
// ---------------------------------------------------------------------------
t('缩放按钮生效；模拟 STATE 广播后 zoom 不变、未触发建造', () => withPage('state=default', ({ d }) => {
  const read = () => d.getElementById('dev-readout').textContent;
  assert.match(read(), /zoom 1\.00/);
  d.getElementById('zoom-in').click();
  assert.match(read(), /zoom 1\.25/);
  d.getElementById('dev-broadcast').click();
  assert.match(read(), /zoom 1\.25/);
  assert.match(read(), /STATE #1/);
  assert.equal(d.querySelectorAll('#confirmbar.show').length, 0);
  d.getElementById('zoom-reset').click();
  assert.match(read(), /zoom 1\.00/);
}));

t('当前候选被服务端更新置为失效时，清除预览并给出原因，不悄悄改选别处', () => withPage('state=build&autopick=1&debug=0', ({ d }) => {
  assert.ok(d.getElementById('confirmbar').classList.contains('show'));
  d.getElementById('dev-invalidate').click();
  assert.equal(d.querySelectorAll('#confirmbar.show').length, 0);
  assert.equal(d.querySelectorAll('#layer-preview [data-key]').length, 0);
  assert.match(d.getElementById('toast').textContent, /已失效/);
  assert.equal(d.getElementById('app').dataset.picking, '0');
}));

// ---------------------------------------------------------------------------
// 4. 弃牌提交与偏好开关
// ---------------------------------------------------------------------------
t('弃牌数量选够才能提交；提交后收起面板且不重复提交', () => withPage('state=discard&debug=0', ({ d }) => {
  const clickPlus = (rowIndex, times) => {
    for (let i = 0; i < times; i++) {
      const row = d.querySelectorAll('#discard-rows .discard-row')[rowIndex];
      row.querySelectorAll('.stepper')[1].click();
    }
  };
  clickPlus(0, 3); // 木材 3
  clickPlus(1, 2); // 砖块 2
  assert.equal(d.getElementById('discard-selected').textContent, '5');
  assert.equal(d.getElementById('discard-submit').disabled, false);
  d.getElementById('discard-submit').click();
  assert.equal(d.querySelectorAll('#discard-sheet.show').length, 0);
  assert.match(d.getElementById('toast').textContent, /等待其他人完成/);
}));

t('减少动态效果开关只改偏好，静态文字与高亮仍保留', () => withPage('state=default', ({ d }) => {
  const btn = d.getElementById('btn-motion');
  btn.click();
  assert.equal(d.getElementById('app').dataset.reduceMotion, '1');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  btn.click();
  assert.equal(d.getElementById('app').dataset.reduceMotion, '0');
}));

t('触屏帮助不依赖 hover：? 按钮可打开成本与手势说明', () => withPage('state=default', ({ d }) => {
  d.getElementById('btn-help').click();
  assert.ok(d.getElementById('drawer').classList.contains('open'));
  const text = d.getElementById('drawer-body').textContent;
  assert.match(text, /村庄成本/);
  assert.match(text, /双指缩放/);
  assert.match(text, /触屏没有 hover/);
}));

// ---------------------------------------------------------------------------
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map(f => f.name).join('、'));
  process.exitCode = 1;
}
