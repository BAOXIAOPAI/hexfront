import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's native TypeScript test runner requires the source extension.
import { availableHand, BUILD_COSTS, canDiscard, canStage, coversCost, maritimeQuote, reconcileStaged, spendStagedBuild, stagedBuildAffordability, stagedBuildOptions } from "../lib/ui-staging.ts";
import { applyAction, legalActions, newGame } from "../lib/engine.js";

const noPorts = { wood: 4, brick: 4, sheep: 4, wheat: 4, ore: 4 };
const generic = { wood: 3, brick: 3, sheep: 3, wheat: 3, ore: 3 };
const specialized = { ...noPorts, ore: 2 };
const allLegal = { roads: ["e1"], settlements: ["v1"], cities: ["v2"], canBuyDevelopment: true };

test("staging consumes only the displayed hand and cannot stage beyond inventory", () => {
  const hand = Object.freeze({ wood: 2, brick: 1, ore: 3 });
  const staged = Object.freeze({ wood: 1, ore: 3 });
  assert.deepEqual(availableHand(hand, staged), { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 });
  assert.equal(canStage(hand, staged, "wood"), true);
  assert.equal(canStage(hand, staged, "ore"), false);
  assert.equal(canStage(hand, staged, "wheat"), false);
  assert.deepEqual(hand, { wood: 2, brick: 1, ore: 3 });
  assert.deepEqual(staged, { wood: 1, ore: 3 });
});

test("hand updates clamp stale staged cards and never produce negative counts", () => {
  const hand = Object.freeze({ wood: 1, brick: 2 });
  const staged = Object.freeze({ wood: 3, brick: 1, ore: 1 });
  assert.deepEqual(reconcileStaged(hand, staged), { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 });
  assert.deepEqual(availableHand(hand, staged), { wood: 0, brick: 1, sheep: 0, wheat: 0, ore: 0 });
  assert.equal(canStage(hand, staged, "wood"), false);
  assert.equal(canStage(hand, staged, "brick"), true);
  const reconciled = reconcileStaged(hand, staged);
  assert.deepEqual(reconcileStaged(hand, reconciled), reconciled);
});

test("construction availability requires both staged cost and a legal action", () => {
  assert.deepEqual(stagedBuildOptions({ wood: 1, brick: 1 }, allLegal), { road: true, settlement: false, city: false, development: false });
  assert.deepEqual(stagedBuildOptions({ wood: 1, brick: 1, sheep: 1, wheat: 2, ore: 3 }, allLegal), { road: true, settlement: true, city: true, development: true });
  assert.deepEqual(stagedBuildOptions({ wood: 10, brick: 10, sheep: 10, wheat: 10, ore: 10 }, { roads: [], settlements: [], cities: [], canBuyDevelopment: false }), { road: false, settlement: false, city: false, development: false });
  assert.equal(coversCost({ wheat: 2, ore: 2 }, BUILD_COSTS.city), false);
  assert.equal(coversCost({ wood: 4, brick: 1 }, BUILD_COSTS.road), true);
  assert.equal(Object.isFrozen(BUILD_COSTS.road), true);
});

test("resource affordability remains true even when the current turn forbids construction", () => {
  const staged = Object.freeze({ wood: 3, brick: 3, sheep: 1, wheat: 2, ore: 3 });
  assert.deepEqual(stagedBuildAffordability(staged), { road: true, settlement: true, city: true, development: true });
  assert.deepEqual(stagedBuildOptions(staged, {}), { road: false, settlement: false, city: false, development: false });
  assert.deepEqual(stagedBuildAffordability({ wood: 3, brick: 3 }), { road: true, settlement: false, city: false, development: false });
  assert.deepEqual(stagedBuildAffordability({ wheat: 2, ore: 2 }), { road: false, settlement: false, city: false, development: false });
  assert.deepEqual(stagedBuildAffordability({}), { road: false, settlement: false, city: false, development: false });
});

test("three wood and brick pay for three roads one at a time without clearing the basket", () => {
  const original = Object.freeze({ wood: 3, brick: 3 });
  let staged = spendStagedBuild(original, "road");
  assert.deepEqual(staged, { wood: 2, brick: 2, sheep: 0, wheat: 0, ore: 0 });
  assert.equal(stagedBuildOptions(staged, allLegal).road, true);
  const first = Object.freeze(staged);
  staged = spendStagedBuild(first, "road");
  assert.deepEqual(staged, { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 });
  assert.equal(stagedBuildOptions(staged, allLegal).road, true);
  staged = spendStagedBuild(staged, "road");
  assert.deepEqual(staged, { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
  assert.equal(stagedBuildOptions(staged, allLegal).road, false);
  assert.deepEqual(original, { wood: 3, brick: 3 });
  assert.deepEqual(first, { wood: 2, brick: 2, sheep: 0, wheat: 0, ore: 0 });
});

test("each build payment preserves unrelated and excess resources in a fresh normalized basket", () => {
  const staged = Object.freeze({ wood: 4, brick: 3, sheep: 2, wheat: 5, ore: 6 });
  const expected = {
    road: { wood: 3, brick: 2, sheep: 2, wheat: 5, ore: 6 },
    settlement: { wood: 3, brick: 2, sheep: 1, wheat: 4, ore: 6 },
    city: { wood: 4, brick: 3, sheep: 2, wheat: 3, ore: 3 },
    development: { wood: 4, brick: 3, sheep: 1, wheat: 4, ore: 5 },
  };
  for (const [kind, remainder] of Object.entries(expected)) {
    const result = spendStagedBuild(staged, kind);
    assert.deepEqual(result, remainder);
    assert.notEqual(result, staged);
  }
  assert.deepEqual(spendStagedBuild({ sheep: 1, wheat: 1, ore: 1 }, "development"), { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
  assert.deepEqual(staged, { wood: 4, brick: 3, sheep: 2, wheat: 5, ore: 6 });
});

test("insufficient build payments and unknown build kinds throw without mutating the basket", () => {
  const incomplete = {
    road: Object.freeze({ wood: 3 }),
    settlement: Object.freeze({ wood: 1, brick: 1, sheep: 1 }),
    city: Object.freeze({ wheat: 2, ore: 2 }),
    development: Object.freeze({ sheep: 1, wheat: 1 }),
  };
  for (const [kind, staged] of Object.entries(incomplete)) {
    const original = { ...staged };
    assert.throws(() => spendStagedBuild(staged, kind), /不足/);
    assert.deepEqual(staged, original);
  }
  for (const kind of ["", "bridge", "toString", "__proto__", null, undefined, 1, {}]) {
    assert.throws(() => spendStagedBuild({ wood: 3, brick: 3 }, kind), /类型无效/);
  }
});

test("real game actions deduct one road payment and leave staged resources usable for the next action", () => {
  let state = newGame([{ id: "a" }, { id: "b" }, { id: "c" }], { firstPlayerIndex: 0, rng: () => 0.37 });
  while (state.phase.startsWith("setup")) {
    const legal = legalActions(state, state.activePlayerId);
    state = applyAction(state, state.activePlayerId, state.phase === "setup_settlement"
      ? { type: "buildSettlement", vertexId: legal.settlements[0] }
      : { type: "buildRoad", edgeId: legal.roads[0] });
  }
  const playerId = state.activePlayerId;
  state = applyAction(state, playerId, { type: "roll", dice: [1, 1] });
  assert.equal(state.phase, "actions");
  const player = state.players.find((candidate: { id: string }) => candidate.id === playerId)!;
  const initial = { wood: 3, brick: 3, sheep: 2, wheat: 2, ore: 2 };
  for (const resource of Object.keys(initial) as Array<keyof typeof initial>) {
    state.bank[resource] += player.resources[resource] - initial[resource];
  }
  player.resources = { ...initial };
  let staged = { ...initial };
  for (const remaining of [2, 1, 0]) {
    const legal = legalActions(state, playerId);
    assert.equal(stagedBuildOptions(staged, legal).road, true);
    const bankBefore = { ...state.bank };
    state = applyAction(state, playerId, { type: "buildRoad", edgeId: legal.roads[0] });
    staged = spendStagedBuild(staged, "road");
    const expected = { wood: remaining, brick: remaining, sheep: 2, wheat: 2, ore: 2 };
    assert.deepEqual(state.players.find((candidate: { id: string }) => candidate.id === playerId)!.resources, expected);
    assert.deepEqual(staged, expected);
    assert.equal(state.bank.wood, bankBefore.wood + 1);
    assert.equal(state.bank.brick, bankBefore.brick + 1);
    assert.equal(stagedBuildOptions(staged, legalActions(state, playerId)).road, remaining > 0);
  }
  assert.equal(stagedBuildOptions(staged, legalActions(state, playerId)).development, true);
  const cardsBefore = state.players.find((candidate: { id: string }) => candidate.id === playerId)!.development.length;
  state = applyAction(state, playerId, { type: "buyDevelopment" });
  staged = spendStagedBuild(staged, "development");
  const after = state.players.find((candidate: { id: string }) => candidate.id === playerId)!;
  assert.deepEqual(staged, { wood: 0, brick: 0, sheep: 1, wheat: 1, ore: 1 });
  assert.deepEqual(after.resources, staged);
  assert.equal(after.development.length, cardsBefore + 1);
  assert.equal(stagedBuildOptions(staged, legalActions(state, playerId)).development, true);
});

test("bank exchange always uses four of each resource despite port ratios", () => {
  assert.deepEqual(maritimeQuote({ wood: 8, ore: 4 }, "bank", specialized, false, false, false), { valid: true, receiveCount: 3, reason: "" });
  assert.equal(maritimeQuote({ ore: 2 }, "bank", specialized, false, false, false).valid, false);
  assert.equal(maritimeQuote({ wood: 2, brick: 2 }, "bank", noPorts, false, false, false).valid, false);
  assert.equal(maritimeQuote({ wood: 3 }, "bank", generic, true, true, true).valid, false);
});

test("standard port exchange combines whole groups and rejects unrelated resources", () => {
  const ports = { ...generic, ore: 2 };
  assert.deepEqual(maritimeQuote({ wood: 6, ore: 4 }, "port", ports, true, false, false), { valid: true, receiveCount: 4, reason: "" });
  assert.equal(maritimeQuote({ wood: 1, brick: 2 }, "port", generic, true, false, false).valid, false);
  assert.equal(maritimeQuote({ wood: 4 }, "port", specialized, false, false, false).valid, false);
  assert.deepEqual(maritimeQuote({ ore: 6 }, "port", specialized, false, false, false), { valid: true, receiveCount: 3, reason: "" });
});

test("mixed ports require the house rule plus a generic port, including multi-group payments", () => {
  const basket = { wood: 1, brick: 2, ore: 3 };
  assert.deepEqual(maritimeQuote(basket, "port", generic, true, true, true), { valid: true, receiveCount: 2, reason: "" });
  assert.equal(maritimeQuote(basket, "port", generic, true, false, true).valid, false);
  assert.equal(maritimeQuote(basket, "port", specialized, false, true, true).valid, false);
  assert.equal(maritimeQuote({ wood: 1, brick: 3 }, "port", generic, true, true, true).valid, false);
  assert.equal(maritimeQuote({ wood: 3 }, "port", generic, true, false, false).valid, true);
});

test("discard confirms exactly the authoritative amount, including odd-count variants", () => {
  assert.equal(canDiscard({ wood: 2, ore: 2 }, 4), true);
  assert.equal(canDiscard({ wood: 2, ore: 2 }, 5), false);
  assert.equal(canDiscard({ wood: 2, ore: 3 }, 5), true);
  assert.equal(canDiscard({ wood: 2, ore: 4 }, 5), false);
  assert.equal(canDiscard({}, 0), true);
  assert.equal(canDiscard({ wood: 1 }, -1), false);
  assert.equal(canDiscard({ wood: 1 }, 1.5), false);
});

test("unknown resources and malformed quantities fail closed without coercion", () => {
  const invalid = [
    { gold: 0 }, { wood: -1 }, { wood: 0.5 }, { wood: "1" }, { wood: null }, { wood: undefined },
    { wood: NaN }, { wood: Infinity }, { wood: Number.MAX_SAFE_INTEGER + 1 },
    { wood: Number.MAX_SAFE_INTEGER, brick: 1 }, [], null,
  ];
  for (const basket of invalid) {
    assert.equal(canStage({ wood: 5 }, basket, "wood"), false);
    assert.equal(coversCost(basket, BUILD_COSTS.road), false);
    assert.equal(canDiscard(basket, 1), false);
    assert.deepEqual(stagedBuildOptions(basket, allLegal), { road: false, settlement: false, city: false, development: false });
    assert.deepEqual(stagedBuildAffordability(basket), { road: false, settlement: false, city: false, development: false });
    assert.deepEqual(maritimeQuote(basket, "port", generic, true, true, true).receiveCount, 0);
    assert.equal(maritimeQuote(basket, "bank", noPorts, false, false, false).valid, false);
    assert.throws(() => availableHand({ wood: 5 }, basket));
    assert.throws(() => reconcileStaged({ wood: 5 }, basket));
    assert.throws(() => spendStagedBuild(basket, "road"));
  }
  assert.equal(canStage({ wood: 5 }, {}, "gold"), false);
  assert.equal(canStage({ wood: "5" }, {}, "wood"), false);
  assert.equal(coversCost({ wood: 2 }, { wood: 1, gold: 0 }), false);
  assert.throws(() => availableHand({ wood: -2 }, {}));
});

test("empty payments and invalid port ratios never produce an actionable quote", () => {
  assert.equal(maritimeQuote({}, "bank", noPorts, false, false, false).valid, false);
  for (const ratios of [{ ore: 0 }, { ore: 1 }, { ore: 2.5 }, { ore: "2" }, { gold: 3 }, null, []]) {
    assert.equal(maritimeQuote({ ore: 2 }, "port", ratios, false, false, false).valid, false);
  }
});
