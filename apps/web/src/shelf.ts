/**
 * 桌面纸雕底栏（#shelf）与阶段 D 逻辑节点之间的桥。
 *
 * 阶段 D 的全部事件绑定都在 ui.ts / panels.ts 里，绑在 #btn-roll / #btn-build /
 * #btn-trade / #btn-end / #btn-buy-dev / #hand / #devcards / #offer 等既有 id 上。
 * 桌面布局把这些逻辑节点收进不可见的 .rail-legacy / .rail-pinned，
 * 可见的手牌架与主动作放在 #shelf。这里只做两件事：
 *   1. 点击 #shelf 的可见按钮 → 触发对应逻辑按钮的 click（不复制任何游戏规则）。
 *   2. 每次 STATE 后把逻辑节点的 disabled / 文本 / 手牌 HTML 同步到可见镜像。
 *
 * 这样规则、协议、网络恢复、棋盘几何、动作回调全都不用改一行，
 * 也不会出现「同一动作绑两次」导致重复提交。
 */

const MIRROR_CLICKS: Array<[string, string]> = [
  ['shelf-btn-roll', 'btn-roll'],
  ['shelf-btn-build', 'btn-build'],
  ['shelf-btn-trade', 'btn-trade'],
  ['shelf-btn-bank', 'btn-buy-dev'], // 「兑换」入口在桌面用右下抽屉；见下方说明
  ['shelf-btn-end', 'btn-end'],
];

/**
 * 安装底栏代理。
 * - 「兑换」按钮：正式入口是 #rail-actions 的 data-panel="bank"，这里打开该抽屉；
 *   若该按钮暂不可用（阶段/权限），点击会给出与 rail 相同的禁用反馈。
 */
export function installShelfBridge(): void {
  for (const [mirrorId, logicId] of MIRROR_CLICKS) {
    const mirror = document.getElementById(mirrorId);
    const logic = document.getElementById(logicId) as HTMLButtonElement | null;
    if (!mirror || !logic) continue;
    mirror.addEventListener('click', () => {
      if (mirrorId === 'shelf-btn-bank') {
        // 兑换走既有「银行 / 港口兑换」抽屉，不新造规则入口
        const bank = document.querySelector<HTMLElement>('#rail-actions [data-panel="bank"]');
        if (bank && !bank.hasAttribute('disabled')) bank.click();
        return;
      }
      if (!(logic as HTMLButtonElement).disabled) logic.click();
    });
  }
}

/** 每次权威重绘后同步可见镜像（disabled / 文本 / 手牌 / 发展卡 / 报价 / 状态）。 */
export function syncShelf(): void {
  const mirror = (mirrorId: string, logicId: string): void => {
    const m = document.getElementById(mirrorId) as HTMLButtonElement | null;
    const l = document.getElementById(logicId) as HTMLButtonElement | null;
    if (!m || !l) return;
    m.disabled = l.disabled;
    if (l.title) m.title = l.title;
    m.classList.toggle('ready', !l.disabled);
  };
  mirror('shelf-btn-roll', 'btn-roll');
  mirror('shelf-btn-build', 'btn-build');
  mirror('shelf-btn-trade', 'btn-trade');
  mirror('shelf-btn-end', 'btn-end');
  const bank = document.querySelector<HTMLButtonElement>('#rail-actions [data-panel="bank"]');
  const shelfBank = document.getElementById('shelf-btn-bank') as HTMLButtonElement | null;
  if (shelfBank && bank) shelfBank.disabled = bank.disabled;

  // 手牌：把逻辑 #hand 的 5 张资源卡原样搬到可见手牌架（结构一致，CSS 换皮）
  const hand = document.getElementById('hand');
  const shelfHand = document.getElementById('shelf-hand');
  if (hand && shelfHand && shelfHand.innerHTML !== hand.innerHTML) shelfHand.innerHTML = hand.innerHTML;

  // 手牌总数 / 风险
  const total = document.getElementById('hand-total');
  const shelfTotal = document.getElementById('shelf-hand-total');
  if (total && shelfTotal) shelfTotal.textContent = total.textContent;
  const risk = document.getElementById('risk-chip');
  if (risk && total) {
    const n = Number((total.textContent ?? '').replace(/[^0-9]/g, '')) || 0;
    risk.classList.toggle('hidden', n < 8);
  }

  // 发展卡数量（不公开内容）
  const devcards = document.getElementById('devcards');
  const devCount = document.getElementById('shelf-dev-count');
  if (devcards && devCount) {
    const n = devcards.querySelectorAll('.devcard').length;
    // devcards 是 5 类固定槽；显示真实张数需读 me.devCards.length，由 ui.ts 写入 dataset
    const real = Number(devcards.dataset.count ?? n);
    devCount.textContent = String(Number.isFinite(real) ? real : n);
  }

  // 事件 slip 文案（骰子点数由 paintDice 写入 #die1/#die2，这里同步镜像文本）
  syncText('feed-tag', 'feed-tag-mirror');
  syncText('feed-text', 'feed-text-mirror');
  syncText('die1', 'die1-mirror');
  syncText('die2', 'die2-mirror');

  // 禁用原因：既有 #blocked-reason 的文本搬到手牌架下方
  syncText('blocked-reason', 'shelf-action-note');

  // 报价数量镜像
  const offerBar = document.getElementById('offer');
  const count = document.getElementById('rail-offer-count');
  if (offerBar && count) {
    const b = offerBar.querySelector('.ob-text b');
    const m = /交易\s*(\d+)/.exec(b?.textContent ?? '');
    count.textContent = m ? m[1]! : '0';
  }
}

function syncText(fromId: string, toId: string): void {
  const from = document.getElementById(fromId);
  const to = document.getElementById(toId);
  if (from && to && to.textContent !== from.textContent) to.textContent = from.textContent;
}
