/** 设计原型交互层：只负责呈现与草稿，不实现服务端规则。 */
(function () {
  const THEME = document.body.dataset.theme || 'folio';
  const T = Board.THEME[THEME];
  const state = JSON.parse(JSON.stringify(window.GAME_STATE));
  state.seven = null;
  const params = new URLSearchParams(location.search);
  const NAMES = ['甲', '乙', '丙', '丁'];
  const COLORS = ['a', 'b', 'c', 'd'];
  const RES = {
    wood: { name: '木材', label: '木', terrain: 'wood', uses: '道路、村庄' },
    brick: { name: '砖块', label: '砖', terrain: 'brick', uses: '道路、村庄' },
    sheep: { name: '羊毛', label: '羊', terrain: 'sheep', uses: '村庄、发展卡' },
    wheat: { name: '麦子', label: '麦', terrain: 'wheat', uses: '村庄、城市、发展卡' },
    ore: { name: '矿石', label: '矿', terrain: 'ore', uses: '城市、发展卡' },
  };
  const TERRAIN = { wood: '森林', brick: '丘陵', sheep: '牧场', wheat: '田地', ore: '山地', desert: '沙漠' };
  const COST = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { wheat: 2, ore: 3 },
  };
  const themeName = THEME === 'folio' ? '航海图志' : '晴湾纸雕';

  let boardCtx = null;
  let popoverAnchor = null;
  let toastTimer = 0;
  let ui = {
    zoom: 1,
    rolling: false,
    build: null,
    trade: null,
    drawerOpen: false,
    tradeTimer: 0,
    incomingTimer: 0,
    incomingScheduled: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const playerColor = (i) => T.player[COLORS[i]];
  const totalHand = () => state.hand.reduce((sum, r) => sum + r.count, 0);
  const handOf = (key) => state.hand.find((r) => r.key === key)?.count || 0;
  const costAvailable = (cost) => Object.entries(cost).every(([k, n]) => handOf(k) >= n);
  const missingText = (cost) => {
    const out = Object.entries(cost)
      .filter(([k, n]) => handOf(k) < n)
      .map(([k, n]) => `${RES[k].name} ${n - handOf(k)}`);
    return out.length ? `还缺 ${out.join('、')}` : '';
  };

  function pips(n) {
    return { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 }[n] || 0;
  }

  function syncHand() {
    const total = totalHand();
    state.players[0].handCount = total;
    state.discardRisk = total >= 8 ? Math.ceil(total / 2) : 0;
  }

  function discardNeed(count) {
    return count >= 8 ? Math.ceil(count / 2) : 0;
  }

  function selectedCount() {
    if (!state.seven) return 0;
    return Object.values(state.seven.selected).reduce((a, b) => a + b, 0);
  }

  function tileLabel(key) {
    const t = state.tiles.find((x) => x.key === key);
    if (!t) return '所选地块';
    return `${TERRAIN[t.terrain]}${t.number ? ' ' + t.number + ' 号' : ''}`;
  }

  function victimsFor(tileKey) {
    if (!boardCtx) return [];
    const out = [];
    for (const [vk, b] of boardCtx.buildingVertices.entries()) {
      if (b.player === 0) continue;
      const v = boardCtx.geo.vertices[vk];
      if (v?.tiles.includes(tileKey) && !out.includes(b.player)) out.push(b.player);
    }
    return out;
  }

  // ———————————————————————————————— 图标 ————————————————————————————————
  const ICON = {
    logo: `<svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path d="M20 3 35 11.5v17L20 37 5 28.5v-17Z" stroke="currentColor" stroke-width="1.5" opacity=".9"/>
      <path d="M20 8 27 20 20 32 13 20Z" fill="currentColor" opacity=".16" stroke="currentColor" stroke-width="1.2"/>
      <path d="M20 8v24M13 20h14" stroke="currentColor" stroke-width=".8" opacity=".45"/>
      <circle cx="20" cy="20" r="2.1" fill="currentColor"/>
      <path d="M20 4.5v2M35 11.5l-1.7 1M35 28.5l-1.7-1M20 35.5v-2M5 28.5l1.7-1M5 11.5l1.7 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`,
    hand: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3.2" y="5.2" width="10.2" height="12" rx="1.7" stroke="currentColor" stroke-width="1.3"/><path d="M6.6 3.4h8.1c.9 0 1.6.7 1.6 1.6v9.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    dev: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="4" y="3" width="12" height="14" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="m10 6.2 1.1 2.2 2.4.35-1.75 1.7.42 2.4L10 11.75 8.23 12.85l.42-2.4L6.9 8.75l2.4-.35Z" fill="currentColor" opacity=".75"/></svg>`,
    crown: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 7.5 6.5 11 10 5.5 13.5 11 17 7.5v7H3Z" fill="currentColor" opacity=".2" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
    road: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 16.5 8.5 3.5M12 3.5l4.5 13M7 12h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    knight: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4.2 16.5h11.6M5.5 13.8h9M6 13.8c0-4 1.8-6.8 5-7.5l-1-2.8 4 2.2c1.2 1.2 1.5 3 1 4.4-.6 1.6-1.1 2.5-1.2 3.7" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    trade: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 7.5h12.5M12.5 4.5l3 3-3 3M17 12.5H4.5M7.5 9.5l-3 3 3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    build: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 16.8h14M4.5 16.8V9l5.5-4 5.5 4v7.8M7.5 16.8v-4h5v4" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
    exchange: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4.2 6.5h9.6M10.8 3.4l3.3 3.1-3.3 3.1M15.8 13.5H6.2M9.2 10.4l-3.3 3.1 3.3 3.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    end: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 17V3.5M5 4h9.5l-2.2 3 2.2 3H5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    close: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    plus: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    minus: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4.5 10h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    reset: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 8.5h4V4.5M4.6 8.2A6 6 0 1 1 4 11.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    warn: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.5 18 17H2Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M10 7v4.6M10 14.4v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    help: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.2" stroke="currentColor" stroke-width="1.3"/><path d="M8.2 7.6c.2-1.4 3.6-1.7 3.6.5 0 1.6-1.8 1.7-1.8 3.4M10 14.5v.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    dice: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="3" stroke="currentColor" stroke-width="1.3"/><circle cx="7" cy="7" r="1.1" fill="currentColor"/><circle cx="13" cy="7" r="1.1" fill="currentColor"/><circle cx="10" cy="10" r="1.1" fill="currentColor"/><circle cx="7" cy="13" r="1.1" fill="currentColor"/><circle cx="13" cy="13" r="1.1" fill="currentColor"/></svg>`,
  };

  function dieSvg(n, size = 28) {
    const pos = {
      1: [[12, 12]],
      2: [[7.5, 7.5], [16.5, 16.5]],
      3: [[7.5, 7.5], [12, 12], [16.5, 16.5]],
      4: [[7.5, 7.5], [16.5, 7.5], [7.5, 16.5], [16.5, 16.5]],
      5: [[7.5, 7.5], [16.5, 7.5], [12, 12], [7.5, 16.5], [16.5, 16.5]],
      6: [[7.5, 7], [16.5, 7], [7.5, 12], [16.5, 12], [7.5, 17], [16.5, 17]],
    }[n] || [];
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="1.6" y="1.6" width="20.8" height="20.8" rx="5" fill="var(--die-face)" stroke="var(--die-line)" stroke-width="1.7"/>
      ${pos.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.05" fill="var(--die-dot)"/>`).join('')}
    </svg>`;
  }

  function badgeIcon(name) {
    return name === '最长路' ? ICON.road : ICON.crown;
  }

  // ———————————————————————————————— 主框架 ————————————————————————————————
  function shell() {
    return `<div class="app">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">${ICON.logo}</span>
          <div class="brand-copy">
            <div class="brand-line"><b>六角拓荒</b><span class="brand-tag">HEX FRONTIER</span></div>
            <div class="room-line"><span class="conn-dot"></span>${state.room}<span class="sep">·</span>已连接</div>
          </div>
        </div>
        <nav class="players" id="players" aria-label="玩家与公开分数"></nav>
        <div class="turnbox" id="turnbox">
          <div class="round-mark"><span>ROUND</span><b>${state.round}</b></div>
          <div class="turn-copy"><b id="turn-title">甲 行动中</b><span id="turn-sub">尚未掷骰</span></div>
          <button class="icon-btn" data-act="help" aria-label="规则与帮助" title="规则与帮助">${ICON.help}</button>
        </div>
      </header>

      <main class="main">
        <section class="board-wrap" id="board-wrap" aria-label="海岬群岛棋盘">
          <div class="board-ornament" aria-hidden="true"></div>
          <svg id="board"></svg>
          <div class="board-event" id="board-event" aria-live="polite"></div>
          <div class="board-tools" aria-label="棋盘缩放">
            <button class="cam-btn" data-act="zoom-in" aria-label="放大棋盘">${ICON.plus}</button>
            <button class="cam-btn" data-act="zoom-out" aria-label="缩小棋盘">${ICON.minus}</button>
            <button class="cam-btn" data-act="zoom-reset" aria-label="回到全局视图">${ICON.reset}</button>
          </div>
          <div class="tile-tip" id="tile-tip" hidden></div>
          <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
        </section>

        <aside class="rail" id="rail" aria-label="当前任务与桌上的提议"></aside>
      </main>

      <footer class="shelf" id="shelf" aria-label="你的手牌与行动"></footer>
    </div>

    <div class="drawer-layer" id="drawer-layer" hidden></div>
    <div class="popover" id="popover" hidden></div>`;
  }

  // ———————————————————————————————— 顶栏 ————————————————————————————————
  function topPlayers() {
    $('#players').innerHTML = state.players
      .map((p, i) => {
        const color = playerColor(i);
        const badge = p.badges?.[0];
        const current = i === state.current;
        return `<button class="pchip${current ? ' current' : ''}${p.you ? ' you' : ''}" data-act="player" data-player="${i}" style="--pc:${color}" aria-current="${current ? 'true' : 'false'}" title="${p.name} · ${p.score} 分 · 手牌 ${p.handCount} 张">
          <span class="pavatar">${p.name}</span>
          <span class="pname">${p.name}${p.you ? '<em>你</em>' : ''}</span>
          <span class="pscore"><b>${p.score}</b><small>分</small></span>
          <span class="pmeta">
            <span class="metric${p.handCount >= 8 ? ' warn' : ''}" title="手牌 ${p.handCount} 张">${ICON.hand}<b>${p.handCount}</b></span>
            <span class="metric" title="发展卡 ${p.devCount} 张">${ICON.dev}<b>${p.devCount}</b></span>
          </span>
          ${badge ? `<span class="pbadge">${badgeIcon(badge)}<span>${badge}</span></span>` : ''}
        </button>`;
      })
      .join('');
    const cur = state.players[state.current];
    $('#turn-title').textContent = `${cur.name} 行动中`;
    let sub = state.hasRolled ? '已掷骰 · 可结束回合' : '尚未掷骰';
    if (state.seven) {
      sub = state.seven.phase === 'discard' ? '弃牌阶段'
        : state.seven.phase === 'waiting' ? '等待弃牌'
        : state.seven.phase === 'robber' ? '强盗待放置'
        : '选择抽牌对象';
    }
    $('#turn-sub').textContent = sub;
  }

  // ———————————————————————————————— 右栏 ————————————————————————————————
  function taskCard() {
    const total = totalHand();
    const risk = total >= 8 ? `你持 ${total} 张 · 若掷出 7 需弃 ${state.discardRisk} 张` : `你持 ${total} 张 · 无弃牌风险`;
    const seal = state.players[state.current].name;
    if (!state.hasRolled) {
      return `<section class="card task-card">
        <span class="task-seal" aria-hidden="true">${seal}</span>
        <div class="eyebrow"><span class="pulse"></span>你的回合 · 第 ${state.round} 回合</div>
        <h2>你的回合，尚未掷骰</h2>
        <p>先掷骰，或先建造 / 交易。</p>
        <div class="risk-chip${total >= 8 ? ' hot' : ''}">${ICON.warn}<span>${risk}</span></div>
        <div class="task-foot"><span>当前阶段</span><b>行动阶段 · 未掷骰</b></div>
      </section>`;
    }
    return `<section class="card task-card">
      <span class="task-seal" aria-hidden="true">${seal}</span>
      <div class="eyebrow"><span class="pulse"></span>你的回合 · 第 ${state.round} 回合</div>
      <h2>骰子已落，继续行动</h2>
      <p>可继续建造、交易，或打 1 张发展卡。</p>
      <div class="risk-chip">${ICON.dice}<span>已掷骰 · 结束回合前仍可行动</span></div>
      <div class="task-foot"><span>当前阶段</span><b>行动阶段 · 已掷骰</b></div>
    </section>`;
  }

  function offerCard() {
    if (!state.offers.length) {
      const locked = state.seven && ['discard', 'waiting'].includes(state.seven.phase);
      const text = locked
        ? '掷出 7 点，桌上的报价已全部作废。<br>完成弃牌前不能发起交易。'
        : '暂时没有待处理提议。<br>需要换资源时，可以直接发起一笔。';
      return `<section class="card offers-card${locked ? ' cleared' : ''}">
        <header class="card-head"><h3>桌上的提议</h3><span class="count">0</span>${locked ? '<span class="live">已清空</span>' : ''}</header>
        <div class="empty-offers">${text}</div>
        ${locked ? '' : `<button class="text-link" data-act="trade-open">发起交易 ${ICON.trade}</button>`}
      </section>`;
    }
    return `<section class="card offers-card">
      <header class="card-head"><h3>桌上的提议</h3><span class="count">${state.offers.length}</span><span class="live">10 秒内有效</span></header>
      <div class="offer-list">${state.offers.map((o) => offerTicket(o)).join('')}</div>
    </section>`;
  }

  function metaInline() {
    const lr = state.players[state.meta.longestRoad.player];
    const la = state.players[state.meta.largestArmy.player];
    return `<div class="meta-inline">
      <div><span>牌堆</span><b>${state.meta.deck}</b></div>
      <div><span>最长路</span><b>${lr.name} · ${state.meta.longestRoad.length}</b></div>
      <div><span>最大军</span><b>${la.name} · ${state.meta.largestArmy.count}</b></div>
    </div>`;
  }

  function logCard() {
    const iconFor = { knight: ICON.knight, dice: ICON.dice, trade: ICON.trade, build: ICON.build, discard: ICON.hand, dev: ICON.dev };
    return `<section class="card log-card">
      <header class="card-head"><h3>岛上动静</h3><button class="text-btn" data-act="log">全部</button></header>
      <ol class="log-list">
        ${state.log
          .slice(0, 3)
          .map((l) => `<li><span class="log-ico">${iconFor[l.icon] || ICON.build}</span><span>${l.text}</span></li>`)
          .join('')}
      </ol>
      ${metaInline()}
    </section>`;
  }

  function buildTaskCard() {
    const isRoad = ui.build.type === 'road';
    const cost = isRoad ? COST.road : COST.settlement;
    const ok = costAvailable(cost);
    const selected = ui.build.selected;
    return `<section class="card task-card build-task">
      <span class="task-seal" aria-hidden="true">${isRoad ? '路' : '村'}</span>
      <div class="eyebrow"><span class="pulse"></span>建造模式 · 在棋盘选点</div>
      <h2>${isRoad ? '放置一条道路' : '放置一座村庄'}</h2>
      <p>${isRoad ? '点选一条金色高亮边。道路必须接在你已有的路网或建筑上。' : '点选一个金色高亮路口。村庄要离开其他村庄至少一格。'}</p>
      <div class="risk-chip">${costMarkup(cost)}<span>${selected ? '位置已选 · 等待确认' : '尚未选择位置'}</span></div>
      <div class="build-steps">
        <span class="step ${selected ? 'done' : 'on'}"><i>1</i>选择位置</span>
        <span class="step ${selected ? 'on' : ''}"><i>2</i>确认建造</span>
      </div>
      <div class="build-actions">
        <button class="mini-btn solid" data-act="confirm-build" ${selected && ok ? '' : 'disabled'}>确认建造</button>
        <button class="mini-btn quiet" data-act="cancel-build">取消</button>
      </div>
      <div class="task-foot"><span>Esc 取消</span><b>${ok ? '资源足够' : missingText(cost)}</b></div>
    </section>`;
  }

  function discardCard() {
    const sx = state.seven;
    const total = totalHand();
    const sel = selectedCount();
    const others = Object.entries(sx.others || {}).map(([i, n]) => `${state.players[i].name} 需弃 ${n} 张`);
    return `<section class="card task-card discard-task">
      <span class="task-seal" aria-hidden="true">7</span>
      <div class="eyebrow"><span class="pulse danger"></span>掷出 7 · 弃牌阶段</div>
      <h2>你需要弃掉 ${sx.required} 张</h2>
      <p>手牌 ${total} 张，8 张起弃一半向上取整。自己选满 ${sx.required} 张再确认。</p>
      <div class="discard-meter">
        <div class="discard-pips">${Array.from({ length: sx.required }, (_, i) => `<i class="${i < sel ? 'on' : ''}"></i>`).join('')}</div>
        <b>${sel} / ${sx.required}</b>
      </div>
      <div class="risk-chip hot">${ICON.warn}<span>${others.length ? others.join(' · ') + ' · 等待中' : '其他玩家无需弃牌'}</span></div>
      <div class="task-foot"><span>已暂停</span><b>建造 · 交易 · 兑换 · 发展卡</b></div>
    </section>`;
  }

  function waitingCard() {
    const sx = state.seven;
    const others = Object.entries(sx.others || {}).map(([i, n]) => {
      const p = state.players[i];
      return `<div class="waiting-person"><span class="ravatar" style="--pc:${playerColor(i)}">${p.name}</span><span>${p.name} 正在选牌</span><b>${n} 张</b></div>`;
    }).join('');
    return `<section class="card task-card waiting-task">
      <span class="task-seal" aria-hidden="true">甲</span>
      <div class="eyebrow"><span class="pulse"></span>弃牌阶段 · 已提交</div>
      <h2>${sx.required ? `你已弃 ${sx.required} 张` : '你无需弃牌'}</h2>
      <p>等待其他手牌超限的玩家完成弃牌。弃完后建造、交易和兑换会恢复；发展卡与结束回合仍锁定。</p>
      <div class="waiting-list">
        <div class="waiting-person done"><span class="ravatar" style="--pc:${playerColor(0)}">甲</span><span>你</span><b>${sx.required ? sx.required + ' / ' + sx.required : '无需弃牌'}</b></div>
        ${others}
      </div>
      <div class="task-foot"><span>接下来</span><b>移动强盗</b></div>
    </section>`;
  }

  function robberCard() {
    return `<section class="card task-card robber-task">
      <span class="task-seal" aria-hidden="true">盗</span>
      <div class="eyebrow"><span class="pulse danger"></span>强盗阶段 · 选择地块</div>
      <h2>把强盗移到哪里？</h2>
      <p>点棋盘上带金色虚线的地块。被占据的地块不产资源；若相邻有建筑，再选择一名玩家抽牌。</p>
      <div class="risk-chip">${ICON.build}<span>弃牌已完成 · 建造 / 交易 / 兑换已恢复</span></div>
      <div class="task-foot"><span>仍锁定</span><b>发展卡 · 结束回合</b></div>
    </section>`;
  }

  function victimCard() {
    const sx = state.seven;
    return `<section class="card task-card victim-task">
      <span class="task-seal" aria-hidden="true">抽</span>
      <div class="eyebrow"><span class="pulse danger"></span>强盗落点 · 选择对象</div>
      <h2>从谁手里抽 1 张？</h2>
      <p>${tileLabel(state.robberTile)} 相邻有这些玩家。抽到的资源内容不公开。</p>
      <div class="victim-list">
        ${sx.victims.map((i) => {
          const p = state.players[i];
          return `<button class="victim-btn" data-act="choose-victim" data-player="${i}" style="--pc:${playerColor(i)}">
            <span class="ravatar">${p.name}</span><span class="victim-name">${p.name}</span><span class="victim-hand">手牌 ${p.handCount} 张</span><span class="victim-go">抽 1 张</span>
          </button>`;
        }).join('')}
      </div>
      <div class="task-foot"><span>提交后</span><b>本回合可继续行动</b></div>
    </section>`;
  }

  function renderRail() {
    let main;
    if (ui.build) main = buildTaskCard();
    else if (!state.seven) main = taskCard();
    else if (state.seven.phase === 'discard') main = discardCard();
    else if (state.seven.phase === 'waiting') main = waitingCard();
    else if (state.seven.phase === 'robber') main = robberCard();
    else main = victimCard();
    const pending = ui.build && state.seven && ['robber', 'victim'].includes(state.seven.phase)
      ? `<button class="pending-chip" data-act="resume-robber">${ICON.warn}<span>强盗待放置</span><b>继续 →</b></button>`
      : '';
    $('#rail').innerHTML = pending + main + offerCard() + logCard();
  }

  // ———————————————————————————————— 底部手牌与行动 ————————————————————————————————
  function handLabel(mode) {
    const total = totalHand();
    if (mode === 'discard') {
      const sel = selectedCount();
      const req = state.seven.required;
      return `<div class="hand-label discard-label">
        <span class="eyebrow">选择要弃的牌</span>
        <div class="hand-total"><b>${sel}</b><span>/ ${req}</span></div>
        <span class="risk-tag hot">${ICON.warn}持有 ${total} 张 · 点牌选择</span>
      </div>`;
    }
    if (mode === 'waiting') {
      return `<div class="hand-label discard-label">
        <span class="eyebrow">你的手牌</span>
        <div class="hand-total"><b>${total}</b><span>张</span></div>
        <span class="risk-tag">已弃 ${state.seven.required} 张 · 等待</span>
      </div>`;
    }
    const risk = total >= 8 ? `7 点弃 ${state.discardRisk}` : '无弃牌风险';
    return `<div class="hand-label">
      <span class="eyebrow">你的手牌</span>
      <div class="hand-total"><b>${total}</b><span>张</span></div>
      <span class="risk-tag${total >= 8 ? ' hot' : ''}">${ICON.warn}${risk}</span>
    </div>`;
  }

  function handCards(mode) {
    return state.hand
      .map((r) => {
        const pick = mode === 'discard' ? (state.seven.selected[r.key] || 0) : 0;
        const discard = mode === 'discard';
        return `<button class="res-card${r.count === 0 ? ' empty' : ''}${discard ? ' discardable' : ''}${pick ? ' picked' : ''}" data-act="${discard ? 'discard-add' : 'res'}" data-res="${r.key}" style="--rc:${T.terrain[RES[r.key].terrain].base};--rcl:${T.terrain[RES[r.key].terrain].light};--rcd:${T.terrain[RES[r.key].terrain].deep}" ${discard ? `aria-pressed="${pick > 0}" aria-label="${RES[r.key].name}，持有 ${r.count} 张${pick ? `，已选 ${pick} 张` : ''}，点击再选一张"` : ''}>
          <span class="res-ico">${Board.resourceIcon(r.key, THEME, 30)}</span>
          <span class="res-name">${RES[r.key].name}</span>
          <b class="res-count">${r.count}</b>
          ${r.port && !discard ? `<span class="port-tag">${r.port}</span>` : ''}
          ${pick ? `<span class="pick-badge" data-act="discard-remove" data-res="${r.key}" title="取消 1 张" aria-label="取消 1 张${RES[r.key].name}">已选 ${pick} <b>−</b></span>` : ''}
        </button>`;
      })
      .join('');
  }

  function devZone(locked = false, note = '本回合可打 1 张') {
    return `<button class="dev-stack${locked ? ' locked' : ''}" data-act="${locked ? 'dev-locked' : 'dev-open'}" aria-label="发展卡${locked ? '已锁定' : ''}" ${locked ? 'disabled' : ''}>
      <span class="dev-fan" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="dev-copy"><span class="eyebrow">发展卡</span><b>${state.players[0].devCount}</b><small>${note}</small></span>
    </button>`;
  }

  function actions() {
    const rolled = state.hasRolled;
    const total = totalHand();
    const robber = state.seven && ['robber', 'victim'].includes(state.seven.phase);
    const endDisabled = !rolled || robber;
    return `<div class="actions">
      <div class="action-main">
        <button class="btn primary roll-btn${rolled ? ' done' : ''}${ui.rolling ? ' rolling' : ''}" data-act="roll" ${rolled || ui.rolling ? 'disabled' : ''}>
          <span class="btn-ico">${ICON.dice}</span>
          <span>${ui.rolling ? '骰子滚动中…' : rolled ? '本轮已掷骰' : '掷骰子'}</span>
          <kbd>2d6</kbd>
        </button>
        <div class="action-row">
          <button class="btn" data-act="build-open">${ICON.build}<span>建造</span></button>
          <button class="btn" data-act="trade-open">${ICON.trade}<span>交易</span></button>
          <button class="btn" data-act="exchange-open">${ICON.exchange}<span>兑换</span></button>
          <button class="btn quiet end-btn" data-act="end-open" ${endDisabled ? 'disabled' : ''} title="${robber ? '先完成强盗结算' : rolled ? '结束本回合' : '需先掷骰'}">${ICON.end}<span>结束回合</span></button>
        </div>
      </div>
      <div class="action-note">${robber ? '先完成强盗结算 · 建造 / 交易仍可用' : rolled ? '已掷骰 · 结束后轮到 乙' : '结束回合需先掷骰 · 你持 ' + total + ' 张'}</div>
    </div>`;
  }

  function discardActions() {
    const sel = selectedCount();
    const req = state.seven.required;
    return `<div class="actions discard-actions">
      <div class="action-main">
        <button class="btn primary discard-confirm" data-act="confirm-discard" ${sel === req ? '' : 'disabled'}>
          <span>确认弃牌</span><kbd>${sel} / ${req}</kbd>
        </button>
        <div class="action-row discard-reset">
          <button class="btn" data-act="reset-discard">重选</button>
        </div>
      </div>
      <div class="action-note">弃牌完成前：建造 / 交易 / 兑换 / 发展卡暂停</div>
    </div>`;
  }

  function waitingActions() {
    return `<div class="actions waiting-actions">
      <div class="action-main">
        <button class="btn primary done" disabled><span>等待其他玩家弃牌…</span></button>
      </div>
      <div class="action-note">弃完后进入强盗阶段</div>
    </div>`;
  }

  function renderShelf() {
    const seven = state.seven;
    if (seven?.phase === 'discard') {
      $('#shelf').innerHTML = `${handLabel('discard')}<div class="hand-row" id="hand-row">${handCards('discard')}</div>${devZone(true, '弃牌阶段锁定')}${discardActions()}`;
      return;
    }
    if (seven?.phase === 'waiting') {
      $('#shelf').innerHTML = `${handLabel('waiting')}<div class="hand-row" id="hand-row">${handCards()}</div>${devZone(true, '弃牌阶段锁定')}${waitingActions()}`;
      return;
    }
    const robber = seven && ['robber', 'victim'].includes(seven.phase);
    $('#shelf').innerHTML = `${handLabel()}<div class="hand-row" id="hand-row">${handCards()}</div>${devZone(!!robber, robber ? '强盗结算后可打' : '本回合可打 1 张')}${actions()}`;
  }

  // ———————————————————————————————— 棋盘事件 ————————————————————————————————
  function renderBoardEvent() {
    const el = $('#board-event');
    if (!el) return;
    const r = state.lastRoll;
    const who = state.players[r.by]?.name || '甲';
    el.innerHTML = `<div class="event-dice">${dieSvg(r.d1, 26)}${dieSvg(r.d2, 26)}</div>
      <div class="event-copy"><b>${who} 掷出 ${r.total} 点</b><span>${r.sub}</span></div>`;
  }

  // ———————————————————————————————— 棋盘绘制 ————————————————————————————————
  function overlayData() {
    if (ui.build) {
      return {
        type: ui.build.type,
        edges: ui.build.edges,
        vertices: ui.build.vertices,
        selected: ui.build.selected,
      };
    }
    if (state.seven?.phase === 'robber') {
      return {
        type: 'robber',
        tiles: state.tiles.map((t) => t.key).filter((k) => k !== state.robberTile),
      };
    }
    return null;
  }

  function drawBoard() {
    const svg = $('#board');
    boardCtx = Board.render(svg, state, THEME, overlayData());
    applyZoom();
  }

  function applyZoom() {
    const g = $('#board-zoom');
    if (g) g.style.transform = ui.zoom === 1 ? '' : `scale(${ui.zoom})`;
  }

  function renderAll() {
    syncHand();
    topPlayers();
    renderRail();
    renderShelf();
    drawBoard();
    renderBoardEvent();
  }

  // ———————————————————————————————— 提示 / 弹层 ————————————————————————————————
  function showToast(text, tone = '') {
    const el = $('#toast');
    if (!el) return;
    el.innerHTML = `<span class="toast-mark">${tone === 'warn' ? ICON.warn : ICON.logo}</span><span>${text}</span>`;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { if (el) el.hidden = true; }, 220);
    }, 3200);
  }

  function closePopover() {
    const p = $('#popover');
    if (!p) return;
    p.hidden = true;
    p.innerHTML = '';
    p.style.left = '';
    p.style.top = '';
    popoverAnchor = null;
  }

  function openPopover(html, anchor, side = 'bottom', cls = '') {
    const pop = $('#popover');
    pop.className = `popover ${cls}`.trim();
    pop.innerHTML = html;
    pop.hidden = false;
    pop.style.visibility = 'hidden';
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = r.left + r.width / 2 - pr.width / 2;
    let top = side === 'top' ? r.top - pr.height - 10 : r.bottom + 10;
    left = clamp(left, 12, window.innerWidth - pr.width - 12);
    top = clamp(top, 12, window.innerHeight - pr.height - 12);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.visibility = '';
    popoverAnchor = anchor;
  }

  function popHead(eyebrow, title) {
    return `<div class="pop-head"><div><span class="eyebrow">${eyebrow}</span><h3>${title}</h3></div><button class="pop-close" data-act="close-pop" aria-label="关闭">${ICON.close}</button></div>`;
  }

  // ———————————————————————————————— 玩家 / 资源 / 发展卡 ————————————————————————————————
  function playerPopover(i) {
    const p = state.players[i];
    const handDetail = i === 0
      ? state.hand.map((r) => `${RES[r.key].label} ${r.count}`).join(' · ')
      : `${p.handCount} 张 · 内容不可见`;
    const devDetail = i === 0
      ? state.devCards.map((d) => `${d.name} ${d.count}`).join(' · ')
      : `${p.devCount} 张 · 未公开`;
    const badges = p.badges.length ? p.badges.join(' · ') : '无';
    return `${popHead('公开信息', p.name + (p.you ? ' · 你' : ''))}
      <div class="pop-score"><span class="psorb" style="--pc:${playerColor(i)}">${p.name}</span><div><b>${p.score}</b><small>分</small></div><span class="badge-text">${badges}</span></div>
      <div class="pop-rows">
        <div><span>建筑</span><b>${p.buildings}</b></div>
        <div><span>手牌</span><b>${handDetail}</b></div>
        <div><span>发展卡</span><b>${devDetail}</b></div>
        <div><span>港口</span><b>${p.port}</b></div>
        <div><span>已打出骑士</span><b>${p.knights}</b></div>
      </div>
      <div class="pop-note">${i === 0 ? '这些是你自己的隐藏信息，对手只看到手牌数与发展卡数量。' : '对手的资源种类、发展卡类型与隐藏胜利点不显示。'}</div>`;
  }

  function resPopover(key) {
    const r = state.hand.find((x) => x.key === key);
    const info = RES[key];
    const portNote = key === 'sheep' ? '<div class="pop-callout">你拥有 2:1 羊港，2 张羊毛可换 1 张任意资源。</div>' : '';
    return `${popHead('手牌用途', info.name)}
      <div class="pop-res-big">${Board.resourceIcon(key, THEME, 46)}<div><b>${r.count}</b><span>张在手</span></div></div>
      <div class="pop-rows">
        <div><span>用于</span><b>${info.uses}</b></div>
        <div><span>产地</span><b>${TERRAIN[info.terrain]}</b></div>
      </div>
      ${portNote}
      <div class="pop-note">数量会随掷骰、交易与建造变化。</div>`;
  }

  function devPopover() {
    return `${popHead('你的手牌', '发展卡 · ' + state.players[0].devCount + ' 张')}
      <div class="dev-list">
        ${state.devCards
          .map((d) => `<div class="dev-item"><span class="dev-ico">${d.key === 'knight' ? ICON.knight : d.key === 'road' ? ICON.road : ICON.crown}</span><div><b>${d.name}</b><small>${d.note}</small></div><span class="dev-count">×${d.count}</span></div>`)
          .join('')}
      </div>
      <div class="dev-buy">
        <div><b>购买 1 张</b><small>${costMarkup({ sheep: 1, wheat: 1, ore: 1 })}</small></div>
        <button class="mini-btn solid" data-act="dev-buy" ${costAvailable({ sheep: 1, wheat: 1, ore: 1 }) ? '' : 'disabled'}>抽一张</button>
      </div>
      <div class="pop-note">本回合还可打出 1 张。当回合购买的发展卡不能当回合打出。</div>`;
  }

  function buyDevCard() {
    const cost = { sheep: 1, wheat: 1, ore: 1 };
    if (!costAvailable(cost)) {
      showToast(missingText(cost), 'warn');
      return;
    }
    for (const [k, n] of Object.entries(cost)) {
      const r = state.hand.find((x) => x.key === k);
      if (r) r.count -= n;
    }
    syncHand();
    state.players[0].devCount += 1;
    const knight = state.devCards.find((d) => d.key === 'knight');
    if (knight) knight.count += 1;
    addLog('dev', '甲 购买了 1 张发展卡（未公开）');
    closePopover();
    renderAll();
    playDevDrawEffect();
    showToast('抽到 1 张发展卡 · 本回合不能打出');
  }

  function helpPopover() {
    return `${popHead('这桌的规则', '先看棋盘，再动手')}
      <ul class="help-list">
        <li><b>掷骰前也能行动。</b>建造、交易、发展卡都不要求先掷骰；只有“结束回合”要求本回合已掷骰。</li>
        <li><b>7 点弃牌。</b>手牌 8 张起，弃掉一半并向上取整；系统算张数，你自己选牌。</li>
        <li><b>报价并存。</b>每人最多 1 条，全桌可多条同时存在；每条 10 秒，发送后冷却 3 秒。</li>
        <li><b>强盗未结算不能结束回合。</b>弃牌完成后可以继续建造与交易，但发展卡和结束回合仍锁定。</li>
      </ul>
      <div class="pop-note">本页是设计原型：报价计时、对手弃牌与抽牌为本地演示。</div>`;
  }

  function logPopover() {
    const iconFor = { knight: ICON.knight, dice: ICON.dice, trade: ICON.trade, build: ICON.build, discard: ICON.hand, dev: ICON.dev };
    return `${popHead('本局记录', '岛上动静')}
      <ol class="log-list full">${state.log
        .map((l) => `<li><span class="log-ico">${iconFor[l.icon] || ICON.build}</span><span>${l.text}</span></li>`)
        .join('')}</ol>
      ${metaInline()}`;
  }

  // ———————————————————————————————— 建造 ————————————————————————————————
  function costMarkup(cost) {
    return Object.entries(cost)
      .map(([k, n]) => `<span class="cost-pill">${Board.resourceIcon(k, THEME, 18)}<b>${n}</b></span>`)
      .join('');
  }

  function buildPopover() {
    const roadOk = costAvailable(COST.road);
    const setOk = costAvailable(COST.settlement);
    const cityOk = costAvailable(COST.city);
    return `${popHead('本回合行动', '建造')}
      <div class="build-list">
        <button class="build-opt" data-act="build-choice" data-build-type="road" ${roadOk ? '' : 'disabled'}>
          <span class="bo-ico">${ICON.road}</span><span class="bo-copy"><b>道路</b><small>连通你的路网</small></span>
          <span class="bo-cost">${costMarkup(COST.road)}</span>
          <span class="bo-state ${roadOk ? 'ok' : 'bad'}">${roadOk ? '可建' : missingText(COST.road)}</span>
        </button>
        <button class="build-opt" data-act="build-choice" data-build-type="settlement" ${setOk ? '' : 'disabled'}>
          <span class="bo-ico">${ICON.build}</span><span class="bo-copy"><b>村庄</b><small>+1 分，产出相邻地块</small></span>
          <span class="bo-cost">${costMarkup(COST.settlement)}</span>
          <span class="bo-state ${setOk ? 'ok' : 'bad'}">${setOk ? '可建' : missingText(COST.settlement)}</span>
        </button>
        <button class="build-opt" data-act="build-choice" data-build-type="city" ${cityOk ? '' : 'disabled'}>
          <span class="bo-ico">${ICON.crown}</span><span class="bo-copy"><b>城市</b><small>升级村庄，+1 分</small></span>
          <span class="bo-cost">${costMarkup(COST.city)}</span>
          <span class="bo-state ${cityOk ? 'ok' : 'bad'}">${cityOk ? '可建' : missingText(COST.city)}</span>
        </button>
      </div>
      <div class="pop-note">选类别后在棋盘上点高亮位置，再确认。Esc 可取消。</div>`;
  }

  function findMyNetwork() {
    if (!boardCtx) return { edges: new Set(), vertices: new Set() };
    const edges = new Set();
    for (const [k, p] of boardCtx.roadEdges.entries()) if (p === 0) edges.add(k);
    const vertices = new Set();
    for (const [k, b] of boardCtx.buildingVertices.entries()) if (b.player === 0) vertices.add(k);
    return { edges, vertices };
  }

  function legalSpots(type) {
    const geo = boardCtx.geo;
    const mine = findMyNetwork();
    if (type === 'road') {
      const out = [];
      for (const ek of geo.edgeKeys) {
        if (boardCtx.roadEdges.has(ek)) continue;
        const e = geo.edges[ek];
        const touches = [e.a, e.b].some((vk) => {
          if (mine.vertices.has(vk)) return true;
          return geo.vertices[vk].edges.some((other) => other !== ek && mine.edges.has(other));
        });
        if (touches) out.push(ek);
      }
      return out;
    }
    if (type === 'settlement') {
      const out = [];
      for (const vk of geo.vertexKeys) {
        if (boardCtx.buildingVertices.has(vk)) continue;
        const v = geo.vertices[vk];
        if (v.neighbors.some((n) => boardCtx.buildingVertices.has(n))) continue;
        if (v.edges.some((e) => mine.edges.has(e))) out.push(vk);
      }
      return out;
    }
    return [];
  }

  function startBuild(type, anchor) {
    closePopover();
    const spots = legalSpots(type);
    if (!spots.length) {
      showToast('当前没有合法位置可放置', 'warn');
      return;
    }
    ui.build = { type, edges: type === 'road' ? spots : [], vertices: type === 'settlement' ? spots : [], selected: null };
    drawBoard();
    renderRail();
  }

  function confirmBuild() {
    if (!ui.build || !ui.build.selected) return;
    const isRoad = ui.build.type === 'road';
    const cost = isRoad ? COST.road : COST.settlement;
    if (!costAvailable(cost)) {
      showToast(missingText(cost), 'warn');
      return;
    }
    for (const [k, n] of Object.entries(cost)) {
      const r = state.hand.find((x) => x.key === k);
      if (r) r.count -= n;
    }
    if (isRoad) {
      const e = boardCtx.geo.edges[ui.build.selected];
      const a = boardCtx.geo.vertices[e.a];
      const b = boardCtx.geo.vertices[e.b];
      state.roadChains.push({ player: 0, points: [[a.x, a.y], [b.x, b.y]] });
      addLog('build', '甲 在东南路网补了一条道路');
      showToast('道路已放下 · 木 −1 · 砖 −1');
    } else {
      const v = boardCtx.geo.vertices[ui.build.selected];
      state.buildings.push({ player: 0, city: false, x: v.x, y: v.y });
      state.players[0].score += 1;
      state.players[0].buildings = '2 城 · 3 村';
      addLog('build', '甲 建了一座村庄，分数来到 ' + state.players[0].score);
      showToast('村庄已放下 · +1 分');
    }
    ui.build = null;
    renderAll();
  }

  function cancelBuild() {
    ui.build = null;
    drawBoard();
    renderRail();
    showToast('已取消建造');
  }

  // ———————————————————————————————— 交易 ————————————————————————————————
  const RES_KEYS = Object.keys(RES);
  const blankCounts = () => Object.fromEntries(RES_KEYS.map((k) => [k, 0]));
  const normalizeCounts = (src = {}) => {
    const out = blankCounts();
    RES_KEYS.forEach((k) => {
      const n = Number(src[k]);
      out[k] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    });
    return out;
  };
  const tradeTargets = () => (state.current === 0 ? [1, 2, 3] : [0]).filter((i) => i !== state.current);
  const tradeName = (i) => state.players[i]?.name || '玩家';
  const totalOf = (counts) => RES_KEYS.reduce((sum, k) => sum + (counts[k] || 0), 0);
  const cooldownLeft = () => Math.max(0, Math.ceil(((ui.trade?.cooldownUntil || 0) - Date.now()) / 1000));

  function tradeTotals() {
    const d = ui.trade;
    return { give: totalOf(d.give), want: totalOf(d.want) };
  }

  function countItems(counts) {
    return RES_KEYS.filter((k) => counts[k] > 0)
      .map((k) => `<span class="trade-item">${Board.resourceIcon(k, THEME, 16)}<b>${counts[k]}</b>${RES[k].label}</span>`)
      .join('');
  }

  function countText(counts) {
    return RES_KEYS.filter((k) => counts[k] > 0).map((k) => `${RES[k].label} ×${counts[k]}`).join('、');
  }

  function tradeConditionHTML(d) {
    const name = tradeName(d.to);
    const give = countItems(d.give);
    const want = countItems(d.want);
    if (give && want) return `<span class="cond-label">给 ${name}</span>${give}<span class="cond-arrow">→</span><span class="cond-label">收到</span>${want}`;
    if (give) return `<span class="cond-label">仅赠予 ${name}</span>${give}`;
    if (want) return `<span class="cond-label">向 ${name} 索取</span>${want}`;
    return '<span class="soft">还没有选择资源</span>';
  }

  function tradeInvalidReason(d = ui.trade) {
    if (!d) return '';
    if (d.sending) return '发送中…';
    const totals = tradeTotals();
    if (!totals.give && !totals.want) return '至少选择一种资源';
    for (const k of RES_KEYS) {
      if ((d.give[k] || 0) > handOf(k)) return `你只有 ${handOf(k)} 张${RES[k].name}`;
    }
    if (cooldownLeft() > 0) return `发送冷却 ${cooldownLeft()} 秒`;
    return '';
  }

  function offerTicket(o, extra = '') {
    const p = state.players[o.from];
    const pct = Math.max(4, Math.round((o.seconds / o.total) * 100));
    const live = o.seconds > 0;
    return `<article class="offer${extra ? ' ' + extra : ''}" data-offer="${o.id}" aria-label="${p.name} 的提议">
      <div class="offer-top">
        <span class="oavatar" style="--pc:${playerColor(o.from)}">${p.name}</span>
        <span class="oname">${p.name} 的提议</span>
        <span class="otime">${live ? o.seconds : '—'}<small>${live ? '秒' : ''}</small></span>
      </div>
      <div class="swap">
        <div class="swap-side"><small>你给出</small><span class="sres">${Board.resourceIcon(o.want.key, THEME, 19)}<b>${o.want.count}</b>${RES[o.want.key].label}</span></div>
        <span class="swap-arrow">→</span>
        <div class="swap-side"><small>你收到</small><span class="sres">${Board.resourceIcon(o.give.key, THEME, 19)}<b>${o.give.count}</b>${RES[o.give.key].label}</span></div>
      </div>
      <div class="offer-actions">
        <button class="mini-btn accept" data-act="accept-offer" data-offer="${o.id}" ${live ? '' : 'disabled'}>${live ? '接受' : '已过期'}</button>
        <button class="mini-btn quiet" data-act="reject-offer" data-offer="${o.id}">拒绝</button>
      </div>
      <div class="timer-track"><i style="width:${pct}%"></i></div>
    </article>`;
  }

  function startTradeClock() {
    clearInterval(ui.tradeTimer);
    ui.tradeTimer = setInterval(tickTradeClock, 1000);
  }

  function cancelTradeClock() {
    clearInterval(ui.tradeTimer);
    ui.tradeTimer = 0;
  }

  function cancelTradeTimers() {
    cancelTradeClock();
    clearTimeout(ui.incomingTimer);
    ui.incomingTimer = 0;
  }

  function scheduleIncomingOffer() {
    if (ui.incomingScheduled) return;
    ui.incomingScheduled = true;
    clearTimeout(ui.incomingTimer);
    ui.incomingTimer = setTimeout(addDemoOffer, 8500);
  }

  function addDemoOffer() {
    if (!ui.trade || state.seven) return;
    if (state.offers.some((o) => o.from === 1)) return;
    if (state.offers.length >= 3) return;
    state.offers.push({
      id: 'of-live-1',
      from: 1,
      give: { key: 'sheep', count: 2 },
      want: { key: 'brick', count: 1 },
      seconds: 10,
      total: 10,
    });
    addLog('trade', '乙 发来一条提议：2 羊 ⇄ 1 砖');
    ui.trade.unseen = (ui.trade.unseen || 0) + 1;
    renderRail();
    if (ui.drawerOpen) {
      if (ui.trade.view === 'offers') {
        ui.trade.unseen = 0;
        renderDrawer();
      } else {
        refreshTradeCountBadge();
      }
    }
    showToast('收到乙的新提议 · 在「收到的提议」里查看');
  }

  function tickTradeClock() {
    if (!ui.drawerOpen || !ui.trade) return;
    const d = ui.trade;
    const expired = [];
    for (const o of state.offers) {
      if (o.seconds > 0) o.seconds -= 1;
      if (o.seconds <= 0) expired.push(o);
    }
    refreshOfferTimes();
    if (expired.length) {
      state.offers = state.offers.filter((o) => !expired.includes(o));
      addLog('trade', `${expired.map((o) => tradeName(o.from)).join('、')} 的提议已过期`);
      renderRail();
      if (d.view === 'offers') renderDrawer();
      else refreshTradeCountBadge();
      showToast(`${expired.map((o) => tradeName(o.from)).join('、')} 的提议已过期`, 'warn');
    }
    if (d.sent && Date.now() >= d.sent.expiresAt) {
      const name = tradeName(d.sent.to);
      d.sent = null;
      addLog('trade', `甲 给 ${name} 的提议已过期`);
      renderDrawer();
      showToast(`给 ${name} 的提议已过期`, 'warn');
    } else if (d.sent) {
      refreshSentPanel();
    }
  }

  function refreshOfferTimes() {
    for (const o of state.offers) {
      const pct = Math.max(0, Math.round((o.seconds / o.total) * 100));
      document.querySelectorAll(`[data-offer="${o.id}"]`).forEach((el) => {
        const time = el.querySelector('.otime');
        if (time) time.innerHTML = `${o.seconds > 0 ? o.seconds : '—'}<small>${o.seconds > 0 ? '秒' : ''}</small>`;
        const bar = el.querySelector('.timer-track i');
        if (bar) bar.style.width = `${pct}%`;
        const accept = el.querySelector('[data-act="accept-offer"]');
        if (accept && o.seconds <= 0) accept.disabled = true;
      });
    }
  }

  function refreshTradeCountBadge() {
    const el = document.querySelector('#trade-offer-count');
    if (el) el.textContent = String(state.offers.length);
    const tab = document.querySelector('[data-act="trade-view"][data-view="offers"]');
    if (tab) tab.classList.toggle('unseen', !!ui.trade?.unseen);
  }

  function renderTradeRow(side, key) {
    const d = ui.trade;
    const n = d[side][key] || 0;
    const stock = handOf(key);
    const invalid = side === 'give' && n > stock;
    const max = side === 'give' ? Math.max(stock, n) : Math.max(12, n);
    return `<div class="tr-line${n ? ' on' : ''}${invalid ? ' invalid' : ''}" data-side="${side}" data-key="${key}">
      <div class="tr-top">
        <span class="tr-ico">${Board.resourceIcon(key, THEME, 23)}</span>
        <span class="tr-label">${RES[key].name}</span>
        <span class="tr-stock">${side === 'give' ? `持有 ${stock}${invalid ? ` · 超出 ${n - stock}` : ''}` : ''}</span>
        <input class="tr-num" type="number" min="0" step="1" value="${n}" inputmode="numeric" data-side="${side}" data-key="${key}" aria-label="${RES[key].name}数量">
      </div>
      <div class="tr-control">
        <button class="tr-btn" data-act="trade-dec" data-side="${side}" data-key="${key}" ${n <= 0 ? 'disabled' : ''} aria-label="减少${RES[key].name}">${ICON.minus}</button>
        <input class="tr-range" type="range" min="0" max="${max}" step="1" value="${n}" data-side="${side}" data-key="${key}" aria-label="${RES[key].name}数量滑条">
        <button class="tr-btn" data-act="trade-inc" data-side="${side}" data-key="${key}" ${side === 'give' && n >= stock ? 'disabled' : ''} aria-label="增加${RES[key].name}">${ICON.plus}</button>
      </div>
    </div>`;
  }

  function renderTradeTabs() {
    const d = ui.trade;
    return `<div class="trade-tabs" role="tablist" aria-label="交易面板">
      <button class="trade-tab${d.view === 'edit' ? ' on' : ''}" data-act="trade-view" data-view="edit" role="tab" aria-selected="${d.view === 'edit'}">发起交易</button>
      <button class="trade-tab${d.view === 'offers' ? ' on' : ''}${d.unseen ? ' unseen' : ''}" data-act="trade-view" data-view="offers" role="tab" aria-selected="${d.view === 'offers'}">收到的提议 <b id="trade-offer-count">${state.offers.length}</b></button>
    </div>`;
  }

  function renderWantStep() {
    const d = ui.trade;
    const wantLit = countItems(d.want);
    return `<div class="trade-step-panel" data-step="want">
      <div class="trade-step-head"><span class="trade-kicker">第一步</span><h3>我想收到</h3><p>先挑你想从 ${tradeName(d.to)} 那里收到的资源。</p></div>
      <div class="trade-list">${RES_KEYS.map((k) => renderTradeRow('want', k)).join('')}</div>
      <div class="trade-summary-line"><span>收到</span><b>${wantLit || '<span class="soft">还没有选择</span>'}</b></div>
      <footer class="trade-foot">
        <span class="trade-hint">${totalOf(d.want) ? '也可以只收不给。' : '也可以跳过，只给出资源。'}</span>
        <button class="btn primary trade-next" data-act="trade-next">下一步：我愿给出</button>
      </footer>
    </div>`;
  }

  function renderGiveStep() {
    const d = ui.trade;
    const reason = tradeInvalidReason(d);
    const valid = !reason;
    const wantLit = countItems(d.want);
    return `<div class="trade-step-panel" data-step="give">
      <button class="trade-recap" data-act="trade-back">
        <span><small>我想收到</small><b>${wantLit || '无'}</b></span><em>修改</em>
      </button>
      <div class="trade-step-head"><span class="trade-kicker">第二步</span><h3>我愿给出</h3><p>最多给到你当前持有的数量。</p></div>
      <div class="trade-list">${RES_KEYS.map((k) => renderTradeRow('give', k)).join('')}</div>
      <div class="trade-condition">${tradeConditionHTML(d)}</div>
      <footer class="trade-foot">
        <span class="trade-hint${reason ? ' warn' : ''}">${reason || '确认后直接发出，不再弹确认框。'}</span>
        <button class="btn primary send-btn" data-act="trade-send" ${valid && !d.sending ? '' : 'disabled'}>${d.sending ? '发送中…' : `发送给 ${tradeName(d.to)}`}</button>
      </footer>
    </div>`;
  }

  function refreshSentPanel() {
    const d = ui.trade;
    if (!d?.sent) return;
    const left = Math.max(0, Math.ceil((d.sent.expiresAt - Date.now()) / 1000));
    const cd = cooldownLeft();
    const line = document.querySelector('.trade-sent-state');
    if (line) line.textContent = left > 0 ? `还剩 ${left} 秒 · ${cd > 0 ? `冷却 ${cd} 秒` : '可再发一笔'}` : '提议已过期';
    const btn = document.querySelector('[data-act="trade-new"]');
    if (btn) {
      btn.disabled = cd > 0;
      btn.textContent = cd > 0 ? `冷却 ${cd} 秒` : '再发一笔';
    }
  }

  function renderSentPanel() {
    const d = ui.trade;
    const sent = d.sent;
    const left = Math.max(0, Math.ceil((sent.expiresAt - Date.now()) / 1000));
    const cd = cooldownLeft();
    return `<div class="trade-step-panel trade-sent-panel">
      <div class="trade-success"><span class="trade-success-mark">${ICON.check || '✓'}</span><div><h3>已向 ${tradeName(sent.to)} 发出提议</h3><p>对方接受前，资源不会被预占。</p></div></div>
      <div class="trade-condition">${tradeConditionHTML(sent)}</div>
      <div class="trade-sent-state">${left > 0 ? `还剩 ${left} 秒 · ${cd > 0 ? `冷却 ${cd} 秒` : '可再发一笔'}` : '提议已过期'}</div>
      <footer class="trade-foot">
        <button class="mini-btn quiet" data-act="trade-withdraw">撤回</button>
        <button class="mini-btn solid" data-act="trade-new" ${cd > 0 ? 'disabled' : ''}>${cd > 0 ? `冷却 ${cd} 秒` : '再发一笔'}</button>
      </footer>
      <div class="trade-sent-note">新提议会替换你当前这一条；报价不会自动续期。</div>
    </div>`;
  }

  function renderTradeOffers() {
    const list = state.offers.length
      ? `<div class="trade-offers">${state.offers.map((o) => offerTicket(o, 'drawer-offer')).join('')}</div>`
      : `<div class="trade-offers-empty"><b>暂时没有收到提议</b><p>别人发来的报价会出现在这里，10 秒内有效。</p><button class="mini-btn solid" data-act="trade-view" data-view="edit">发起一笔</button></div>`;
    return `<div class="trade-step-panel trade-offers-panel">
      <div class="trade-step-head"><span class="trade-kicker">收到的提议</span><h3>${state.offers.length ? `${state.offers.length} 条待处理` : '现在很安静'}</h3><p>按到达顺序显示；你给出 / 你收到，都从你的视角看。</p></div>
      ${list}
    </div>`;
  }

  function renderDrawer() {
    if (!ui.drawerOpen || !ui.trade) {
      const layer = $('#drawer-layer');
      if (layer) { layer.hidden = true; layer.innerHTML = ''; }
      return;
    }
    const d = ui.trade;
    const p = state.players[d.to];
    const targets = tradeTargets();
    if (!targets.includes(d.to)) d.to = targets[0] ?? d.to;
    const body = d.view === 'offers' ? renderTradeOffers() : (d.sent ? renderSentPanel() : (d.step === 'give' ? renderGiveStep() : renderWantStep()));
    const lockTargets = !!d.sent;
    const layer = $('#drawer-layer');
    layer.hidden = false;
    layer.innerHTML = `<aside class="drawer trade-drawer" role="dialog" aria-label="交易">
      <header class="drawer-head">
        <div><span class="eyebrow">语音里谈好，这里执行</span><h2>和 ${p.name} 换资源</h2></div>
        <button class="pop-close" data-act="trade-close" aria-label="关闭交易面板">${ICON.close}</button>
      </header>
      <div class="trade-target">
        <span class="eyebrow">交易对象</span>
        <div class="recipient-row" style="--targets:${targets.length}" role="tablist" aria-label="交易对象">
          ${targets.map((i) => `<button class="recipient${d.to === i ? ' on' : ''}${lockTargets ? ' locked' : ''}" data-act="recipient" data-player="${i}" style="--pc:${playerColor(i)}" role="tab" aria-selected="${d.to === i}" ${lockTargets && d.to !== i ? 'disabled' : ''}>
            <span class="ravatar">${state.players[i].name}</span><span>${state.players[i].name}</span><small>${state.players[i].handCount} 张</small>
          </button>`).join('')}
        </div>
        ${lockTargets ? `<span class="target-note">先撤回或等提议过期再换对象</span>` : ''}
      </div>
      ${renderTradeTabs()}
      <div class="trade-body">${body}</div>
    </aside>`;
  }

  function openTrade() {
    closePopover();
    ui.drawerOpen = true;
    if (!ui.trade) ui.trade = {
      to: tradeTargets().includes(2) ? 2 : tradeTargets()[0],
      step: 'want',
      view: 'edit',
      want: normalizeCounts({ ore: 1 }),
      give: normalizeCounts({ sheep: 1 }),
      sent: null,
      sending: false,
      cooldownUntil: 0,
      unseen: 0,
    };
    else {
      ui.trade.want = normalizeCounts(ui.trade.want);
      ui.trade.give = normalizeCounts(ui.trade.give);
      ui.trade.step = ui.trade.step === 'give' ? 'give' : 'want';
      ui.trade.view = ui.trade.view === 'offers' ? 'offers' : 'edit';
      if (ui.trade.view === 'offers') ui.trade.unseen = 0;
      if (ui.trade.sent && Date.now() >= ui.trade.sent.expiresAt) ui.trade.sent = null;
      ui.trade.sending = false;
    }
    startTradeClock();
    scheduleIncomingOffer();
    renderDrawer();
  }

  function closeTrade(reset = false) {
    ui.drawerOpen = false;
    cancelTradeClock();
    if (reset) {
      ui.trade = null;
      clearTimeout(ui.incomingTimer);
      ui.incomingTimer = 0;
    }
    renderDrawer();
    renderRail();
  }

  function setTradeView(view) {
    if (!ui.trade) return;
    ui.trade.view = view === 'offers' ? 'offers' : 'edit';
    if (ui.trade.view === 'offers') ui.trade.unseen = 0;
    renderDrawer();
  }

  function setTradeStep(step) {
    if (!ui.trade || ui.trade.sent) return;
    ui.trade.step = step === 'give' ? 'give' : 'want';
    renderDrawer();
  }

  function setTradeTarget(i) {
    if (!ui.trade) return;
    if (ui.trade.sent) {
      showToast('先撤回或等当前提议过期，再换交易对象', 'warn');
      return;
    }
    if (!tradeTargets().includes(i)) return;
    ui.trade.to = i;
    renderDrawer();
  }

  function popTradeNumber(side, key) {
    const el = document.querySelector(`.tr-line[data-side="${side}"][data-key="${key}"] .tr-num`);
    if (!el) return;
    el.classList.remove('num-pop');
    void el.offsetWidth;
    el.classList.add('num-pop');
  }

  function refreshTradeRow(side, key) {
    const d = ui.trade;
    const row = document.querySelector(`.tr-line[data-side="${side}"][data-key="${key}"]`);
    if (!row) return;
    const n = d[side][key] || 0;
    const stock = handOf(key);
    const invalid = side === 'give' && n > stock;
    row.classList.toggle('on', n > 0);
    row.classList.toggle('invalid', invalid);
    const num = row.querySelector('.tr-num');
    if (num && document.activeElement !== num) num.value = String(n);
    const range = row.querySelector('.tr-range');
    if (range) {
      range.max = String(side === 'give' ? Math.max(stock, n) : Math.max(12, n));
      if (document.activeElement !== range) range.value = String(n);
    }
    const minus = row.querySelector('[data-act="trade-dec"]');
    const plus = row.querySelector('[data-act="trade-inc"]');
    if (minus) minus.disabled = n <= 0;
    if (plus) plus.disabled = side === 'give' && n >= stock;
    const stockEl = row.querySelector('.tr-stock');
    if (stockEl) stockEl.textContent = side === 'give' ? `持有 ${stock}${invalid ? ` · 超出 ${n - stock}` : ''}` : '';
  }

  function refreshTradeUI() {
    if (!ui.drawerOpen || !ui.trade) return;
    RES_KEYS.forEach((k) => { refreshTradeRow('want', k); refreshTradeRow('give', k); });
    const d = ui.trade;
    const summary = document.querySelector('.trade-summary-line b');
    if (summary) summary.innerHTML = countItems(d.want) || '<span class="soft">还没有选择</span>';
    const recap = document.querySelector('.trade-recap b');
    if (recap) recap.innerHTML = countItems(d.want) || '无';
    const condition = document.querySelector('.trade-condition');
    if (condition) condition.innerHTML = tradeConditionHTML(d);
    const hint = document.querySelector('.trade-foot .trade-hint');
    const reason = tradeInvalidReason(d);
    if (hint) {
      hint.textContent = reason || (d.step === 'give' ? '确认后直接发出，不再弹确认框。' : (totalOf(d.want) ? '也可以只收不给。' : '也可以跳过，只给出资源。'));
      hint.classList.toggle('warn', !!reason);
    }
    const send = document.querySelector('[data-act="trade-send"]');
    if (send) {
      send.disabled = !!reason;
      send.textContent = d.sending ? '发送中…' : `发送给 ${tradeName(d.to)}`;
    }
  }

  function changeTrade(side, key, delta) {
    if (!ui.trade || ui.trade.sent) return;
    const d = ui.trade;
    const cur = d[side][key] || 0;
    if (side === 'give' && delta > 0 && cur >= handOf(key)) {
      showToast(`你只有 ${handOf(key)} 张${RES[key].name}`, 'warn');
      return;
    }
    const next = Math.max(0, cur + delta);
    d[side][key] = next;
    refreshTradeUI();
    popTradeNumber(side, key);
  }

  function setTradeRange(side, key, value) {
    if (!ui.trade || ui.trade.sent) return;
    const n = Math.max(0, Math.floor(Number(value) || 0));
    ui.trade[side][key] = n;
    refreshTradeUI();
  }

  function setTradeNumber(side, key, value) {
    if (!ui.trade || ui.trade.sent) return;
    const raw = String(value).trim();
    const n = raw === '' ? 0 : Math.max(0, Math.floor(Number(raw) || 0));
    ui.trade[side][key] = n;
    refreshTradeUI();
  }

  function sendTrade() {
    if (!ui.trade || ui.trade.sent) return;
    const reason = tradeInvalidReason(ui.trade);
    if (reason) {
      showToast(reason, 'warn');
      return;
    }
    const d = ui.trade;
    d.sending = true;
    refreshTradeUI();
    const snapshot = { to: d.to, give: { ...d.give }, want: { ...d.want } };
    const p = state.players[d.to];
    setTimeout(() => {
      if (!ui.trade || ui.trade !== d) return;
      d.sending = false;
      d.sent = { ...snapshot, expiresAt: Date.now() + 10000 };
      d.cooldownUntil = Date.now() + 3000;
      addLog('trade', `甲 向 ${p.name} 发出提议：给 ${countText(snapshot.give) || '无'}，收 ${countText(snapshot.want) || '无'}`);
      showToast(`已向 ${p.name} 发出提议`);
      if (ui.drawerOpen) renderDrawer();
    }, 430);
  }

  function withdrawTrade() {
    if (!ui.trade?.sent) return;
    const name = tradeName(ui.trade.sent.to);
    ui.trade.sent = null;
    addLog('trade', `甲 撤回给 ${name} 的提议`);
    showToast(`已撤回给 ${name} 的提议`);
    renderDrawer();
  }

  function newTradeDraft() {
    if (!ui.trade) return;
    if (cooldownLeft() > 0) return;
    ui.trade.sent = null;
    ui.trade.step = 'want';
    ui.trade.view = 'edit';
    renderDrawer();
  }

  // ———————————————————————————————— 兑换 ————————————————————————————————
  function exchangePopover() {
    const sheep = handOf('sheep');
    const canPort = sheep >= 2;
    return `${popHead('银行 / 港口', '兑换资源')}
      <div class="rate-row ${canPort ? 'ok' : 'off'}">
        <span class="rate-badge">2:1</span>
        <div><b>羊港</b><small>你的东南海岸村庄 · 2 羊换 1 任意</small></div>
        <span class="rate-state">${canPort ? '可用' : '羊毛不足'}</span>
      </div>
      ${canPort ? `<div class="exchange-picks">${Object.keys(RES)
        .map((k) => `<button data-act="exchange-pick" data-key="${k}" title="用 2 羊毛换 1 ${RES[k].name}">${Board.resourceIcon(k, THEME, 22)}<span>${RES[k].label}</span></button>`)
        .join('')}</div>` : '<div class="pop-note">你当前只有 ' + sheep + ' 张羊毛，凑不够 2:1。</div>'}
      <div class="rate-row off">
        <span class="rate-badge">4:1</span>
        <div><b>银行</b><small>需要 4 张同类资源</small></div>
        <span class="rate-state">${Object.keys(RES).some((k) => handOf(k) >= 4) ? '可用' : '手牌不足'}</span>
      </div>
      <div class="pop-note">兑换不经过其他玩家，成交后直接更新手牌。</div>`;
  }

  function doExchange(key) {
    if (handOf('sheep') < 2) {
      showToast('羊毛不足 2 张', 'warn');
      return;
    }
    const sheep = state.hand.find((r) => r.key === 'sheep');
    sheep.count -= 2;
    const target = state.hand.find((r) => r.key === key);
    target.count += 1;
    syncHand();
    closePopover();
    renderAll();
    showToast(`2 羊换了 1 ${RES[key].name}（羊港 2:1）`);
  }

  // ———————————————————————————————— 报价处理 ————————————————————————————————
  function acceptOffer(id) {
    const o = state.offers.find((x) => x.id === id);
    if (!o) return;
    if (o.seconds <= 0) {
      state.offers = state.offers.filter((x) => x.id !== id);
      addLog('trade', `${state.players[o.from].name} 的提议已过期`);
      renderAll();
      refreshTradeAfterOffers();
      showToast('这条提议已过期，不能接受', 'warn');
      return;
    }
    const want = state.hand.find((r) => r.key === o.want.key);
    if (!want || want.count < o.want.count) {
      showToast(`接受失败：你的${RES[o.want.key].name}不足`, 'warn');
      return;
    }
    want.count -= o.want.count;
    const give = state.hand.find((r) => r.key === o.give.key);
    give.count += o.give.count;
    state.players[o.from].handCount = Math.max(0, state.players[o.from].handCount + o.want.count - o.give.count);
    state.offers = state.offers.filter((x) => x.id !== id);
    addLog('trade', `甲 接受 ${state.players[o.from].name} 的提议：给 ${RES[o.want.key].label}${o.want.count}，收 ${RES[o.give.key].label}${o.give.count}`);
    renderAll();
    refreshTradeAfterOffers();
    showToast(`已成交：你收到 ${o.give.count} ${RES[o.give.key].name}，给出 ${o.want.count} ${RES[o.want.key].name}`);
  }

  function refreshTradeAfterOffers() {
    if (!ui.drawerOpen || !ui.trade) return;
    if (ui.trade.view === 'offers') renderDrawer();
    else refreshTradeCountBadge();
  }

  function rejectOffer(id) {
    const o = state.offers.find((x) => x.id === id);
    if (!o) return;
    state.offers = state.offers.filter((x) => x.id !== id);
    renderAll();
    refreshTradeAfterOffers();
    showToast(`已拒绝 ${state.players[o.from].name} 的提议`);
  }

  function addLog(icon, text) {
    state.log.unshift({ icon, text });
    state.log = state.log.slice(0, 6);
  }

  // ———————————————————————————————— 掷骰 ————————————————————————————————
  function rollDice() {
    if (state.hasRolled || ui.rolling) return;
    ui.rolling = true;
    renderShelf();
    const eventEl = $('#board-event');
    if (eventEl) eventEl.classList.add('rolling');
    setTimeout(() => {
      ui.rolling = false;
      if (THEME === 'papercut') {
        enterSeven();
      } else {
        state.hasRolled = true;
        state.lastRoll = { d1: 5, d2: 6, total: 11, by: 0, sub: '羊 +3 · 已结算' };
        const sheep = state.hand.find((r) => r.key === 'sheep');
        sheep.count += 3;
        addLog('dice', '甲 掷出 11 点，收下羊 +3');
        renderAll();
        const el = $('#board-event');
        if (el) el.classList.remove('rolling');
        showToast('11 点 · 羊 +3。可以继续建造、交易，或结束回合。');
      }
    }, 680);
  }

  // ———————————————————————————————— 掷出 7：弃牌 → 强盗 ————————————————————————————————
  function enterSeven(opts = {}) {
    closeTrade(true);
    const required = discardNeed(totalHand());
    const others = {};
    state.players.forEach((p, i) => {
      if (i === 0) return;
      const n = discardNeed(p.handCount);
      if (n) others[i] = n;
    });
    state.hasRolled = true;
    state.offers = [];
    state.lastRoll = { d1: 3, d2: 4, total: 7, by: 0, sub: '报价已清空 · 先弃牌' };
    state.seven = {
      phase: required > 0 ? 'discard' : (Object.keys(others).length ? 'waiting' : 'robber'),
      required,
      selected: opts.selected || {},
      others,
      submitted: required === 0,
      robberTile: null,
      victims: [],
    };
    addLog('discard', `甲 掷出 7 点 · 所有报价作废${required ? '，先弃 ' + required + ' 张' : ''}`);
    renderAll();
    const el = $('#board-event');
    if (el) el.classList.remove('rolling');
    if (!opts.silent) {
      showToast(required ? '掷出 7 点 · 先选择要弃的资源' : '掷出 7 点 · 选择强盗位置', 'warn');
    }
    if (!required && Object.keys(others).length) {
      state.seven.phase = 'waiting';
      renderAll();
      setTimeout(advanceSevenToRobber, 950);
    }
  }

  function advanceSevenToRobber() {
    if (!state.seven || state.seven.phase !== 'waiting') return;
    for (const [i, n] of Object.entries(state.seven.others)) {
      const idx = Number(i);
      state.players[idx].handCount = Math.max(0, state.players[idx].handCount - n);
      addLog('discard', `${state.players[idx].name} 弃了 ${n} 张（不公开）`);
    }
    state.seven.others = {};
    state.seven.phase = 'robber';
    state.seven.victims = [];
    state.lastRoll.sub = '报价已清空 · 先移强盗';
    renderAll();
    showToast('弃牌完成 · 建造与交易恢复，先移动强盗', 'warn');
  }

  function toggleDiscard(key) {
    if (!state.seven || state.seven.phase !== 'discard') return;
    const totalSel = selectedCount();
    if (totalSel >= state.seven.required) {
      showToast(`已经选够 ${state.seven.required} 张`, 'warn');
      return;
    }
    const cur = state.seven.selected[key] || 0;
    if (cur >= handOf(key)) {
      showToast(`${RES[key].name} 没有更多可弃`, 'warn');
      return;
    }
    state.seven.selected[key] = cur + 1;
    renderShelf();
    renderRail();
  }

  function removeDiscard(key) {
    if (!state.seven || state.seven.phase !== 'discard') return;
    const cur = state.seven.selected[key] || 0;
    if (!cur) return;
    if (cur <= 1) delete state.seven.selected[key];
    else state.seven.selected[key] = cur - 1;
    renderShelf();
    renderRail();
  }

  function resetDiscard() {
    if (!state.seven || state.seven.phase !== 'discard') return;
    state.seven.selected = {};
    renderShelf();
    renderRail();
  }

  function confirmDiscard() {
    if (!state.seven || state.seven.phase !== 'discard') return;
    if (selectedCount() !== state.seven.required) {
      showToast(`还需要选择 ${state.seven.required - selectedCount()} 张`, 'warn');
      return;
    }
    for (const [key, n] of Object.entries(state.seven.selected)) {
      const r = state.hand.find((x) => x.key === key);
      if (r) r.count = Math.max(0, r.count - n);
    }
    syncHand();
    addLog('discard', `甲 弃掉 ${state.seven.required} 张（内容不公开）`);
    state.seven.selected = {};
    state.seven.submitted = true;
    closePopover();
    if (Object.keys(state.seven.others).length) {
      state.seven.phase = 'waiting';
      renderAll();
      setTimeout(advanceSevenToRobber, 1050);
    } else {
      state.seven.phase = 'waiting';
      advanceSevenToRobber();
    }
  }

  function chooseRobberTile(key) {
    if (!state.seven || state.seven.phase !== 'robber') return;
    if (key === state.robberTile) return;
    state.robberTile = key;
    state.seven.robberTile = key;
    const victims = victimsFor(key);
    state.seven.victims = victims;
    closePopover();
    if (victims.length) {
      state.seven.phase = 'victim';
      state.lastRoll.sub = `强盗落在 ${tileLabel(key)} · 选择抽牌对象`;
      renderAll();
      showToast(`强盗落在 ${tileLabel(key)} · 选择一名玩家抽牌`, 'warn');
    } else {
      resolveRobber(null);
    }
  }

  function resolveRobber(victimIndex) {
    if (!state.seven) return;
    const label = tileLabel(state.robberTile);
    let text = `甲 把强盗移到 ${label}，相邻没有其他玩家`;
    if (victimIndex !== null && victimIndex !== undefined) {
      const p = state.players[victimIndex];
      p.handCount = Math.max(0, p.handCount - 1);
      text = `甲 把强盗移到 ${label}，从 ${p.name} 抽走 1 张`;
      state.lastRoll.sub = `强盗已移动 · 从 ${p.name} 抽 1 张`;
    } else {
      state.lastRoll.sub = '强盗已移动 · 无人可抽';
    }
    addLog('knight', text);
    state.seven = null;
    renderAll();
    if (victimIndex !== null && victimIndex !== undefined) playDrawEffect(victimIndex);
    showToast(victimIndex !== null && victimIndex !== undefined ? `强盗结算完成 · 从 ${state.players[victimIndex].name} 抽走 1 张` : '强盗结算完成 · 可以继续行动');
  }

  function playCardFly(src, dst, glyph = '?', duration = 460) {
    if (!src || !dst) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const a = src.getBoundingClientRect();
    const b = dst.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'draw-fly';
    el.innerHTML = `<span class="draw-card-back" aria-hidden="true">${glyph}</span>`;
    el.style.left = `${a.left + a.width / 2 - 15}px`;
    el.style.top = `${a.top + a.height / 2 - 20}px`;
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const dx = b.left + b.width / 2 - (a.left + a.width / 2);
      const dy = b.top + b.height / 2 - (a.top + a.height / 2);
      el.style.transitionDuration = `${duration}ms`;
      el.style.transform = `translate(${dx}px, ${dy}px) scale(.86) rotate(7deg)`;
      el.style.opacity = '0';
    }));
    setTimeout(() => el.remove(), duration + 120);
  }

  function playDrawEffect(fromPlayer) {
    playCardFly(
      document.querySelector(`.pchip[data-player="${fromPlayer}"] .pavatar`),
      document.querySelector('.hand-label'),
      '?',
      460
    );
  }

  function playDevDrawEffect() {
    playCardFly(
      document.querySelector('.dev-stack .dev-fan'),
      document.querySelector('.dev-stack .dev-copy b'),
      '✦',
      380
    );
  }

  function resumeRobber() {
    if (!state.seven) return;
    ui.build = null;
    drawBoard();
    renderRail();
    showToast('继续完成强盗结算', 'warn');
  }

  // ———————————————————————————————— 弹层触发 ————————————————————————————————
  function openByAct(act, el) {
    if (ui.drawerOpen && act !== 'trade-open') closeTrade();
    if (act === 'player') {
      openPopover(playerPopover(Number(el.dataset.player)), el, 'bottom', 'pop-player');
    } else if (act === 'res') {
      openPopover(resPopover(el.dataset.res), el, 'top', 'pop-res');
    } else if (act === 'dev-open') {
      openPopover(devPopover(), el, 'top', 'pop-dev');
    } else if (act === 'help') {
      openPopover(helpPopover(), el, 'bottom', 'pop-help');
    } else if (act === 'log') {
      openPopover(logPopover(), el, 'bottom', 'pop-log');
    } else if (act === 'build-open') {
      openPopover(buildPopover(), el, 'top', 'pop-build');
    } else if (act === 'exchange-open') {
      openPopover(exchangePopover(), el, 'top', 'pop-exchange');
    } else if (act === 'trade-open') {
      openTrade();
    } else if (act === 'end-open') {
      openPopover(`${popHead('结束回合', '确认结束？')}
        <p class="pop-p">本回合已掷骰。结束后轮到 乙 行动。</p>
        <div class="pop-actions"><button class="mini-btn solid" data-act="end-confirm">确认结束</button><button class="mini-btn quiet" data-act="close-pop">再想想</button></div>`, el, 'top', 'pop-end');
    }
  }

  // ———————————————————————————————— 事件 ————————————————————————————————
  function onDocumentClick(e) {
    const tileHit = e.target.closest?.('.ov-hit[data-tile]');
    if (tileHit && state.seven?.phase === 'robber') {
      chooseRobberTile(tileHit.dataset.tile);
      return;
    }
    const hit = e.target.closest?.('.ov-hit');
    if (hit && ui.build) {
      ui.build.selected = hit.dataset.edge || hit.dataset.vertex || null;
      drawBoard();
      renderRail();
      return;
    }
    const actEl = e.target.closest?.('[data-act]');
    const inPopover = e.target.closest?.('#popover');
    const inDrawer = e.target.closest?.('.drawer');
    if (!actEl) {
      if (!inPopover) closePopover();
      return;
    }
    const act = actEl.dataset.act;
    if (!['close-pop', 'recipient', 'exchange-pick', 'trade-send', 'trade-close', 'trade-view', 'trade-next', 'trade-back', 'trade-dec', 'trade-inc', 'trade-withdraw', 'trade-new', 'zoom-in', 'zoom-out', 'zoom-reset', 'confirm-build', 'cancel-build', 'roll', 'build-choice', 'discard-add', 'discard-remove', 'confirm-discard', 'reset-discard', 'choose-victim', 'resume-robber', 'dev-buy'].includes(act)) {
      // 打开新弹层时先清掉旧的，避免叠在一起
      if (!inDrawer) closePopover();
    }
    if (['player', 'res', 'dev-open', 'help', 'log', 'build-open', 'exchange-open', 'end-open', 'trade-open'].includes(act)) {
      openByAct(act, actEl);
      return;
    }
    if (act === 'close-pop') {
      closePopover();
      return;
    }
    if (act === 'roll') {
      rollDice();
      return;
    }
    if (act === 'discard-add') {
      toggleDiscard(actEl.dataset.res);
      return;
    }
    if (act === 'discard-remove') {
      removeDiscard(actEl.dataset.res);
      return;
    }
    if (act === 'confirm-discard') {
      confirmDiscard();
      return;
    }
    if (act === 'reset-discard') {
      resetDiscard();
      return;
    }
    if (act === 'choose-victim') {
      resolveRobber(Number(actEl.dataset.player));
      return;
    }
    if (act === 'dev-buy') {
      buyDevCard();
      return;
    }
    if (act === 'resume-robber') {
      resumeRobber();
      return;
    }
    if (act === 'accept-offer') {
      closePopover();
      acceptOffer(actEl.dataset.offer);
      return;
    }
    if (act === 'reject-offer') {
      closePopover();
      rejectOffer(actEl.dataset.offer);
      return;
    }
    if (act === 'build-choice') {
      startBuild(actEl.dataset.buildType);
      return;
    }
    if (act === 'confirm-build') {
      confirmBuild();
      return;
    }
    if (act === 'cancel-build') {
      cancelBuild();
      return;
    }
    if (act === 'trade-close') {
      closeTrade();
      return;
    }
    if (act === 'recipient') {
      setTradeTarget(Number(actEl.dataset.player));
      return;
    }
    if (act === 'trade-view') {
      setTradeView(actEl.dataset.view);
      return;
    }
    if (act === 'trade-next') {
      setTradeStep('give');
      return;
    }
    if (act === 'trade-back') {
      setTradeStep('want');
      return;
    }
    if (act === 'trade-dec') {
      changeTrade(actEl.dataset.side, actEl.dataset.key, -1);
      return;
    }
    if (act === 'trade-inc') {
      changeTrade(actEl.dataset.side, actEl.dataset.key, 1);
      return;
    }
    if (act === 'trade-send') {
      sendTrade();
      return;
    }
    if (act === 'trade-withdraw') {
      withdrawTrade();
      return;
    }
    if (act === 'trade-new') {
      newTradeDraft();
      return;
    }
    if (act === 'exchange-pick') {
      doExchange(actEl.dataset.key);
      return;
    }
    if (act === 'end-confirm') {
      closePopover();
      showToast('已确认结束回合，等待 乙 开始（原型演示）');
      return;
    }
    if (act === 'zoom-in') {
      ui.zoom = Math.min(1.4, Math.round((ui.zoom + 0.12) * 100) / 100);
      applyZoom();
      return;
    }
    if (act === 'zoom-out') {
      ui.zoom = Math.max(0.88, Math.round((ui.zoom - 0.12) * 100) / 100);
      applyZoom();
      return;
    }
    if (act === 'zoom-reset') {
      ui.zoom = 1;
      applyZoom();
      return;
    }
  }

  document.addEventListener('click', onDocumentClick);

  document.addEventListener('input', (e) => {
    const range = e.target.closest?.('.tr-range');
    if (range) {
      setTradeRange(range.dataset.side, range.dataset.key, range.value);
      return;
    }
    const num = e.target.closest?.('.tr-num');
    if (num) setTradeNumber(num.dataset.side, num.dataset.key, num.value);
  });

  document.addEventListener('focusout', (e) => {
    const num = e.target.closest?.('.tr-num');
    if (!num || !ui.trade) return;
    const side = num.dataset.side;
    const key = num.dataset.key;
    num.value = String(ui.trade[side]?.[key] || 0);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (ui.build) {
        cancelBuild();
      } else if (ui.drawerOpen) {
        closeTrade();
      } else {
        closePopover();
      }
    }
  });

  // 地图悬停说明
  document.addEventListener('mousemove', (e) => {
    const tip = $('#tile-tip');
    if (!tip) return;
    if (ui.build || state.seven?.phase === 'robber') {
      tip.hidden = true;
      return;
    }
    const tileEl = e.target.closest?.('.btile');
    if (!tileEl) {
      tip.hidden = true;
      return;
    }
    const key = tileEl.dataset.terrain;
    const n = tileEl.dataset.number;
    const robber = tileEl.dataset.robber === '1';
    const label = TERRAIN[key] || '地块';
    const pipsN = n ? pips(Number(n)) : 0;
    tip.innerHTML = `<b>${label}${n ? ' · ' + n : ' · 无数字'}</b><span>${n ? '骰点 ' + n + ' · ' + '●'.repeat(pipsN) + '○'.repeat(Math.max(0, 5 - pipsN)) : '不产资源'}${robber ? ' · 强盗占据' : ''}</span>`;
    tip.hidden = false;
    const tw = tip.getBoundingClientRect().width;
    const th = tip.getBoundingClientRect().height;
    tip.style.left = `${clamp(e.clientX + 16, 10, window.innerWidth - tw - 10)}px`;
    tip.style.top = `${clamp(e.clientY - th - 14, 10, window.innerHeight - th - 10)}px`;
  });

  document.addEventListener('mouseleave', () => {
    const tip = $('#tile-tip');
    if (tip) tip.hidden = true;
  });

  window.addEventListener('resize', () => {
    closePopover();
    applyZoom();
  });

  // ———————————————————————————————— 初始化 ————————————————————————————————
  function init() {
    document.body.dataset.theme = THEME;
    $('#app').innerHTML = shell();
    renderAll();
    // 预置一条“日志已读”的视觉状态，避免新会话像空壳
    setTimeout(() => {
      const ev = $('#board-event');
      if (ev) ev.classList.add('arrive');
    }, 220);
    if (THEME === 'papercut') {
      const scenario = params.get('state');
      if (scenario === 'trade') {
        setTimeout(() => {
          openTrade();
          if (params.get('step') === 'give') ui.trade.step = 'give';
          if (params.get('tab') === 'offers') { ui.trade.view = 'offers'; ui.trade.unseen = 0; }
          renderDrawer();
        }, 120);
      } else if (scenario === 'robber') {
        enterSeven({ selected: { wood: 1, brick: 1, sheep: 1 }, silent: true });
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
