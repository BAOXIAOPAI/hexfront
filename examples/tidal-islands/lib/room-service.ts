import { applyAction, legalActions, newGame, publicState } from "./engine.js";
// @ts-expect-error Node's native TypeScript test runner requires the source extension.
import { normalizeRuleFlags, RULE_OPTIONS } from "./rule-options.ts";
import type { RuleFlagOptions, RuleProposal } from "./rule-options";

export type RoomOptions = RuleFlagOptions & {
  expanded: boolean;
  extensionRule: "paired" | "special";
  maxPlayers: 3 | 4 | 5 | 6;
};
export type RoomPlayer = { id: string; name: string; color: string };
type RoomMember = RoomPlayer & { tokenHash: string };
export type RoomStatus = "lobby" | "playing" | "finished";
export type GameState = Record<string, unknown>;
export type RoomRecord = {
  code: string; version: number; hostId: string; status: RoomStatus;
  options: RoomOptions; members: RoomMember[]; game: GameState | null;
  createdAt: number; updatedAt: number;
};

export interface RoomStore {
  find(code: string): Promise<RoomRecord | null>;
  insert(room: RoomRecord): Promise<boolean>;
  compareAndSwap(room: RoomRecord, expectedVersion: number): Promise<boolean>;
}

type Engine = {
  newGame(players: RoomPlayer[], options: RoomOptions): GameState;
  applyAction(game: GameState, playerId: string, action: Record<string, unknown>): GameState;
  publicState(game: GameState, playerId: string): unknown;
  legalActions(game: GameState, playerId: string): unknown;
};

const engine: Engine = { newGame, applyAction, publicState, legalActions } as unknown as Engine;
const COLORS = ["#e75e4f", "#65a7d9", "#e8be62", "#83b79b", "#a08ac8", "#f29a63"];
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RANDOM_URL = "https://www.random.org/integers/?num=2&min=1&max=6&col=1&base=10&format=plain&rnd=new";
const MAX_ROOM_AGE = 7 * 24 * 60 * 60 * 1000;

export class RoomError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "INVALID_REQUEST") {
    super(message);
    this.name = "RoomError";
    this.status = status;
    this.code = code;
  }
}

/** Browsers must create and mutate rooms from this site. CLI requests lack Origin. */
export function assertRoomRequestOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  if ((origin !== null && origin !== new URL(request.url).origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw new RoomError("请从游戏页面操作房间。", 403, "CROSS_ORIGIN_REQUEST");
  }
}

export function roomRequestToken(request: Request, payloadToken?: unknown) {
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    const bearer = /^Bearer ([a-f0-9]{64})$/i.exec(authorization);
    if (!bearer) throw new RoomError("房间身份验证格式不正确。", 401, "UNAUTHORIZED");
    return bearer[1];
  }
  return payloadToken;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoomError("请求内容格式不正确。");
  return value as Record<string, unknown>;
}

function nameOf(value: unknown): string {
  if (typeof value !== "string") throw new RoomError("请输入玩家昵称。");
  const name = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!name || [...name].length > 24 || /[\u0000-\u001f\u007f]/u.test(name)) throw new RoomError("玩家昵称需为 1–24 个字符。");
  return name;
}

function codeOf(value: unknown): string {
  const code = typeof value === "string" ? value.toUpperCase().replace(/\s/g, "") : "";
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new RoomError("请输入有效的 6 位邀请码。");
  return code;
}

function optionsOf(value: unknown, previous?: RoomOptions): RoomOptions {
  const options = value == null ? {} : object(value);
  const allowed = new Set<string>(["expanded", "extensionRule", "maxPlayers", "rules", ...RULE_OPTIONS.map((rule) => rule.id)]);
  if (Object.keys(options).some((key) => !allowed.has(key))) throw new RoomError("存在尚未支持的房间选项。");
  if (options.expanded !== undefined && typeof options.expanded !== "boolean") throw new RoomError("房间人数设置不正确。");
  if (options.extensionRule !== undefined && options.extensionRule !== "paired" && options.extensionRule !== "special") throw new RoomError("请选择有效的扩展回合规则。");
  const expanded = options.expanded === undefined ? previous?.expanded ?? false : options.expanded === true;
  const defaultCapacity = previous && previous.expanded === expanded ? previous.maxPlayers : expanded ? 6 : 4;
  const maxPlayers = options.maxPlayers === undefined ? defaultCapacity : options.maxPlayers;
  if (!(expanded ? [5, 6] : [3, 4]).includes(maxPlayers as number)) throw new RoomError("经典地图可选 3–4 人，扩展地图可选 5–6 人。");
  let rules: RuleFlagOptions;
  try { rules = normalizeRuleFlags(options, previous); }
  catch (error) { throw new RoomError(error instanceof Error ? error.message : "可选规则设置不正确。"); }
  return { expanded, maxPlayers: maxPlayers as RoomOptions["maxPlayers"], extensionRule: options.extensionRule === undefined ? previous?.extensionRule ?? "paired" : options.extensionRule === "special" ? "special" : "paired", ...rules };
}

function randomCode(): string {
  // Exactly 32 characters: masking introduces no bias.
  return [...crypto.getRandomValues(new Uint8Array(6))].map((value) => CODE_ALPHABET[value & 31]).join("");
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function equalHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function assertVersion(value: unknown, room: RoomRecord) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new RoomError("缺少房间版本，请刷新房间后重试。");
  if (value !== room.version) throw new RoomError("房间状态已更新，请刷新后重试。", 409, "VERSION_CONFLICT");
}

/** Atmospheric dice are fetched only after turn and identity validation. */
export async function atmosphericDice(fetcher: typeof fetch = fetch): Promise<[number, number]> {
  let response: Response;
  try {
    response = await fetcher(RANDOM_URL, { headers: { Accept: "text/plain" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
  } catch {
    throw new RoomError("大气真随机服务暂时无法连接，尚未掷骰。请稍后重试。", 503, "RANDOM_UNAVAILABLE");
  }
  if (!response.ok) throw new RoomError("大气真随机服务暂时不可用，尚未掷骰。请稍后重试。", 503, "RANDOM_UNAVAILABLE");
  let result: string;
  try { result = (await response.text()).trim(); }
  catch { throw new RoomError("真随机服务响应中断，尚未掷骰。请稍后重试。", 503, "RANDOM_UNAVAILABLE"); }
  if (!/^[1-6]\s+[1-6]$/.test(result)) throw new RoomError("真随机服务返回了无效结果，尚未掷骰。请稍后重试。", 503, "RANDOM_UNAVAILABLE");
  return result.split(/\s+/).map(Number) as [number, number];
}

export function createRoomService(store: RoomStore, dependencies: { engine?: Engine; fetcher?: typeof fetch; now?: () => number } = {}) {
  const rules = dependencies.engine ?? engine;
  const now = dependencies.now ?? Date.now;

  async function load(rawCode: unknown): Promise<RoomRecord> {
    const room = await store.find(codeOf(rawCode));
    if (!room || now() - room.updatedAt > MAX_ROOM_AGE) throw new RoomError("未找到房间，或房间已超过 7 天未活动。", 404, "ROOM_NOT_FOUND");
    // Older rooms are upgraded in memory; the JSON column needs no migration.
    room.options = optionsOf(room.options);
    return room;
  }

  async function authenticate(room: RoomRecord, tokenValue: unknown): Promise<RoomMember> {
    if (typeof tokenValue !== "string" || !/^[a-f0-9]{64}$/.test(tokenValue)) throw new RoomError("房间身份已失效，请使用加入房间时的浏览器。", 401, "UNAUTHORIZED");
    const tokenHash = await hashToken(tokenValue);
    const member = room.members.find((candidate) => equalHash(candidate.tokenHash, tokenHash));
    if (!member) throw new RoomError("房间身份验证失败。", 401, "UNAUTHORIZED");
    return member;
  }

  function view(room: RoomRecord, playerId: string, token?: string) {
    return {
      room: {
        code: room.code, version: room.version, hostId: room.hostId, status: room.status, options: room.options,
        players: room.members.map(({ id, name, color }) => ({ id, name, color })),
        game: room.game ? rules.publicState(room.game, playerId) : null,
        legalActions: room.game ? rules.legalActions(room.game, playerId) : null,
      },
      playerId,
      ...(token ? { token } : {}),
    };
  }

  async function persist(room: RoomRecord, previousVersion: number) {
    room.version = previousVersion + 1;
    room.updatedAt = now();
    if (!(await store.compareAndSwap(room, previousVersion))) throw new RoomError("另一位玩家刚刚更新了房间，请刷新后重试。", 409, "VERSION_CONFLICT");
  }

  async function commitAction(payload: Record<string, unknown>, action: Record<string, unknown>, useLatestVersion: boolean) {
    const room = await load(payload.code);
    const member = await authenticate(room, payload.token);
    if (!useLatestVersion) assertVersion(payload.version, room);
    if (room.status !== "playing" || !room.game) throw new RoomError("当前没有进行中的对局。", 409, "GAME_NOT_ACTIVE");
    if (action.type === "roll") {
      const legal = rules.legalActions(room.game, member.id) as { canRoll?: boolean } | null;
      if (!legal?.canRoll) throw new RoomError("现在还不能掷骰，或尚未轮到你。", 422, "INVALID_ACTION");
      action.dice = await atmosphericDice(dependencies.fetcher);
    }
    let next: GameState;
    try {
      next = rules.applyAction(room.game, member.id, action);
    } catch (error) {
      throw new RoomError(error instanceof Error ? error.message : "该操作不符合当前游戏规则。", 422, "INVALID_ACTION");
    }
    if (next === room.game) return view(room, member.id);
    const proposal = next.ruleProposal as RuleProposal | undefined;
    if (action.type === "voteRules" && proposal?.status === "approved") {
      room.options = { ...room.options, ...proposal.changes };
    }
    const previousVersion = room.version;
    room.game = next;
    if (next.phase === "finished") room.status = "finished";
    await persist(room, previousVersion);
    return view(room, member.id);
  }

  return {
    async get(rawCode: unknown, token: unknown) {
      const room = await load(rawCode);
      const player = await authenticate(room, token);
      return view(room, player.id);
    },

    async create(payloadValue: unknown) {
      const payload = object(payloadValue);
      const name = nameOf(payload.name);
      const options = optionsOf(payload.options);
      const token = randomToken();
      const member: RoomMember = { id: crypto.randomUUID(), name, color: COLORS[0], tokenHash: await hashToken(token) };
      const timestamp = now();
      for (let attempt = 0; attempt < 8; attempt++) {
        const room: RoomRecord = { code: randomCode(), version: 1, hostId: member.id, status: "lobby", options, members: [member], game: null, createdAt: timestamp, updatedAt: timestamp };
        if (await store.insert(room)) return view(room, member.id, token);
      }
      throw new RoomError("暂时无法分配邀请码，请稍后重试。", 503, "ROOM_CREATION_FAILED");
    },

    async join(payloadValue: unknown) {
      const payload = object(payloadValue);
      const name = nameOf(payload.name);
      const token = randomToken();
      const tokenHash = await hashToken(token);
      const playerId = crypto.randomUUID();
      for (let attempt = 0; attempt < 5; attempt++) {
        const room = await load(payload.code);
        if (room.status !== "lobby") throw new RoomError("对局已开始，无法再加入新玩家。", 409, "GAME_ALREADY_STARTED");
        if (room.members.length >= room.options.maxPlayers) throw new RoomError("房间人数已满。", 409, "ROOM_FULL");
        if (room.members.some((member) => member.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new RoomError("房间内已有同名玩家，请换一个昵称。", 409, "NAME_TAKEN");
        const previousVersion = room.version;
        room.members.push({ id: playerId, name, color: COLORS[room.members.length], tokenHash });
        room.version++;
        room.updatedAt = now();
        if (await store.compareAndSwap(room, previousVersion)) return view(room, playerId, token);
      }
      throw new RoomError("多人正在加入房间，请稍后重试。", 409, "VERSION_CONFLICT");
    },

    async start(payloadValue: unknown) {
      const payload = object(payloadValue);
      const room = await load(payload.code);
      const member = await authenticate(room, payload.token);
      if (member.id !== room.hostId) throw new RoomError("只有房主可以开始对局。", 403, "HOST_REQUIRED");
      assertVersion(payload.version, room);
      if (room.status !== "lobby") throw new RoomError("对局已经开始。", 409, "GAME_ALREADY_STARTED");
      if (room.members.length !== room.options.maxPlayers) throw new RoomError(`此房间需要 ${room.options.maxPlayers} 位真实玩家加入后才能开始。`, 409, "PLAYER_COUNT");
      const previousVersion = room.version;
      room.game = rules.newGame(room.members.map(({ id, name, color }) => ({ id, name, color })), room.options);
      room.status = "playing";
      await persist(room, previousVersion);
      return view(room, member.id);
    },

    async updateOptions(payloadValue: unknown) {
      const payload = object(payloadValue);
      const room = await load(payload.code);
      const member = await authenticate(room, payload.token);
      if (member.id !== room.hostId) throw new RoomError("只有房主可以修改房间规则。", 403, "HOST_REQUIRED");
      assertVersion(payload.version, room);
      if (room.status !== "lobby") throw new RoomError("对局已开始，请通过局内投票更改可选规则。", 409, "GAME_ALREADY_STARTED");
      const options = optionsOf(object(payload.options), room.options);
      if (options.maxPlayers < room.members.length) throw new RoomError(`房间已有 ${room.members.length} 位玩家，不能缩减到更少座位。`, 409, "PLAYER_COUNT");
      const previousVersion = room.version;
      room.options = options;
      await persist(room, previousVersion);
      return view(room, member.id);
    },

    async action(payloadValue: unknown) {
      const payload = object(payloadValue);
      const action = { ...object(payload.action) };
      if (typeof action.type !== "string" || action.type.length > 40) throw new RoomError("缺少有效的游戏操作。");
      // Randomness and acting player identity always come from this service.
      delete action.playerId;
      delete action.actorId;
      delete action.dice;
      delete action.rng;
      delete action.options;
      delete action.rules;
      // A ballot targets one immutable proposal. Re-read that proposal after a
      // racing room update so distinct voters can vote at the same time.
      const useLatestVersion = action.type === "voteRules" || action.type === "withdrawRuleProposal";
      if (!useLatestVersion) return commitAction(payload, action, false);
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          return await commitAction(payload, action, true);
        } catch (error) {
          if (!(error instanceof RoomError) || error.code !== "VERSION_CONFLICT") throw error;
        }
      }
      throw new RoomError("多人正在更新提案，请稍后重试。", 409, "VERSION_CONFLICT");
    },
  };
}

type RoomRow = {
  code: string; version: number; host_id: string; status: RoomStatus;
  options_json: string; members_json: string; game_json: string | null;
  created_at: number; updated_at: number;
};

function fromRow(row: RoomRow): RoomRecord {
  return { code: row.code, version: row.version, hostId: row.host_id, status: row.status, options: JSON.parse(row.options_json), members: JSON.parse(row.members_json), game: row.game_json ? JSON.parse(row.game_json) : null, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function createD1RoomStore(database: D1Database): RoomStore {
  return {
    async find(code) {
      const row = await database.prepare("SELECT * FROM rooms WHERE code = ?").bind(code).first<RoomRow>();
      return row ? fromRow(row) : null;
    },
    async insert(room) {
      const result = await database.prepare("INSERT INTO rooms (code, version, host_id, status, options_json, members_json, game_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(code) DO NOTHING").bind(room.code, room.version, room.hostId, room.status, JSON.stringify(room.options), JSON.stringify(room.members), room.game ? JSON.stringify(room.game) : null, room.createdAt, room.updatedAt).run();
      return result.meta.changes === 1;
    },
    async compareAndSwap(room, expectedVersion) {
      const result = await database.prepare("UPDATE rooms SET version = ?, status = ?, options_json = ?, members_json = ?, game_json = ?, updated_at = ? WHERE code = ? AND version = ?").bind(room.version, room.status, JSON.stringify(room.options), JSON.stringify(room.members), room.game ? JSON.stringify(room.game) : null, room.updatedAt, room.code, expectedVersion).run();
      return result.meta.changes === 1;
    },
  };
}
