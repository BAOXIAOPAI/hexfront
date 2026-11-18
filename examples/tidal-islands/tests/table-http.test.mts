import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's native TypeScript test runner requires the source extension.
import { createRoomService, RoomError } from "../lib/room-service.ts";
import type { RoomRecord, RoomStore } from "../lib/room-service.ts";

type Resources = Record<"wood" | "brick" | "sheep" | "wheat" | "ore", number>;
type Session = { playerId: string; token: string };
type TableTrade = { id: string; from: string; to: string | null; give: Resources; response: Resources | null; confirmed: string[] };
type GameView = {
  phase: string; activePlayerId: string; board: unknown; dice: number[] | null;
  players: { id: string; resources?: Resources; development?: unknown[] }[];
  tableTrades: TableTrade[]; tradeOffers: { id: string }[]; tableResetId: number;
  tableTradeResult: { from: string; to: string; status: string } | null;
};

const resources = (value: Partial<Resources> = {}): Resources => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0, ...value });
const isError = (code: string) => (error: unknown) => error instanceof RoomError && error.code === code;

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

/** Uses the same authenticated service as the HTTP route, with only dice transport stubbed. */
async function readyRoom() {
  const store = memoryStore();
  let randomCalls = 0;
  const service = createRoomService(store, { fetcher: async () => { randomCalls++; return new Response("3\n4\n"); } });
  const host = await service.create({ name: "房主", options: { maxPlayers: 3, flexibleRoll: true, allowGifts: true } });
  const second = await service.join({ code: host.room.code, name: "玩家二" });
  const third = await service.join({ code: host.room.code, name: "玩家三" });
  const code = host.room.code;
  const sessions: Session[] = [host, second, third].map((session) => ({ playerId: session.playerId, token: session.token! }));
  let result = await service.start({ code, token: host.token, version: third.room.version });
  for (let step = 0; step < 12; step++) {
    const game = result.room.game as GameView;
    const actor = sessions.find((session) => session.playerId === game.activePlayerId)!;
    const view = await service.get(code, actor.token);
    const legal = view.room.legalActions as { settlements: string[]; roads: string[] };
    const action = game.phase === "setup_settlement"
      ? { type: "buildSettlement", vertexId: legal.settlements[0] }
      : { type: "buildRoad", edgeId: legal.roads[0] };
    result = await service.action({ code, token: actor.token, version: view.room.version, action });
  }
  const game = result.room.game as GameView;
  assert.equal(game.phase, "actions");
  const from = sessions.find((session) => session.playerId === game.activePlayerId)!;
  const [to, spectator] = sessions.filter((session) => session.playerId !== from.playerId);

  // Test-only fixture access establishes predictable resources; no API accepts it.
  const stored = store.data.get(code)!;
  const fixture = stored.game as unknown as GameView & { bank: Resources };
  for (const player of fixture.players) player.resources = resources();
  fixture.players.find((player) => player.id === from.playerId)!.resources = resources({ wood: 4, ore: 2 });
  fixture.players.find((player) => player.id === to.playerId)!.resources = resources({ brick: 3, wheat: 2 });
  fixture.players.find((player) => player.id === spectator.playerId)!.resources = resources({ sheep: 2 });
  fixture.bank = resources({ wood: 15, brick: 16, sheep: 17, wheat: 17, ore: 17 });

  const view = (session: Session) => service.get(code, session.token);
  const action = async (session: Session, move: Record<string, unknown>, version?: number) => service.action({
    code, token: session.token, version: version ?? (await view(session)).room.version, action: move,
  });
  const hands = () => Object.fromEntries((store.data.get(code)!.game as unknown as GameView).players.map((player) => [player.id, structuredClone(player.resources!)]));
  const negotiate = async () => {
    const opened = await action(from, { type: "createTableTrade", targetId: to.playerId, give: { wood: 2 } });
    const tradeId = (opened.room.game as GameView).tableTrades.at(-1)!.id;
    await action(to, { type: "respondTableTrade", tradeId, give: { brick: 1 } });
    return tradeId;
  };
  return { store, service, code, sessions, from, to, spectator, view, action, hands, negotiate, randomCalls: () => randomCalls };
}

test("authenticated service keeps targeted negotiation private and swaps only after both confirmations", async () => {
  const room = await readyRoom();
  const tradeId = await room.negotiate();
  const before = room.hands();
  for (const participant of [room.from, room.to]) {
    const snapshot = await room.view(participant);
    const game = snapshot.room.game as GameView;
    assert.equal(game.tableTrades.length, 1);
    assert.equal(game.tableTrades[0].id, tradeId);
    assert.ok(game.players.find((player) => player.id === participant.playerId)!.resources);
    for (const other of game.players.filter((player) => player.id !== participant.playerId)) {
      assert.equal("resources" in other, false);
      assert.equal("development" in other, false);
    }
    assert.equal("token" in snapshot, false);
  }
  const hidden = await room.view(room.spectator);
  assert.deepEqual((hidden.room.game as GameView).tableTrades, []);
  assert.deepEqual((hidden.room.legalActions as { tableTradeIds: string[] }).tableTradeIds, []);
  const hiddenVersion = hidden.room.version;
  for (const type of ["respondTableTrade", "confirmTableTrade", "updateTableTrade", "unconfirmTableTrade", "rejectTableTrade"]) {
    await assert.rejects(room.action(room.spectator, { type, tradeId, give: { sheep: 1 } }), isError("INVALID_ACTION"));
  }
  assert.equal((await room.view(room.spectator)).room.version, hiddenVersion);

  const first = await room.action(room.from, { type: "confirmTableTrade", tradeId });
  assert.deepEqual(room.hands(), before);
  assert.deepEqual((first.room.game as GameView).tableTrades[0].confirmed, [room.from.playerId]);
  await assert.rejects(room.action(room.to, { type: "confirmTableTrade", tradeId }, first.room.version - 1), isError("VERSION_CONFLICT"));
  assert.deepEqual(room.hands(), before);

  const completed = await room.action(room.to, { type: "confirmTableTrade", tradeId }, first.room.version);
  assert.equal(completed.room.version, first.room.version + 1);
  const after = room.hands();
  assert.deepEqual(after[room.from.playerId], resources({ wood: 2, ore: 2, brick: 1 }));
  assert.deepEqual(after[room.to.playerId], resources({ wood: 2, brick: 2, wheat: 2 }));
  assert.deepEqual(after[room.spectator.playerId], before[room.spectator.playerId]);
  assert.deepEqual((completed.room.game as GameView).tableTrades, []);
  assert.equal((completed.room.game as GameView).tableTradeResult!.status, "accepted");
  assert.equal(((await room.view(room.spectator)).room.game as GameView).tableTradeResult, null);
  await assert.rejects(room.action(room.from, { type: "confirmTableTrade", tradeId }), isError("INVALID_ACTION"));
  assert.deepEqual(room.hands(), after);
});

test("editing either basket or withdrawing confirmation resets the negotiation without moving cards", async () => {
  const room = await readyRoom();
  const tradeId = await room.negotiate();
  const before = room.hands();
  await room.action(room.from, { type: "confirmTableTrade", tradeId });
  const receiverEdit = await room.action(room.to, { type: "updateTableTrade", tradeId, give: { brick: 2 } });
  assert.deepEqual((receiverEdit.room.game as GameView).tableTrades[0].confirmed, []);
  assert.equal((receiverEdit.room.game as GameView).tableTrades[0].response!.brick, 2);

  await room.action(room.to, { type: "confirmTableTrade", tradeId });
  const senderEdit = await room.action(room.from, { type: "updateTableTrade", tradeId, give: { wood: 3 } });
  assert.deepEqual((senderEdit.room.game as GameView).tableTrades[0].confirmed, []);
  assert.equal((senderEdit.room.game as GameView).tableTrades[0].give.wood, 3);

  await room.action(room.from, { type: "confirmTableTrade", tradeId });
  const withdrawn = await room.action(room.to, { type: "unconfirmTableTrade", tradeId });
  assert.deepEqual((withdrawn.room.game as GameView).tableTrades[0].confirmed, []);
  assert.deepEqual(room.hands(), before);
  const oneAgain = await room.action(room.to, { type: "confirmTableTrade", tradeId });
  assert.deepEqual((oneAgain.room.game as GameView).tableTrades[0].confirmed, [room.to.playerId]);
  assert.deepEqual(room.hands(), before);
});

test("concurrent confirmations use version CAS and cannot transfer cards twice", async () => {
  const room = await readyRoom();
  const tradeId = await room.negotiate();
  const before = room.hands();
  const version = (await room.view(room.from)).room.version;
  const results = await Promise.allSettled([
    room.action(room.from, { type: "confirmTableTrade", tradeId }, version),
    room.action(room.to, { type: "confirmTableTrade", tradeId }, version),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(isError("VERSION_CONFLICT")(failed.reason));
  assert.deepEqual(room.hands(), before);
  const current = await room.view(room.from);
  assert.equal(current.room.version, version + 1);
  const confirmed = (current.room.game as GameView).tableTrades[0].confirmed;
  assert.equal(confirmed.length, 1);
  const pending = [room.from, room.to].find((session) => !confirmed.includes(session.playerId))!;
  const completed = await room.action(pending, { type: "confirmTableTrade", tradeId }, current.room.version);
  assert.equal(completed.room.version, version + 2);
  assert.deepEqual((completed.room.game as GameView).tableTrades, []);
  assert.deepEqual(room.hands()[room.from.playerId], resources({ wood: 2, ore: 2, brick: 1 }));
});

test("server seven clears negotiations and advances a shared reset nonce for every viewer", async () => {
  const room = await readyRoom();
  const tradeId = await room.negotiate();
  await room.action(room.from, { type: "confirmTableTrade", tradeId });
  await room.action(room.from, { type: "offerTrade", targetId: room.to.playerId, give: { ore: 1 }, get: { wheat: 1 } });
  const before = await room.view(room.from);
  const beforeGame = before.room.game as GameView;
  assert.equal(beforeGame.phase, "actions");
  assert.equal((before.room.legalActions as { canRoll: boolean }).canRoll, true);
  assert.equal(beforeGame.tableTrades.length, 1);
  assert.equal(beforeGame.tradeOffers.length, 1);
  const beforeHands = room.hands();
  const rolled = await room.action(room.from, { type: "roll", dice: [6, 6] }, before.room.version);
  assert.equal(room.randomCalls(), 1);
  assert.deepEqual((rolled.room.game as GameView).dice, [3, 4]);
  assert.equal(rolled.room.version, before.room.version + 1);
  for (const session of room.sessions) {
    const snapshot = await room.view(session);
    const game = snapshot.room.game as GameView;
    assert.equal(snapshot.room.version, rolled.room.version);
    assert.equal(game.tableResetId, beforeGame.tableResetId + 1);
    assert.equal(game.phase, "robber");
    assert.deepEqual(game.tableTrades, []);
    assert.deepEqual(game.tradeOffers, []);
    assert.equal(game.tableTradeResult, null);
    assert.deepEqual(game.board, beforeGame.board);
  }
  assert.deepEqual(room.hands(), beforeHands);
  await assert.rejects(room.action(room.to, { type: "confirmTableTrade", tradeId }, before.room.version), isError("VERSION_CONFLICT"));
  await assert.rejects(room.action(room.to, { type: "confirmTableTrade", tradeId }), isError("INVALID_ACTION"));
  assert.equal((await room.view(room.from)).room.version, rolled.room.version);
});
