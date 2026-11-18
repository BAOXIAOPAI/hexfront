/* CATAN classic rules engine. All mutation is validated here, on the server.
 * Rules: catan.com/understand-catan/game-rules (2025), base-game FAQ.
 * applyAction is transactional: it never mutates its input state.
 */
import { RULE_OPTIONS } from './rule-options.ts';

export const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  development: { sheep: 1, wheat: 1, ore: 1 },
};
const COLORS = ['#dc6148', '#51a8d4', '#ead9b5', '#dc9b40', '#72a474', '#a781c8'];
const emptyResources = () => Object.fromEntries(RESOURCES.map(r => [r, 0]));
const count = object => RESOURCES.reduce((sum, r) => sum + (object[r] || 0), 0);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const clone = value => structuredClone(value);
function random(rng) {
  if (rng) {
    const n = rng();
    assert(Number.isFinite(n) && n >= 0 && n < 1, '随机源返回无效数值');
    return n;
  }
  const data = new Uint32Array(1);
  globalThis.crypto.getRandomValues(data);
  return data[0] / 4294967296;
}
function shuffle(array, rng) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(random(rng) * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
function normalizeResources(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), '请选择资源');
  assert(Object.keys(value).every(key => RESOURCES.includes(key)), '存在未知资源');
  const result = emptyResources();
  for (const r of RESOURCES) {
    const n = value[r] ?? 0;
    assert(Number.isSafeInteger(n) && n >= 0, '资源数量必须为非负整数');
    result[r] = n;
  }
  return result;
}
const canPay = (player, cost) => RESOURCES.every(r => player.resources[r] >= (cost[r] || 0));
function transfer(source, destination, resources, state) {
  for (const r of RESOURCES) {
    // An infinite bank keeps its numeric supply marker unchanged. Player hands
    // still change normally, so card costs, stealing, and undo remain exact.
    if (!state?.options.infiniteBank || source !== state.bank) source[r] -= resources[r] || 0;
    if (!state?.options.infiniteBank || destination !== state.bank) destination[r] += resources[r] || 0;
  }
}
const bankHas = (state, resources) => state.options.infiniteBank || RESOURCES.every(r => state.bank[r] >= (resources[r] || 0));
const playerById = (state, id) => state.players.find(p => p.id === id);
const current = state => playerById(state, state.activePlayerId);
const vertexById = (state, id) => state.board.vertices.find(v => v.id === id);
const edgeById = (state, id) => state.board.edges.find(e => e.id === id);
const tileById = (state, id) => state.board.tiles.find(t => t.id === id);
const isTradeTurn = state => state.phase === 'actions' && state.turnKind !== 'special';
const domesticAllowed = state => isTradeTurn(state) && state.turnKind !== 'paired';
const isActionTurn = state => state.phase === 'actions';
const adjacency = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r)) === 1;

function makeBoard(expanded, rng) {
  const tiles = [];
  const radius = expanded ? 3 : 2;
  for (let r = -radius; r <= radius; r++) {
    const qMin = Math.max(-radius, -r - radius);
    const qMax = Math.min(expanded ? radius - 1 : radius, -r + (expanded ? radius - 1 : radius));
    for (let q = qMin; q <= qMax; q++) tiles.push({ id: tiles.length, q, r });
  }
  const quantities = expanded
    ? { wood: 6, brick: 5, sheep: 6, wheat: 6, ore: 5, desert: 2 }
    : { wood: 4, brick: 3, sheep: 4, wheat: 4, ore: 3, desert: 1 };
  const resources = shuffle(Object.entries(quantities).flatMap(([r, n]) => Array(n).fill(r)), rng);
  tiles.forEach((tile, i) => { tile.resource = resources[i]; tile.number = null; });
  // Official variable placement uses the lettered number discs in a spiral.
  // These are the number sequences printed on the classic/extension discs.
  const baseNumbers = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];
  const expandedNumbers = [2, 5, 4, 6, 3, 9, 8, 11, 11, 10, 6, 3, 8, 4, 8, 10, 11, 12, 10, 5, 4, 9, 5, 9, 12, 3, 2, 6];
  // The perimeter is walked counterclockwise, then the next inner perimeter.
  const remaining = new Set(tiles.map(t => t.id));
  const spiral = [];
  while (remaining.size) {
    const layer = tiles.filter(t => remaining.has(t.id) && tiles.filter(o => remaining.has(o.id) && adjacency(t, o)).length < 6);
    const cx = layer.reduce((n, t) => n + t.q + t.r / 2, 0) / layer.length;
    const cy = layer.reduce((n, t) => n + t.r, 0) / layer.length;
    layer.sort((a, b) => Math.atan2(a.r - cy, a.q + a.r / 2 - cx) - Math.atan2(b.r - cy, b.q + b.r / 2 - cx));
    const corner = layer.reduce((best, t, i) => t.q + t.r / 2 < layer[best].q + layer[best].r / 2 ? i : best, 0);
    for (const tile of [...layer.slice(corner), ...layer.slice(0, corner)]) { spiral.push(tile); remaining.delete(tile.id); }
  }
  let numberIndex = 0;
  for (const tile of spiral) if (tile.resource !== 'desert') tile.number = (expanded ? expandedNumbers : baseNumbers)[numberIndex++];
  const vertices = [], edges = [], vertexMap = new Map(), edgeMap = new Map();
  const hexSize = 64;
  for (const tile of tiles) {
    const cx = Math.sqrt(3) * (tile.q + tile.r / 2) * hexSize;
    const cy = 1.5 * tile.r * hexSize;
    tile.x = cx; tile.y = cy; tile.vertices = [];
    for (let i = 0; i < 6; i++) {
      const angle = (30 + 60 * i) * Math.PI / 180;
      const x = cx + hexSize * Math.cos(angle), y = cy + hexSize * Math.sin(angle);
      const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)}`;
      let vertex = vertexMap.get(key);
      if (!vertex) {
        vertex = { id: `v${vertices.length}`, x, y, tiles: [], neighbors: [], owner: null, level: 0 };
        vertexMap.set(key, vertex); vertices.push(vertex);
      }
      vertex.tiles.push(tile.id); tile.vertices.push(vertex.id);
    }
    for (let i = 0; i < 6; i++) {
      const a = tile.vertices[i], b = tile.vertices[(i + 1) % 6];
      const key = [a, b].sort().join(':');
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = { id: `e${edges.length}`, a, b, owner: null, tiles: [] };
        edgeMap.set(key, edge); edges.push(edge);
        vertices.find(v => v.id === a).neighbors.push(b);
        vertices.find(v => v.id === b).neighbors.push(a);
      }
      edge.tiles.push(tile.id);
    }
  }
  const centerX = tiles.reduce((n, t) => n + t.x, 0) / tiles.length;
  const centerY = tiles.reduce((n, t) => n + t.y, 0) / tiles.length;
  const coast = edges.filter(e => e.tiles.length === 1).sort((a, b) => {
    const angle = e => {
      const va = vertices.find(v => v.id === e.a), vb = vertices.find(v => v.id === e.b);
      return Math.atan2((va.y + vb.y) / 2 - centerY, (va.x + vb.x) / 2 - centerX);
    };
    return angle(a) - angle(b);
  });
  const portResources = shuffle([...RESOURCES, ...Array(expanded ? 5 : 4).fill(null), ...(expanded ? ['sheep'] : [])], rng);
  const ports = portResources.map((resource, i) => {
    const edge = coast[Math.floor(i * coast.length / portResources.length)];
    return { id: `p${i}`, vertices: [edge.a, edge.b], resource, ratio: resource ? 2 : 3 };
  });
  return { tiles, vertices, edges, ports, hexSize, centerX, centerY };
}

export function newGame(players, options = {}) {
  assert(Array.isArray(players) && players.length >= 3 && players.length <= 6, '经典卡坦需要 3–6 位玩家');
  assert(new Set(players.map(p => p.id)).size === players.length && players.every(p => typeof p.id === 'string' && p.id), '玩家身份无效');
  const expanded = options.expanded ?? players.length > 4;
  assert(expanded ? players.length >= 5 : players.length <= 4, '3–4 人使用经典地图，5–6 人使用扩展地图');
  assert(!options.extensionRule || ['paired', 'special'].includes(options.extensionRule), '扩展规则无效');
  const rng = options.rng;
  const board = makeBoard(expanded, rng);
  const playerStates = players.map((p, i) => ({
    id: p.id, name: String(p.name || `玩家 ${i + 1}`).slice(0, 40), color: p.color || COLORS[i],
    resources: emptyResources(), development: [], playedKnights: 0, personalTurn: 0,
    usedDevelopment: false, points: 0, totalPoints: 0, longestRoadLength: 0,
  }));
  const developmentDeck = shuffle([
    ...Array(expanded ? 20 : 14).fill('knight'), ...Array(expanded ? 3 : 2).fill('roadBuilding'),
    ...Array(expanded ? 3 : 2).fill('yearOfPlenty'), ...Array(expanded ? 3 : 2).fill('monopoly'),
    ...Array(5).fill('victoryPoint'),
  ], rng);
  const firstPlayerIndex = options.firstPlayerIndex ?? Math.floor(random(rng) * players.length);
  assert(Number.isInteger(firstPlayerIndex) && firstPlayerIndex >= 0 && firstPlayerIndex < players.length, '起始玩家无效');
  const order = players.map((_, i) => (firstPlayerIndex + i) % players.length);
  const state = {
    version: 1, options: {
      expanded, extensionRule: options.extensionRule || 'paired', friendlyRobber: !!options.friendlyRobber,
      allowUndo: options.allowUndo !== false, mixedPortTrade: !!options.mixedPortTrade,
      infiniteBank: !!options.infiniteBank, flexibleRoll: !!options.flexibleRoll,
      allowGifts: !!options.allowGifts, roundUpDiscard: !!options.roundUpDiscard,
    },
    board, players: playerStates, bank: Object.fromEntries(RESOURCES.map(r => [r, expanded ? 24 : 19])),
    developmentDeck, developmentDiscard: [], robberTile: board.tiles.find(t => t.resource === 'desert').id,
    phase: 'setup_settlement', activePlayerId: players[firstPlayerIndex].id, mainPlayerIndex: firstPlayerIndex,
    turnKind: 'main', turn: 0, actionSequence: 0, dice: null, hasRolled: false, winner: null,
    setupOrder: [...order, ...order.toReversed()], setupStep: 0, setupVertexId: null,
    discardRequired: {}, tradeOffers: [], tradeResult: null, longestRoadHolder: null, largestArmyHolder: null,
    tableTrades: [], tableTradeResult: null, tableResetId: 0,
    // Room convenience rule, explicitly requested by the user; not a standard
    // CATAN take-back rule. This server-only history never reaches publicState.
    undoStack: [],
    log: [{ id: 0, text: '开始初始放置：每人两座村庄与两条道路。' }],
  };
  return state;
}

function remainingPieces(state, playerId) {
  return {
    roads: 15 - state.board.edges.filter(e => e.owner === playerId).length,
    settlements: 5 - state.board.vertices.filter(v => v.owner === playerId && v.level === 1).length,
    cities: 4 - state.board.vertices.filter(v => v.owner === playerId && v.level === 2).length,
  };
}
function legalSettlement(state, playerId, vertex, setup = false) {
  if (!vertex || vertex.owner || vertex.neighbors.some(id => vertexById(state, id).owner)) return false;
  if (remainingPieces(state, playerId).settlements <= 0) return false;
  return setup || state.board.edges.some(e => e.owner === playerId && (e.a === vertex.id || e.b === vertex.id));
}
function legalRoad(state, playerId, edge, setup = false) {
  if (!edge || edge.owner || remainingPieces(state, playerId).roads <= 0) return false;
  if (setup) return edge.a === state.setupVertexId || edge.b === state.setupVertexId;
  return [edge.a, edge.b].some(id => {
    const vertex = vertexById(state, id);
    if (vertex.owner) return vertex.owner === playerId;
    return state.board.edges.some(e => e.owner === playerId && (e.a === id || e.b === id));
  });
}
function longestRoad(state, playerId) {
  const roads = state.board.edges.filter(e => e.owner === playerId);
  const byVertex = new Map();
  for (const road of roads) for (const id of [road.a, road.b]) {
    if (!byVertex.has(id)) byVertex.set(id, []);
    byVertex.get(id).push(road);
  }
  let best = 0;
  const walk = (id, used, length) => {
    best = Math.max(best, length);
    const v = vertexById(state, id);
    if (length > 0 && v.owner && v.owner !== playerId) return;
    for (const road of byVertex.get(id) || []) if (!used.has(road.id)) {
      used.add(road.id); walk(road.a === id ? road.b : road.a, used, length + 1); used.delete(road.id);
    }
  };
  for (const id of byVertex.keys()) walk(id, new Set(), 0);
  return best;
}
function updateScores(state) {
  for (const p of state.players) p.longestRoadLength = longestRoad(state, p.id);
  const longest = Math.max(...state.players.map(p => p.longestRoadLength));
  const roadLeaders = state.players.filter(p => p.longestRoadLength === longest && longest >= 5);
  if (!roadLeaders.some(p => p.id === state.longestRoadHolder)) state.longestRoadHolder = roadLeaders.length === 1 ? roadLeaders[0].id : null;
  const mostKnights = Math.max(...state.players.map(p => p.playedKnights));
  const armyLeaders = state.players.filter(p => p.playedKnights === mostKnights && mostKnights >= 3);
  if (!armyLeaders.some(p => p.id === state.largestArmyHolder)) state.largestArmyHolder = armyLeaders.length === 1 ? armyLeaders[0].id : null;
  for (const p of state.players) {
    p.points = state.board.vertices.filter(v => v.owner === p.id).reduce((n, v) => n + v.level, 0)
      + (state.longestRoadHolder === p.id ? 2 : 0) + (state.largestArmyHolder === p.id ? 2 : 0);
    p.totalPoints = p.points + p.development.filter(c => c.type === 'victoryPoint').length;
  }
}
function log(state, text) {
  state.log.push({ id: state.actionSequence, text });
  if (state.log.length > 100) state.log = state.log.slice(-100);
}
function checkWinner(state) {
  updateScores(state);
  if (state.turnKind === 'special' || state.phase.startsWith('setup') || state.phase === 'finished') return;
  const p = current(state);
  if (p.totalPoints >= 10) {
    state.winner = p.id; state.phase = 'finished'; state.tradeOffers = []; state.tableTrades = [];
    if (state.ruleProposal?.status === 'pending') state.ruleProposal.status = 'withdrawn';
    log(state, `${p.name} 达到 ${p.totalPoints} 分，赢得胜利！`);
  }
}
function startPersonalTurn(state, index, kind, phase) {
  const p = state.players[index];
  state.activePlayerId = p.id; state.turnKind = kind; state.phase = phase;
  if (kind === 'main') {
    state.hasRolled = false;
    if (state.options.flexibleRoll) state.phase = 'actions';
  }
  if (kind !== 'special') { p.personalTurn++; p.usedDevelopment = false; }
  state.tradeOffers = []; state.tableTrades = [];
  checkWinner(state);
}
function nextMainTurn(state) {
  state.mainPlayerIndex = (state.mainPlayerIndex + 1) % state.players.length;
  state.turn++; state.dice = null;
  startPersonalTurn(state, state.mainPlayerIndex, 'main', 'roll');
}
function endTurn(state) {
  if (!state.options.expanded) return nextMainTurn(state);
  if (state.options.extensionRule === 'paired') {
    if (state.turnKind === 'main') startPersonalTurn(state, (state.mainPlayerIndex + 3) % state.players.length, 'paired', 'actions');
    else nextMainTurn(state);
  } else {
    if (state.turnKind === 'main') state.specialStep = 1;
    else state.specialStep++;
    if (state.specialStep >= state.players.length) { delete state.specialStep; nextMainTurn(state); }
    else startPersonalTurn(state, (state.mainPlayerIndex + state.specialStep) % state.players.length, 'special', 'actions');
  }
}
function pay(state, player, cost) {
  assert(canPay(player, cost), '资源不足');
  transfer(player.resources, state.bank, cost, state);
}
function bankRatios(state, playerId) {
  const ratios = Object.fromEntries(RESOURCES.map(r => [r, 4]));
  for (const port of state.board.ports) if (port.vertices.some(id => vertexById(state, id).owner === playerId)) {
    for (const r of RESOURCES) if (!port.resource || port.resource === r) ratios[r] = Math.min(ratios[r], port.ratio);
  }
  return ratios;
}
function validRobberTiles(state) {
  let tiles = state.board.tiles.filter(t => t.id !== state.robberTile);
  if (state.options.friendlyRobber) tiles = tiles.filter(t => t.resource === 'desert' || !state.board.vertices.some(v => v.tiles.includes(t.id) && v.owner && playerById(state, v.owner).points < 3));
  return tiles.map(t => t.id);
}
function robberTargets(state, playerId, tileId, withResources = false) {
  return [...new Set(state.board.vertices.filter(v => v.tiles.includes(tileId) && v.owner && v.owner !== playerId
    && (!state.options.friendlyRobber || playerById(state, v.owner).points >= 3)
    && (!withResources || count(playerById(state, v.owner).resources) > 0)).map(v => v.owner))];
}
function stealRobberResource(state, player, targetId, rng) {
  const target = playerById(state, targetId);
  const cards = RESOURCES.flatMap(r => Array(target.resources[r]).fill(r));
  if (cards.length) {
    const stolen = cards[Math.floor(random(rng) * cards.length)];
    transfer(target.resources, player.resources, { [stolen]: 1 });
    log(state, `${player.name} 从 ${target.name} 随机夺取了 1 张资源牌。`);
  } else log(state, `${target.name} 没有资源牌，${player.name} 未能夺取资源。`);
}
function resumeAfterRobber(state) {
  state.phase = state.resumePhase || 'actions'; delete state.resumePhase; delete state.stealTargets;
}
function beginRobber(state, resumePhase) {
  state.resumePhase = resumePhase; state.phase = 'robber';
  if (!validRobberTiles(state).length) resumeAfterRobber(state);
}
function produce(state, total) {
  const dues = Object.fromEntries(state.players.map(p => [p.id, emptyResources()]));
  for (const tile of state.board.tiles) if (tile.number === total && tile.id !== state.robberTile && tile.resource !== 'desert') {
    for (const v of state.board.vertices) if (v.owner && v.tiles.includes(tile.id)) dues[v.owner][tile.resource] += v.level;
  }
  for (const r of RESOURCES) {
    const receivers = state.players.filter(p => dues[p.id][r] > 0);
    const need = receivers.reduce((n, p) => n + dues[p.id][r], 0);
    if (!state.options.infiniteBank && need > state.bank[r] && receivers.length > 1) { log(state, `${r} 库存不足，本次该资源不发放。`); continue; }
    for (const p of receivers) transfer(state.bank, p.resources, {
      [r]: state.options.infiniteBank ? dues[p.id][r] : Math.min(dues[p.id][r], state.bank[r]),
    }, state);
  }
}

function resolveTrade(state, offer, recipientId, status) {
  if (status === 'declined' && !offer.to) {
    // A broadcast is a set of independent invitations. One recipient declining
    // must not withdraw the invitation from every other eligible player.
    offer.declinedBy = [...new Set([...(offer.declinedBy || []), recipientId])];
  } else state.tradeOffers = state.tradeOffers.filter(o => o.id !== offer.id);
  state.tradeResult = { id: `trade-result-${state.actionSequence}`, offerId: offer.id, from: offer.from, to: recipientId, status };
  // The same public result covers both a deliberate decline and an offer that
  // cannot be filled. It must not reveal whether either hand is insufficient.
  if (status === 'declined') log(state, '资源交换未达成');
  else log(state, '资源交换已完成');
}

function tableTradeVisible(trade, playerId) {
  return (trade.from === playerId || !trade.to || trade.to === playerId)
    && (trade.from === playerId || !(trade.declinedBy || []).includes(playerId));
}
function validateTableGive(state, player, give) {
  assert(state.options.allowGifts || count(give) > 0, '未开启赠牌时需要提供至少一张资源');
  assert(canPay(player, give), '你没有报价中承诺的资源');
}
function validateTableTerms(state, give, response) {
  assert(count(give) + count(response) > 0, '赠送或交易至少需要一张资源牌');
  assert(state.options.allowGifts || (count(give) > 0 && count(response) > 0), '交易双方都必须提供资源');
  assert(RESOURCES.every(r => !(give[r] && response[r])), '不能交换相同种类的资源');
}
function resolveTableTrade(state, trade, recipientId, status) {
  if (status === 'declined' && !trade.to && recipientId !== trade.from) {
    trade.declinedBy = [...new Set([...(trade.declinedBy || []), recipientId])];
    state.tableTrades = state.tableTrades.filter(t => !(t.parentId === trade.id && t.to === recipientId));
  } else if (status === 'accepted' && trade.parentId) {
    // A public offer represents one exchange. Completing one bilateral fork
    // retires the original offer and its sibling conversations atomically.
    state.tableTrades = state.tableTrades.filter(t => t.id !== trade.parentId && t.parentId !== trade.parentId);
  } else if (!trade.to && recipientId === trade.from) {
    state.tableTrades = state.tableTrades.filter(t => t.id !== trade.id && t.parentId !== trade.id);
  } else state.tableTrades = state.tableTrades.filter(t => t.id !== trade.id);
  state.tableTradeResult = {
    id: `table-result-${state.actionSequence}`, tradeId: trade.id,
    from: trade.from, to: trade.to || recipientId, status,
  };
  log(state, status === 'accepted' ? '资源交换已完成' : '资源交换未达成');
}

export function legalActions(state, playerId) {
  const p = playerById(state, playerId);
  const active = !!p && state.activePlayerId === playerId && !state.winner;
  const canBuild = active && isActionTurn(state);
  const setupSettlement = active && state.phase === 'setup_settlement';
  const setupRoad = active && state.phase === 'setup_road';
  const freeRoad = active && state.phase === 'road_building';
  const latestBuild = state.undoStack?.at(-1);
  const canUndoBuild = !!(active && state.options.allowUndo !== false && latestBuild
    && latestBuild.playerId === playerId && latestBuild.turn === state.turn
    && latestBuild.personalTurn === p.personalTurn && latestBuild.turnKind === state.turnKind
    && ['actions', 'setup_road'].includes(state.phase));
  // Missing hasRolled supports persisted games created before this room rule.
  // In those states, the roll phase means pending; actions follow a dice roll.
  const hasRolled = state.hasRolled ?? (state.phase !== 'roll' && !!state.dice);
  const canRoll = active && state.turnKind === 'main' && !hasRolled
    && (state.phase === 'roll' || (state.options.flexibleRoll && state.phase === 'actions'));
  const legal = {
    phase: state.phase, active, canRoll,
    canEndTurn: canBuild && (state.turnKind !== 'main' || hasRolled),
    canUndoBuild,
    settlements: [], roads: [], cities: [], robberTiles: [], robberChoices: {}, stealTargets: [],
    discardCount: p ? state.discardRequired[p.id] || 0 : 0,
    canBuyDevelopment: !!(canBuild && state.developmentDeck.length && canPay(p, COSTS.development)),
    canTrade: !!(active && isTradeTurn(state)), canTradePlayers: !!(active && domesticAllowed(state)),
    canOfferTrade: !!(p && domesticAllowed(state)),
    hasGenericPort: !!(p && state.board.ports.some(port => !port.resource && port.ratio === 3
      && port.vertices.some(id => vertexById(state, id).owner === p.id))),
    bankRatios: p ? bankRatios(state, p.id) : {}, developmentCards: [], tradeOffers: [], tableTradeIds: [],
  };
  if (!p || state.winner) return legal;
  if (setupSettlement || (canBuild && canPay(p, COSTS.settlement))) legal.settlements = state.board.vertices.filter(v => legalSettlement(state, p.id, v, setupSettlement)).map(v => v.id);
  if (setupRoad || freeRoad || (canBuild && canPay(p, COSTS.road))) legal.roads = state.board.edges.filter(e => legalRoad(state, p.id, e, setupRoad)).map(e => e.id);
  if (canBuild && canPay(p, COSTS.city) && remainingPieces(state, p.id).cities > 0) legal.cities = state.board.vertices.filter(v => v.owner === p.id && v.level === 1).map(v => v.id);
  if (active && state.phase === 'robber') {
    legal.robberTiles = validRobberTiles(state);
    // Candidate identities depend only on the public board and hand sizes.
    legal.robberChoices = Object.fromEntries(legal.robberTiles.map(tileId => [tileId, robberTargets(state, p.id, tileId, true)]));
  }
  if (active && state.phase === 'steal') legal.stealTargets = state.stealTargets || [];
  if (active && ['roll', 'actions'].includes(state.phase) && state.turnKind !== 'special' && !p.usedDevelopment) {
    legal.developmentCards = p.development.filter(c => c.type !== 'victoryPoint' && c.boughtTurn < p.personalTurn).map(c => c.id);
  }
  if (domesticAllowed(state)) legal.tradeOffers = state.tradeOffers.filter(o => o.from !== p.id && (!o.to || o.to === p.id)
    && !(o.declinedBy || []).includes(p.id)
    && (o.from === state.activePlayerId || p.id === state.activePlayerId)).map(o => o.id);
  if (domesticAllowed(state)) legal.tableTradeIds = (state.tableTrades || []).filter(t => tableTradeVisible(t, p.id)).map(t => t.id);
  return legal;
}

function enactRuleChanges(state, changes) {
  Object.assign(state.options, changes);
  // Undo histories can contain costs, production and permissions from the old rules.
  state.undoStack = [];
  const hasRolled = state.hasRolled ?? !!state.dice;
  if (changes.flexibleRoll !== undefined && state.turnKind === 'main' && !hasRolled) {
    const nextPhase = changes.flexibleRoll ? 'actions' : 'roll';
    if (['roll', 'actions'].includes(state.phase)) state.phase = nextPhase;
    if (['roll', 'actions'].includes(state.resumePhase)) state.resumePhase = nextPhase;
  }
  if (changes.friendlyRobber && state.phase === 'robber' && !validRobberTiles(state).length) {
    resumeAfterRobber(state);
  }
  if (changes.allowGifts === false) {
    state.tradeOffers = state.tradeOffers.filter(offer => count(offer.give) && count(offer.get));
    state.tableTrades = (state.tableTrades || []).filter(trade => count(trade.give) && (trade.response === null || count(trade.response)));
  }
}

function applyRuleVote(input, state, playerId, action) {
  const proposal = state.ruleProposal;
  if (action.type === 'voteRules' && proposal && proposal.id === action.proposalId
    && typeof action.approve === 'boolean' && Object.hasOwn(proposal.votes, playerId)) {
    assert(proposal.votes[playerId] === action.approve, '你已在本次提案中投过票');
    return input; // Retrying the same ballot never adds a vote or changes the result.
  }
  assert(!state.winner && state.phase !== 'finished', '对局结束后无法更改规则');
  state.actionSequence++;
  if (action.type === 'proposeRules') {
    assert(proposal?.status !== 'pending', '已有一项规则提案正在表决');
    const changes = action.changes;
    assert(changes && typeof changes === 'object' && !Array.isArray(changes), '请选择要更改的规则');
    const entries = Object.entries(changes);
    assert(entries.length && entries.every(([id, value]) =>
      typeof value === 'boolean' && RULE_OPTIONS.some(option => option.id === id)), '提案只能修改可选规则');
    const changed = entries.filter(([id, value]) => value !== (state.options[id] ?? RULE_OPTIONS.find(option => option.id === id).defaultValue));
    assert(changed.length, '提案需至少更改一项规则');
    state.ruleProposal = { id: state.actionSequence, proposerId: playerId, changes: Object.fromEntries(changed), votes: {}, status: 'pending' };
    return state;
  }

  assert(proposal?.status === 'pending' && proposal.id === action.proposalId, '这项规则提案已结束或不存在');
  if (action.type === 'withdrawRuleProposal') {
    assert(proposal.proposerId === playerId, '只有发起人可以撤回这项提案');
    proposal.status = 'withdrawn';
    return state;
  }

  assert(typeof action.approve === 'boolean', '请选择同意或反对');
  proposal.votes = { ...proposal.votes, [playerId]: action.approve };
  if (!action.approve) {
    proposal.status = 'rejected';
    log(state, '规则提案未获全票通过，本局规则保持原样。');
  } else if (state.players.every(player => proposal.votes[player.id] === true)) {
    enactRuleChanges(state, proposal.changes);
    proposal.status = 'approved';
    const changes = RULE_OPTIONS.filter(option => Object.hasOwn(proposal.changes, option.id))
      .map(option => `${proposal.changes[option.id] ? '开启' : '关闭'}${option.label}`);
    log(state, `规则提案全票通过：${changes.join('、')}。`);
  }
  return state;
}

export function applyAction(input, playerId, action, rng) {
  assert(input && !input.winner, '本局已经结束');
  assert(action && typeof action.type === 'string', '操作无效');
  const state = clone(input), p = playerById(state, playerId);
  assert(p, '你不在本局中');
  if (['proposeRules', 'voteRules', 'withdrawRuleProposal'].includes(action.type)) {
    return applyRuleVote(input, state, playerId, action);
  }
  const legal = legalActions(state, playerId);
  state.actionSequence++;
  if (action.type === 'undoBuild') {
    assert(legal.canUndoBuild, '现在没有可以撤销的建造');
    const history = state.undoStack.slice(0, -1);
    const restored = clone(state.undoStack.at(-1).before);
    restored.undoStack = history;
    restored.actionSequence = state.actionSequence;
    if (state.ruleProposal) restored.ruleProposal = state.ruleProposal;
    log(restored, `${p.name} 撤销了上一次建造，资源与棋子已退回。`);
    checkWinner(restored);
    return restored;
  }
  // Only completed paid builds (including special-building phases) and a
  // setup settlement awaiting its road are reversible. Free road actions are
  // part of a development-card resolution and do not create take-back history.
  const reversibleBuild = state.options.allowUndo !== false
    && ['buildRoad', 'buildSettlement', 'buildCity'].includes(action.type)
    && (input.phase === 'actions' || (input.phase === 'setup_settlement' && action.type === 'buildSettlement'));
  const buildBefore = reversibleBuild ? clone(input) : null;
  if (buildBefore) { delete buildBefore.undoStack; delete buildBefore.ruleProposal; }
  const previousHistory = reversibleBuild ? state.undoStack || [] : [];
  state.undoStack = [];
  switch (action.type) {
    case 'buildSettlement': {
      assert(legal.settlements.includes(action.vertexId), '不能在此建造村庄');
      const setup = state.phase === 'setup_settlement';
      const v = vertexById(state, action.vertexId);
      if (!setup) pay(state, p, COSTS.settlement);
      v.owner = p.id; v.level = 1;
      if (setup) {
        state.setupVertexId = v.id; state.phase = 'setup_road';
        if (state.setupStep >= state.players.length) for (const tileId of v.tiles) {
          const resource = tileById(state, tileId).resource;
          if (resource !== 'desert' && bankHas(state, { [resource]: 1 })) transfer(state.bank, p.resources, { [resource]: 1 }, state);
        }
      }
      log(state, `${p.name} 建造了一座村庄。`); break;
    }
    case 'buildRoad': {
      assert(legal.roads.includes(action.edgeId), '不能在此建造道路');
      const setup = state.phase === 'setup_road', free = state.phase === 'road_building';
      if (!setup && !free) pay(state, p, COSTS.road);
      edgeById(state, action.edgeId).owner = p.id;
      if (setup) {
        state.setupStep++; state.setupVertexId = null;
        if (state.setupStep === state.setupOrder.length) {
          state.turn = 1; startPersonalTurn(state, state.mainPlayerIndex, 'main', 'roll');
        } else {
          state.activePlayerId = state.players[state.setupOrder[state.setupStep]].id;
          state.phase = 'setup_settlement';
        }
      } else if (free) {
        state.freeRoads--;
        if (!state.freeRoads || !state.board.edges.some(e => legalRoad(state, p.id, e))) {
          state.phase = state.resumePhase; delete state.resumePhase; delete state.freeRoads;
        }
      }
      log(state, `${p.name} 建造了一条道路。`); break;
    }
    case 'buildCity': {
      assert(legal.cities.includes(action.vertexId), '不能在此升级城市');
      pay(state, p, COSTS.city); vertexById(state, action.vertexId).level = 2;
      log(state, `${p.name} 将村庄升级为城市。`); break;
    }
    case 'roll': {
      assert(legal.canRoll, '现在不能投骰子');
      const dice = action.dice || [1 + Math.floor(random(rng) * 6), 1 + Math.floor(random(rng) * 6)];
      assert(Array.isArray(dice) && dice.length === 2 && dice.every(n => Number.isInteger(n) && n >= 1 && n <= 6), '骰子点数无效');
      state.dice = [...dice]; state.hasRolled = true;
      const total = dice[0] + dice[1];
      log(state, `${p.name} 掷出 ${dice[0]} + ${dice[1]} = ${total}。`);
      if (total === 7) {
        state.tableResetId = (state.tableResetId || 0) + 1;
        state.tableTrades = []; state.tradeOffers = [];
        state.tableTradeResult = null; state.tradeResult = null;
        const roundDiscard = state.options.roundUpDiscard ? Math.ceil : Math.floor;
        state.discardRequired = Object.fromEntries(state.players.filter(other => count(other.resources) > 7).map(other => [other.id, roundDiscard(count(other.resources) / 2)]));
        if (Object.keys(state.discardRequired).length) state.phase = 'discard';
        else beginRobber(state, 'actions');
      } else { produce(state, total); state.phase = 'actions'; }
      break;
    }
    case 'discard': {
      assert(state.phase === 'discard' && legal.discardCount > 0, '现在无需弃牌');
      const resources = normalizeResources(action.resources);
      assert(count(resources) === legal.discardCount && canPay(p, resources), `请弃掉 ${legal.discardCount} 张资源牌`);
      transfer(p.resources, state.bank, resources, state); delete state.discardRequired[p.id];
      log(state, `${p.name} 弃掉了 ${count(resources)} 张资源牌。`);
      if (!Object.keys(state.discardRequired).length) beginRobber(state, 'actions');
      break;
    }
    case 'confirmRobber': {
      const tileId = typeof action.tileId === 'string' && /^\d+$/.test(action.tileId) ? Number(action.tileId) : action.tileId;
      assert(legal.robberTiles.includes(tileId), '强盗必须移动到另一块合法地形');
      const targets = legal.robberChoices[tileId];
      const targetId = action.targetId ?? (targets.length === 1 ? targets[0] : null);
      assert(targets.length ? targets.includes(targetId) : targetId === null, '请选择强盗旁有资源的玩家');
      // Validate the complete decision before committing either movement or theft.
      state.robberTile = tileId;
      log(state, `${p.name} 移动了强盗。`);
      if (targetId !== null) stealRobberResource(state, p, targetId, rng);
      resumeAfterRobber(state);
      break;
    }
    case 'moveRobber': {
      const tileId = typeof action.tileId === 'string' && /^\d+$/.test(action.tileId) ? Number(action.tileId) : action.tileId;
      assert(legal.robberTiles.includes(tileId), '强盗必须移动到另一块合法地形');
      state.robberTile = tileId;
      state.stealTargets = robberTargets(state, p.id, tileId);
      log(state, `${p.name} 移动了强盗。`);
      if (state.stealTargets.length) state.phase = 'steal'; else resumeAfterRobber(state);
      break;
    }
    case 'steal': {
      assert(legal.stealTargets.includes(action.targetId), '请选择强盗旁的玩家');
      stealRobberResource(state, p, action.targetId, rng);
      resumeAfterRobber(state); break;
    }
    case 'bankTrade': {
      assert(legal.canTrade, '现在不能与银行交易');
      assert(RESOURCES.includes(action.give) && RESOURCES.includes(action.get) && action.give !== action.get, '请选择不同的交换资源');
      const quantity = action.quantity ?? 1;
      assert(Number.isSafeInteger(quantity) && quantity > 0, '交易数量无效');
      const required = legal.bankRatios[action.give] * quantity;
      assert(p.resources[action.give] >= required && bankHas(state, { [action.get]: quantity }), '玩家或银行资源不足');
      transfer(p.resources, state.bank, { [action.give]: required }, state);
      transfer(state.bank, p.resources, { [action.get]: quantity }, state);
      log(state, `${p.name} 完成了一笔银行／港口交易。`); break;
    }
    case 'maritimeTrade': {
      assert(legal.canTrade, '现在不能与银行或港口交易');
      assert(['bank', 'port'].includes(action.mode), '请选择银行或港口交易');
      assert(action.mixed === undefined || typeof action.mixed === 'boolean', '混合兑换选项无效');
      const give = normalizeResources(action.give), get = normalizeResources(action.get);
      assert(count(give) > 0 && count(get) > 0, '请填写给出和获得的资源');
      assert(RESOURCES.every(r => !(give[r] && get[r])), '不能交换相同种类的资源');
      let credits = 0;
      if (action.mixed) {
        // Optional room rule, separate from the official identical-resource
        // port groups. A specialist 2:1 port never enables mixed exchanges.
        assert(action.mode === 'port', '混合兑换只能在港口使用');
        assert(state.options.mixedPortTrade, '房主未开启混合港口兑换');
        assert(legal.hasGenericPort, '混合兑换需要拥有通用 3:1 港口');
        assert(count(give) % 3 === 0, '混合兑换每组必须提供 3 张资源');
        credits = count(give) / 3;
      } else {
        for (const r of RESOURCES) if (give[r]) {
          const ratio = action.mode === 'bank' ? 4 : legal.bankRatios[r];
          assert(action.mode !== 'port' || ratio < 4, '你没有可交换此类资源的港口');
          assert(give[r] % ratio === 0, `每组必须提供 ${ratio} 张同类资源`);
          credits += give[r] / ratio;
        }
      }
      assert(credits === count(get), '获得数量必须等于给出的完整交易组数');
      assert(canPay(p, give), '你没有足够的资源完成交易');
      assert(bankHas(state, get), '银行没有足够的所选资源');
      transfer(p.resources, state.bank, give, state); transfer(state.bank, p.resources, get, state);
      log(state, `${p.name} 完成了一笔${action.mode === 'bank' ? '银行' : action.mixed ? '混合港口' : '港口'}交易。`);
      break;
    }
    case 'offerTrade': {
      assert(domesticAllowed(state), '本阶段不能进行玩家交易');
      const give = normalizeResources(action.give), get = normalizeResources(action.get);
      if (state.options.allowGifts) assert(count(give) || count(get), '赠送或交易至少需要一张资源牌');
      else assert(count(give) && count(get), '交易双方都必须提供资源');
      assert(RESOURCES.every(r => !(give[r] && get[r])), '不能交换相同种类的资源');
      assert(canPay(p, give), '你没有报价中承诺的资源');
      const to = action.targetId || (p.id === state.activePlayerId ? null : state.activePlayerId);
      assert(!to || (to !== p.id && playerById(state, to)), '交易对象无效');
      assert(p.id === state.activePlayerId || to === state.activePlayerId, '交易必须包含当前行动玩家');
      state.tradeOffers = state.tradeOffers.filter(o => o.from !== p.id);
      state.tradeOffers.push({ id: `trade${state.actionSequence}`, from: p.id, to, give, get });
      log(state, `${p.name} 发起了资源交换。`); break;
    }
    case 'createTableTrade': {
      assert(domesticAllowed(state), '本阶段不能进行玩家交易');
      const give = normalizeResources(action.give);
      validateTableGive(state, p, give);
      const to = action.targetId || (p.id === state.activePlayerId ? null : state.activePlayerId);
      assert(!to || (to !== p.id && playerById(state, to)), '交易对象无效');
      assert(p.id === state.activePlayerId || to === state.activePlayerId, '交易必须包含当前行动玩家');
      state.tableTrades ||= [];
      state.tableTrades.push({ id: `table${state.actionSequence}`, from: p.id, to, give, response: null, confirmed: [] });
      log(state, `${p.name} 发起了资源交换。`);
      break;
    }
    case 'respondTableTrade': {
      assert(domesticAllowed(state) && legal.tableTradeIds.includes(action.tradeId), '此交易邀请已经失效');
      const trade = state.tableTrades.find(t => t.id === action.tradeId);
      assert(trade.from !== p.id && (!trade.to || trade.to === p.id), '只能回应发给自己的交易邀请');
      assert(trade.from === state.activePlayerId || p.id === state.activePlayerId, '交易必须包含当前行动玩家');
      const give = normalizeResources(action.give);
      validateTableGive(state, p, give); validateTableTerms(state, trade.give, give);
      if (!trade.to) {
        const existing = state.tableTrades.find(t => t.parentId === trade.id && t.to === p.id);
        if (existing) {
          existing.give = clone(trade.give); existing.response = give; existing.confirmed = [];
        } else state.tableTrades.push({
          id: `table${state.actionSequence}`, parentId: trade.id, from: trade.from, to: p.id,
          give: clone(trade.give), response: give, confirmed: [],
        });
      } else { trade.response = give; trade.confirmed = []; }
      break;
    }
    case 'updateTableTrade': {
      assert(domesticAllowed(state) && legal.tableTradeIds.includes(action.tradeId), '此交易邀请已经失效');
      const trade = state.tableTrades.find(t => t.id === action.tradeId);
      assert(trade.from === p.id || trade.to === p.id, '只能修改自己参与的交易');
      const give = normalizeResources(action.give);
      validateTableGive(state, p, give);
      if (trade.from === p.id) {
        if (trade.response !== null) validateTableTerms(state, give, trade.response);
        trade.give = give;
        // Forks quote a particular version of the public offer. An edit retires
        // those quotes instead of silently changing already proposed terms.
        if (!trade.to) state.tableTrades = state.tableTrades.filter(t => t.parentId !== trade.id);
      } else { validateTableTerms(state, trade.give, give); trade.response = give; }
      trade.confirmed = []; delete trade.declinedBy;
      break;
    }
    case 'confirmTableTrade': {
      assert(domesticAllowed(state) && legal.tableTradeIds.includes(action.tradeId), '此交易邀请已经失效');
      const trade = state.tableTrades.find(t => t.id === action.tradeId);
      assert(trade.to && (trade.from === p.id || trade.to === p.id), '请先选择一个双边交易会话');
      assert(trade.response !== null, '请等待双方都摆好交易资源');
      assert(trade.from === state.activePlayerId || trade.to === state.activePlayerId, '交易必须包含当前行动玩家');
      validateTableTerms(state, trade.give, trade.response);
      const from = playerById(state, trade.from), to = playerById(state, trade.to);
      if (!canPay(from, trade.give) || !canPay(to, trade.response)) {
        resolveTableTrade(state, trade, p.id, 'declined');
      } else {
        trade.confirmed = [...new Set([...(trade.confirmed || []), p.id])];
        if (trade.confirmed.includes(trade.from) && trade.confirmed.includes(trade.to)) {
          transfer(from.resources, to.resources, trade.give);
          transfer(to.resources, from.resources, trade.response);
          resolveTableTrade(state, trade, p.id, 'accepted');
        }
      }
      break;
    }
    case 'unconfirmTableTrade': {
      assert(domesticAllowed(state) && legal.tableTradeIds.includes(action.tradeId), '此交易邀请已经失效');
      const trade = state.tableTrades.find(t => t.id === action.tradeId);
      assert(trade.to && (trade.from === p.id || trade.to === p.id), '只能撤回自己参与的双边交易确认');
      assert(trade.response !== null, '请等待双方都摆好交易资源');
      assert(trade.from === state.activePlayerId || trade.to === state.activePlayerId, '交易必须包含当前行动玩家');
      trade.confirmed = [];
      break;
    }
    case 'rejectTableTrade': {
      assert(domesticAllowed(state) && legal.tableTradeIds.includes(action.tradeId), '此交易邀请已经失效');
      const trade = state.tableTrades.find(t => t.id === action.tradeId);
      assert(!trade.to || trade.from === p.id || trade.to === p.id, '只能拒绝自己参与的交易');
      resolveTableTrade(state, trade, p.id, 'declined');
      break;
    }
    case 'acceptTrade': {
      assert(legal.tradeOffers.includes(action.offerId), '此报价已经失效或无法接受');
      const offer = state.tradeOffers.find(o => o.id === action.offerId), from = playerById(state, offer.from);
      assert(from.id === state.activePlayerId || p.id === state.activePlayerId, '交易必须包含当前行动玩家');
      if (canPay(from, offer.give) && canPay(p, offer.get)) {
        transfer(from.resources, p.resources, offer.give); transfer(p.resources, from.resources, offer.get);
        resolveTrade(state, offer, p.id, 'accepted');
      } else resolveTrade(state, offer, p.id, 'declined');
      break;
    }
    case 'rejectTrade': {
      assert(legal.tradeOffers.includes(action.offerId), '此报价已经失效或无法拒绝');
      resolveTrade(state, state.tradeOffers.find(o => o.id === action.offerId), p.id, 'declined');
      break;
    }
    case 'cancelTrade': {
      const offer = state.tradeOffers.find(o => o.id === action.offerId);
      assert(offer && offer.from === p.id, '只能取消自己的报价');
      state.tradeOffers = state.tradeOffers.filter(o => o.id !== offer.id); break;
    }
    case 'buyDevelopment': {
      assert(legal.canBuyDevelopment, '资源不足或发展牌已经售罄');
      pay(state, p, COSTS.development);
      p.development.push({ id: `dev${state.actionSequence}`, type: state.developmentDeck.pop(), boughtTurn: p.personalTurn });
      log(state, `${p.name} 购买了一张发展牌。`); break;
    }
    case 'playDevelopment': {
      assert(legal.developmentCards.includes(action.cardId), '本回合不能使用这张发展牌');
      const card = p.development.find(c => c.id === action.cardId), priorPhase = state.phase;
      p.development = p.development.filter(c => c.id !== card.id); p.usedDevelopment = true;
      if (card.type === 'knight') {
        p.playedKnights++; beginRobber(state, priorPhase); log(state, `${p.name} 打出了骑士。`);
      } else if (card.type === 'roadBuilding') {
        state.freeRoads = Math.min(2, remainingPieces(state, p.id).roads);
        if (state.freeRoads && state.board.edges.some(e => legalRoad(state, p.id, e))) {
          state.resumePhase = priorPhase; state.phase = 'road_building';
        } else delete state.freeRoads;
        log(state, `${p.name} 打出了修路。`);
      } else if (card.type === 'yearOfPlenty') {
        assert(Array.isArray(action.resources) && action.resources.length >= 1 && action.resources.length <= 2 && action.resources.every(r => RESOURCES.includes(r)), '丰收需要选择两张资源');
        const resources = emptyResources(); action.resources.forEach(r => resources[r]++);
        assert(count(resources) === (state.options.infiniteBank ? 2 : Math.min(2, count(state.bank))) && bankHas(state, resources), '请选择库存中可用的两张资源');
        transfer(state.bank, p.resources, resources, state); log(state, `${p.name} 打出了丰收。`);
      } else if (card.type === 'monopoly') {
        assert(RESOURCES.includes(action.resource), '请选择垄断资源');
        for (const other of state.players) if (other.id !== p.id) transfer(other.resources, p.resources, { [action.resource]: other.resources[action.resource] });
        log(state, `${p.name} 打出了垄断。`);
      }
      state.developmentDiscard.push(card.type); break;
    }
    case 'endTurn': {
      assert(legal.canEndTurn, '请先完成当前操作');
      log(state, `${p.name} 结束行动。`); endTurn(state); break;
    }
    default: throw new Error('未知游戏操作');
  }
  checkWinner(state);
  if (reversibleBuild && !state.winner && state.activePlayerId === playerId
    && state.turn === input.turn && state.turnKind === input.turnKind
    && current(state).personalTurn === p.personalTurn) {
    state.undoStack = [...previousHistory, {
      playerId, turn: input.turn, personalTurn: p.personalTurn, turnKind: input.turnKind,
      before: buildBefore,
    }];
  }
  return state;
}

export function publicState(state, playerId) {
  const result = clone(state);
  result.developmentRemaining = state.developmentDeck.length;
  delete result.developmentDeck;
  delete result.setupOrder;
  delete result.undoStack;
  result.tradeOffers = result.tradeOffers.filter(o => (!o.to || o.from === playerId || o.to === playerId)
    && (o.from === playerId || !(o.declinedBy || []).includes(playerId)));
  for (const offer of result.tradeOffers) delete offer.declinedBy;
  if (result.tradeResult && result.tradeResult.from !== playerId && result.tradeResult.to !== playerId) result.tradeResult = null;
  result.tableTrades = (result.tableTrades || []).filter(trade => tableTradeVisible(trade, playerId));
  for (const trade of result.tableTrades) delete trade.declinedBy;
  if (result.tableTradeResult && result.tableTradeResult.from !== playerId && result.tableTradeResult.to !== playerId) result.tableTradeResult = null;
  for (const p of result.players) {
    p.resourceCount = count(p.resources);
    p.developmentCount = p.development.length;
    p.pieces = remainingPieces(state, p.id);
    if (p.id !== playerId && !state.winner) { delete p.resources; delete p.development; delete p.totalPoints; }
  }
  result.you = playerId;
  result.legal = legalActions(state, playerId);
  return result;
}
