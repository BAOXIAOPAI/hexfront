import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyAction, publicState, legalActions, RESOURCES } from './engine.js';

const rng = () => 0.42;
const players = n => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `玩家${i}` }));
const game = (n = 4, options = {}) => newGame(players(n), { rng, firstPlayerIndex: 0, ...options });
const act = (s, action, id = s.activePlayerId) => applyAction(s, id, action, rng);
function finishSetup(initial) {
  let s = initial;
  while (s.phase.startsWith('setup')) {
    const legal = legalActions(s, s.activePlayerId);
    s = s.phase === 'setup_settlement'
      ? act(s, { type: 'buildSettlement', vertexId: legal.settlements[0] })
      : act(s, { type: 'buildRoad', edgeId: legal.roads[0] });
  }
  return s;
}
function rich(s, id = s.activePlayerId) {
  const p = s.players.find(p => p.id === id);
  for (const r of RESOURCES) p.resources[r] = 10;
  return s;
}
function actionGame(n = 4, options) {
  const s = finishSetup(game(n, options));
  s.phase = 'actions'; s.hasRolled = true;
  return s;
}

test('classic and extension form connected nonduplicated hex graphs with correct components', () => {
  for (const n of [3, 4, 5, 6]) {
    const s = game(n), expanded = n > 4;
    assert.equal(s.board.tiles.length, expanded ? 30 : 19);
    assert.equal(s.board.vertices.length, expanded ? 80 : 54);
    assert.equal(s.board.edges.length, expanded ? 109 : 72);
    assert.equal(s.board.ports.length, expanded ? 11 : 9);
    assert.equal(s.developmentDeck.length, expanded ? 34 : 25);
    assert.equal(s.bank.wood, expanded ? 24 : 19);
    assert.equal(s.board.tiles.filter(t => t.resource === 'desert').length, expanded ? 2 : 1);
    assert.equal(s.board.tiles.filter(t => t.number === 6).length, expanded ? 3 : 2);
    assert.equal(new Set(s.board.ports.flatMap(p => p.vertices)).size, s.board.ports.length * 2);
    for (const v of s.board.vertices) {
      assert.ok(v.neighbors.length >= 2 && v.neighbors.length <= 3);
      for (const neighbor of v.neighbors) assert.ok(s.board.vertices.find(o => o.id === neighbor).neighbors.includes(v.id));
    }
  }
});

test('optional bank, turn-timing, gift and discard room rules default off and are publicly visible', () => {
  const flags = ['infiniteBank', 'flexibleRoll', 'allowGifts', 'roundUpDiscard'];
  const standard = game();
  for (const key of flags) assert.equal(standard.options[key], false);
  const custom = game(4, Object.fromEntries(flags.map(key => [key, true])));
  for (const key of flags) assert.equal(publicState(custom, 'p0').options[key], true);
});

test('only a unanimous rule proposal changes the active turn, even when voters act out of turn', () => {
  const initial = finishSetup(game(3));
  let state = act(initial, { type: 'proposeRules', changes: { flexibleRoll: true, infiniteBank: true } }, 'p1');
  const approve = { type: 'voteRules', proposalId: state.ruleProposal.id, approve: true };
  state = act(state, approve, 'p1');
  assert.strictEqual(act(state, approve, 'p1'), state);
  assert.throws(() => act(state, { ...approve, approve: false }, 'p1'), /投过票/);
  state = act(state, approve, 'p2');
  assert.equal(state.ruleProposal.status, 'pending');
  assert.equal(state.options.infiniteBank, false);
  assert.equal(state.phase, 'roll');

  state = act(state, approve, 'p0');
  assert.equal(state.ruleProposal.status, 'approved');
  assert.equal(state.options.infiniteBank, true);
  assert.equal(state.options.flexibleRoll, true);
  assert.equal(state.phase, 'actions');
  assert.equal(legalActions(state, 'p0').canRoll, true);
  assert.equal(legalActions(state, 'p0').canEndTurn, false);
  assert.deepEqual(state.board, initial.board);
  assert.strictEqual(act(state, approve, 'p0'), state);

  state = act(state, { type: 'proposeRules', changes: { flexibleRoll: false } });
  const restore = { ...approve, proposalId: state.ruleProposal.id };
  for (const player of state.players) state = act(state, restore, player.id);
  assert.equal(state.phase, 'roll');
  assert.equal(legalActions(state, 'p0').canTrade, false);
  assert.equal(legalActions(state, 'p0').canRoll, true);
});

test('dissent closes the proposal and stale, invalid, or unauthorized ballots cannot alter rules', () => {
  const initial = game(3);
  const propose = { type: 'proposeRules', changes: { allowGifts: true } };
  assert.throws(() => act(initial, { type: 'voteRules', approve: true }), /已结束/);
  assert.throws(() => act(initial, { ...propose, changes: { expanded: true } }), /可选规则/);
  assert.throws(() => act(initial, { ...propose, changes: { allowGifts: false } }), /至少更改/);
  let state = act(initial, propose);
  const reject = { type: 'voteRules', proposalId: state.ruleProposal.id, approve: false };
  assert.throws(() => act(state, propose, 'p1'), /正在表决/);
  assert.throws(() => act(state, { type: 'withdrawRuleProposal', proposalId: reject.proposalId }, 'p1'), /发起人/);
  assert.throws(() => act(state, reject, 'outside'), /你不在本局/);
  state = act(state, reject, 'p1');
  assert.equal(state.ruleProposal.status, 'rejected');
  assert.equal(state.options.allowGifts, false);
  state = act(state, propose);
  assert.throws(() => act(state, reject, 'p2'), /已结束/);
  state = act(state, { type: 'withdrawRuleProposal', proposalId: state.ruleProposal.id });
  assert.equal(state.ruleProposal.status, 'withdrawn');
  assert.equal(state.options.allowGifts, false);
});

test('undo keeps pending ballots and cannot restore rules from before a unanimous change', () => {
  let state = game(3);
  const settlement = () => ({ type: 'buildSettlement', vertexId: legalActions(state, 'p0').settlements[0] });
  state = act(state, settlement());
  state = act(state, { type: 'proposeRules', changes: { friendlyRobber: true } });
  const approve = { type: 'voteRules', proposalId: state.ruleProposal.id, approve: true };
  state = act(state, approve, 'p2');
  state = act(state, { type: 'undoBuild' });
  assert.equal(state.ruleProposal.votes.p2, true);
  assert.equal(state.phase, 'setup_settlement');
  state = act(state, settlement());
  state = act(state, approve, 'p0');
  state = act(state, approve, 'p1');
  assert.equal(state.options.friendlyRobber, true);
  assert.equal(legalActions(state, 'p0').canUndoBuild, false);
});

test('official number spiral keeps red discs separated for varied desert placements', () => {
  for (const n of [4, 6]) for (let seed = 1; seed <= 40; seed++) {
    let value = seed;
    const seeded = () => { value = (1664525 * value + 1013904223) >>> 0; return value / 4294967296; };
    const s = game(n, { rng: seeded });
    const red = s.board.tiles.filter(t => t.number === 6 || t.number === 8);
    for (const a of red) for (const b of red) if (a.id !== b.id) {
      const distance = Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
      assert.ok(distance > 1, `adjacent red discs for ${n} players, seed ${seed}`);
    }
  }
});

test('setup is snake ordered, respects distances, and awards only second-settlement resources', () => {
  let s = game();
  const turns = [];
  while (s.phase.startsWith('setup')) {
    const id = s.activePlayerId, p = s.players.find(p => p.id === id);
    if (s.phase === 'setup_settlement') {
      turns.push(id);
      const before = RESOURCES.reduce((n, r) => n + p.resources[r], 0);
      const target = legalActions(s, id).settlements[0], v = s.board.vertices.find(v => v.id === target);
      const amount = v.tiles.filter(t => s.board.tiles[t].resource !== 'desert').length;
      const step = s.setupStep;
      s = act(s, { type: 'buildSettlement', vertexId: target });
      const after = RESOURCES.reduce((n, r) => n + s.players.find(p => p.id === id).resources[r], 0);
      assert.equal(after - before, step >= 4 ? amount : 0);
      assert.ok(v.neighbors.every(neighbor => !legalActions(s, id).settlements.includes(neighbor)));
    } else s = act(s, { type: 'buildRoad', edgeId: legalActions(s, id).roads[0] });
  }
  assert.deepEqual(turns, ['p0', 'p1', 'p2', 'p3', 'p3', 'p2', 'p1', 'p0']);
  assert.equal(s.phase, 'roll'); assert.equal(s.activePlayerId, 'p0');
  assert.equal(s.board.edges.filter(e => e.owner).length, 8);
  assert.equal(s.players[0].points, 2);
});

test('illegal actions are transactional, including attempted out-of-turn rolls', () => {
  const s = finishSetup(game()), before = structuredClone(s);
  assert.throws(() => applyAction(s, 'p1', { type: 'roll', dice: [6, 6] }), /不能投/);
  assert.throws(() => act(s, { type: 'roll', dice: [7, 0] }), /无效/);
  assert.deepEqual(s, before);
});

test('rolling any outcome preserves every tile, building position, road owner, and port', () => {
  for (const n of [3, 4, 5, 6]) for (const dice of [[1, 1], [3, 4], [4, 4], [6, 6]]) {
    const s = finishSetup(game(n));
    const originalBoard = structuredClone(s.board);
    const expectedOwners = s.board.vertices.filter(v => v.owner).map(v => [v.id, v.owner, v.level]);
    const next = act(s, { type: 'roll', dice });
    assert.deepEqual(next.board, originalBoard, `board changed for ${n} players rolling ${dice}`);
    assert.deepEqual(next.board.vertices.filter(v => v.owner).map(v => [v.id, v.owner, v.level]), expectedOwners);
    assert.deepEqual(s.board, originalBoard, 'input board was mutated');
  }
});

test('seven blocks trading until all required players discard, then robber must move', () => {
  let s = finishSetup(game());
  s.players.forEach(p => { for (const r of RESOURCES) p.resources[r] = 0; });
  s.players[0].resources.wood = 9; s.players[1].resources.brick = 8;
  s = act(s, { type: 'roll', dice: [3, 4] });
  assert.equal(s.phase, 'discard'); assert.deepEqual(s.discardRequired, { p0: 4, p1: 4 });
  assert.throws(() => act(s, { type: 'bankTrade', give: 'wood', get: 'ore' }), /不能/);
  s = act(s, { type: 'discard', resources: { brick: 4 } }, 'p1');
  assert.equal(s.phase, 'discard');
  assert.throws(() => act(s, { type: 'discard', resources: { wood: 3 } }), /4/);
  s = act(s, { type: 'discard', resources: { wood: 4 } });
  assert.equal(s.phase, 'robber');
  assert.throws(() => act(s, { type: 'moveRobber', tileId: s.robberTile }), /另一/);
  assert.equal(s.players[0].resources.wood, 5);
});

test('optional round-up discard affects all qualifying resource hands, not seven cards or development cards', () => {
  for (const roundUpDiscard of [false, true]) {
    let s = finishSetup(game(4, { roundUpDiscard, infiniteBank: true }));
    s.players.forEach(p => { p.resources = Object.fromEntries(RESOURCES.map(r => [r, 0])); });
    const hands = [9, 11, 8, 7];
    s.players.forEach((p, i) => { p.resources.wood = hands[i]; });
    s.players[3].development = [{ id: 'dev', type: 'knight', boughtTurn: 0 }];
    const bankBefore = structuredClone(s.bank);
    s = act(s, { type: 'roll', dice: [3, 4] });
    const expected = { p0: roundUpDiscard ? 5 : 4, p1: roundUpDiscard ? 6 : 5, p2: 4 };
    assert.deepEqual(s.discardRequired, expected);
    assert.throws(() => act(s, { type: 'discard', resources: { wood: expected.p0 - 1 } }), /请弃掉/);
    for (const [id, amount] of Object.entries(expected)) s = act(s, { type: 'discard', resources: { wood: amount } }, id);
    assert.equal(s.phase, 'robber');
    assert.equal(s.players[3].resources.wood, 7); assert.equal(s.players[3].development.length, 1);
    assert.deepEqual(s.bank, bankBefore, 'discarding must not increase infinite-bank supply markers');
  }
});

test('robber steals a random resource and public view never reveals hand identities', () => {
  let s = actionGame();
  s.phase = 'robber'; s.resumePhase = 'actions';
  const targetVertex = s.board.vertices.find(v => v.owner === 'p1');
  const targetTile = targetVertex.tiles.find(id => id !== s.robberTile);
  s.players[1].resources = { wood: 1, brick: 2, sheep: 0, wheat: 0, ore: 0 };
  const before = RESOURCES.reduce((n, r) => n + s.players[0].resources[r], 0);
  s = act(s, { type: 'moveRobber', tileId: targetTile });
  assert.ok(s.stealTargets.includes('p1'));
  s = act(s, { type: 'steal', targetId: 'p1' });
  assert.equal(s.phase, 'actions');
  assert.equal(RESOURCES.reduce((n, r) => n + s.players[0].resources[r], 0), before + 1);
  const view = publicState(s, 'p0');
  assert.ok(view.players[0].resources);
  assert.equal(view.players[1].resources, undefined);
  assert.equal(view.players[1].development, undefined);
  assert.equal(view.players[1].totalPoints, undefined);
  assert.equal(view.developmentDeck, undefined);
  assert.equal(view.players[1].resourceCount, 2);
});

test('confirmed robber movement after seven is atomic, steals once, and cannot be undone or repeated', () => {
  let s = finishSetup(game());
  s.players.forEach(p => { p.resources = Object.fromEntries(RESOURCES.map(r => [r, 0])); });
  s.players[1].resources = { wood: 1, brick: 2, sheep: 0, wheat: 0, ore: 0 };
  s = act(s, { type: 'roll', dice: [3, 4] });
  const tileId = s.board.vertices.find(v => v.owner === 'p1').tiles.find(id => id !== s.robberTile);
  const before = structuredClone(s);
  const view = publicState(s, 'p0');
  assert.deepEqual(view.legal.robberChoices[tileId], ['p1']);
  assert.equal(view.players[1].resources, undefined);
  assert.equal(view.players[1].resourceCount, 3);
  assert.deepEqual(publicState(s, 'p1').legal.robberChoices, {});
  assert.deepEqual(s, before, 'reading preview choices must not move the robber or take any cards');
  let samples = 0;
  const next = applyAction(s, 'p0', { type: 'confirmRobber', tileId: String(tileId) }, () => { samples++; return 0.42; });
  assert.deepEqual(s, before, 'confirmation must not mutate the caller state');
  assert.equal(next.robberTile, tileId); assert.equal(next.phase, 'actions');
  assert.equal(next.resumePhase, undefined); assert.equal(next.stealTargets, undefined);
  assert.equal(samples, 1);
  assert.equal(RESOURCES.reduce((n, r) => n + next.players[0].resources[r], 0), 1);
  assert.equal(RESOURCES.reduce((n, r) => n + next.players[1].resources[r], 0), 2);
  assert.deepEqual(next.bank, before.bank); assert.deepEqual(next.board, before.board);
  assert.deepEqual(next.undoStack, []); assert.equal(legalActions(next, 'p0').canUndoBuild, false);
  assert.throws(() => act(next, { type: 'undoBuild' }), /可以撤销/);
  assert.throws(() => act(next, { type: 'confirmRobber', tileId }), /另一/);
});

test('confirmed robber validates the whole multi-player choice before movement or randomness', () => {
  const s = actionGame();
  s.phase = 'robber'; s.resumePhase = 'actions';
  s.board.vertices.forEach(v => { v.owner = null; v.level = 0; });
  s.players.forEach(p => { p.resources = Object.fromEntries(RESOURCES.map(r => [r, 0])); });
  const tile = s.board.tiles.find(t => t.id !== s.robberTile);
  for (const [index, owner] of [[0, 'p1'], [2, 'p2'], [4, 'p3']]) {
    const vertex = s.board.vertices.find(v => v.id === tile.vertices[index]);
    vertex.owner = owner; vertex.level = 1;
  }
  s.players[1].resources.wood = 2; s.players[2].resources.ore = 1;
  const before = structuredClone(s), choices = legalActions(s, 'p0').robberChoices;
  assert.deepEqual([...choices[tile.id]].sort(), ['p1', 'p2'], 'empty-handed neighbors are excluded');
  const differentTypes = structuredClone(s);
  differentTypes.players[1].resources = { wood: 0, brick: 0, sheep: 2, wheat: 0, ore: 0 };
  assert.deepEqual(legalActions(differentTypes, 'p0').robberChoices, choices, 'choices reveal no resource identities');
  let samples = 0;
  const fail = (action, id = 'p0') => {
    assert.throws(() => applyAction(s, id, action, () => { samples++; return 0.42; }), /另一|请选择/);
    assert.deepEqual(s, before);
  };
  fail({ type: 'confirmRobber', tileId: s.robberTile, targetId: 'p1' });
  fail({ type: 'confirmRobber', tileId: 'missing', targetId: 'p1' });
  fail({ type: 'confirmRobber', tileId: tile.id });
  for (const targetId of ['p0', 'p3', 'missing']) fail({ type: 'confirmRobber', tileId: tile.id, targetId });
  fail({ type: 'confirmRobber', tileId: tile.id, targetId: 'p1' }, 'p2');
  assert.equal(samples, 0, 'rejected previews must not consume a theft draw');
  const next = act(s, { type: 'confirmRobber', tileId: tile.id, targetId: 'p2' });
  assert.equal(next.phase, 'actions'); assert.equal(next.robberTile, tile.id);
  assert.equal(next.players[0].resources.ore, 1); assert.equal(next.players[2].resources.ore, 0);
  assert.deepEqual(next.players[1].resources, before.players[1].resources);
});

test('confirmed robber with no resource-bearing neighbors moves without a target or theft draw', () => {
  let s = finishSetup(game());
  s.players.forEach(p => { p.resources = Object.fromEntries(RESOURCES.map(r => [r, 0])); });
  s = act(s, { type: 'roll', dice: [3, 4] });
  const tileId = s.board.vertices.find(v => v.owner === 'p1').tiles.find(id => id !== s.robberTile);
  assert.deepEqual(legalActions(s, 'p0').robberChoices[tileId], []);
  const before = structuredClone(s);
  assert.throws(() => act(s, { type: 'confirmRobber', tileId, targetId: 'p1' }), /请选择/);
  assert.deepEqual(s, before);
  const next = applyAction(s, 'p0', { type: 'confirmRobber', tileId }, () => { throw new Error('no theft draw expected'); });
  assert.equal(next.robberTile, tileId); assert.equal(next.phase, 'actions');
  assert.deepEqual(next.players.map(p => p.resources), before.players.map(p => p.resources));
  assert.deepEqual(next.undoStack, []);
});

test('confirmed knight movement resumes its prior phase and never restores prior building history', () => {
  for (const phase of ['roll', 'actions']) {
    let s = finishSetup(game());
    s.players.forEach(p => { p.resources = Object.fromEntries(RESOURCES.map(r => [r, 0])); });
    s.players[1].resources.wheat = 2;
    if (phase === 'actions') {
      s.phase = 'actions'; s.hasRolled = true;
      s.players[0].resources.wood = 1; s.players[0].resources.brick = 1;
      s = act(s, { type: 'buildRoad', edgeId: legalActions(s, 'p0').roads[0] });
      assert.equal(s.undoStack.length, 1);
    }
    s.players[0].development = [{ id: 'confirmed-knight', type: 'knight', boughtTurn: 0 }];
    s = act(s, { type: 'playDevelopment', cardId: 'confirmed-knight' });
    assert.equal(s.phase, 'robber'); assert.equal(s.resumePhase, phase);
    const tileId = s.board.vertices.find(v => v.owner === 'p1').tiles.find(id => id !== s.robberTile);
    s = act(s, { type: 'confirmRobber', tileId });
    assert.equal(s.phase, phase); assert.equal(s.players[0].resources.wheat, 1);
    assert.equal(legalActions(s, 'p0').canRoll, phase === 'roll');
    assert.deepEqual(s.undoStack, []); assert.equal(s.players[0].playedKnights, 1);
    assert.throws(() => act(s, { type: 'undoBuild' }), /可以撤销/);
  }
});

test('production shortage gives nobody resource if multiple players are owed; lone player gets remainder', () => {
  let s = game();
  s.phase = 'roll'; s.players[0].personalTurn = 1;
  s.board.vertices.forEach(v => { v.owner = null; v.level = 0; });
  const tile = s.board.tiles.find(t => t.resource === 'ore');
  s.board.tiles.forEach(t => { if (t.number) t.number = 12; }); tile.number = 8;
  const a = s.board.vertices.find(v => v.id === tile.vertices[0]);
  const b = s.board.vertices.find(v => v.id === tile.vertices[3]);
  a.owner = 'p0'; a.level = 2; b.owner = 'p1'; b.level = 1;
  s.bank.ore = 2;
  const result = act(s, { type: 'roll', dice: [4, 4] });
  assert.equal(result.players[0].resources.ore, 0); assert.equal(result.players[1].resources.ore, 0);
  b.owner = null; b.level = 0; s.bank.ore = 1;
  const single = act(s, { type: 'roll', dice: [4, 4] });
  assert.equal(single.players[0].resources.ore, 1); assert.equal(single.bank.ore, 0);
});

test('infinite bank supplies every producer despite zero stock and preserves stock during setup and production', () => {
  let s = finishSetup(game(4, { infiniteBank: true }));
  assert.ok(RESOURCES.every(r => s.bank[r] === 19), 'initial settlements must not deplete an infinite bank');
  assert.ok(s.players.every(p => RESOURCES.some(r => p.resources[r] > 0)));
  s.players.forEach(p => { p.resources = Object.fromEntries(RESOURCES.map(r => [r, 0])); });
  s.board.vertices.forEach(v => { v.owner = null; v.level = 0; });
  const tile = s.board.tiles.find(t => t.resource === 'ore');
  s.board.tiles.forEach(t => { if (t.number) t.number = 12; }); tile.number = 8;
  const a = s.board.vertices.find(v => v.id === tile.vertices[0]);
  const b = s.board.vertices.find(v => v.id === tile.vertices[3]);
  a.owner = 'p0'; a.level = 2; b.owner = 'p1'; b.level = 1;
  s.bank.ore = 0;
  const before = structuredClone(s.bank);
  s = act(s, { type: 'roll', dice: [4, 4] });
  assert.equal(s.players[0].resources.ore, 2); assert.equal(s.players[1].resources.ore, 1);
  assert.deepEqual(s.bank, before);
});

test('infinite bank covers plenty, bank/port trades and build refunds without waiving player costs', () => {
  let s = rich(actionGame(4, { infiniteBank: true, mixedPortTrade: true }));
  s.bank = Object.fromEntries(RESOURCES.map(r => [r, 0]));
  const generic = s.board.ports.find(p => !p.resource);
  const v = s.board.vertices.find(v => v.id === generic.vertices[0]); v.owner = 'p0'; v.level = 1;
  const beforeHand = structuredClone(s.players[0].resources);
  s = act(s, { type: 'bankTrade', give: 'wood', get: 'ore' });
  assert.equal(s.players[0].resources.wood, beforeHand.wood - 3); assert.equal(s.players[0].resources.ore, beforeHand.ore + 1);
  s = act(s, { type: 'maritimeTrade', mode: 'bank', give: { brick: 4 }, get: { ore: 1 } });
  s = act(s, { type: 'maritimeTrade', mode: 'port', give: { sheep: 3 }, get: { wheat: 1 } });
  s = act(s, { type: 'maritimeTrade', mode: 'port', mixed: true, give: { wood: 1, brick: 1, sheep: 1 }, get: { ore: 1 } });
  s.players[0].development = [{ id: 'plenty', type: 'yearOfPlenty', boughtTurn: 0 }];
  const ore = s.players[0].resources.ore;
  s = act(s, { type: 'playDevelopment', cardId: 'plenty', resources: ['ore', 'ore'] });
  assert.equal(s.players[0].resources.ore, ore + 2);
  const beforeBuild = structuredClone(s.players[0].resources);
  s = act(s, { type: 'buildRoad', edgeId: legalActions(s, 'p0').roads[0] });
  assert.equal(s.players[0].resources.wood, beforeBuild.wood - 1);
  s = act(s, { type: 'undoBuild' }); assert.deepEqual(s.players[0].resources, beforeBuild);
  s = act(s, { type: 'buyDevelopment' });
  assert.ok(RESOURCES.every(r => s.bank[r] === 0), 'infinite-bank markers must not change in either direction');
  assert.throws(() => act(s, { type: 'maritimeTrade', mode: 'bank', give: { wood: 400 }, get: { ore: 100 } }), /没有足够/);
  assert.throws(() => act(s, { type: 'bankTrade', give: 'brick', get: 'ore', quantity: 100 }), /资源不足/);
});

test('flexible roll allows actions first but requires exactly one roll before the main player can end', () => {
  let s = rich(finishSetup(game(4, { flexibleRoll: true })));
  rich(s, 'p1');
  assert.equal(s.phase, 'actions'); assert.equal(s.hasRolled, false);
  assert.equal(legalActions(s, 'p0').canRoll, true); assert.equal(legalActions(s, 'p0').canEndTurn, false);
  assert.equal(legalActions(s, 'p1').canRoll, false);
  assert.throws(() => act(s, { type: 'endTurn' }), /完成当前/);
  const boardBefore = structuredClone(s.board);
  s = act(s, { type: 'buildRoad', edgeId: legalActions(s, 'p0').roads[0] });
  assert.equal(s.hasRolled, false); assert.equal(legalActions(s, 'p0').canRoll, true);
  s = act(s, { type: 'undoBuild' }); assert.deepEqual(s.board, boardBefore); assert.equal(s.hasRolled, false);
  s = act(s, { type: 'bankTrade', give: 'ore', get: 'wood' });
  s = act(s, { type: 'offerTrade', targetId: 'p1', give: { wood: 1 }, get: { brick: 1 } });
  s = act(s, { type: 'acceptTrade', offerId: s.tradeOffers[0].id }, 'p1');
  s.developmentDeck = ['knight']; s = act(s, { type: 'buyDevelopment' });
  const fresh = s.players[0].development[0];
  assert.throws(() => act(s, { type: 'playDevelopment', cardId: fresh.id }), /不能使用/);
  s = act(s, { type: 'roll', dice: [1, 1] });
  assert.equal(s.hasRolled, true); assert.equal(legalActions(s, 'p0').canRoll, false);
  assert.equal(legalActions(s, 'p0').canEndTurn, true);
  assert.throws(() => act(s, { type: 'roll', dice: [6, 6] }), /不能投/);
  s = act(s, { type: 'endTurn' });
  assert.equal(s.activePlayerId, 'p1'); assert.equal(s.phase, 'actions'); assert.equal(s.hasRolled, false);
  assert.equal(legalActions(s, 'p1').canRoll, true); assert.equal(legalActions(s, 'p1').canEndTurn, false);
});

test('flexible rolling still waits for development-card resolution and seven/robber processing', () => {
  let s = finishSetup(game(4, { flexibleRoll: true }));
  s.players[0].development = [{ id: 'knight', type: 'knight', boughtTurn: 0 }];
  s = act(s, { type: 'playDevelopment', cardId: 'knight' });
  assert.equal(s.phase, 'robber'); assert.equal(legalActions(s, 'p0').canRoll, false);
  assert.throws(() => act(s, { type: 'roll', dice: [2, 2] }), /不能投/);
  s = act(s, { type: 'moveRobber', tileId: legalActions(s, 'p0').robberTiles[0] });
  if (s.phase === 'steal') s = act(s, { type: 'steal', targetId: s.stealTargets[0] });
  assert.equal(s.phase, 'actions'); assert.equal(legalActions(s, 'p0').canRoll, true);
  s.players[0].resources.wood = 9;
  s = act(s, { type: 'roll', dice: [3, 4] });
  assert.equal(s.phase, 'discard'); assert.equal(s.hasRolled, true);
  assert.equal(legalActions(s, 'p0').canRoll, false); assert.equal(legalActions(s, 'p0').canTrade, false);
  assert.equal(legalActions(s, 'p0').canEndTurn, false);
  for (const [id, amount] of Object.entries(s.discardRequired)) {
    let pending = amount; const resources = {};
    for (const r of RESOURCES) { resources[r] = Math.min(pending, s.players.find(p => p.id === id).resources[r]); pending -= resources[r]; }
    s = act(s, { type: 'discard', resources }, id);
  }
  assert.equal(s.phase, 'robber'); assert.equal(legalActions(s, 'p0').canRoll, false);
  s = act(s, { type: 'moveRobber', tileId: legalActions(s, 'p0').robberTiles[0] });
  if (s.phase === 'steal') s = act(s, { type: 'steal', targetId: s.stealTargets[0] });
  assert.equal(s.phase, 'actions'); assert.equal(legalActions(s, 'p0').canEndTurn, true);
  assert.throws(() => act(s, { type: 'roll', dice: [2, 2] }), /不能投/);
});

test('flexible timing never gives paired or special-building players an extra dice roll', () => {
  for (const extensionRule of ['paired', 'special']) {
    let s = finishSetup(game(5, { flexibleRoll: true, extensionRule }));
    s = act(s, { type: 'roll', dice: [1, 1] }); s = act(s, { type: 'endTurn' });
    const followers = extensionRule === 'paired' ? 1 : 4;
    for (let i = 0; i < followers; i++) {
      assert.equal(legalActions(s, s.activePlayerId).canRoll, false);
      assert.equal(legalActions(s, s.activePlayerId).canEndTurn, true);
      assert.throws(() => act(s, { type: 'roll', dice: [4, 4] }), /不能投/);
      s = act(s, { type: 'endTurn' });
    }
    assert.equal(s.activePlayerId, 'p1'); assert.equal(s.turnKind, 'main'); assert.equal(s.hasRolled, false);
    assert.equal(legalActions(s, 'p1').canRoll, true);
  }
  const ordinary = rich(finishSetup(game()));
  assert.equal(ordinary.phase, 'roll'); assert.deepEqual(legalActions(ordinary, 'p0').roads, []);
  assert.equal(legalActions(ordinary, 'p0').canTrade, false);
  assert.throws(() => act(ordinary, { type: 'offerTrade', targetId: 'p1', give: { wood: 1 }, get: { ore: 1 } }), /不能/);
});

test('paired turn gives third-left player an action phase, bank trade, and no domestic trade', () => {
  let s = actionGame(5);
  s = act(s, { type: 'endTurn' });
  assert.equal(s.activePlayerId, 'p3'); assert.equal(s.turnKind, 'paired'); assert.equal(s.phase, 'actions');
  rich(s); assert.equal(legalActions(s, 'p3').canTrade, true);
  assert.equal(legalActions(s, 'p3').canTradePlayers, false);
  assert.throws(() => act(s, { type: 'offerTrade', give: { wood: 1 }, get: { ore: 1 } }), /不能/);
  s = act(s, { type: 'bankTrade', give: 'wood', get: 'ore' });
  s = act(s, { type: 'endTurn' });
  assert.equal(s.activePlayerId, 'p1'); assert.equal(s.phase, 'roll');
});

test('legacy special building visits opponents without trading or playing development cards', () => {
  let s = actionGame(6, { extensionRule: 'special' });
  s = act(s, { type: 'endTurn' });
  for (let i = 1; i <= 5; i++) {
    assert.equal(s.activePlayerId, `p${i}`); assert.equal(s.turnKind, 'special');
    rich(s);
    assert.equal(legalActions(s, s.activePlayerId).canTrade, false);
    s = act(s, { type: 'endTurn' });
  }
  assert.equal(s.activePlayerId, 'p1'); assert.equal(s.turnKind, 'main'); assert.equal(s.phase, 'roll');
});

test('development card bought during legacy special building is usable on the next personal turn', () => {
  let s = actionGame(5, { extensionRule: 'special' });
  s = act(s, { type: 'endTurn' });
  assert.equal(s.activePlayerId, 'p1');
  rich(s); s.developmentDeck = ['knight'];
  s = act(s, { type: 'buyDevelopment' });
  const card = s.players[1].development[0];
  assert.throws(() => act(s, { type: 'playDevelopment', cardId: card.id }), /不能/);
  for (let i = 0; i < 4; i++) s = act(s, { type: 'endTurn' });
  assert.equal(s.phase, 'roll'); assert.equal(s.activePlayerId, 'p1');
  s = act(s, { type: 'playDevelopment', cardId: card.id });
  assert.equal(s.phase, 'robber'); assert.equal(s.players[1].playedKnights, 1);
});

test('friendly robber protects visible two-point players even on desert and ignores hidden victory points', () => {
  let s = actionGame(4, { friendlyRobber: true });
  const desert = s.board.tiles.find(t => t.resource === 'desert');
  const v = s.board.vertices.find(v => v.id === desert.vertices[0]);
  s.board.vertices.filter(v => v.owner === 'p1').forEach(v => { v.owner = null; v.level = 0; });
  v.owner = 'p1'; v.level = 1;
  const other = s.board.vertices.find(o => !o.tiles.includes(desert.id) && !o.owner);
  other.owner = 'p1'; other.level = 1;
  s.players[1].points = 2;
  s.players[1].development = [{ id: 'secret', type: 'victoryPoint', boughtTurn: 0 }];
  s.players[1].resources.wood = 3;
  s.robberTile = s.board.tiles.find(t => t.resource !== 'desert').id;
  s.phase = 'robber'; s.resumePhase = 'actions';
  for (const tileId of v.tiles.filter(id => id !== desert.id)) assert.ok(!legalActions(s, 'p0').robberTiles.includes(tileId));
  assert.ok(!legalActions(s, 'p0').robberChoices[desert.id].includes('p1'));
  const confirmed = act(s, { type: 'confirmRobber', tileId: desert.id });
  assert.equal(confirmed.phase, 'actions'); assert.equal(confirmed.players[1].resources.wood, 3);
  s = act(s, { type: 'moveRobber', tileId: desert.id });
  assert.ok(!s.stealTargets?.includes('p1'));
  assert.equal(s.players[1].resources.wood, 3);
});

test('robber can select an adjacent empty-handed player without inventing a resource', () => {
  let s = actionGame();
  const v = s.board.vertices.find(v => v.owner === 'p1');
  const tileId = v.tiles.find(id => id !== s.robberTile);
  s.players[1].resources = Object.fromEntries(RESOURCES.map(r => [r, 0]));
  s.phase = 'robber'; s.resumePhase = 'actions';
  s = act(s, { type: 'moveRobber', tileId });
  assert.ok(s.stealTargets.includes('p1'));
  const before = structuredClone(s.players[0].resources);
  s = act(s, { type: 'steal', targetId: 'p1' });
  assert.equal(s.phase, 'actions'); assert.deepEqual(s.players[0].resources, before);
  assert.ok(RESOURCES.every(r => Number.isFinite(s.bank[r])));
});

test('new development cards cannot be played immediately, while old knight before roll does not discard', () => {
  let s = rich(actionGame());
  s.developmentDeck = ['knight'];
  s = act(s, { type: 'buyDevelopment' });
  const card = s.players[0].development[0];
  assert.throws(() => act(s, { type: 'playDevelopment', cardId: card.id }), /不能/);
  s.phase = 'roll'; s.players[0].personalTurn++;
  s = act(s, { type: 'playDevelopment', cardId: card.id });
  assert.equal(s.phase, 'robber'); assert.deepEqual(s.discardRequired, {});
  assert.equal(s.players[0].playedKnights, 1); assert.equal(s.resumePhase, 'roll');
});

test('road building is free, then resumes the previous phase and prevents a second development card', () => {
  let s = actionGame();
  const p = s.players[0];
  p.resources = Object.fromEntries(RESOURCES.map(r => [r, 0]));
  p.development = [{ id: 'roads', type: 'roadBuilding', boughtTurn: 0 }, { id: 'knight', type: 'knight', boughtTurn: 0 }];
  s = act(s, { type: 'playDevelopment', cardId: 'roads' });
  assert.equal(s.phase, 'road_building');
  const before = s.board.edges.filter(e => e.owner === 'p0').length;
  s = act(s, { type: 'buildRoad', edgeId: legalActions(s, 'p0').roads[0] });
  s = act(s, { type: 'buildRoad', edgeId: legalActions(s, 'p0').roads[0] });
  assert.equal(s.board.edges.filter(e => e.owner === 'p0').length, before + 2);
  assert.equal(s.phase, 'actions');
  assert.equal(RESOURCES.reduce((n, r) => n + s.players[0].resources[r], 0), 0);
  assert.throws(() => act(s, { type: 'playDevelopment', cardId: 'knight' }), /不能/);
});

test('road building ends after one road when only one piece or one legal edge remains', () => {
  for (const inventoryLimited of [true, false]) {
    let s = actionGame();
    s.players[0].development = [{ id: 'roads', type: 'roadBuilding', boughtTurn: 0 }];
    if (inventoryLimited) {
      s.board.edges.forEach(e => { e.owner = null; });
      s.board.edges.slice(0, 14).forEach(e => { e.owner = 'p0'; });
    } else {
      s.board.vertices = [
        { id: 'a', x: 0, y: 0, tiles: [], neighbors: ['b'], owner: 'p0', level: 1 },
        { id: 'b', x: 1, y: 0, tiles: [], neighbors: ['a'], owner: null, level: 0 },
      ];
      s.board.edges = [{ id: 'only', a: 'a', b: 'b', owner: null }]; s.board.ports = [];
    }
    s = act(s, { type: 'playDevelopment', cardId: 'roads' });
    assert.equal(s.phase, 'road_building');
    s = act(s, { type: 'buildRoad', edgeId: legalActions(s, 'p0').roads[0] });
    assert.equal(s.phase, 'actions'); assert.equal(s.freeRoads, undefined);
  }
});

test('plenty validates inventory atomically and monopoly transfers every opponent resource of chosen type', () => {
  let s = actionGame();
  s.players[0].development = [{ id: 'plenty', type: 'yearOfPlenty', boughtTurn: 0 }];
  s.bank.ore = 1;
  const before = structuredClone(s);
  assert.throws(() => act(s, { type: 'playDevelopment', cardId: 'plenty', resources: ['ore', 'ore'] }), /库存/);
  assert.deepEqual(s, before);
  const ore = s.players[0].resources.ore, wheat = s.players[0].resources.wheat;
  s = act(s, { type: 'playDevelopment', cardId: 'plenty', resources: ['ore', 'wheat'] });
  assert.equal(s.players[0].resources.ore, ore + 1); assert.equal(s.players[0].resources.wheat, wheat + 1);
  s.players[0].usedDevelopment = false;
  s.players[0].development = [{ id: 'mono', type: 'monopoly', boughtTurn: 0 }];
  s.players.forEach((p, i) => { p.resources.wood = i; });
  s = act(s, { type: 'playDevelopment', cardId: 'mono', resource: 'wood' });
  assert.equal(s.players[0].resources.wood, 6);
  assert.ok(s.players.slice(1).every(p => p.resources.wood === 0));
});

test('bank ports require owned buildings and reject identical resources', () => {
  let s = rich(actionGame());
  const port = s.board.ports.find(p => p.resource === 'ore');
  const v = s.board.vertices.find(v => v.id === port.vertices[0]); v.owner = 'p0'; v.level = 1;
  assert.equal(legalActions(s, 'p0').bankRatios.ore, 2);
  s = act(s, { type: 'bankTrade', give: 'ore', get: 'wheat', quantity: 2 });
  assert.equal(s.players[0].resources.ore, 6); assert.equal(s.players[0].resources.wheat, 12);
  assert.throws(() => act(s, { type: 'bankTrade', give: 'wood', get: 'wood' }), /不同/);
});

test('multi-resource maritime bank trades use complete 4:1 groups even when a port is owned', () => {
  let s = rich(actionGame());
  const port = s.board.ports.find(p => p.resource === 'wood');
  const v = s.board.vertices.find(v => v.id === port.vertices[0]); v.owner = 'p0'; v.level = 1;
  const before = structuredClone(s.players[0].resources);
  s = act(s, { type: 'maritimeTrade', mode: 'bank', give: { wood: 8, brick: 4 }, get: { wheat: 1, ore: 2 } });
  assert.equal(s.players[0].resources.wood, before.wood - 8);
  assert.equal(s.players[0].resources.brick, before.brick - 4);
  assert.equal(s.players[0].resources.wheat, before.wheat + 1);
  assert.equal(s.players[0].resources.ore, before.ore + 2);
  assert.throws(() => act(s, { type: 'maritimeTrade', mode: 'bank', give: { wood: 2 }, get: { ore: 1 } }), /4 张同类/);
});

test('port trades combine eligible groups at best owned rates, without mixing a single group', () => {
  let s = rich(actionGame());
  // Remove prior port ownership so only the deliberately granted ports apply.
  s.board.ports.forEach(port => port.vertices.forEach(id => {
    const v = s.board.vertices.find(v => v.id === id); if (v.owner === 'p0') { v.owner = null; v.level = 0; }
  }));
  const woodPort = s.board.ports.find(p => p.resource === 'wood');
  const woodVertex = s.board.vertices.find(v => v.id === woodPort.vertices[0]); woodVertex.owner = 'p0'; woodVertex.level = 1;
  assert.throws(() => act(s, { type: 'maritimeTrade', mode: 'port', give: { brick: 4 }, get: { ore: 1 } }), /没有.*港口/);
  const generic = s.board.ports.find(p => !p.resource);
  const genericVertex = s.board.vertices.find(v => v.id === generic.vertices[0]); genericVertex.owner = 'p0'; genericVertex.level = 1;
  s = act(s, { type: 'maritimeTrade', mode: 'port', give: { wood: 2, brick: 3 }, get: { ore: 1, wheat: 1 } });
  assert.equal(s.players[0].resources.wood, 8); assert.equal(s.players[0].resources.brick, 7);
  const before = structuredClone(s);
  assert.throws(() => act(s, { type: 'maritimeTrade', mode: 'port', give: { brick: 1, sheep: 2 }, get: { ore: 1 } }), /3 张同类/);
  assert.deepEqual(s, before);
  assert.throws(() => act(s, { type: 'maritimeTrade', mode: 'port', give: { brick: 3 }, get: { brick: 1 } }), /相同/);
  assert.throws(() => act(s, { type: 'maritimeTrade', mode: 'port', give: { wood: 2 }, get: { wheat: 2 } }), /组数/);
});

test('mixed port exchanges require an enabled room rule and a personally owned generic port', () => {
  const request = { type: 'maritimeTrade', mode: 'port', mixed: true, give: { wood: 1, brick: 1, sheep: 1 }, get: { ore: 1 } };
  function grantGeneric(s) {
    const generic = s.board.ports.find(p => !p.resource);
    const v = s.board.vertices.find(v => v.id === generic.vertices[0]); v.owner = 'p0'; v.level = 1;
    return s;
  }
  let disabled = grantGeneric(rich(actionGame()));
  assert.equal(disabled.options.mixedPortTrade, false);
  assert.equal(legalActions(disabled, 'p0').hasGenericPort, true);
  assert.throws(() => act(disabled, request), /未开启/);
  let noPort = rich(actionGame(4, { mixedPortTrade: true }));
  noPort.board.ports = noPort.board.ports.filter(port => port.resource);
  const specific = noPort.board.ports.find(port => port.resource === 'wood');
  const specificVertex = noPort.board.vertices.find(v => v.id === specific.vertices[0]); specificVertex.owner = 'p0'; specificVertex.level = 1;
  assert.equal(legalActions(noPort, 'p0').hasGenericPort, false);
  assert.throws(() => act(noPort, request), /通用 3:1/);
  let enabled = grantGeneric(rich(actionGame(4, { mixedPortTrade: true })));
  enabled = act(enabled, request);
  assert.equal(enabled.players[0].resources.wood, 9);
  assert.equal(enabled.players[0].resources.brick, 9);
  assert.equal(enabled.players[0].resources.sheep, 9);
  assert.equal(enabled.players[0].resources.ore, 11);
  assert.throws(() => act(enabled, { ...request, mixed: false }), /同类/);
  assert.throws(() => act(enabled, { ...request, mixed: undefined }), /同类/);
  assert.throws(() => act(enabled, { ...request, mode: 'bank' }), /只能在港口/);
});

test('mixed port exchanges allow multiple varied groups and still enforce both inventories and disjoint resources', () => {
  let s = rich(actionGame(4, { mixedPortTrade: true }));
  const generic = s.board.ports.find(p => !p.resource);
  const v = s.board.vertices.find(v => v.id === generic.vertices[0]); v.owner = 'p0'; v.level = 1;
  s = act(s, { type: 'maritimeTrade', mode: 'port', mixed: true, give: { wood: 2, brick: 3, sheep: 4 }, get: { wheat: 2, ore: 1 } });
  assert.equal(s.players[0].resources.wood, 8); assert.equal(s.players[0].resources.brick, 7);
  assert.equal(s.players[0].resources.sheep, 6); assert.equal(s.players[0].resources.wheat, 12);
  assert.equal(s.players[0].resources.ore, 11);
  const before = structuredClone(s);
  assert.throws(() => act(s, { type: 'maritimeTrade', mode: 'port', mixed: true, give: { wood: 3 }, get: { wood: 1 } }), /相同/);
  assert.throws(() => act(s, { type: 'maritimeTrade', mode: 'port', mixed: true, give: { wood: 1, brick: 1 }, get: { ore: 1 } }), /3 张/);
  assert.throws(() => act(s, { type: 'maritimeTrade', mode: 'port', mixed: true, give: { wood: 3 }, get: { ore: 2 } }), /组数/);
  assert.throws(() => act(s, { type: 'maritimeTrade', mode: 'port', mixed: true, give: { wood: 30 }, get: { ore: 10 } }), /没有足够/);
  assert.deepEqual(s, before);
  s.bank.ore = 0;
  assert.throws(() => act(s, { type: 'maritimeTrade', mode: 'port', mixed: true, give: { wood: 3 }, get: { ore: 1 } }), /银行没有/);
});

test('player trades cannot gift cards, exchange same resource, or bypass current player', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  assert.throws(() => act(s, { type: 'offerTrade', give: { wood: 1 }, get: {} }), /双方/);
  assert.throws(() => act(s, { type: 'offerTrade', give: { wood: 2 }, get: { wood: 1 } }), /相同/);
  assert.throws(() => act(s, { type: 'offerTrade', give: { wood: 1 }, get: { ore: 1 }, targetId: 'p2' }, 'p1'), /当前/);
  s = act(s, { type: 'offerTrade', give: { wood: 1 }, get: { ore: 2 } }, 'p1');
  s = act(s, { type: 'acceptTrade', offerId: s.tradeOffers[0].id }, 'p0');
  assert.equal(s.players[0].resources.wood, 11); assert.equal(s.players[0].resources.ore, 8);
  assert.equal(s.players[1].resources.wood, 9); assert.equal(s.players[1].resources.ore, 12);
});

test('optional gifts require the recipient confirmation and cannot be empty or spend another player hand implicitly', () => {
  let s = actionGame(4, { allowGifts: true }); s.players.forEach(p => rich(s, p.id));
  const before = structuredClone(s.players.map(p => p.resources));
  s = act(s, { type: 'offerTrade', targetId: 'p1', give: { wood: 2, sheep: 1 }, get: {} });
  assert.deepEqual(s.players.map(p => p.resources), before, 'creating a gift must not transfer any cards');
  s = act(s, { type: 'rejectTrade', offerId: s.tradeOffers[0].id }, 'p1');
  assert.deepEqual(s.players.map(p => p.resources), before);
  s = act(s, { type: 'offerTrade', targetId: 'p1', give: { wood: 2, sheep: 1 }, get: {} });
  s = act(s, { type: 'acceptTrade', offerId: s.tradeOffers[0].id }, 'p1');
  assert.equal(s.players[0].resources.wood, 8); assert.equal(s.players[1].resources.wood, 12);
  const beforeRequest = structuredClone(s.players.map(p => p.resources));
  s = act(s, { type: 'offerTrade', targetId: 'p1', give: {}, get: { ore: 3 } });
  assert.deepEqual(s.players.map(p => p.resources), beforeRequest, 'gift request must not debit target automatically');
  s = act(s, { type: 'acceptTrade', offerId: s.tradeOffers[0].id }, 'p1');
  assert.equal(s.players[0].resources.ore, 13); assert.equal(s.players[1].resources.ore, 7);
  assert.throws(() => act(s, { type: 'offerTrade', targetId: 'p1', give: {}, get: {} }), /至少/);
  assert.throws(() => act(s, { type: 'offerTrade', targetId: 'p1', give: { wood: 3 }, get: { wood: 1 } }), /相同/);
  assert.throws(() => act(s, { type: 'offerTrade', targetId: 'p1', give: { wood: 100 }, get: {} }), /承诺/);
  assert.throws(() => act(s, { type: 'offerTrade', targetId: 'p2', give: { wood: 1 }, get: {} }, 'p1'), /当前/);
});

test('an unaffordable optional gift request follows the same private declined result', () => {
  let s = actionGame(4, { allowGifts: true });
  s.players[1].resources.ore = 0;
  s = act(s, { type: 'offerTrade', targetId: 'p1', give: {}, get: { ore: 1 } });
  const offerId = s.tradeOffers[0].id;
  assert.ok(legalActions(s, 'p1').tradeOffers.includes(offerId));
  assert.deepEqual(act(s, { type: 'acceptTrade', offerId }, 'p1'), act(s, { type: 'rejectTrade', offerId }, 'p1'));
});

test('accepting an unaffordable trade and explicitly declining it produce identical results', () => {
  for (const insufficientPlayer of ['p0', 'p1']) {
    let s = rich(actionGame());
    s.players[1].resources = Object.fromEntries(RESOURCES.map(r => [r, 0]));
    s.players[1].resources.ore = 2;
    s = act(s, { type: 'offerTrade', targetId: 'p1', give: { wood: 2, sheep: 1 }, get: { ore: 2, wheat: 1 } });
    if (insufficientPlayer === 'p0') {
      s.players[1].resources.wheat = 1;
      s.players[0].resources.wood = 0;
    }
    const offerId = s.tradeOffers[0].id;
    assert.ok(legalActions(s, 'p1').tradeOffers.includes(offerId), 'balance leaked by removing actionable offer');
    const accepted = act(s, { type: 'acceptTrade', offerId }, 'p1');
    const rejected = act(s, { type: 'rejectTrade', offerId }, 'p1');
    assert.deepEqual(accepted, rejected);
    assert.equal(accepted.log.at(-1).text, '资源交换未达成');
    assert.equal(accepted.tradeResult.status, 'declined');
    assert.deepEqual(accepted.players.map(p => p.resources), s.players.map(p => p.resources));
    assert.equal(accepted.tradeOffers.length, 0);
  }
});

test('targeted trade contents and results are visible only to their participants', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  s = act(s, { type: 'offerTrade', targetId: 'p1', give: { wood: 2, sheep: 1 }, get: { ore: 2, wheat: 1 } });
  const offerId = s.tradeOffers[0].id;
  assert.equal(publicState(s, 'p0').tradeOffers.length, 1);
  assert.equal(publicState(s, 'p1').tradeOffers.length, 1);
  assert.equal(publicState(s, 'p2').tradeOffers.length, 0);
  assert.deepEqual(legalActions(s, 'p2').tradeOffers, []);
  s = act(s, { type: 'acceptTrade', offerId }, 'p1');
  assert.equal(s.tradeResult.status, 'accepted');
  assert.equal(s.players[1].resources.wood, 12); assert.equal(s.players[1].resources.sheep, 11);
  assert.equal(s.players[1].resources.ore, 8); assert.equal(s.players[1].resources.wheat, 9);
  assert.equal(publicState(s, 'p2').tradeResult, null);
  assert.equal(publicState(s, 'p1').tradeResult.to, 'p1');
});

test('resolving one directed offer preserves independent offers and rechecks balances when each is accepted', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  s = act(s, { type: 'offerTrade', targetId: 'p1', give: { wood: 2 }, get: { ore: 2 } });
  const firstOfferId = s.tradeOffers[0].id;
  s = act(s, { type: 'offerTrade', targetId: 'p0', give: { wheat: 2 }, get: { brick: 2 } }, 'p2');
  const secondOfferId = s.tradeOffers.find(o => o.from === 'p2').id;
  s = act(s, { type: 'acceptTrade', offerId: firstOfferId }, 'p1');
  assert.equal(s.tradeOffers.length, 1); assert.equal(s.tradeOffers[0].id, secondOfferId);
  assert.ok(legalActions(s, 'p0').tradeOffers.includes(secondOfferId));
  s.players[0].resources.brick = 0;
  s = act(s, { type: 'acceptTrade', offerId: secondOfferId });
  assert.equal(s.tradeResult.status, 'declined'); assert.equal(s.log.at(-1).text, '资源交换未达成');
  assert.equal(s.tradeOffers.length, 0);
});

test('broadcast decline is private to its participants and leaves other recipients able to accept', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  s = act(s, { type: 'offerTrade', give: { wood: 2 }, get: { ore: 2 } });
  const offerId = s.tradeOffers[0].id;
  s = act(s, { type: 'rejectTrade', offerId }, 'p1');
  assert.equal(s.tradeOffers.length, 1);
  assert.deepEqual(s.tradeOffers[0].declinedBy, ['p1']);
  assert.deepEqual(legalActions(s, 'p1').tradeOffers, []);
  assert.ok(legalActions(s, 'p2').tradeOffers.includes(offerId));
  assert.equal(publicState(s, 'p1').tradeOffers.length, 0);
  for (const id of ['p0', 'p2', 'p3']) {
    const offer = publicState(s, id).tradeOffers[0];
    assert.equal(offer.id, offerId); assert.equal(Object.hasOwn(offer, 'declinedBy'), false);
  }
  assert.equal(publicState(s, 'p2').tradeResult, null);
  assert.equal(publicState(s, 'p0').tradeResult.to, 'p1');
  s = act(s, { type: 'acceptTrade', offerId }, 'p2');
  assert.equal(s.tradeOffers.length, 0); assert.equal(s.tradeResult.status, 'accepted');
  assert.equal(s.tradeResult.to, 'p2');
});

test('unaffordable acceptance of a broadcast is indistinguishable from its recipient declining', () => {
  let s = rich(actionGame());
  s.players[1].resources.ore = 0;
  s = act(s, { type: 'offerTrade', give: { wood: 1 }, get: { ore: 1 } });
  const offerId = s.tradeOffers[0].id;
  const attempted = act(s, { type: 'acceptTrade', offerId }, 'p1');
  const declined = act(s, { type: 'rejectTrade', offerId }, 'p1');
  assert.deepEqual(attempted, declined);
  assert.equal(attempted.tradeOffers.length, 1);
  assert.deepEqual(attempted.tradeOffers[0].declinedBy, ['p1']);
  assert.ok(legalActions(attempted, 'p2').tradeOffers.includes(offerId));
});

test('table trade requires two proposals and two separate confirmations before atomically moving cards', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  const before = structuredClone(s.players.map(p => p.resources));
  s = act(s, { type: 'createTableTrade', targetId: 'p1', give: { wood: 2, sheep: 1 } });
  const tradeId = s.tableTrades[0].id;
  assert.equal(s.tableTrades[0].response, null);
  assert.throws(() => act(s, { type: 'confirmTableTrade', tradeId }), /双方都摆好/);
  assert.throws(() => act(s, { type: 'respondTableTrade', tradeId, give: { ore: 1 } }), /只能回应/);
  s = act(s, { type: 'respondTableTrade', tradeId, give: { ore: 1, wheat: 2 } }, 'p1');
  assert.deepEqual(s.players.map(p => p.resources), before);
  s = act(s, { type: 'confirmTableTrade', tradeId });
  assert.deepEqual(s.tableTrades[0].confirmed, ['p0']);
  assert.deepEqual(s.players.map(p => p.resources), before, 'first confirmation must not move cards');
  s = act(s, { type: 'confirmTableTrade', tradeId });
  assert.deepEqual(s.tableTrades[0].confirmed, ['p0'], 'duplicate confirmation must not count twice');
  s = act(s, { type: 'confirmTableTrade', tradeId }, 'p1');
  assert.equal(s.tableTrades.length, 0); assert.equal(s.tableTradeResult.status, 'accepted');
  assert.equal(s.players[0].resources.wood, 8); assert.equal(s.players[0].resources.sheep, 9);
  assert.equal(s.players[0].resources.ore, 11); assert.equal(s.players[0].resources.wheat, 12);
  assert.equal(s.players[1].resources.wood, 12); assert.equal(s.players[1].resources.sheep, 11);
  assert.equal(s.players[1].resources.ore, 9); assert.equal(s.players[1].resources.wheat, 8);
});

test('table proposals and edits validate only own pledge, both-sided resources, and active-player participation', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  assert.throws(() => act(s, { type: 'createTableTrade', targetId: 'p1', give: {} }), /至少/);
  assert.throws(() => act(s, { type: 'createTableTrade', targetId: 'p1', give: { wood: 11 } }), /承诺/);
  assert.throws(() => act(s, { type: 'createTableTrade', targetId: 'p2', give: { wood: 1 } }, 'p1'), /当前/);
  s = act(s, { type: 'createTableTrade', give: { wood: 2 } }, 'p1');
  const tradeId = s.tableTrades[0].id;
  assert.equal(s.tableTrades[0].to, 'p0', 'inactive creator defaults to current player rather than a broadcast');
  assert.throws(() => act(s, { type: 'respondTableTrade', tradeId, give: { wood: 1 } }), /相同/);
  assert.throws(() => act(s, { type: 'respondTableTrade', tradeId, give: {} }), /至少/);
  s = act(s, { type: 'respondTableTrade', tradeId, give: { ore: 2 } });
  assert.throws(() => act(s, { type: 'updateTableTrade', tradeId, give: { ore: 1 } }, 'p1'), /相同/);
  assert.throws(() => act(s, { type: 'updateTableTrade', tradeId, give: { brick: 1 } }, 'p2'), /失效/);
  assert.throws(() => act(s, { type: 'confirmTableTrade', tradeId }, 'p2'), /失效/);
  assert.throws(() => act(s, { type: 'rejectTableTrade', tradeId }, 'p2'), /失效/);
});

test('editing either table proposal clears both confirmations and requires agreement to the new terms', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  s = act(s, { type: 'createTableTrade', targetId: 'p1', give: { wood: 1 } });
  const tradeId = s.tableTrades[0].id;
  s = act(s, { type: 'respondTableTrade', tradeId, give: { ore: 1 } }, 'p1');
  s = act(s, { type: 'confirmTableTrade', tradeId });
  s = act(s, { type: 'updateTableTrade', tradeId, give: { ore: 2 } }, 'p1');
  assert.deepEqual(s.tableTrades[0].confirmed, []); assert.equal(s.tableTrades[0].response.ore, 2);
  s = act(s, { type: 'confirmTableTrade', tradeId }, 'p1');
  s = act(s, { type: 'updateTableTrade', tradeId, give: { wood: 3 } });
  assert.deepEqual(s.tableTrades[0].confirmed, []); assert.equal(s.tableTrades[0].give.wood, 3);
  s = act(s, { type: 'confirmTableTrade', tradeId });
  assert.equal(s.tableTrades.length, 1);
  s = act(s, { type: 'confirmTableTrade', tradeId }, 'p1');
  assert.equal(s.players[0].resources.wood, 7); assert.equal(s.players[0].resources.ore, 12);
});

test('withdrawing table confirmation preserves terms and prevents the other confirmation from completing stale agreement', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  s = act(s, { type: 'createTableTrade', targetId: 'p1', give: { wood: 2 } });
  const tradeId = s.tableTrades[0].id;
  assert.throws(() => act(s, { type: 'unconfirmTableTrade', tradeId }), /双方都摆好/);
  s = act(s, { type: 'respondTableTrade', tradeId, give: { ore: 1 } }, 'p1');
  s = act(s, { type: 'confirmTableTrade', tradeId });
  const beforeHands = structuredClone(s.players.map(p => p.resources));
  const beforeTerms = { give: structuredClone(s.tableTrades[0].give), response: structuredClone(s.tableTrades[0].response) };
  assert.throws(() => act(s, { type: 'unconfirmTableTrade', tradeId }, 'p2'), /失效/);
  s = act(s, { type: 'unconfirmTableTrade', tradeId });
  assert.deepEqual(s.tableTrades[0].confirmed, []);
  assert.deepEqual(s.tableTrades[0].give, beforeTerms.give); assert.deepEqual(s.tableTrades[0].response, beforeTerms.response);
  assert.deepEqual(s.players.map(p => p.resources), beforeHands);
  s = act(s, { type: 'confirmTableTrade', tradeId }, 'p1');
  assert.equal(s.tableTrades.length, 1); assert.deepEqual(s.tableTrades[0].confirmed, ['p1']);
  assert.deepEqual(s.players.map(p => p.resources), beforeHands);
  s = act(s, { type: 'unconfirmTableTrade', tradeId });
  assert.deepEqual(s.tableTrades[0].confirmed, [], 'either party can clear a pending confirmation');
  s = act(s, { type: 'confirmTableTrade', tradeId });
  s = act(s, { type: 'confirmTableTrade', tradeId }, 'p1');
  assert.equal(s.tableTrades.length, 0); assert.equal(s.tableTradeResult.status, 'accepted');
});

test('withdrawal of confirmation requires a live private session in the trading phase', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  s = act(s, { type: 'createTableTrade', give: { wood: 1 } });
  const publicId = s.tableTrades[0].id;
  assert.throws(() => act(s, { type: 'unconfirmTableTrade', tradeId: publicId }), /双边/);
  s = act(s, { type: 'respondTableTrade', tradeId: publicId, give: { ore: 1 } }, 'p1');
  const tradeId = s.tableTrades.find(t => t.to === 'p1').id;
  s = act(s, { type: 'confirmTableTrade', tradeId });
  const paused = structuredClone(s); paused.phase = 'discard';
  assert.throws(() => act(paused, { type: 'unconfirmTableTrade', tradeId }), /失效/);
  s = act(s, { type: 'endTurn' });
  assert.throws(() => act(s, { type: 'unconfirmTableTrade', tradeId }, 'p0'), /失效/);
});

test('public table responders fork private independent sessions and completing one retires its parent and siblings', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  s = act(s, { type: 'createTableTrade', give: { wood: 2 } });
  const publicId = s.tableTrades[0].id;
  s = act(s, { type: 'respondTableTrade', tradeId: publicId, give: { ore: 1 } }, 'p1');
  const firstId = s.tableTrades.find(t => t.to === 'p1').id;
  s = act(s, { type: 'respondTableTrade', tradeId: publicId, give: { wheat: 2 } }, 'p2');
  const secondId = s.tableTrades.find(t => t.to === 'p2').id;
  s = act(s, { type: 'createTableTrade', targetId: 'p0', give: { brick: 1 } }, 'p3');
  const unrelatedId = s.tableTrades.find(t => t.from === 'p3').id;
  assert.equal(s.tableTrades.length, 4);
  assert.equal(s.tableTrades.find(t => t.id === firstId).parentId, publicId);
  assert.equal(publicState(s, 'p0').tableTrades.length, 4);
  assert.deepEqual(publicState(s, 'p1').tableTrades.map(t => t.id), [publicId, firstId]);
  assert.deepEqual(publicState(s, 'p2').tableTrades.map(t => t.id), [publicId, secondId]);
  s = act(s, { type: 'confirmTableTrade', tradeId: firstId }, 'p1');
  s = act(s, { type: 'confirmTableTrade', tradeId: firstId });
  assert.deepEqual(s.tableTrades.map(t => t.id), [unrelatedId]);
  assert.equal(s.players[0].resources.wood, 8); assert.equal(s.players[1].resources.wood, 12);
  assert.equal(s.players[2].resources.wood, 10);
  assert.throws(() => act(s, { type: 'confirmTableTrade', tradeId: secondId }, 'p2'), /失效/);
  assert.equal(publicState(s, 'p2').tableTradeResult, null);
  assert.equal(publicState(s, 'p1').tableTradeResult.status, 'accepted');
});

test('public table responses are reused per recipient, declined forks preserve other responses, and parent edits retire stale quotes', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  s = act(s, { type: 'createTableTrade', give: { wood: 1 } });
  const publicId = s.tableTrades[0].id;
  s = act(s, { type: 'respondTableTrade', tradeId: publicId, give: { ore: 1 } }, 'p1');
  const firstId = s.tableTrades.find(t => t.to === 'p1').id;
  s = act(s, { type: 'confirmTableTrade', tradeId: firstId });
  s = act(s, { type: 'respondTableTrade', tradeId: publicId, give: { ore: 2 } }, 'p1');
  assert.equal(s.tableTrades.length, 2); assert.equal(s.tableTrades.find(t => t.to === 'p1').id, firstId);
  assert.deepEqual(s.tableTrades.find(t => t.id === firstId).confirmed, []);
  s = act(s, { type: 'respondTableTrade', tradeId: publicId, give: { wheat: 1 } }, 'p2');
  s = act(s, { type: 'rejectTableTrade', tradeId: firstId }, 'p1');
  assert.ok(s.tableTrades.some(t => t.id === publicId)); assert.ok(s.tableTrades.some(t => t.to === 'p2'));
  s = act(s, { type: 'updateTableTrade', tradeId: publicId, give: { brick: 2 } });
  assert.deepEqual(s.tableTrades.map(t => t.id), [publicId]); assert.equal(s.tableTrades[0].give.brick, 2);
});

test('declining a public table invitation is private and does not hide it from other players', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  s = act(s, { type: 'createTableTrade', give: { wood: 1 } });
  const publicId = s.tableTrades[0].id;
  s = act(s, { type: 'rejectTableTrade', tradeId: publicId }, 'p1');
  assert.equal(publicState(s, 'p1').tableTrades.length, 0);
  assert.equal(publicState(s, 'p2').tableTrades.length, 1);
  assert.equal(Object.hasOwn(publicState(s, 'p2').tableTrades[0], 'declinedBy'), false);
  assert.equal(publicState(s, 'p2').tableTradeResult, null);
  assert.ok(!legalActions(s, 'p1').tableTradeIds.includes(publicId));
  assert.ok(legalActions(s, 'p2').tableTradeIds.includes(publicId));
  s = act(s, { type: 'rejectTableTrade', tradeId: publicId });
  assert.equal(s.tableTrades.length, 0);
});

test('table confirmation with either hand now insufficient matches explicit rejection byte-for-byte', () => {
  for (const depleted of ['p0', 'p1']) {
    let s = actionGame(); s.players.forEach(p => rich(s, p.id));
    s = act(s, { type: 'createTableTrade', targetId: 'p1', give: { wood: 2 } });
    const tradeId = s.tableTrades[0].id;
    s = act(s, { type: 'respondTableTrade', tradeId, give: { ore: 2 } }, 'p1');
    s = act(s, { type: 'confirmTableTrade', tradeId });
    s.players.find(p => p.id === depleted).resources[depleted === 'p0' ? 'wood' : 'ore'] = 0;
    const confirmed = act(s, { type: 'confirmTableTrade', tradeId }, 'p1');
    const rejected = act(s, { type: 'rejectTableTrade', tradeId }, 'p1');
    assert.deepEqual(confirmed, rejected);
    assert.equal(confirmed.log.at(-1).text, '资源交换未达成');
    assert.equal(confirmed.tableTradeResult.status, 'declined');
    assert.deepEqual(confirmed.players.map(p => p.resources), s.players.map(p => p.resources));
  }
});

test('normal spending retains pending table sessions but final confirmation rechecks the current hands', () => {
  let s = actionGame(); s.players.forEach(p => rich(s, p.id));
  s.players[0].resources.wood = 4;
  s = act(s, { type: 'createTableTrade', targetId: 'p1', give: { wood: 4 } });
  const tradeId = s.tableTrades[0].id;
  s = act(s, { type: 'respondTableTrade', tradeId, give: { ore: 1 } }, 'p1');
  s = act(s, { type: 'confirmTableTrade', tradeId });
  s = act(s, { type: 'maritimeTrade', mode: 'bank', give: { wood: 4 }, get: { brick: 1 } });
  assert.equal(s.tableTrades[0].id, tradeId);
  s = act(s, { type: 'confirmTableTrade', tradeId }, 'p1');
  assert.equal(s.tableTradeResult.status, 'declined'); assert.equal(s.players[0].resources.wood, 0);
  assert.equal(s.players[1].resources.wood, 10);
});

test('optional table gifts still need both confirmations and never allow two empty proposals', () => {
  let s = actionGame(4, { allowGifts: true }); s.players.forEach(p => rich(s, p.id));
  s = act(s, { type: 'createTableTrade', targetId: 'p1', give: {} });
  const tradeId = s.tableTrades[0].id;
  assert.throws(() => act(s, { type: 'respondTableTrade', tradeId, give: {} }, 'p1'), /至少/);
  s = act(s, { type: 'respondTableTrade', tradeId, give: { ore: 2 } }, 'p1');
  const before = structuredClone(s.players.map(p => p.resources));
  s = act(s, { type: 'confirmTableTrade', tradeId }, 'p1');
  assert.deepEqual(s.players.map(p => p.resources), before);
  s = act(s, { type: 'confirmTableTrade', tradeId });
  assert.equal(s.players[0].resources.ore, 12); assert.equal(s.players[1].resources.ore, 8);
});

test('rolling seven resets all table sessions and legacy offers before calculating hand-based discards', () => {
  let s = rich(finishSetup(game(4, { flexibleRoll: true })));
  rich(s, 'p1');
  s = act(s, { type: 'offerTrade', targetId: 'p1', give: { wood: 1 }, get: { ore: 1 } });
  s = act(s, { type: 'createTableTrade', give: { wood: 5, brick: 3 } });
  const publicId = s.tableTrades[0].id;
  s = act(s, { type: 'respondTableTrade', tradeId: publicId, give: { ore: 4 } }, 'p1');
  const privateId = s.tableTrades.find(t => t.to === 'p1').id;
  s = act(s, { type: 'confirmTableTrade', tradeId: privateId });
  const hands = structuredClone(s.players.map(p => p.resources));
  const beforeBoard = structuredClone(s.board);
  const reset = s.tableResetId;
  s = act(s, { type: 'roll', dice: [3, 4] });
  assert.equal(s.tableResetId, reset + 1); assert.equal(s.tableTrades.length, 0); assert.equal(s.tradeOffers.length, 0);
  assert.equal(s.phase, 'discard'); assert.equal(s.discardRequired.p0, 25); assert.equal(s.discardRequired.p1, 25);
  assert.deepEqual(s.players.map(p => p.resources), hands, 'proposed cards were never removed from hands');
  assert.deepEqual(s.board, beforeBoard);
  assert.equal(publicState(s, 'p1').tableResetId, reset + 1);
  assert.throws(() => act(s, { type: 'confirmTableTrade', tradeId: privateId }, 'p1'), /失效/);
  assert.throws(() => act(s, { type: 'roll', dice: [3, 4] }), /不能投/);
});

test('seven also resets table state without required discards, while other rolls preserve proposals', () => {
  for (const dice of [[3, 4], [1, 1]]) {
    let s = finishSetup(game(4, { flexibleRoll: true }));
    s.players.forEach(p => { p.resources = Object.fromEntries(RESOURCES.map(r => [r, 0])); });
    s.players[0].resources.wood = 2;
    s = act(s, { type: 'createTableTrade', give: { wood: 1 } });
    s = act(s, { type: 'roll', dice });
    const seven = dice[0] + dice[1] === 7;
    assert.equal(s.tableResetId, seven ? 1 : 0);
    assert.equal(s.tableTrades.length, seven ? 0 : 1);
    assert.equal(s.phase, seven ? 'robber' : 'actions');
  }
});

test('end of a personal turn closes table sessions, and paired/special phases cannot create them', () => {
  for (const extensionRule of ['paired', 'special']) {
    let s = actionGame(5, { extensionRule }); s.players.forEach(p => rich(s, p.id));
    s = act(s, { type: 'createTableTrade', targetId: 'p1', give: { wood: 1 } });
    s = act(s, { type: 'endTurn' });
    assert.equal(s.tableTrades.length, 0);
    assert.deepEqual(legalActions(s, s.activePlayerId).tableTradeIds, []);
    assert.throws(() => act(s, { type: 'createTableTrade', give: { wood: 1 } }), /不能/);
  }
});

test('consecutive normal builds undo in reverse order, refund all costs, and never expose history', () => {
  let s = rich(actionGame());
  const before = structuredClone(s);
  s = act(s, { type: 'buildRoad', edgeId: legalActions(s, 'p0').roads[0] });
  const afterFirst = structuredClone(s);
  s = act(s, { type: 'buildRoad', edgeId: legalActions(s, 'p0').roads[0] });
  assert.equal(s.undoStack.length, 2); assert.equal(legalActions(s, 'p0').canUndoBuild, true);
  assert.equal(legalActions(s, 'p1').canUndoBuild, false);
  assert.ok(s.undoStack.every(entry => !Object.hasOwn(entry.before, 'undoStack')));
  assert.equal(publicState(s, 'p0').undoStack, undefined);
  assert.equal(publicState(s, 'p1').undoStack, undefined);
  s = act(s, { type: 'undoBuild' });
  assert.deepEqual(s.board, afterFirst.board); assert.deepEqual(s.bank, afterFirst.bank);
  assert.deepEqual(s.players, afterFirst.players);
  s = act(s, { type: 'undoBuild' });
  assert.deepEqual(s.board, before.board); assert.deepEqual(s.bank, before.bank);
  assert.deepEqual(s.players, before.players);
  assert.equal(legalActions(s, 'p0').canUndoBuild, false);
});

test('settlement and city take-backs restore resource costs, pieces, points, and a gained port', () => {
  let s = rich(actionGame());
  s.board.vertices = [
    { id: 'a', x: 0, y: 0, tiles: [], neighbors: ['b'], owner: 'p0', level: 1 },
    { id: 'b', x: 1, y: 0, tiles: [], neighbors: ['a', 'c'], owner: null, level: 0 },
    { id: 'c', x: 2, y: 0, tiles: [], neighbors: ['b'], owner: null, level: 0 },
  ];
  s.board.edges = [{ id: 'ab', a: 'a', b: 'b', owner: 'p0' }, { id: 'bc', a: 'b', b: 'c', owner: 'p0' }];
  s.board.ports = [{ id: 'port', vertices: ['c'], resource: 'wood', ratio: 2 }];
  const beforeBank = structuredClone(s.bank), beforeResources = structuredClone(s.players[0].resources);
  s = act(s, { type: 'buildSettlement', vertexId: 'c' });
  assert.equal(legalActions(s, 'p0').bankRatios.wood, 2);
  s = act(s, { type: 'buildCity', vertexId: 'c' });
  assert.equal(s.board.vertices.find(v => v.id === 'c').level, 2);
  s = act(s, { type: 'undoBuild' }); assert.equal(s.board.vertices.find(v => v.id === 'c').level, 1);
  s = act(s, { type: 'undoBuild' }); assert.equal(s.board.vertices.find(v => v.id === 'c').owner, null);
  assert.equal(legalActions(s, 'p0').bankRatios.wood, 4);
  assert.deepEqual(s.bank, beforeBank); assert.deepEqual(s.players[0].resources, beforeResources);
  assert.equal(s.players[0].points, 1);
});

test('taking back a fifth road returns the longest-route award and its points', () => {
  let s = rich(actionGame());
  s.board.vertices = Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, x: i, y: 0, tiles: [], neighbors: [i > 0 ? `u${i - 1}` : null, i < 5 ? `u${i + 1}` : null].filter(Boolean), owner: i === 0 ? 'p0' : null, level: i === 0 ? 1 : 0 }));
  s.board.edges = Array.from({ length: 5 }, (_, i) => ({ id: `ue${i}`, a: `u${i}`, b: `u${i + 1}`, owner: i < 4 ? 'p0' : null }));
  s.board.ports = [];
  s = act(s, { type: 'buildRoad', edgeId: 'ue4' });
  assert.equal(s.longestRoadHolder, 'p0'); assert.equal(s.players[0].points, 3);
  s = act(s, { type: 'undoBuild' });
  assert.equal(s.longestRoadHolder, null); assert.equal(s.players[0].points, 1);
  assert.equal(s.players[0].longestRoadLength, 4);
});

test('any successful intervening non-build action locks take-backs, including another player offer', () => {
  for (const interrupt of ['bank', 'buy', 'otherOffer', 'end']) {
    let s = rich(actionGame()); rich(s, 'p1');
    s = act(s, { type: 'buildRoad', edgeId: legalActions(s, 'p0').roads[0] });
    assert.equal(legalActions(s, 'p0').canUndoBuild, true);
    if (interrupt === 'bank') s = act(s, { type: 'bankTrade', give: 'ore', get: 'wood' });
    if (interrupt === 'buy') s = act(s, { type: 'buyDevelopment' });
    if (interrupt === 'otherOffer') s = act(s, { type: 'offerTrade', give: { wood: 1 }, get: { ore: 1 } }, 'p1');
    if (interrupt === 'end') s = act(s, { type: 'endTurn' });
    assert.equal(s.undoStack.length, 0); assert.equal(legalActions(s, 'p0').canUndoBuild, false);
    assert.throws(() => act(s, { type: 'undoBuild' }, 'p0'), /不能撤销|可以撤销/);
  }
});

test('setup village may be undone before its road, but placing that road commits the setup step', () => {
  let s = game();
  const before = structuredClone(s);
  const vertexId = legalActions(s, 'p0').settlements[0];
  s = act(s, { type: 'buildSettlement', vertexId });
  assert.equal(legalActions(s, 'p0').canUndoBuild, true);
  s = act(s, { type: 'undoBuild' });
  assert.equal(s.phase, 'setup_settlement'); assert.deepEqual(s.board, before.board); assert.deepEqual(s.bank, before.bank);
  s = act(s, { type: 'buildSettlement', vertexId });
  s = act(s, { type: 'buildRoad', edgeId: legalActions(s, 'p0').roads[0] });
  assert.equal(s.activePlayerId, 'p1'); assert.equal(s.undoStack.length, 0);
});

test('undo can be disabled and a winning build is final', () => {
  let s = rich(actionGame(4, { allowUndo: false }));
  s = act(s, { type: 'buildRoad', edgeId: legalActions(s, 'p0').roads[0] });
  assert.equal(legalActions(s, 'p0').canUndoBuild, false);
  assert.throws(() => act(s, { type: 'undoBuild' }), /可以撤销/);
  s = rich(actionGame());
  s.players[0].development = Array.from({ length: 7 }, (_, i) => ({ id: `v${i}`, type: 'victoryPoint', boughtTurn: 0 }));
  const vertexId = legalActions(s, 'p0').cities[0];
  s = act(s, { type: 'buildCity', vertexId });
  assert.equal(s.winner, 'p0'); assert.equal(s.undoStack.length, 0);
  assert.throws(() => act(s, { type: 'undoBuild' }), /结束/);
});

test('longest road counts a hexagonal loop and opposing buildings break traversal', () => {
  let s = actionGame();
  s.board.edges.forEach(e => { e.owner = null; });
  s.board.vertices.forEach(v => { v.owner = null; v.level = 0; });
  const tile = s.board.tiles.find(t => t.q === 0 && t.r === 0);
  for (let i = 0; i < 6; i++) {
    const a = tile.vertices[i], b = tile.vertices[(i + 1) % 6];
    s.board.edges.find(e => (e.a === a && e.b === b) || (e.b === a && e.a === b)).owner = 'p0';
  }
  s = act(s, { type: 'endTurn' });
  assert.equal(s.players[0].longestRoadLength, 6); assert.equal(s.longestRoadHolder, 'p0');
  for (const id of [tile.vertices[0], tile.vertices[3]]) {
    const v = s.board.vertices.find(v => v.id === id); v.owner = 'p1'; v.level = 1;
  }
  s = act(s, { type: 'roll', dice: [1, 1] }); s = act(s, { type: 'endTurn' });
  assert.equal(s.players[0].longestRoadLength, 3); assert.equal(s.longestRoadHolder, null);
});

test('breaking a route transfers its bonus but an off-turn ten-point recipient must wait for their turn', () => {
  let s = rich(actionGame());
  const vertices = [], edges = [];
  function line(prefix, length, owner) {
    for (let i = 0; i <= length; i++) vertices.push({ id: `${prefix}${i}`, x: i, y: 0, tiles: [], neighbors: [], owner: null, level: 0 });
    for (let i = 0; i < length; i++) {
      const a = `${prefix}${i}`, b = `${prefix}${i + 1}`;
      edges.push({ id: `${prefix}e${i}`, a, b, owner });
      vertices.find(v => v.id === a).neighbors.push(b); vertices.find(v => v.id === b).neighbors.push(a);
    }
  }
  line('old', 7, 'p1'); line('new', 6, 'p2');
  vertices.push({ id: 'branch', x: 0, y: 0, tiles: [], neighbors: ['old3'], owner: null, level: 0 });
  vertices.find(v => v.id === 'old3').neighbors.push('branch');
  edges.push({ id: 'branchRoad', a: 'branch', b: 'old3', owner: 'p0' });
  for (let i = 0; i < 4; i++) vertices.push({ id: `city${i}`, x: 0, y: 0, tiles: [], neighbors: [], owner: 'p2', level: 2 });
  s.board.vertices = vertices; s.board.edges = edges; s.board.ports = []; s.longestRoadHolder = 'p1';
  s = act(s, { type: 'buildSettlement', vertexId: 'old3' });
  assert.equal(s.longestRoadHolder, 'p2'); assert.equal(s.players[2].totalPoints, 10); assert.equal(s.winner, null);
  s = act(s, { type: 'endTurn' }); assert.equal(s.winner, null);
  s = act(s, { type: 'roll', dice: [1, 1] }); s = act(s, { type: 'endTurn' });
  assert.equal(s.winner, 'p2'); assert.equal(s.phase, 'finished');
});

test('paired player can win immediately with newly purchased hidden victory point card', () => {
  let s = actionGame(5);
  s = act(s, { type: 'endTurn' });
  rich(s);
  const p = s.players.find(p => p.id === 'p3');
  p.development = Array.from({ length: 7 }, (_, i) => ({ id: `v${i}`, type: 'victoryPoint', boughtTurn: 0 }));
  s.developmentDeck = ['victoryPoint'];
  s = act(s, { type: 'buyDevelopment' });
  assert.equal(s.phase, 'finished'); assert.equal(s.winner, 'p3');
  assert.equal(s.players.find(p => p.id === 'p3').totalPoints, 10);
});

test('third knight can trigger an immediate victory before any further action', () => {
  let s = actionGame();
  const p = s.players[0];
  p.playedKnights = 2;
  p.development = [
    { id: 'knight', type: 'knight', boughtTurn: 0 },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `vp${i}`, type: 'victoryPoint', boughtTurn: 0 })),
  ];
  s = act(s, { type: 'playDevelopment', cardId: 'knight' });
  assert.equal(s.largestArmyHolder, 'p0');
  assert.equal(s.winner, 'p0');
  assert.equal(s.phase, 'finished');
});
