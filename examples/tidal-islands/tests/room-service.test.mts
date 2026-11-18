import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error Node's native TypeScript runner requires the source extension.
import { assertRoomRequestOrigin, atmosphericDice, createD1RoomStore, createRoomService, RoomError, roomRequestToken } from "../lib/room-service.ts";
import type { GameState, RoomPlayer, RoomRecord, RoomStore } from "../lib/room-service.ts";

function memoryStore(): RoomStore & { data: Map<string, RoomRecord> } {
  const data = new Map<string, RoomRecord>();
  return {
    data,
    async find(code) { return structuredClone(data.get(code) ?? null); },
    async insert(room) {
      if (data.has(room.code)) return false;
      data.set(room.code, structuredClone(room));
      return true;
    },
    async compareAndSwap(room, expectedVersion) {
      if (data.get(room.code)?.version !== expectedVersion) return false;
      data.set(room.code, structuredClone(room));
      return true;
    },
  };
}

const testEngine = {
  newGame(players: RoomPlayer[]) {
    return { phase: "roll", activePlayerId: players[0].id, players: players.map((p) => ({ ...p, resources: { ore: 3 } })), secret: "hidden-development-deck" };
  },
  applyAction(game: GameState, playerId: string, action: Record<string, unknown>) {
    if (game.activePlayerId !== playerId) throw new Error("还未轮到你");
    if (action.type !== "roll") throw new Error("未知操作");
    return { ...game, phase: "actions", dice: action.dice, actor: playerId };
  },
  publicState(game: GameState, playerId: string) {
    return { phase: game.phase, activePlayerId: game.activePlayerId, dice: game.dice, ownId: playerId, ownResources: { ore: 3 } };
  },
  legalActions(game: GameState, playerId: string) { return { canRoll: game.phase === "roll" && game.activePlayerId === playerId }; },
};

const fetchDice: typeof fetch = async () => new Response("2\n5\n");
const extraRules = ["infiniteBank", "flexibleRoll", "allowGifts", "roundUpDiscard"] as const;

async function setup(expanded = false, maxPlayers = expanded ? 5 : 3) {
  const store = memoryStore();
  const service = createRoomService(store, { engine: testEngine, fetcher: fetchDice });
  const host = await service.create({ name: "船长", options: { expanded, maxPlayers } });
  const credentials = [host];
  for (let i = 1; i < (expanded ? 5 : 3); i++) credentials.push(await service.join({ code: host.room.code, name: `水手${i}` }));
  return { store, service, host, credentials };
}

const errorCode = (code: string) => (error: unknown) => error instanceof RoomError && error.code === code;

test("room creation stays in lobby, credentials are private and a full 256 bits", async () => {
  const store = memoryStore();
  const service = createRoomService(store, { engine: testEngine });
  const host = await service.create({ name: "船长" });
  assert.equal(host.room.status, "lobby");
  assert.equal(host.room.game, null);
  assert.match(host.room.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.match(host.token!, /^[a-f0-9]{64}$/);
  const stored = store.data.get(host.room.code)!;
  assert.notEqual(stored.members[0].tokenHash, host.token);
  assert.equal(JSON.stringify(host.room).includes("tokenHash"), false);
  assert.equal(JSON.stringify(host.room).includes(host.token!), false);
  const fetched = await service.get(host.room.code, host.token);
  assert.equal("token" in fetched, false);
  await assert.rejects(service.get(host.room.code, "0".repeat(64)), errorCode("UNAUTHORIZED"));
  await assert.rejects(service.start({ code: host.room.code, token: host.token, version: 1 }), errorCode("PLAYER_COUNT"));
});

test("only the host starts, with current version and official player count", async () => {
  const { service, host, credentials } = await setup();
  const version = credentials.at(-1)!.room.version;
  await assert.rejects(service.start({ code: host.room.code, token: credentials[1].token, version }), errorCode("HOST_REQUIRED"));
  await assert.rejects(service.start({ code: host.room.code, token: host.token, version: 1 }), errorCode("VERSION_CONFLICT"));
  const started = await service.start({ code: host.room.code, token: host.token, version });
  assert.equal(started.room.status, "playing");
  assert.equal(JSON.stringify(started).includes("hidden-development-deck"), false);
  await assert.rejects(service.join({ code: host.room.code, name: "迟到者" }), errorCode("GAME_ALREADY_STARTED"));
  const large = await setup(true);
  const largeStarted = await large.service.start({ code: large.host.room.code, token: large.host.token, version: large.credentials.at(-1)!.room.version });
  assert.equal(largeStarted.room.players.length, 5);
});

test("concurrent joins cannot overfill a room or lose members", async () => {
  const { service, host } = await setup(false, 4);
  const joined = await Promise.allSettled([
    service.join({ code: host.room.code, name: "红" }),
    service.join({ code: host.room.code, name: "蓝" }),
  ]);
  assert.equal(joined.filter((result) => result.status === "fulfilled").length, 1);
  const room = await service.get(host.room.code, host.token);
  assert.equal(room.room.players.length, 4);
  assert.equal(new Set(room.room.players.map((p) => p.id)).size, 4);
});

test("roll ignores client dice and player IDs, while concurrent actions use CAS", async () => {
  const { service, host, credentials } = await setup();
  const started = await service.start({ code: host.room.code, token: host.token, version: credentials.at(-1)!.room.version });
  const payload = { code: host.room.code, token: host.token, version: started.room.version, action: { type: "roll", dice: [6, 6], playerId: credentials[1].playerId } };
  const rolled = await Promise.allSettled([service.action(payload), service.action(payload)]);
  assert.equal(rolled.filter((result) => result.status === "fulfilled").length, 1);
  const snapshot = await service.get(host.room.code, host.token);
  assert.deepEqual((snapshot.room.game as GameState).dice, [2, 5]);
  assert.equal(snapshot.room.version, started.room.version + 1);
  await assert.rejects(service.action(payload), errorCode("VERSION_CONFLICT"));
});

test("randomness failure does not advance the room or fall back", async () => {
  const { store, service, host, credentials } = await setup();
  const started = await service.start({ code: host.room.code, token: host.token, version: credentials.at(-1)!.room.version });
  const broken = createRoomService(store, { engine: testEngine, fetcher: async () => { throw new Error("offline"); } });
  await assert.rejects(broken.action({ code: host.room.code, token: host.token, version: started.room.version, action: { type: "roll", dice: [4, 4] } }), errorCode("RANDOM_UNAVAILABLE"));
  const snapshot = await service.get(host.room.code, host.token);
  assert.equal(snapshot.room.version, started.room.version);
  assert.equal((snapshot.room.game as GameState).phase, "roll");
  for (const response of ["0\n5", "2\n7", "2\n5\n4", "quota exceeded", "<html>2 5</html>"]) {
    await assert.rejects(atmosphericDice(async () => new Response(response)), errorCode("RANDOM_UNAVAILABLE"));
  }
});

test("out of turn rolls fail before asking the external random service", async () => {
  const { store, service, host, credentials } = await setup();
  const started = await service.start({ code: host.room.code, token: host.token, version: credentials.at(-1)!.room.version });
  let calls = 0;
  const observed = createRoomService(store, { engine: testEngine, fetcher: async () => { calls++; return new Response("2\n5"); } });
  await assert.rejects(observed.action({ code: host.room.code, token: credentials[1].token, version: started.room.version, action: { type: "roll" } }), errorCode("INVALID_ACTION"));
  assert.equal(calls, 0);
});

test("D1 adapter persists private JSON and checks the actual SQL version", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE rooms (code TEXT PRIMARY KEY, version INTEGER NOT NULL, host_id TEXT NOT NULL, status TEXT NOT NULL, options_json TEXT NOT NULL, members_json TEXT NOT NULL, game_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  const database = {
    prepare(sql: string) {
      let parameters: unknown[] = [];
      return {
        bind(...values: unknown[]) { parameters = values; return this; },
        async first() { return sqlite.prepare(sql).get(...parameters as (string | number | null)[]) ?? null; },
        async run() { const result = sqlite.prepare(sql).run(...parameters as (string | number | null)[]); return { meta: { changes: Number(result.changes) } }; },
      };
    },
  } as unknown as D1Database;
  const store = createD1RoomStore(database);
  const service = createRoomService(store, { engine: testEngine });
  const host = await service.create({ name: "数据库船长" });
  await service.updateOptions({ code: host.room.code, token: host.token, version: host.room.version, options: { mixedPortTrade: true, allowUndo: false } });
  const original = (await store.find(host.room.code))!;
  assert.equal(original.members[0].name, "数据库船长");
  assert.equal(original.options.mixedPortTrade, true);
  assert.equal(original.options.allowUndo, false);
  const next = { ...original, version: original.version + 1 };
  assert.equal(await store.compareAndSwap(next, original.version), true);
  assert.equal(await store.compareAndSwap(next, original.version), false);
  assert.equal((await store.find(host.room.code))!.version, 3);
  sqlite.close();
});

test("real engine completes multiplayer setup and filters opponents' private hands", async () => {
  const service = createRoomService(memoryStore(), { fetcher: fetchDice });
  const host = await service.create({ name: "船长", options: { maxPlayers: 3 } });
  const second = await service.join({ code: host.room.code, name: "水手甲" });
  const third = await service.join({ code: host.room.code, name: "水手乙" });
  const sessions = [host, second, third];
  let result = await service.start({ code: host.room.code, token: host.token, version: third.room.version });
  for (let step = 0; step < 12; step++) {
    const game = result.room.game as { phase: string; activePlayerId: string };
    const actor = sessions.find((session) => session.playerId === game.activePlayerId)!;
    const current = await service.get(host.room.code, actor.token);
    const legal = current.room.legalActions as { settlements: number[]; roads: number[] };
    const action = game.phase === "setup_settlement"
      ? { type: "buildSettlement", vertexId: legal.settlements[0] }
      : { type: "buildRoad", edgeId: legal.roads[0] };
    result = await service.action({ code: host.room.code, token: actor.token, version: current.room.version, action });
  }
  const game = result.room.game as { phase: string; activePlayerId: string; players: { id: string; resources?: unknown; development?: unknown }[] };
  assert.equal(game.phase, "roll");
  const actor = sessions.find((session) => session.playerId === game.activePlayerId)!;
  result = await service.action({ code: host.room.code, token: actor.token, version: result.room.version, action: { type: "roll", dice: [6, 6] } });
  const publicGame = result.room.game as { dice: number[]; players: { id: string; resources?: unknown; development?: unknown }[] };
  assert.deepEqual(publicGame.dice, [2, 5]);
  assert.equal("developmentDeck" in (result.room.game as object), false);
  assert.ok(publicGame.players.find((player) => player.id === actor.playerId)!.resources);
  for (const opponent of publicGame.players.filter((player) => player.id !== actor.playerId)) {
    assert.equal("resources" in opponent, false);
    assert.equal("development" in opponent, false);
  }
});

test("selected room capacity is enforced for every supported player count", async () => {
  for (const capacity of [3, 4, 5, 6]) {
    const service = createRoomService(memoryStore(), { engine: testEngine });
    const host = await service.create({ name: "船长", options: { expanded: capacity > 4, maxPlayers: capacity } });
    let version = host.room.version;
    for (let count = 1; count < capacity; count++) {
      await assert.rejects(service.start({ code: host.room.code, token: host.token, version }), errorCode("PLAYER_COUNT"));
      const joined = await service.join({ code: host.room.code, name: `船员${count}` });
      version = joined.room.version;
    }
    await assert.rejects(service.join({ code: host.room.code, name: "额外船员" }), errorCode("ROOM_FULL"));
    const started = await service.start({ code: host.room.code, token: host.token, version });
    assert.equal(started.room.status, "playing");
    assert.equal(started.room.players.length, capacity);
    assert.equal(started.room.options.maxPlayers, capacity);
  }
});

test("capacity defaults preserve old room JSON and invalid options are rejected", async () => {
  const store = memoryStore();
  const service = createRoomService(store, { engine: testEngine });
  const classic = await service.create({ name: "船长" });
  const expanded = await service.create({ name: "船长", options: { expanded: true } });
  assert.equal(classic.room.options.maxPlayers, 4);
  assert.equal(expanded.room.options.maxPlayers, 6);
  assert.equal(classic.room.options.friendlyRobber, false);
  assert.equal(classic.room.options.mixedPortTrade, false);
  assert.equal(classic.room.options.allowUndo, true);
  for (const rule of extraRules) assert.equal(classic.room.options[rule], false);
  const stored = store.data.get(classic.room.code)!;
  stored.options = { expanded: false, extensionRule: "paired" } as typeof stored.options;
  const restored = await service.get(classic.room.code, classic.token);
  assert.equal(restored.room.options.maxPlayers, 4);
  assert.equal(restored.room.options.friendlyRobber, false);
  assert.equal(restored.room.options.mixedPortTrade, false);
  assert.equal(restored.room.options.allowUndo, true);
  for (const rule of extraRules) assert.equal(restored.room.options[rule], false);
  for (const options of [
    { maxPlayers: 2 }, { maxPlayers: 5 }, { maxPlayers: 7 }, { maxPlayers: "3" }, { maxPlayers: null },
    { expanded: true, maxPlayers: 4 }, { friendlyRobber: "true" },
  ]) await assert.rejects(service.create({ name: "无效房间", options }), errorCode("INVALID_REQUEST"));
});

test("friendly robber option reaches the authoritative engine", async () => {
  const service = createRoomService(memoryStore());
  const host = await service.create({ name: "船长", options: { maxPlayers: 3, friendlyRobber: true } });
  await service.join({ code: host.room.code, name: "船员甲" });
  const last = await service.join({ code: host.room.code, name: "船员乙" });
  const started = await service.start({ code: host.room.code, token: host.token, version: last.room.version });
  assert.equal(started.room.options.friendlyRobber, true);
  assert.equal((started.room.game as { options: { friendlyRobber: boolean } }).options.friendlyRobber, true);
});

test("HTTP helpers accept bearer credentials and reject cross-origin mutations", async () => {
  const { service, host } = await setup();
  const url = `https://islands.example/api/room?code=${host.room.code}`;
  const request = new Request(url, { headers: { Authorization: `Bearer ${host.token}`, Origin: "https://islands.example", "Sec-Fetch-Site": "same-origin" } });
  assertRoomRequestOrigin(request);
  const result = await service.get(host.room.code, roomRequestToken(request, "invalid-body-token"));
  assert.equal(result.playerId, host.playerId);
  assert.equal(roomRequestToken(new Request(url), host.token), host.token);
  assertRoomRequestOrigin(new Request(url));
  const rejectedHeaders: Record<string, string>[] = [
    { Origin: "https://unrelated.example" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of rejectedHeaders) assert.throws(() => assertRoomRequestOrigin(new Request(url, { headers })), errorCode("CROSS_ORIGIN_REQUEST"));
  assert.throws(() => roomRequestToken(new Request(url, { headers: { Authorization: "Basic invalid" } }), host.token), errorCode("UNAUTHORIZED"));
});

test("rule flags accept flat and grouped input but reject unknown or ambiguous rules", async () => {
  const service = createRoomService(memoryStore(), { engine: testEngine });
  const flat = await service.create({ name: "平铺规则", options: { friendlyRobber: true, mixedPortTrade: true, allowUndo: false } });
  const nested = await service.create({ name: "分组规则", options: { rules: { friendlyRobber: true, mixedPortTrade: true, allowUndo: false } } });
  assert.deepEqual(flat.room.options, nested.room.options);
  assert.equal("rules" in nested.room.options, false);
  for (const options of [
    { mixedPortTrade: "true" }, { allowUndo: 0 }, { rules: { mixedPortTrade: null } },
    { rules: [] }, { rules: { freeResources: true } }, { freeResources: true },
    { mixedPortTrade: true, rules: { mixedPortTrade: false } },
    { rng: 1 }, { firstPlayerIndex: 0 },
  ]) await assert.rejects(service.create({ name: "非法规则", options }), errorCode("INVALID_REQUEST"));
});

test("only the lobby host can update rule options using the current version", async () => {
  const { service, host, credentials } = await setup(false, 4);
  const version = credentials.at(-1)!.room.version;
  await assert.rejects(service.updateOptions({ code: host.room.code, token: credentials[1].token, version, options: { mixedPortTrade: true } }), errorCode("HOST_REQUIRED"));
  await assert.rejects(service.updateOptions({ code: host.room.code, token: host.token, version: 1, options: { mixedPortTrade: true } }), errorCode("VERSION_CONFLICT"));
  const updated = await service.updateOptions({ code: host.room.code, token: host.token, version, options: { rules: { mixedPortTrade: true, allowUndo: false } } });
  assert.equal(updated.room.version, version + 1);
  assert.equal(updated.room.options.mixedPortTrade, true);
  assert.equal(updated.room.options.allowUndo, false);
  assert.equal(updated.room.options.maxPlayers, 4);
  assert.equal(updated.room.options.extensionRule, "paired");
  const joined = await service.join({ code: host.room.code, name: "第四位" });
  await assert.rejects(service.updateOptions({ code: host.room.code, token: host.token, version: joined.room.version, options: { maxPlayers: 3 } }), errorCode("PLAYER_COUNT"));
  const started = await service.start({ code: host.room.code, token: host.token, version: joined.room.version });
  await assert.rejects(service.updateOptions({ code: host.room.code, token: host.token, version: started.room.version, options: { mixedPortTrade: false } }), errorCode("GAME_ALREADY_STARTED"));
  assert.equal((await service.get(host.room.code, host.token)).room.options.mixedPortTrade, true);
});

test("concurrent option updates cannot silently overwrite each other", async () => {
  const service = createRoomService(memoryStore(), { engine: testEngine });
  const host = await service.create({ name: "船长" });
  const shared = { code: host.room.code, token: host.token, version: host.room.version };
  const results = await Promise.allSettled([
    service.updateOptions({ ...shared, options: { mixedPortTrade: true } }),
    service.updateOptions({ ...shared, options: { allowUndo: false } }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(errorCode("VERSION_CONFLICT")(rejected.reason));
  assert.equal((await service.get(host.room.code, host.token)).room.version, host.room.version + 1);
});

test("engine receives the saved rules and action payloads cannot change them", async () => {
  const service = createRoomService(memoryStore());
  const host = await service.create({ name: "船长", options: { maxPlayers: 3, friendlyRobber: true, mixedPortTrade: true, allowUndo: false } });
  const second = await service.join({ code: host.room.code, name: "船员甲" });
  const third = await service.join({ code: host.room.code, name: "船员乙" });
  const started = await service.start({ code: host.room.code, token: host.token, version: third.room.version, options: { mixedPortTrade: false, allowUndo: true } });
  const game = started.room.game as { activePlayerId: string; options: { friendlyRobber: boolean; mixedPortTrade: boolean; allowUndo: boolean } };
  assert.equal(game.options.friendlyRobber, true);
  assert.equal(game.options.mixedPortTrade, true);
  assert.equal(game.options.allowUndo, false);
  const actor = [host, second, third].find((session) => session.playerId === game.activePlayerId)!;
  const view = await service.get(host.room.code, actor.token);
  const legal = view.room.legalActions as { settlements: string[] };
  const built = await service.action({ code: host.room.code, token: actor.token, version: view.room.version, action: { type: "buildSettlement", vertexId: legal.settlements[0], options: { mixedPortTrade: false, allowUndo: true }, rules: { mixedPortTrade: false, allowUndo: true } } });
  assert.equal((built.room.game as typeof game).options.mixedPortTrade, true);
  assert.equal((built.room.game as typeof game).options.allowUndo, false);
  assert.equal(built.room.options.mixedPortTrade, true);
});

test("the lobby endpoint cannot bypass an in-progress game's rule vote", async () => {
  const service = createRoomService(memoryStore());
  const host = await service.create({ name: "船长", options: { maxPlayers: 3 } });
  const configured = await service.updateOptions({ code: host.room.code, token: host.token, version: host.room.version, options: { rules: Object.fromEntries(extraRules.map((rule) => [rule, true])) } });
  for (const rule of extraRules) assert.equal(configured.room.options[rule], true);
  const reset = await service.updateOptions({ code: host.room.code, token: host.token, version: configured.room.version, options: { infiniteBank: false } });
  assert.equal(reset.room.options.infiniteBank, false);
  assert.equal(reset.room.options.flexibleRoll, true);
  const restored = await service.updateOptions({ code: host.room.code, token: host.token, version: reset.room.version, options: { infiniteBank: true } });
  await service.join({ code: host.room.code, name: "船员甲" });
  const last = await service.join({ code: host.room.code, name: "船员乙" });
  const started = await service.start({ code: host.room.code, token: host.token, version: last.room.version });
  const gameOptions = (started.room.game as { options: Record<string, unknown> }).options;
  for (const rule of extraRules) {
    assert.equal(started.room.options[rule], true);
    assert.equal(gameOptions[rule], true);
    await assert.rejects(service.updateOptions({ code: host.room.code, token: host.token, version: started.room.version, options: { [rule]: false } }), errorCode("GAME_ALREADY_STARTED"));
  }
  assert.ok(restored.room.version > configured.room.version);
  for (const rule of extraRules) await assert.rejects(service.create({ name: "非法变体", options: { [rule]: "true" } }), errorCode("INVALID_REQUEST"));
});

test("six simultaneous authenticated ballots apply the proposal once and persist both option views", async () => {
  const store = memoryStore();
  const service = createRoomService(store);
  const host = await service.create({ name: "船长", options: { expanded: true, maxPlayers: 6 } });
  const seats = [host];
  for (let i = 1; i < 6; i++) seats.push(await service.join({ code: host.room.code, name: `船员${i}` }));
  const code = host.room.code;
  const started = await service.start({ code, token: host.token, version: seats.at(-1)!.room.version });
  const proposed = await service.action({ code, token: seats[1].token, version: started.room.version,
    action: { type: "proposeRules", changes: { roundUpDiscard: true } } });
  const proposal = (proposed.room.game as { ruleProposal: { id: number } }).ruleProposal;
  const vote = { type: "voteRules", proposalId: proposal.id, approve: true };
  assert.equal(proposed.room.options.roundUpDiscard, false);
  await assert.rejects(service.action({ code, token: "0".repeat(64), action: vote }), errorCode("UNAUTHORIZED"));
  await Promise.all(seats.map(seat => service.action({
    code, token: seat.token, version: proposed.room.version, action: { ...vote, playerId: seats[1].playerId },
  })));

  for (const seat of seats) {
    const snapshot = await service.get(code, seat.token);
    const game = snapshot.room.game as { options: { roundUpDiscard: boolean }; ruleProposal: { votes: object; status: string } };
    assert.equal(snapshot.room.version, proposed.room.version + seats.length);
    assert.equal(game.ruleProposal.status, "approved");
    assert.equal(game.options.roundUpDiscard, true);
    assert.equal(snapshot.room.options.roundUpDiscard, true);
    assert.deepEqual(game.ruleProposal.votes, Object.fromEntries(seats.map(voter => [voter.playerId, true])));
  }
  const retried = await service.action({ code, token: host.token, action: vote });
  assert.equal(retried.room.version, proposed.room.version + seats.length);
});

test("roll eligibility follows the rules engine even in the actions phase", async () => {
  let calls = 0;
  const flexibleEngine = {
    ...testEngine,
    newGame(players: RoomPlayer[]) { return { ...testEngine.newGame(players), phase: "actions", hasRolled: false }; },
    legalActions(game: GameState, playerId: string) { return { canRoll: game.activePlayerId === playerId && game.hasRolled === false }; },
    applyAction(game: GameState, playerId: string, action: Record<string, unknown>) {
      return { ...testEngine.applyAction(game, playerId, action), hasRolled: true };
    },
  };
  const service = createRoomService(memoryStore(), { engine: flexibleEngine, fetcher: async () => { calls++; return new Response("3\n5\n"); } });
  const host = await service.create({ name: "船长", options: { maxPlayers: 3, flexibleRoll: true } });
  await service.join({ code: host.room.code, name: "船员甲" });
  const last = await service.join({ code: host.room.code, name: "船员乙" });
  const started = await service.start({ code: host.room.code, token: host.token, version: last.room.version });
  assert.equal((started.room.game as GameState).phase, "actions");
  const rolled = await service.action({ code: host.room.code, token: host.token, version: started.room.version, action: { type: "roll" } });
  assert.deepEqual((rolled.room.game as GameState).dice, [3, 5]);
  assert.equal(calls, 1);
  await assert.rejects(service.action({ code: host.room.code, token: host.token, version: rolled.room.version, action: { type: "roll" } }), errorCode("INVALID_ACTION"));
  assert.equal(calls, 1);
});
