/** 两种海岛插画语言的 SVG 棋盘。所有坐标沿用 56px 六边形基准，再整体缩放。 */
(function () {
  const GEO = HexGeo.build([3, 4, 5, 4, 3]);
  const CENTER = { x: 520, y: 360 };
  const SCALE = 1.25;
  const ROWS = [3, 4, 5, 4, 3];

  const THEME = {
    folio: {
      sea: '#1B4E57',
      seaLight: '#4E9AA0',
      shallow: '#6FB6B6',
      sand: '#E4D0A4',
      sandEdge: '#8E7348',
      ink: '#2C2419',
      inkSoft: '#5B4A36',
      paper: '#F6EAD2',
      paperDeep: '#E8D5B2',
      accent: '#B3863F',
      hot: '#A94932',
      player: { a: '#B5432F', b: '#315C7C', c: '#C08A2E', d: '#4E7358' },
      terrain: {
        wood: { base: '#5F7D62', deep: '#354F3B', light: '#94AC82', motif: '#456A4D' },
        brick: { base: '#C07F5E', deep: '#8A4B32', light: '#E2B293', motif: '#9A573B' },
        sheep: { base: '#B2C77F', deep: '#7A9354', light: '#DCE8AD', motif: '#87A35E' },
        wheat: { base: '#DFB95B', deep: '#A87928', light: '#F4DC92', motif: '#B0862E' },
        ore: { base: '#8F9996', deep: '#515D5A', light: '#C3CBC6', motif: '#5C6864' },
        desert: { base: '#DECA9D', deep: '#A98B56', light: '#F1E2BE', motif: '#B4955F' },
      },
    },
    papercut: {
      sea: '#216F77',
      seaLight: '#57AEB0',
      shallow: '#9BDED3',
      sand: '#F2DCA9',
      sandEdge: '#C39A56',
      ink: '#23372F',
      inkSoft: '#516157',
      paper: '#FFF6E2',
      paperDeep: '#F2E3C6',
      accent: '#E9A93B',
      hot: '#D9654C',
      player: { a: '#C9503F', b: '#3B6FA0', c: '#B4741D', d: '#4C8B67' },
      terrain: {
        wood: { base: '#74A46B', deep: '#3F7A4B', light: '#B9D69A', motif: '#4B8858' },
        brick: { base: '#D07F57', deep: '#A24F32', light: '#EFAF86', motif: '#B9603E' },
        sheep: { base: '#ACCF7A', deep: '#78A34E', light: '#DCEBB5', motif: '#85AC58' },
        wheat: { base: '#E7BE57', deep: '#BA8628', light: '#F7DC8E', motif: '#C6912E' },
        ore: { base: '#98A6A5', deep: '#617577', light: '#CBD6D2', motif: '#6A7D7E' },
        desert: { base: '#EBD39D', deep: '#C29D5B', light: '#F8E7BE', motif: '#C6A464' },
      },
    },
  };

  const PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

  const r1 = (n) => Math.round(n * 10) / 10;
  function poly(t, scale = 1) {
    return HexGeo.cornersOf(t.x, t.y)
      .map((p) => `${r1(t.x + (p.x - t.x) * scale)},${r1(t.y + (p.y - t.y) * scale)}`)
      .join(' ');
  }

  // ———————————————————————————————— 资源图标 ————————————————————————————————
  function resourceIcon(key, theme, size = 24) {
    const T = THEME[theme];
    const c = T.terrain[key === 'wood' ? 'wood' : key === 'brick' ? 'brick' : key === 'sheep' ? 'sheep' : key === 'wheat' ? 'wheat' : 'ore'];
    if (theme === 'folio') {
      const ink = T.ink;
      const icon = {
        wood: `<g stroke="${ink}" stroke-width="1.4" stroke-linejoin="round">
          <rect x="3" y="8" width="16" height="7.5" rx="3.4" fill="${c.base}" transform="rotate(-8 11 12)"/>
          <ellipse cx="6.4" cy="11.1" rx="2.5" ry="3.3" fill="${c.light}" transform="rotate(-8 6.4 11.1)"/>
          <ellipse cx="6.4" cy="11.1" rx="1" ry="1.7" fill="none"/>
          <rect x="7" y="14.4" width="14" height="6" rx="3" fill="${c.deep}" transform="rotate(5 14 17)"/>
          <ellipse cx="9.1" cy="16.6" rx="2" ry="2.6" fill="${c.base}" transform="rotate(5 9.1 16.6)"/>
        </g>`,
        brick: `<g stroke="${ink}" stroke-width="1.4" stroke-linejoin="round">
          <rect x="3" y="11" width="9" height="6" rx="1" fill="${c.light}"/>
          <rect x="12" y="11" width="9" height="6" rx="1" fill="${c.base}"/>
          <rect x="7.5" y="5" width="9" height="6" rx="1" fill="${c.base}"/>
          <path d="M5.5 14h4M14.5 14h4M10 8h4" stroke="${c.deep}" stroke-width="1"/>
        </g>`,
        sheep: `<g stroke="${ink}" stroke-width="1.3" stroke-linejoin="round">
          <path d="M6 12c-2.6 0-3.5-2-2-3.5-1.2-2.4.8-4.3 3-3.6 1-2.3 4.2-2.3 5.2 0 2.7-.6 4 1.7 2.6 3.6 1.5 2-.4 4-2.6 3.7-1.5 2.2-4.5 1.7-5.2-.2Z" fill="#F7F0DC"/>
          <circle cx="17" cy="11" r="3.1" fill="${c.deep}"/>
          <circle cx="18" cy="10" r=".6" fill="${T.paper}"/>
          <path d="M8.5 15v3M14 15v3" stroke-width="1.6"/>
        </g>`,
        wheat: `<g stroke="${ink}" stroke-width="1.3" stroke-linecap="round" fill="none">
          <path d="M12 21V5"/>
          <path d="M12 8l-4-3M12 8l4-3M12 12l-4-3M12 12l4-3M12 16l-3.5-2.6M12 16l3.5-2.6"/>
          <path d="M12 5c-1.6-1.8-1.2-3.2.1-4 1.2 1 1.4 2.5-.1 4Z" fill="${c.base}"/>
        </g>`,
        ore: `<g stroke="${ink}" stroke-width="1.4" stroke-linejoin="round">
          <path d="M4 19 9 6l5 7 3-4 4 10Z" fill="${c.base}"/>
          <path d="M9 6l2 13M14 13l2 6" fill="none" stroke="${c.deep}"/>
          <path d="M9 6l-1.8 5 3.1 2.5L14 13" fill="${c.light}" stroke="none" opacity=".8"/>
        </g>`,
      }[key];
      return `<svg class="res-svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
    }
    const outline = T.ink;
    const icon = {
      wood: `<g stroke="${outline}" stroke-width="1.6" stroke-linejoin="round">
        <rect x="3" y="8.5" width="15" height="7" rx="3.2" fill="${c.base}" transform="rotate(-9 10.5 12)"/>
        <ellipse cx="6" cy="11.1" rx="2.3" ry="3" fill="${T.paper}" transform="rotate(-9 6 11.1)"/>
        <rect x="7" y="14.2" width="14" height="6.4" rx="3" fill="${c.deep}" transform="rotate(5 14 17.4)"/>
        <ellipse cx="9.3" cy="16.6" rx="2" ry="2.6" fill="${c.light}" transform="rotate(5 9.3 16.6)"/>
      </g>`,
      brick: `<g stroke="${outline}" stroke-width="1.6" stroke-linejoin="round">
        <rect x="2.5" y="11" width="9.5" height="6.4" rx="1.6" fill="${c.light}"/>
        <rect x="12" y="11" width="9.5" height="6.4" rx="1.6" fill="${c.base}"/>
        <rect x="7.2" y="4.6" width="9.5" height="6.4" rx="1.6" fill="${c.base}"/>
        <path d="M5 14.2h4M14.5 14.2h4M9.7 7.8h4" stroke="${c.deep}" stroke-width="1.1"/>
      </g>`,
      sheep: `<g stroke="${outline}" stroke-width="1.6" stroke-linejoin="round">
        <path d="M6 12.6c-3 0-4-2.2-2.2-3.8-1.2-2.6 1-4.6 3.4-3.8 1.1-2.5 4.6-2.4 5.6.1 2.9-.6 4.3 1.8 2.8 3.8 1.6 2.2-.4 4.3-2.8 3.9-1.6 2.5-4.9 1.9-5.6-.2Z" fill="${T.paper}"/>
        <circle cx="17.6" cy="11" r="3.4" fill="${c.deep}"/>
        <circle cx="18.6" cy="10" r=".7" fill="${T.paper}"/>
        <path d="M8.5 15.5v3M14 15.5v3" stroke-width="1.8"/>
      </g>`,
      wheat: `<g stroke="${outline}" stroke-width="1.6" stroke-linecap="round" fill="none">
        <path d="M12 21V5"/>
        <path d="M12 8.5 7.8 5.4M12 8.5l4.2-3.1M12 12.4l-4.2-3.1M12 12.4l4.2-3.1M12 16.2l-4-3M12 16.2l4-3"/>
        <path d="M12 5.2c-1.8-1.9-1.3-3.4.1-4.2 1.3 1.1 1.5 2.7-.1 4.2Z" fill="${c.base}"/>
      </g>`,
      ore: `<g stroke="${outline}" stroke-width="1.7" stroke-linejoin="round">
        <path d="M3.5 19.5 9 5.5l5.3 7.4 3-4 3.4 10.6Z" fill="${c.base}"/>
        <path d="M9 5.5 11.2 19M14.3 12.9l2 6.1" stroke="${c.deep}"/>
        <path d="M9 5.5 7.1 11l3.3 2.6 3.9-1.4" fill="${c.light}" stroke="none"/>
      </g>`,
    }[key];
    return `<svg class="res-svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
  }

  // ———————————————————————————————— 地块插画 A ————————————————————————————————
  function aTree(x, y, s, flip = 1) {
    const T = THEME.folio.terrain.wood;
    return `<g transform="translate(${x} ${y}) scale(${s * flip} ${s})">
      <ellipse cx="0" cy="9" rx="11" ry="2.8" fill="#2B3A2C" opacity=".18"/>
      <rect x="-1.15" y="5" width="2.3" height="5" fill="#5A4530"/>
      <path d="M0-22 8-8 4-9 11 6 -11 6 -4-9 -8-8Z" fill="${T.motif}" stroke="#2F3E31" stroke-width="1.15" stroke-linejoin="round"/>
      <path d="M0-22 4-13 0-10 -4-13Z" fill="${T.light}" opacity=".9"/>
      <path d="M-8 1 -3 0 M-6 5 -1 4 M3 1 8 0" stroke="#2F3E31" stroke-width=".8" opacity=".5"/>
    </g>`;
  }

  function aSheep(x, y, s, flip = 1) {
    return `<g transform="translate(${x} ${y}) scale(${s * flip} ${s})">
      <ellipse cx="0" cy="7" rx="12" ry="2.8" fill="#3C3A2C" opacity=".22"/>
      <path d="M-10 1c-4 0-4.6-4.2-1.2-5.2-1-4 4.2-5.6 6.8-3 2.6-2.6 7.8-1 6.8 3 3.4 1 2.8 5.2-1.2 5.2Z" fill="#FCF6E7" stroke="#5E5137" stroke-width="1.6"/>
      <circle cx="10.8" cy="0.5" r="4.3" fill="#3A2F22"/>
      <circle cx="12" cy="-0.7" r="1" fill="#FCF6E7"/>
      <path d="M-6 5v4.5M4 5v4.5" stroke="#3A2F22" stroke-width="2.1" stroke-linecap="round"/>
    </g>`;
  }

  function aWheat(x, y, s) {
    return `<g transform="translate(${x} ${y}) scale(${s})" stroke="#77541C" stroke-width="1.5" stroke-linecap="round" fill="none">
      <path d="M0 12V-13" stroke-width="1.8"/>
      <path d="M0-3 -4.5-7M0-3 4.5-7M0-8 -4.5-12M0-8 4.5-12M0-12 -3-15.5M0-12 3-15.5" stroke-width="1.8"/>
      <path d="M0-13c-1.5-1.5-1.1-2.8.1-3.6 1.1.9 1.2 2.2-.1 3.6Z" fill="${THEME.folio.terrain.wheat.base}"/>
    </g>`;
  }

  function aBrick(x, y, s) {
    const c = THEME.folio.terrain.brick;
    return `<g transform="translate(${x} ${y}) scale(${s})" stroke="#743D28" stroke-width="1.2" stroke-linejoin="round">
      <rect x="-10" y="1" width="9" height="6" rx="1" fill="${c.light}" transform="rotate(-7)"/>
      <rect x="1" y="2" width="9" height="6" rx="1" fill="${c.base}" transform="rotate(5)"/>
      <rect x="-4.5" y="-7" width="9" height="6" rx="1" fill="${c.base}" transform="rotate(-2)"/>
      <path d="M-7 .8v5M4 1.8v5M-1.5-6v5" stroke="${c.deep}" stroke-width=".9" opacity=".7"/>
    </g>`;
  }

  function aMountain(x, y, s) {
    const c = THEME.folio.terrain.ore;
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <path d="M-15 10 -2-13 12 10Z" fill="${c.base}" stroke="#333C3A" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M-2-13 -7.2-3.4 -2.5-5.2 1.6-3 -2-13Z" fill="#F2EAD8"/>
      <path d="M-9 3 -5 1 M-2 5 2 3 M5 7 8 5" stroke="#525B58" stroke-width=".9" opacity=".6"/>
      <path d="M6 10 14-3 22 10Z" fill="${c.deep}" stroke="#3A4240" stroke-width="1.1" stroke-linejoin="round"/>
      <path d="M14-3 10.8 3 14 1.5 16.3 3.4Z" fill="#E8E0D0"/>
    </g>`;
  }

  function aDune(x, y, w, s = 1) {
    return `<path d="M${x - w} ${y} q${w * 0.42} ${-7 * s} ${w * 0.84} 0 t${w * 0.84} 0" fill="none" stroke="#B0925C" stroke-width="1.2" opacity=".75"/>`;
  }

  function aTerrainDecor(t) {
    const c = THEME.folio.terrain[t.terrain];
    let g = '';
    if (t.terrain === 'wood') {
      g += `<ellipse cx="-20" cy="8" rx="24" ry="17" fill="${c.deep}" opacity=".22"/>`;
      g += `<path d="M-34 28q6-6 12 0M22 32q5-5 10 0M-6 33q4-4 8 0" stroke="${c.motif}" stroke-width="1.4" fill="none" opacity=".7"/>`;
      g += aTree(-27, -15, 1.02) + aTree(20, -25, 0.82, -1) + aTree(-20, 23, 0.76) + aTree(26, 14, 0.88) + aTree(2, -31, 0.62);
    } else if (t.terrain === 'sheep') {
      g += `<ellipse cx="0" cy="4" rx="36" ry="26" fill="${c.light}" opacity=".38"/>`;
      g += aSheep(-29, -18, 1.16) + aSheep(16, -29, 0.96, -1) + aSheep(24, 21, 1.06) + aSheep(-21, 26, 0.9, -1) + aSheep(0, -6, 0.74, -1);
      g += `<path d="M-34 12q4-6 8 0M29 8q4-6 8 0M-3 33q4-6 8 0" stroke="${c.motif}" stroke-width="1.4" fill="none" opacity=".75"/>`;
      g += `<circle cx="-32" cy="-25" r="2.1" fill="#D8A23C"/><circle cx="31" cy="28" r="1.8" fill="#D8A23C"/><circle cx="33" cy="-7" r="1.4" fill="#FAF3DF"/>`;
    } else if (t.terrain === 'wheat') {
      g += `<path d="M-35 25q17-11 35 0t35 0" fill="none" stroke="#A87C2A" stroke-width="1.5" opacity=".55"/>`;
      g += `<path d="M-35 33q17-11 35 0t35 0" fill="none" stroke="#A87C2A" stroke-width="1.3" opacity=".38"/>`;
      g += `<path d="M-35 17q17-10 35 0t35 0" fill="none" stroke="#E8CB7C" stroke-width="4" opacity=".35"/>`;
      g += aWheat(-28, -12, 1.18) + aWheat(22, -16, 1.04) + aWheat(-4, -30, 0.9) + aWheat(29, 19, 0.9) + aWheat(-26, 18, 0.84) + aWheat(8, 18, 0.68);
    } else if (t.terrain === 'brick') {
      g += `<ellipse cx="-8" cy="4" rx="33" ry="25" fill="${c.light}" opacity=".28"/>`;
      g += `<path d="M-35 29q7-6 14 0t14 0" stroke="#8C5138" stroke-width="1.4" fill="none" opacity=".5"/>`;
      g += aBrick(-27, -18, 1.12) + aBrick(17, 4, 1.02) + aBrick(-12, 24, 0.82) + aBrick(7, -23, 0.68);
    } else if (t.terrain === 'ore') {
      g += `<ellipse cx="0" cy="8" rx="35" ry="25" fill="${c.light}" opacity=".26"/>`;
      g += `<path d="M-34 30q6-5 12 0M20 30q5-4 10 0M-2 18l2-4 2 4Z" stroke="#515D5A" stroke-width="1.2" fill="none" opacity=".55"/>`;
      g += aMountain(-15, -9, 1.12) + aMountain(19, 9, 0.86) + aMountain(-27, 17, 0.64) + aMountain(4, 25, 0.5);
    } else {
      g += `<path d="M-35-4q10-8 20 0t20 0" fill="none" stroke="#B99A63" stroke-width="1.4" opacity=".75"/>`;
      g += aDune(0, 8, 32, 1.3) + aDune(2, 19, 30, 1.1) + aDune(-2, 30, 27, 0.9);
      g += `<g transform="translate(22 -12)" fill="#6E8A4A" stroke="#4E6434" stroke-width="1.35" stroke-linejoin="round">
        <rect x="-2.6" y="-14" width="5.2" height="22" rx="2.6"/>
        <path d="M-2.6-5-8-5q-2 0-2-2v-3M2.6-8 7-8q2 0 2 2v3" fill="none" stroke-width="3.3" stroke-linecap="round"/>
      </g>`;
      g += `<g transform="translate(-24 22) scale(.6)" fill="#7D9856" stroke="#4E6434" stroke-width="1.5" stroke-linejoin="round">
        <rect x="-2.4" y="-12" width="4.8" height="18" rx="2.4"/>
        <path d="M-2.4-2-7-2q-2 0-2-2v-2" fill="none" stroke-width="3" stroke-linecap="round"/>
      </g>`;
      g += `<ellipse cx="-8" cy="31" rx="7" ry="2.2" fill="#B99A63" opacity=".6"/><circle cx="29" cy="24" r="1.6" fill="#B99A63" opacity=".7"/>`;
    }
    return g;
  }

  // ———————————————————————————————— 地块插画 B ————————————————————————————————
  function bTree(x, y, s, flip = 1) {
    const c = THEME.papercut.terrain.wood;
    return `<g transform="translate(${x} ${y}) scale(${s * flip} ${s})" stroke="#274C34" stroke-width="1.35" stroke-linejoin="round">
      <ellipse cx="0" cy="10" rx="12" ry="3" fill="#1D4530" opacity=".2"/>
      <rect x="-1.8" y="3" width="3.6" height="8" rx="1.2" fill="#7A5331"/>
      <path d="M0-22C8-14 12-6 7-4H-7C-12-6-8-14 0-22Z" fill="${c.deep}"/>
      <path d="M0-17C6-10 8-3 4-1H-4C-8-3-6-10 0-17Z" fill="${c.motif}"/>
      <path d="M0-21C3-16 4-11 2-8 0-6-2-7-2-10-2-14-1-18 0-21Z" fill="${c.light}" opacity=".9"/>
    </g>`;
  }

  function bSheep(x, y, s, flip = 1) {
    const c = THEME.papercut.terrain.sheep;
    return `<g transform="translate(${x} ${y}) scale(${s * flip} ${s})" stroke="#2F4A36" stroke-width="2" stroke-linejoin="round">
      <ellipse cx="0" cy="7" rx="12" ry="2.9" fill="#33513E" opacity=".24"/>
      <path d="M-9 1c-4 0-4.5-4-1.2-5-1-4 4-5.2 6.4-2.8 2.4-2.5 7.4-1 6.5 2.8 3.3 1 2.8 5-1.2 5Z" fill="#FFF6DF"/>
      <circle cx="9.8" cy=".5" r="4" fill="#3B4A3C"/>
      <circle cx="11" cy="-.6" r="1.05" fill="#FFF8E7"/>
      <path d="M-5 5v4.5M4 5v4.5" stroke-width="2.1" stroke-linecap="round"/>
    </g>`;
  }

  function bWheat(x, y, s) {
    return `<g transform="translate(${x} ${y}) scale(${s})" stroke="#8E5E13" stroke-width="2" stroke-linecap="round" fill="none">
      <path d="M0 12V-12"/>
      <path d="M0-3 -5-7M0-3 5-7M0-8 -5-12M0-8 5-12M0-12 -3.5-15.5M0-12 3.5-15.5"/>
      <path d="M0-12c-2-1.8-1.5-3.3.1-4.2 1.5 1 1.6 2.5-.1 4.2Z" fill="${THEME.papercut.terrain.wheat.base}"/>
    </g>`;
  }

  function bBrickStack(x, y, s) {
    const c = THEME.papercut.terrain.brick;
    return `<g transform="translate(${x} ${y}) scale(${s})" stroke="#7F3C27" stroke-width="1.5" stroke-linejoin="round">
      <rect x="-10" y="1" width="9.5" height="6.4" rx="1.6" fill="${c.light}" transform="rotate(-6)"/>
      <rect x="1" y="2" width="9.5" height="6.4" rx="1.6" fill="${c.base}" transform="rotate(5)"/>
      <rect x="-4.5" y="-6.5" width="9.5" height="6.4" rx="1.6" fill="${c.base}" transform="rotate(-2)"/>
      <path d="M-7 .8v5M4 1.8v5M-1.5-5.5v5" stroke="${c.deep}" stroke-width="1.1"/>
    </g>`;
  }

  function bMountain(x, y, s) {
    const c = THEME.papercut.terrain.ore;
    return `<g transform="translate(${x} ${y}) scale(${s})" stroke="#3F5657" stroke-width="1.6" stroke-linejoin="round">
      <path d="M-16 11 -2-15 13 11Z" fill="${c.base}"/>
      <path d="M-2-15 -8-3 -3-5 1.8-2Z" fill="#F4EBD7"/>
      <path d="M-10 4-6 2M-2 7 2 5M5 9 9 7" stroke="${c.deep}" stroke-width="1.1"/>
      <path d="M6 11 15-4 24 11Z" fill="${c.deep}"/>
      <path d="M15-4 11.5 3 15 1.4 17.5 3.6Z" fill="#E8E0CF"/>
    </g>`;
  }

  function bTerrainDecor(t) {
    const c = THEME.papercut.terrain[t.terrain];
    let g = '';
    if (t.terrain === 'wood') {
      g += `<ellipse cx="-20" cy="8" rx="25" ry="17" fill="${c.deep}" opacity=".22"/>`;
      g += `<path d="M-35 31q5-6 10 0M19 33q5-6 10 0M-5 34q4-5 8 0" stroke="${c.motif}" stroke-width="1.8" fill="none" opacity=".7"/>`;
      g += bTree(-28, -15, 1.02) + bTree(20, -26, 0.82, -1) + bTree(-20, 23, 0.78) + bTree(27, 14, 0.9) + bTree(2, -32, 0.6);
    } else if (t.terrain === 'sheep') {
      g += `<ellipse cx="0" cy="4" rx="36" ry="27" fill="${c.light}" opacity=".42"/>`;
      g += bSheep(-29, -18, 1.2) + bSheep(15, -29, 1.0, -1) + bSheep(24, 21, 1.1) + bSheep(-21, 26, 0.94, -1) + bSheep(0, -6, 0.78, -1);
      g += `<circle cx="-33" cy="-25" r="2.5" fill="#F3C64B"/><circle cx="30" cy="27" r="2" fill="#F3C64B"/><circle cx="33" cy="-8" r="1.8" fill="#FFF8E7"/><circle cx="-6" cy="33" r="1.6" fill="#FFF8E7"/>`;
    } else if (t.terrain === 'wheat') {
      g += `<path d="M-36 24q18-11 36 0t36 0" fill="none" stroke="${c.deep}" stroke-width="1.8" opacity=".55"/>`;
      g += `<path d="M-36 32q18-11 36 0t36 0" fill="none" stroke="${c.deep}" stroke-width="1.6" opacity=".38"/>`;
      g += `<path d="M-36 16q18-10 36 0t36 0" fill="none" stroke="${c.light}" stroke-width="7" opacity=".55"/>`;
      g += bWheat(-28, -12, 1.18) + bWheat(22, -16, 1.04) + bWheat(-4, -31, 0.92) + bWheat(29, 19, 0.92) + bWheat(-26, 18, 0.86) + bWheat(8, 18, 0.7);
    } else if (t.terrain === 'brick') {
      g += `<path d="M-35 2q12-9 24-2t24 0" fill="none" stroke="${c.light}" stroke-width="10" stroke-linecap="round" opacity=".75"/>`;
      g += `<path d="M-35 2q12-9 24-2t24 0" fill="none" stroke="${c.deep}" stroke-width="1.6" opacity=".55"/>`;
      g += bBrickStack(-27, -18, 1.12) + bBrickStack(17, 4, 1.02) + bBrickStack(-12, 24, 0.84) + bBrickStack(7, -23, 0.68);
      g += `<path d="M-35 29q7-6 14 0t14 0" stroke="${c.deep}" stroke-width="1.5" fill="none" opacity=".4"/>`;
    } else if (t.terrain === 'ore') {
      g += `<ellipse cx="0" cy="8" rx="35" ry="25" fill="${c.light}" opacity=".3"/>`;
      g += bMountain(-15, -9, 1.12) + bMountain(19, 9, 0.88) + bMountain(-27, 17, 0.64) + bMountain(4, 26, 0.5);
      g += `<path d="M-34 31q6-5 12 0M20 30q5-4 10 0" stroke="${c.deep}" stroke-width="1.6" fill="none" opacity=".55"/>`;
    } else {
      g += `<path d="M-36-3q11-9 22 0t22 0" fill="none" stroke="${c.deep}" stroke-width="1.8" opacity=".6"/>`;
      g += `<path d="M-37 7q11-9 22 0t22 0" fill="none" stroke="${c.base}" stroke-width="9" opacity=".6"/>`;
      g += `<path d="M-35 18q11-8 22 0t22 0" fill="none" stroke="${c.deep}" stroke-width="1.6" opacity=".45"/>`;
      g += `<path d="M-34 29q11-8 22 0t22 0" fill="none" stroke="${c.light}" stroke-width="5" opacity=".5"/>`;
      g += `<g transform="translate(22 -12)" fill="#5B9162" stroke="#335C3B" stroke-width="1.8" stroke-linejoin="round">
        <rect x="-2.9" y="-14" width="5.8" height="22" rx="2.9"/>
        <path d="M-2.9-5-8-5q-2 0-2-2v-3M2.9-8 7-8q2 0 2 2v3" fill="none" stroke-width="3.4" stroke-linecap="round"/>
      </g>`;
      g += `<g transform="translate(-24 21) scale(.62)" fill="#79A57D" stroke="#335C3B" stroke-width="2" stroke-linejoin="round">
        <rect x="-2.6" y="-12" width="5.2" height="19" rx="2.6"/>
        <path d="M-2.6-2-7-2q-2 0-2-2v-2" fill="none" stroke-width="3" stroke-linecap="round"/>
      </g>`;
      g += `<ellipse cx="-9" cy="31" rx="8" ry="2.5" fill="${c.deep}" opacity=".35"/><circle cx="30" cy="24" r="2" fill="${c.deep}" opacity=".4"/>`;
    }
    return g;
  }

  // ———————————————————————————————— 数字 / 港口 / 棋子 ————————————————————————————————
  function numberToken(t, theme) {
    if (t.number === null) return '';
    const T = THEME[theme];
    const n = t.number;
    const hot = n === 6 || n === 8;
    const pips = PIPS[n] || 0;
    const rot = theme === 'folio' ? ((Number(t.u) * 13 + Number(t.row) * 7) % 5) - 2 : ((Number(t.u) * 9 + Number(t.row) * 5) % 3) - 1;
    if (theme === 'folio') {
      let g = `<g transform="translate(${t.x} ${t.y}) rotate(${rot})" class="token">`;
      g += `<circle cy="2.4" r="22.2" fill="#1F1A12" opacity=".25"/>`;
      g += `<circle r="22" fill="${hot ? '#F2DCC4' : T.paper}" stroke="${T.ink}" stroke-width="1.9"/>`;
      g += `<circle r="18" fill="none" stroke="${T.inkSoft}" stroke-width=".75" stroke-dasharray="1.2 3.2" opacity=".8"/>`;
      g += `<text y="1" text-anchor="middle" dominant-baseline="central" font-family="Georgia, 'Songti SC', serif" font-size="23" font-weight="700" fill="${hot ? T.hot : T.ink}">${n}</text>`;
      const tw = (pips - 1) * 4.9;
      for (let i = 0; i < pips; i++) {
        g += `<circle cx="${-tw / 2 + i * 4.9}" cy="14.6" r="1.55" fill="${hot ? T.hot : T.inkSoft}"/>`;
      }
      g += `<path d="M0-22v-2.5M22 0h2.5M0 22v2.5M-22 0h-2.5" stroke="${T.ink}" stroke-width="1" opacity=".45"/>`;
      g += `</g>`;
      return g;
    }
    let g = `<g transform="translate(${t.x} ${t.y}) rotate(${rot})" class="token">`;
    const rim = THEME.papercut.terrain[t.terrain].deep;
    g += `<circle cy="3.4" r="22.6" fill="#2D4A3C" opacity=".24"/>`;
    g += `<circle r="22.2" fill="${rim}" stroke="${T.ink}" stroke-width="2.3"/>`;
    g += `<circle r="18" fill="${hot ? '#FFE9D7' : T.paper}" stroke="${T.ink}" stroke-width="1.2"/>`;
    g += `<text y="0.5" text-anchor="middle" dominant-baseline="central" font-family="'Avenir Next', 'PingFang SC', sans-serif" font-size="23" font-weight="800" fill="${hot ? T.hot : T.ink}">${n}</text>`;
    const tw = (pips - 1) * 4.9;
    for (let i = 0; i < pips; i++) {
      g += `<circle cx="${-tw / 2 + i * 4.9}" cy="14.8" r="1.7" fill="${hot ? T.hot : T.inkSoft}"/>`;
    }
    g += `<path d="M-13-16a19 19 0 0 1 9-4" fill="none" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>`;
    g += `</g>`;
    return g;
  }

  function portMarkup(p, theme, idx) {
    const T = THEME[theme];
    const isSpecific = p.kind === 'specific';
    const label = isSpecific ? '2:1' : '3:1';
    const w = 66;
    const h = 26;
    const rot = theme === 'folio' ? ((idx % 2 ? 1 : -1) * (1.2 + (idx % 3) * 0.4)) : ((idx % 2 ? 1 : -1) * 2);
    let g = '';
    if (theme === 'folio') {
      g += `<line x1="${r1(p.mx + p.nx * 7)}" y1="${r1(p.my + p.ny * 7)}" x2="${r1(p.lx - p.nx * 30)}" y2="${r1(p.ly - p.ny * 14)}" stroke="${T.ink}" stroke-width="1.1" stroke-dasharray="3 3" opacity=".8"/>`;
      g += `<g transform="translate(${r1(p.lx)} ${r1(p.ly)}) rotate(${rot})">`;
      g += `<rect x="${-w / 2 + 1.4}" y="${-h / 2 + 2.4}" width="${w}" height="${h}" rx="3" fill="#1D1A13" opacity=".22"/>`;
      g += `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="3" fill="${T.paper}" stroke="${T.ink}" stroke-width="1.5"/>`;
      g += `<path d="M${-w / 2 + 5} ${h / 2 - 4}h${w - 10}" stroke="${T.ink}" stroke-width=".7" opacity=".35"/>`;
      if (isSpecific) {
        g += `<g transform="translate(${-w / 2 + 15} -1)" opacity=".95">${resourceIcon(p.resource, theme, 17)}</g>`;
        g += `<text x="8" y=".8" text-anchor="middle" dominant-baseline="central" font-family="Georgia, serif" font-size="13.5" font-weight="700" fill="${T.ink}">${label}</text>`;
      } else {
        g += `<path d="M${-w / 2 + 12} -4v8M${-w / 2 + 12} 4c-3 0-5-1.4-5-4M${-w / 2 + 12} 4c3 0 5-1.4 5-4" stroke="${T.ink}" stroke-width="1.1" fill="none" stroke-linecap="round"/>`;
        g += `<text x="7" y=".8" text-anchor="middle" dominant-baseline="central" font-family="Georgia, serif" font-size="13.5" font-weight="700" fill="${T.ink}">${label}</text>`;
      }
      g += `</g>`;
    } else {
      g += `<line x1="${r1(p.mx + p.nx * 7)}" y1="${r1(p.my + p.ny * 7)}" x2="${r1(p.lx - p.nx * 30)}" y2="${r1(p.ly - p.ny * 14)}" stroke="#8C6738" stroke-width="4" stroke-linecap="round"/>`;
      g += `<g transform="translate(${r1(p.lx)} ${r1(p.ly)}) rotate(${rot})">`;
      g += `<rect x="${-w / 2 + 1.5}" y="${-h / 2 + 3}" width="${w}" height="${h}" rx="7" fill="#2A4B3E" opacity=".22"/>`;
      g += `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="7" fill="${T.paper}" stroke="${T.ink}" stroke-width="2"/>`;
      g += `<path d="M${-w / 2 + 7} ${-h / 2 + 4}h${w - 14}" stroke="#FFFFFF" stroke-width="1.4" stroke-linecap="round" opacity=".5"/>`;
      if (isSpecific) {
        g += `<g transform="translate(${-w / 2 + 15} -1)">${resourceIcon(p.resource, theme, 18)}</g>`;
        g += `<text x="8" y=".8" text-anchor="middle" dominant-baseline="central" font-family="'Avenir Next', 'PingFang SC', sans-serif" font-size="13.5" font-weight="800" fill="${T.ink}">${label}</text>`;
      } else {
        g += `<circle cx="${-w / 2 + 12}" cy="0" r="7" fill="${T.accent}" stroke="${T.ink}" stroke-width="1.7"/>`;
        g += `<path d="M${-w / 2 + 12} -4v8M${-w / 2 + 12} 4c-2.8 0-4.4-1.4-4.4-3.6M${-w / 2 + 12} 4c2.8 0 4.4-1.4 4.4-3.6" stroke="${T.ink}" stroke-width="1.2" fill="none" stroke-linecap="round"/>`;
        g += `<text x="8" y=".8" text-anchor="middle" dominant-baseline="central" font-family="'Avenir Next', 'PingFang SC', sans-serif" font-size="13.5" font-weight="800" fill="${T.ink}">${label}</text>`;
      }
      g += `</g>`;
    }
    return g;
  }

  function aBuilding(x, y, color, city) {
    const ink = '#2C2419';
    const w = city ? 32 : 23;
    const h = city ? 18 : 13;
    const roofH = city ? 15 : 11;
    let g = `<g transform="translate(${r1(x)} ${r1(y)})">`;
    g += `<ellipse cx="0" cy="3.5" rx="${w * 0.66}" ry="4.4" fill="#17140F" opacity=".3"/>`;
    if (city) {
      g += `<rect x="${-w / 2 + 2}" y="${-h - roofH - 7}" width="7.5" height="${roofH + 8}" rx="1" fill="#EFE1C6" stroke="${ink}" stroke-width="1.8"/>`;
      g += `<path d="M${-w / 2 + 1} ${-h - roofH - 7} L${-w / 2 + 5.7} ${-h - roofH - 13} L${-w / 2 + 10.5} ${-h - roofH - 7}Z" fill="${color}" stroke="${ink}" stroke-width="1.7" stroke-linejoin="round"/>`;
    }
    g += `<rect x="${-w / 2}" y="${-h}" width="${w}" height="${h}" rx="1.6" fill="#F1E3C8" stroke="${ink}" stroke-width="2"/>`;
    g += `<path d="M${-w / 2 - 2} ${-h} L0 ${-h - roofH} L${w / 2 + 2} ${-h}Z" fill="${color}" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>`;
    g += `<rect x="${-2.2}" y="${-h * 0.55}" width="4.4" height="${h * 0.55}" rx=".8" fill="${ink}" opacity=".65"/>`;
    if (city) {
      g += `<path d="M${w / 2 - 11} ${-h - roofH + 1} L${w / 2 - 11} ${-h - roofH - 12} L${w / 2 - 2} ${-h - roofH - 12}" fill="none" stroke="${ink}" stroke-width="1.3"/>`;
      g += `<path d="M${w / 2 - 11} ${-h - roofH - 12} l7 2 -7 2.4Z" fill="${color}" stroke="${ink}" stroke-width="1" stroke-linejoin="round"/>`;
    } else {
      g += `<rect x="${w / 2 - 7}" y="${-h - roofH + 2}" width="3.2" height="5" fill="#8B6B4A" stroke="${ink}" stroke-width=".8"/>`;
    }
    g += `<path d="M${-w / 2 + 3} ${-h + 3}h${w - 6}" stroke="#FFFFFF" stroke-width="1.1" opacity=".35"/>`;
    g += `</g>`;
    return g;
  }

  function bBuilding(x, y, color, city, initial) {
    const ink = '#23372F';
    const w = city ? 34 : 24;
    const h = city ? 21 : 14;
    const roofH = city ? 13 : 10;
    let g = `<g transform="translate(${r1(x)} ${r1(y)})" stroke-linejoin="round">`;
    g += `<ellipse cx="0" cy="4" rx="${w * 0.7}" ry="5" fill="#1C392F" opacity=".28"/>`;
    if (city) {
      g += `<rect x="${-w / 2 + 1}" y="${-h - roofH - 9}" width="9" height="${roofH + 11}" rx="2.2" fill="${color}" stroke="${T_PAPER_STROKE}" stroke-width="3.6"/>`;
      g += `<rect x="${-w / 2 + 1}" y="${-h - roofH - 9}" width="9" height="${roofH + 11}" rx="2.2" fill="${color}" stroke="${ink}" stroke-width="1.8"/>`;
      g += `<path d="M${-w / 2} ${-h - roofH - 9} L${-w / 2 + 5.5} ${-h - roofH - 15} L${-w / 2 + 11} ${-h - roofH - 9}Z" fill="#FFF1D3" stroke="${ink}" stroke-width="1.8"/>`;
    }
    g += `<rect x="${-w / 2}" y="${-h}" width="${w}" height="${h}" rx="3" fill="${color}" stroke="#FFF3D8" stroke-width="3.8"/>`;
    g += `<rect x="${-w / 2}" y="${-h}" width="${w}" height="${h}" rx="3" fill="${color}" stroke="${ink}" stroke-width="2"/>`;
    g += `<path d="M${-w / 2 - 2.5} ${-h + 1} L0 ${-h - roofH} L${w / 2 + 2.5} ${-h + 1}Z" fill="#FFF1D3" stroke="${ink}" stroke-width="2.1"/>`;
    if (initial) {
      g += `<text x="0" y="${-h - roofH * 0.36}" text-anchor="middle" dominant-baseline="middle" font-family="'PingFang SC', 'Noto Sans SC', sans-serif" font-size="${city ? 8.2 : 7.2}" font-weight="700" fill="${ink}" opacity=".9">${initial}</text>`;
    }
    g += `<rect x="${-2.6}" y="${-h * 0.58}" width="5.2" height="${h * 0.58}" rx="1" fill="${ink}" opacity=".72"/>`;
    g += `<rect x="${-w / 2 + 4}" y="${-h + 3}" width="4.4" height="4.4" rx="1" fill="#FFF7E4" stroke="none" opacity=".9"/>`;
    if (city) {
      g += `<path d="M${w / 2 - 10} ${-h - roofH + 1} V${-h - roofH - 13}" stroke="${ink}" stroke-width="1.7"/>`;
      g += `<path d="M${w / 2 - 10} ${-h - roofH - 13} l8.5 2.3 -8.5 2.6Z" fill="${color}" stroke="${ink}" stroke-width="1.2"/>`;
    }
    g += `</g>`;
    return g;
  }
  const T_PAPER_STROKE = '#FFF3D8';

  function robberMarkup(t, theme) {
    const x = t.x - 22;
    const y = t.y + 21;
    if (theme === 'folio') {
      return `<g transform="translate(${x} ${y}) scale(1.05)" class="robber">
        <ellipse cx="0" cy="15" rx="12" ry="3.2" fill="#17130E" opacity=".35"/>
        <path d="M-10 14 -8 0Q-7-7 -3.5-8L-2.8-11A4.6 4.6 0 1 1 2.8-11L3.5-8Q7-7 8 0L10 14Z" fill="#211C16" stroke="#0D0A07" stroke-width="1.3" stroke-linejoin="round"/>
        <ellipse cx="0" cy="-14.6" rx="8.2" ry="2.3" fill="#100C08"/>
        <circle cx="-2" cy="-11.2" r="1" fill="#C8503F"/>
        <circle cx="2" cy="-11.2" r="1" fill="#C8503F"/>
        <path d="M-7 2 0 5 7 2" fill="none" stroke="#4A3D2F" stroke-width="1"/>
      </g>`;
    }
    return `<g transform="translate(${x} ${y}) scale(1.1)" class="robber">
      <ellipse cx="0" cy="15" rx="13" ry="3.6" fill="#1C392F" opacity=".32"/>
      <path d="M-9 14 -8 1C-8-4-5-7-3-8L-2.5-11A4.8 4.8 0 1 1 2.5-11L3-8C5-7 8-4 8 1L9 14Z" fill="#3B3328" stroke="#1D2923" stroke-width="2" stroke-linejoin="round"/>
      <path d="M-8.4 2Q0 6 8.4 2L8.8 5Q0 9 -8.8 5Z" fill="#D9654C" stroke="#1D2923" stroke-width="1.4"/>
      <ellipse cx="0" cy="-14" rx="8" ry="2.6" fill="#252F28"/>
      <circle cx="-2.2" cy="-11" r="1.2" fill="#FFF1D6"/>
      <circle cx="2.2" cy="-11" r="1.2" fill="#FFF1D6"/>
    </g>`;
  }

  // ———————————————————————————————— 海面装饰 ————————————————————————————————
  function seaDecor(theme) {
    const T = THEME[theme];
    let g = '';
    if (theme === 'folio') {
      const cx = 862;
      const cy = 152;
      g += `<g opacity=".34" stroke="${T.paper}" fill="none">`;
      g += `<circle cx="${cx}" cy="${cy}" r="54" stroke-width="1"/>`;
      g += `<circle cx="${cx}" cy="${cy}" r="46" stroke-width=".6" stroke-dasharray="2 4"/>`;
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI / 4) * i;
        const r0 = i % 2 ? 18 : 11;
        const r1 = i % 2 ? 42 : 52;
        g += `<path d="M${cx + Math.cos(a) * r0} ${cy + Math.sin(a) * r0} L${cx + Math.cos(a + 0.18) * r1} ${cy + Math.sin(a + 0.18) * r1} L${cx + Math.cos(a) * 30} ${cy + Math.sin(a) * 30}Z" fill="${i % 2 ? T.paper : 'none'}" opacity=".35"/>`;
      }
      g += `<circle cx="${cx}" cy="${cy}" r="3.4" fill="${T.paper}" stroke="none"/>`;
      g += `<text x="${cx}" y="${cy + 78}" text-anchor="middle" font-family="Georgia, serif" font-size="10" letter-spacing="3" fill="${T.paper}">N</text>`;
      g += `</g>`;
      g += `<g opacity=".16" stroke="${T.paper}" stroke-width=".8">`;
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI / 5) * i + 0.16;
        g += `<line x1="${cx}" y1="${cy}" x2="${cx + Math.cos(a) * 760}" y2="${cy + Math.sin(a) * 760}"/>`;
      }
      g += `</g>`;
      g += `<g opacity=".24" stroke="${T.paper}" fill="none" stroke-width="1.15" stroke-linecap="round">`;
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 10; col++) {
          const x = 32 + col * 108 + (row % 2) * 34;
          const y = 555 + row * 16 + (col % 3) * 4;
          if (y > 690) continue;
          g += `<path d="M${x} ${y}q5-4 10 0t10 0"/>`;
        }
      }
      for (let i = 0; i < 7; i++) {
        const x = 69 + i * 143;
        g += `<path d="M${x} 598q5-4 10 0t10 0" opacity=".7"/>`;
      }
      g += `</g>`;
      g += `<g transform="translate(882 548)" opacity=".5">`;
      g += `<path d="M-22 8Q0 13 24 8L17 15H-15Z" fill="${T.ink}" stroke="${T.paper}" stroke-width="1"/>`;
      g += `<path d="M-3 8V-26L18 2Z" fill="${T.paper}" stroke="${T.ink}" stroke-width="1.2" stroke-linejoin="round"/>`;
      g += `<path d="M-3 8V-20L-13 5Z" fill="${T.paper}" opacity=".75" stroke="${T.ink}" stroke-width="1"/>`;
      g += `<path d="M-3-26 0-31 3-26Z" fill="${T.accent}"/>`;
      g += `</g>`;
      g += `<text x="984" y="676" text-anchor="end" font-family="Georgia, serif" font-size="10" letter-spacing="2" fill="${T.paper}" opacity=".55">24°N · 118°E · CHART 07</text>`;
    } else {
      // 纸雕太阳：不抢棋盘，只负责把右上角的海面点亮
      g += `<g transform="translate(884 136)" opacity=".46">`;
      g += `<circle r="54" fill="#FFE4A6" stroke="#F0BF58" stroke-width="2.4"/>`;
      g += `<circle r="41" fill="#FFF2CC" opacity=".9"/>`;
      g += `<circle r="32" fill="none" stroke="#F5CE75" stroke-width="1.5" stroke-dasharray="3 5" opacity=".75"/>`;
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI / 4) * i;
        g += `<line x1="${Math.cos(a) * 64}" y1="${Math.sin(a) * 64}" x2="${Math.cos(a) * 79}" y2="${Math.sin(a) * 79}" stroke="#F6C85F" stroke-width="4.2" stroke-linecap="round"/>`;
      }
      g += `</g>`;
      g += `<g opacity=".44" stroke="#E7FBF4" fill="none" stroke-width="2.1" stroke-linecap="round">`;
      for (let row = 0; row < 9; row++) {
        for (let col = 0; col < 12; col++) {
          const x = 18 + col * 90 + (row % 2) * 28;
          const y = 62 + row * 72;
          if (x > 1020 || y > 690) continue;
          g += `<path d="M${x} ${y}q6-5 12 0t12 0" opacity="${0.5 + (col % 3) * 0.15}"/>`;
        }
      }
      g += `</g>`;
      g += `<g transform="translate(850 512)" opacity=".92">`;
      g += `<ellipse cx="0" cy="17" rx="34" ry="5" fill="#174A4E" opacity=".25"/>`;
      g += `<path d="M-30 6Q0 14 32 6L24 18H-22Z" fill="#E9B24A" stroke="#2B4A3C" stroke-width="2.2" stroke-linejoin="round"/>`;
      g += `<path d="M-2 5V-36L27 -3Z" fill="#FFF6E2" stroke="#2B4A3C" stroke-width="2.2" stroke-linejoin="round"/>`;
      g += `<path d="M-2 5V-28L-19 -1Z" fill="#F4E1BC" stroke="#2B4A3C" stroke-width="2"/>`;
      g += `<path d="M-2-36 1.5-42 5-36Z" fill="#D9654C" stroke="#2B4A3C" stroke-width="1.2"/>`;
      g += `<path d="M-14 10H-4M4 10h11" stroke="#2B4A3C" stroke-width="1.2" opacity=".5"/>`;
      g += `</g>`;
      g += `<g transform="translate(146 168)" stroke="#25554D" stroke-width="2.6" fill="none" stroke-linecap="round" opacity=".65">`;
      g += `<path d="M0 0q7-8 14 0M20 12q6-7 12 0"/>`;
      g += `</g>`;
      g += `<g transform="translate(210 110)" stroke="#25554D" stroke-width="2" fill="none" stroke-linecap="round" opacity=".45">`;
      g += `<path d="M0 0q5-6 10 0"/>`;
      g += `</g>`;
      g += `<text x="980" y="676" text-anchor="end" font-family="'Avenir Next', 'PingFang SC', sans-serif" font-size="10" font-weight="700" letter-spacing="2" fill="#0F4B50" opacity=".55">海岬群岛 · 19 格 · 9 港</text>`;
    }
    return g;
  }

  // ———————————————————————————————— 组装 ————————————————————————————————
  function render(svg, state, theme, overlay) {
    const T = THEME[theme];
    const geo = GEO;
    // 视图数据只带 (u,row)，这里补回与引擎一致的像素坐标
    const SQRT3 = Math.sqrt(3);
    for (const t of state.tiles) {
      t.x = (HexGeo.HEX_SIZE * SQRT3 * t.u) / 2;
      t.y = HexGeo.HEX_SIZE * 1.5 * (t.row - 2);
    }
    const depth = theme === 'folio' ? 1 : 1;
    const portList = HexGeo.ports(geo, state.portPlan);

    // 顶点落子
    const buildingMap = new Map();
    for (const b of state.buildings) {
      const v = HexGeo.nearestVertex(geo, b.x, b.y);
      if (!v || buildingMap.has(v.key)) continue;
      buildingMap.set(v.key, { ...b, v });
    }

    // 道路：沿真实边 BFS；同一条边不被重复占用
    const usedEdges = new Set();
    const roads = [];
    for (const chain of state.roadChains) {
      const points = chain.points.map(([x, y]) => HexGeo.nearestVertex(geo, x, y));
      for (let i = 0; i < points.length - 1; i++) {
        const path = HexGeo.shortestVertexPath(geo, points[i].key, points[i + 1].key);
        if (!path) continue;
        for (let j = 0; j < path.length - 1; j++) {
          const a = path[j];
          const b = path[j + 1];
          const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (usedEdges.has(ek)) continue;
          usedEdges.add(ek);
          const va = geo.vertices[a];
          const vb = geo.vertices[b];
          roads.push({ player: chain.player, a: va, b: vb, key: ek });
        }
      }
    }

    const tileIndex = new Map(state.tiles.map((t, i) => [t.key, i]));
    const dots = [];
    for (let i = 0; i < 70; i++) {
      const x = (i * 83 + 37) % 1010 + 15;
      const y = (i * 57 + 61) % 680 + 12;
      dots.push([x, y, (i % 3) * 0.4 + 0.6]);
    }

    const parts = [];
    parts.push(`<defs>
      <filter id="soft-a" x="-80%" y="-80%" width="260%" height="260%">
        <feDropShadow dx="0" dy="2.4" stdDeviation="2" flood-color="#1D1810" flood-opacity=".32"/>
      </filter>
      <filter id="island-a" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="13" stdDeviation="14" flood-color="#04191E" flood-opacity=".5"/>
      </filter>
      <filter id="wc" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="7"/>
      </filter>
      <filter id="soft-b" x="-60%" y="-60%" width="220%" height="220%">
        <feDropShadow dx="0" dy="4" stdDeviation="3.4" flood-color="#173E35" flood-opacity=".28"/>
      </filter>
      <filter id="island-b" x="-35%" y="-35%" width="170%" height="170%">
        <feDropShadow dx="0" dy="16" stdDeviation="16" flood-color="#063E42" flood-opacity=".42"/>
      </filter>
      <pattern id="grain-a" width="13" height="13" patternUnits="userSpaceOnUse">
        <circle cx="2.4" cy="3.1" r=".85" fill="#3B2E1C" opacity=".16"/>
        <circle cx="8.8" cy="9.6" r=".65" fill="#FFF9E8" opacity=".22"/>
        <path d="M11 2.2l2.2-.7" stroke="#6B5438" stroke-width=".5" opacity=".18"/>
      </pattern>
      <pattern id="grain-b" width="11" height="11" patternUnits="userSpaceOnUse">
        <circle cx="2.2" cy="2.8" r=".75" fill="#FFFFFF" opacity=".3"/>
        <circle cx="7.5" cy="8.2" r=".55" fill="#21463B" opacity=".14"/>
        <path d="M8.5 2.2l1.8.4" stroke="#FFFFFF" stroke-width=".55" opacity=".25"/>
      </pattern>
      <radialGradient id="vignette-a" cx="50%" cy="50%" r="62%">
        <stop offset="50%" stop-color="#000000" stop-opacity="0"/>
        <stop offset="100%" stop-color="#2C2419" stop-opacity=".24"/>
      </radialGradient>
      ${state.tiles.map((t, i) => `<clipPath id="tile-clip-${i}"><polygon points="${poly(t, 0.998)}"/></clipPath>`).join('')}
    </defs>`);

    // 海面装饰（屏幕坐标，不随棋盘缩放）
    parts.push(`<g data-layer="sea">${seaDecor(theme)}</g>`);
    parts.push(`<g id="board-zoom" class="board-zoom">`);
    parts.push(`<g transform="translate(${CENTER.x} ${CENTER.y}) scale(${SCALE})">`);

    // 海面浅滩 + 沙底
    if (theme === 'folio') {
      parts.push(`<g opacity=".26" filter="url(#wc)">`);
      for (const t of state.tiles) {
        parts.push(`<polygon points="${poly(t, 1.34)}" fill="${T.shallow}"/>`);
      }
      parts.push(`</g>`);
      parts.push(`<g opacity=".35" fill="none" stroke="${T.paper}" stroke-width=".8" stroke-dasharray="2 7">`);
      for (const t of state.tiles) {
        parts.push(`<polygon points="${poly(t, 1.24)}"/>`);
      }
      parts.push(`</g>`);
      parts.push(`<g filter="url(#island-a)">`);
      for (const t of state.tiles) {
        parts.push(`<polygon points="${poly(t, 1.155)}" fill="${T.sand}" stroke="${T.sandEdge}" stroke-width="1.1" stroke-linejoin="round"/>`);
      }
      parts.push(`</g>`);
    } else {
      parts.push(`<g opacity=".42" filter="url(#wc)">`);
      for (const t of state.tiles) {
        parts.push(`<polygon points="${poly(t, 1.28)}" fill="${T.shallow}"/>`);
      }
      parts.push(`</g>`);
      parts.push(`<g filter="url(#island-b)">`);
      for (const t of state.tiles) {
        parts.push(`<polygon points="${poly(t, 1.15)}" fill="${T.sand}" stroke="${T.sandEdge}" stroke-width="1.6" stroke-linejoin="round"/>`);
      }
      parts.push(`</g>`);
    }

    // 地块
    parts.push(`<g data-layer="tiles">`);
    for (const t of state.tiles) {
      const i = tileIndex.get(t.key);
      const c = T.terrain[t.terrain];
      const pts = poly(t, 0.998);
      const isRobber = t.key === state.robberTile;
      parts.push(`<g class="btile" data-tile="${t.key}" data-terrain="${t.terrain}" data-number="${t.number ?? ''}" data-robber="${isRobber ? '1' : '0'}">`);
      if (theme === 'folio') {
        parts.push(`<polygon points="${pts}" fill="${c.base}"/>`);
        parts.push(`<g clip-path="url(#tile-clip-${i})">`);
        parts.push(`<ellipse cx="${t.x - 19}" cy="${t.y - 24}" rx="40" ry="32" fill="${c.light}" opacity=".28" filter="url(#wc)"/>`);
        parts.push(`<ellipse cx="${t.x + 24}" cy="${t.y + 22}" rx="34" ry="26" fill="${c.deep}" opacity=".15" filter="url(#wc)"/>`);
        parts.push(`<g transform="translate(${t.x} ${t.y})">${aTerrainDecor(t)}</g>`);
        parts.push(`<rect x="${t.x - 58}" y="${t.y - 58}" width="116" height="116" fill="url(#grain-a)" opacity=".55"/>`);
        parts.push(`<polygon points="${poly(t, 0.998)}" fill="url(#vignette-a)" opacity=".5"/>`);
        if (isRobber) parts.push(`<polygon points="${poly(t, 0.98)}" fill="#1A1710" opacity=".12"/>`);
        parts.push(`</g>`);
        parts.push(`<polygon points="${pts}" fill="none" stroke="${T.ink}" stroke-width="1.75" stroke-linejoin="round"/>`);
        parts.push(`<polygon points="${poly(t, 0.9)}" fill="none" stroke="${T.paper}" stroke-width=".65" opacity=".3" stroke-linejoin="round"/>`);
      } else {
        parts.push(`<polygon points="${pts}" fill="${c.base}"/>`);
        parts.push(`<g clip-path="url(#tile-clip-${i})">`);
        parts.push(`<path d="M${t.x - 58} ${t.y - 58}h116v62q-58 16-116 0Z" fill="${c.light}" opacity=".33"/>`);
        parts.push(`<g transform="translate(${t.x} ${t.y})">${bTerrainDecor(t)}</g>`);
        parts.push(`<rect x="${t.x - 58}" y="${t.y - 58}" width="116" height="116" fill="url(#grain-b)" opacity=".5"/>`);
        if (isRobber) parts.push(`<polygon points="${poly(t, 0.98)}" fill="#17362E" opacity=".12"/>`);
        parts.push(`</g>`);
        parts.push(`<polygon points="${pts}" fill="none" stroke="${T.ink}" stroke-width="2.4" stroke-linejoin="round"/>`);
        parts.push(`<polygon points="${poly(t, 0.94)}" fill="none" stroke="#FFF8E8" stroke-width=".85" opacity=".4" stroke-linejoin="round"/>`);
      }
      parts.push(`</g>`);
    }
    parts.push(`</g>`);

    // 港口
    parts.push(`<g data-layer="ports">`);
    portList.forEach((p, i) => parts.push(portMarkup(p, theme, i)));
    parts.push(`</g>`);

    // 道路
    parts.push(`<g data-layer="roads">`);
    for (const r of roads) {
      const color = T.player[['a', 'b', 'c', 'd'][r.player]];
      if (theme === 'folio') {
        parts.push(`<g class="road" data-player="${r.player}">
          <line x1="${r1(r.a.x)}" y1="${r1(r.a.y + 1.8)}" x2="${r1(r.b.x)}" y2="${r1(r.b.y + 1.8)}" stroke="#1C1710" stroke-width="8.2" stroke-linecap="round" opacity=".26"/>
          <line x1="${r1(r.a.x)}" y1="${r1(r.a.y)}" x2="${r1(r.b.x)}" y2="${r1(r.b.y)}" stroke="${T.ink}" stroke-width="7" stroke-linecap="round"/>
          <line x1="${r1(r.a.x)}" y1="${r1(r.a.y)}" x2="${r1(r.b.x)}" y2="${r1(r.b.y)}" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
          <line x1="${r1(r.a.x)}" y1="${r1(r.a.y - 1)}" x2="${r1(r.b.x)}" y2="${r1(r.b.y - 1)}" stroke="${T.paper}" stroke-width="1.1" stroke-linecap="round" opacity=".45" stroke-dasharray="5 7"/>
        </g>`);
      } else {
        parts.push(`<g class="road" data-player="${r.player}">
          <line x1="${r1(r.a.x)}" y1="${r1(r.a.y + 3)}" x2="${r1(r.b.x)}" y2="${r1(r.b.y + 3)}" stroke="#18392F" stroke-width="11.6" stroke-linecap="round" opacity=".3"/>
          <line x1="${r1(r.a.x)}" y1="${r1(r.a.y)}" x2="${r1(r.b.x)}" y2="${r1(r.b.y)}" stroke="#FFF3D8" stroke-width="10.4" stroke-linecap="round"/>
          <line x1="${r1(r.a.x)}" y1="${r1(r.a.y)}" x2="${r1(r.b.x)}" y2="${r1(r.b.y)}" stroke="${T.ink}" stroke-width="8.2" stroke-linecap="round"/>
          <line x1="${r1(r.a.x)}" y1="${r1(r.a.y)}" x2="${r1(r.b.x)}" y2="${r1(r.b.y)}" stroke="${color}" stroke-width="5.4" stroke-linecap="round"/>
          <line x1="${r1(r.a.x)}" y1="${r1(r.a.y - 1.2)}" x2="${r1(r.b.x)}" y2="${r1(r.b.y - 1.2)}" stroke="#FFFFFF" stroke-width="1.35" stroke-linecap="round" opacity=".62" stroke-dasharray="${['0', '3 4', '0.5 4', '6 3'][r.player]}"/>
        </g>`);
      }
    }
    parts.push(`</g>`);

    // 建筑
    parts.push(`<g data-layer="buildings">`);
    for (const b of buildingMap.values()) {
      const color = T.player[['a', 'b', 'c', 'd'][b.player]];
      parts.push(theme === 'folio' ? aBuilding(b.v.x, b.v.y, color, b.city) : bBuilding(b.v.x, b.v.y, color, b.city, state.players[b.player].name));
    }
    parts.push(`</g>`);

    // 强盗
    const robberTile = state.tiles.find((t) => t.key === state.robberTile);
    if (robberTile) parts.push(robberMarkup(robberTile, theme));

    // 数字片压在最上层，避免插画干扰读取
    parts.push(`<g data-layer="numbers">`);
    for (const t of state.tiles) parts.push(numberToken(t, theme));
    parts.push(`</g>`);

    // 建造热区：只做视觉提示与点击命中，合法性最终由规则层决定
    if (overlay && overlay.type) {
      parts.push(`<g data-layer="overlay" class="build-overlay">`);
      if (overlay.type === 'robber') {
        for (const key of overlay.tiles || []) {
          const t = geo.tiles[key];
          if (!t) continue;
          parts.push(`<g class="ov-hit ov-tile" data-tile="${key}" role="button" aria-label="可放置强盗的地块">
            <polygon points="${poly(t, 0.99)}" fill="transparent" stroke="transparent" stroke-width="2"/>
            <polygon points="${poly(t, 0.94)}" fill="${T.accent}" fill-opacity=".055" stroke="${T.accent}" stroke-width="2.2" stroke-dasharray="8 6" stroke-linejoin="round"/>
            <g transform="translate(${t.x + 31} ${t.y - 33})">
              <path d="M0 9C0 9-7 1.5-7-3a7 7 0 1 1 14 0C7 1.5 0 9 0 9Z" fill="${T.accent}" stroke="${T.ink}" stroke-width="1.5" stroke-linejoin="round"/>
              <circle cx="0" cy="-3" r="2.5" fill="#FFF6DA"/>
            </g>
          </g>`);
        }
      } else if (overlay.type === 'road') {
        for (const ek of overlay.edges || []) {
          const e = geo.edges[ek];
          if (!e) continue;
          const a = geo.vertices[e.a];
          const b = geo.vertices[e.b];
          const picked = overlay.selected === ek;
          parts.push(`<g class="ov-hit${picked ? ' picked' : ''}" data-edge="${ek}" role="button" aria-label="可建造道路的位置">
            <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="transparent" stroke-width="22" stroke-linecap="round"/>
            <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${T.ink}" stroke-width="${picked ? 10 : 7.5}" stroke-linecap="round" opacity="${picked ? '.5' : '.34'}"/>
            <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#FFF6DA" stroke-width="${picked ? 12 : 9}" stroke-linecap="round" opacity="${picked ? '.95' : '.75'}"/>
            <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${T.accent}" stroke-width="${picked ? 6.2 : 4.6}" stroke-linecap="round" stroke-dasharray="${picked ? '0' : '7 5'}"/>
            <g transform="translate(${(a.x+b.x)/2} ${(a.y+b.y)/2})">
              <circle r="${picked ? 10 : 8}" fill="${picked ? T.accent : '#FFF6DA'}" stroke="${T.ink}" stroke-width="1.5"/>
              ${picked
                ? `<path d="M-4 0.5 -1 3.5 4.5 -3" fill="none" stroke="${T.ink}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
                : `<path d="M-3.2 0h6.4M0-3.2v6.4" stroke="${T.ink}" stroke-width="1.6" stroke-linecap="round"/>`}
            </g>
          </g>`);
        }
      } else {
        for (const vk of overlay.vertices || []) {
          const v = geo.vertices[vk];
          if (!v) continue;
          const picked = overlay.selected === vk;
          parts.push(`<g class="ov-hit${picked ? ' picked' : ''}" data-vertex="${vk}" role="button" aria-label="可建造村庄的位置">
            <circle cx="${v.x}" cy="${v.y}" r="20" fill="transparent"/>
            <circle cx="${v.x}" cy="${v.y}" r="${picked ? 16 : 11}" fill="#FFF6DA" fill-opacity="${picked ? '.98' : '.8'}" stroke="${picked ? T.accent : '#8A6428'}" stroke-width="${picked ? 4 : 2.6}" stroke-dasharray="${picked ? '0' : '3 3'}"/>
            <circle cx="${v.x}" cy="${v.y}" r="${picked ? 22 : 18}" fill="none" stroke="${T.accent}" stroke-width="1.8" opacity="${picked ? '.95' : '.55'}"/>
            <path d="M${v.x - 4} ${v.y}h8M${v.x} ${v.y - 4}v8" stroke="${T.ink}" stroke-width="1.8" stroke-linecap="round" opacity=".8"/>
          </g>`);
        }
      }
      parts.push(`</g>`);
    }

    parts.push(`</g></g>`);
    svg.setAttribute('viewBox', `0 0 1040 720`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '海岬群岛棋盘：19 块地形、9 个港口，强盗位于北岸 6 号田');
    svg.innerHTML = parts.join('');
    const roadEdges = new Map(roads.map((r) => [r.key, r.player]));
    const buildingVertices = new Map();
    for (const b of buildingMap.values()) buildingVertices.set(b.v.key, { player: b.player, city: b.city });
    return { center: CENTER, scale: SCALE, geo, theme, roadEdges, buildingVertices, portList };
  }

  window.Board = { render, resourceIcon, THEME };
})();
