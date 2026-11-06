/**
 * 桌面端 hover 说明。
 *
 * 只在有鼠标的设备上生效；内容用短句 + 资源色块图示，不常驻、不抢主界面。
 * 所有文案都由本表提供，避免散落在模板里。
 */

import type { Resource } from '@hexfront/engine';
import { TERRAIN_COLOR, TERRAIN_SHORT } from './theme.js';

const chip = (res: Resource, n: number): string =>
  `<span class="tip-chip${res === 'wheat' ? ' light' : ''}" style="background:${TERRAIN_COLOR[res]}">${TERRAIN_SHORT[res]} ×${n}</span>`;

const cost = (list: [Resource, number][]): string =>
  `<div class="tip-cost">${list.map(([r, n]) => chip(r, n)).join('')}</div>`;

const COSTS = {
  road: [['wood', 1], ['brick', 1]] as [Resource, number][],
  settlement: [['wood', 1], ['brick', 1], ['sheep', 1], ['wheat', 1]] as [Resource, number][],
  city: [['ore', 3], ['wheat', 2]] as [Resource, number][],
  dev: [['sheep', 1], ['wheat', 1], ['ore', 1]] as [Resource, number][],
};

export const TIP_HTML: Record<string, string> = {
  roll: `
    <div class="tip-title">掷骰子</div>
    <div class="tip-desc">每回合必须掷一次，但<b>先后顺序自由</b>：可以先交易、先建造，再掷。</div>
    <div class="tip-note">点数相加后，对应数字的地块给相邻村庄发资源；掷出 7 则手牌 ≥8 的人弃一半（向上取整），然后移动强盗。</div>`,

  build: `
    <div class="tip-title">建造 · 成本</div>
    ${cost(COSTS.road)}
    <div class="tip-desc">道路 · 接在自己的路或建筑旁</div>
    ${cost(COSTS.settlement)}
    <div class="tip-desc">村庄 · 挨自己的路、周围无建筑</div>
    ${cost(COSTS.city)}
    <div class="tip-desc">城市 · 升级村庄，产出翻倍</div>
    <div class="tip-note">掷骰前也能建；点开面板选一项，详细的说明在每一项上。</div>`,

  trade: `
    <div class="tip-title">交易</div>
    <div class="tip-desc">选一位玩家，填「我给 / 我要」，对方看到报价后可接受或拒绝。</div>
    <div class="tip-note">允许零对价（存牌）；桌上同时只挂一条报价；回合结束报价作废。掷骰前后都能谈。</div>`,

  end: `
    <div class="tip-title">结束回合</div>
    <div class="tip-desc">本回合必须掷过骰子才能结束，其余动作顺序不限。</div>
    <div class="tip-note">结束后桌上的报价作废，轮到下一家。</div>`,

  'build-road': `
    <div class="tip-title">道路</div>
    ${cost(COSTS.road)}
    <div class="tip-desc">必须接在自己已有的道路或建筑旁边；上限 15 条。</div>
    <div class="tip-note">连成 5 段以上可争夺「最长路」+2 分。</div>`,

  'build-settlement': `
    <div class="tip-title">村庄</div>
    ${cost(COSTS.settlement)}
    <div class="tip-desc">挨着自己的路；且周围一圈路口都不能有建筑（距离规则）。上限 5 座。</div>
    <div class="tip-note">每个村庄 1 分，相邻地块出数字时收 1 张资源。</div>`,

  'build-city': `
    <div class="tip-title">城市</div>
    ${cost(COSTS.city)}
    <div class="tip-desc">把自己已建的一座村庄升级为城市，不另占路口。上限 4 座。</div>
    <div class="tip-note">每个城市 2 分，相邻地块出数字时收 2 张资源。</div>`,

  'dev-knight': `
    <div class="tip-title">骑士</div>
    <div class="tip-desc">移动强盗，并从目标地块旁的一位对手手里随机抽 1 张牌。</div>
    <div class="tip-note">打出 3 张骑士可拿「最大军队」+2 分。</div>`,

  'dev-victory': `
    <div class="tip-title">胜利点</div>
    <div class="tip-desc">直接 +1 分，不需要打出，一直藏着，达成胜利时自动计入。</div>
    <div class="tip-note">别人只能看到你的发展卡张数，看不到内容。</div>`,

  'dev-monopoly': `
    <div class="tip-title">垄断</div>
    <div class="tip-desc">指定一种资源，所有对手手里的该资源全部归你。</div>
    <div class="tip-note">看准谁囤了什么再打，语音谈判里这张牌最有杀伤力。</div>`,

  'dev-plenty': `
    <div class="tip-title">丰饶</div>
    <div class="tip-desc">从银行免费拿任意 2 张资源（可以同种）。</div>
    <div class="tip-note">本变体银行资源无限。</div>`,

  'dev-roadbuilding': `
    <div class="tip-title">筑路</div>
    <div class="tip-desc">免费铺最多 2 条路，仍须符合连通与占用规则。</div>
    <div class="tip-note">常用来抢最长路或抢关键路口。</div>`,
};

/** 事件委托挂在 document 上，动态重绘的面板也能自动生效 */
export function initTooltips(): void {
  const box = document.getElementById('tipbox');
  if (!box) return;
  // 触屏不弹说明，避免挡住棋盘
  if (!window.matchMedia('(hover: hover)').matches) return;

  const hide = (): void => box.classList.add('hidden');

  const show = (el: HTMLElement): void => {
    const html = TIP_HTML[el.dataset.tip ?? ''];
    if (!html) return;
    box.innerHTML = html;
    box.classList.remove('hidden');

    const r = el.getBoundingClientRect();
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - bw / 2, window.innerWidth - bw - 8));
    const above = r.top - bh - 10;
    const preferred = above < 8 ? r.bottom + 10 : above;
    // 夹在视口内，别让说明浮出屏幕或压住底栏按钮
    const top = Math.max(8, Math.min(preferred, window.innerHeight - bh - 8));
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  };

  const closestTip = (node: EventTarget | null): HTMLElement | null => {
    if (!(node instanceof Element)) return null;
    return node.closest<HTMLElement>('[data-tip]');
  };

  document.addEventListener('mouseover', (ev) => {
    const el = closestTip(ev.target);
    if (el) show(el);
  });
  document.addEventListener('mouseout', (ev) => {
    const from = closestTip(ev.target);
    const to = closestTip(ev.relatedTarget);
    if (from && from !== to) hide();
  });
  document.addEventListener('focusin', (ev) => {
    const el = closestTip(ev.target);
    if (el) show(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('click', hide);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}
