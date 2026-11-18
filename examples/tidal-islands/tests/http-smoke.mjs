/** Local, real-HTTP multiplayer smoke test. Never prints credentials or hands. */
const base = new URL(process.env.CATAN_SMOKE_URL || "http://127.0.0.1:5173/");
const results = [];
let checks = 0;

function check(condition, description) {
  if (!condition) throw new Error(description);
  checks++;
}

async function call(payload, token, { method = "POST", origin = base.origin } = {}) {
  const url = new URL("/api/room", base);
  if (method === "GET") url.searchParams.set("code", payload.code);
  const headers = { Origin: origin, "Sec-Fetch-Site": origin === base.origin ? "same-origin" : "cross-site" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method === "POST") headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(url, { method, headers, body: method === "POST" ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(20000) });
  } catch {
    throw new Error("本地 HTTP 请求无法完成；请检查开发服务器是否已启动。");
  }
  let data;
  try { data = await response.json(); }
  catch {
    // Vite can reject an Origin at its outer HTTP layer before reaching the route.
    if (response.status === 403 && origin !== base.origin) data = { code: "HTTP_ORIGIN_BLOCK" };
    else throw new Error(`房间接口未返回有效 JSON（HTTP ${response.status}）。`);
  }
  return { status: response.status, data, cacheControl: response.headers.get("Cache-Control") };
}

function success(response, expectedStatus, description) {
  check(response.status === expectedStatus, `${description}（HTTP ${response.status}，${response.data?.code || "unexpected_response"}）`);
  check(response.data?.room && typeof response.data.playerId === "string", `${description}返回结构错误。`);
  check(response.cacheControl?.includes("no-store"), `${description}未禁用私密响应缓存。`);
  return response.data;
}

async function read(code, session) {
  return success(await call({ code }, session.token, { method: "GET" }), 200, "读取房间");
}

function privateView(snapshot, viewer, sessions) {
  const game = snapshot.room.game;
  check(game && !Object.hasOwn(game, "developmentDeck"), "公共状态泄漏发展牌牌堆。");
  check(!Object.hasOwn(snapshot, "token"), "读取响应不应重新返回身份令牌。");
  const serialized = JSON.stringify(snapshot);
  check(!serialized.includes("tokenHash"), "公共状态泄漏身份令牌摘要。");
  for (const session of sessions) check(!serialized.includes(session.token), "公共状态泄漏身份令牌。");
  check(game.you === viewer.playerId, "接口未按请求头中的身份返回视图。");
  const own = game.players.find((player) => player.id === viewer.playerId);
  check(own && typeof own.resources === "object" && Array.isArray(own.development), "本人不能读取自己的手牌。");
  for (const opponent of game.players.filter((player) => player.id !== viewer.playerId)) {
    check(!Object.hasOwn(opponent, "resources") && !Object.hasOwn(opponent, "development") && !Object.hasOwn(opponent, "totalPoints"), "其他玩家私密手牌或隐藏胜利点泄漏。");
    check(Number.isInteger(opponent.resourceCount) && Number.isInteger(opponent.developmentCount), "公共手牌数量缺失。");
  }
}

function fixedBoard(before, after) {
  const ordered = (values) => [...values].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const geometry = (board) => ({
    tiles: ordered(board.tiles).map(({ id, q, r, x, y, vertices }) => ({ id, q, r, x, y, vertices })),
    vertices: ordered(board.vertices).map(({ id, x, y, neighbors, tiles }) => ({ id, x, y, neighbors, tiles })),
    edges: ordered(board.edges).map(({ id, a, b, tiles }) => ({ id, a, b, tiles })),
  });
  const buildings = (board) => ({
    vertices: ordered(board.vertices).map(({ id, owner, level }) => ({ id, owner, level })),
    edges: ordered(board.edges).map(({ id, owner }) => ({ id, owner })),
  });
  const landscape = (board) => ({
    tiles: ordered(board.tiles).map(({ id, resource, number }) => ({ id, resource, number })),
    ports: ordered(board.ports),
  });
  check(JSON.stringify(geometry(before)) === JSON.stringify(geometry(after)), "掷骰改变了棋盘坐标或连通关系。");
  check(JSON.stringify(buildings(before)) === JSON.stringify(buildings(after)), "掷骰移动了建筑、道路或改变了归属。");
  check(JSON.stringify(landscape(before)) === JSON.stringify(landscape(after)), "掷骰重新生成了地形、数字标记或港口。");
}

async function runRoom(capacity) {
  const label = `${capacity} 人房间`;
  const created = success(await call({ type: "create", name: `验收船长${capacity}`, options: { expanded: capacity > 4, maxPlayers: capacity, extensionRule: "paired" } }), 201, `${label}创建`);
  const code = created.room.code;
  const sessions = [created];
  check(created.room.status === "lobby" && created.room.game === null, "创建房间不应自动开始。");
  check(created.room.options.maxPlayers === capacity, "房间未保存选择的人数。");
  check(/^[a-f0-9]{64}$/.test(created.token), "新玩家身份令牌强度格式不正确。");

  const early = await call({ type: "start", code, version: created.room.version }, created.token);
  check(early.status === 409 && early.data.code === "PLAYER_COUNT", "人数不足时仍允许开局。");
  for (let i = 1; i < capacity; i++) {
    const joined = success(await call({ type: "join", code, name: `验收船员${i}` }), 200, `${label}加入`);
    check(/^[a-f0-9]{64}$/.test(joined.token), "加入玩家未获得有效身份令牌。");
    check(!sessions.some((session) => session.token === joined.token || session.playerId === joined.playerId), "玩家未分配独立身份。");
    sessions.push(joined);
  }
  let latest = await read(code, created);
  check(latest.room.players.length === capacity, "加入后的玩家人数错误。");
  const overflow = await call({ type: "join", code, name: "超额玩家" });
  check(overflow.status === 409 && overflow.data.code === "ROOM_FULL", "房间允许超过选择人数加入。");

  const stranger = await call({ code }, "0".repeat(64), { method: "GET" });
  check(stranger.status === 401 && stranger.data.code === "UNAUTHORIZED", "伪造身份可以读取房间。");
  const nonHost = await call({ type: "start", code, version: latest.room.version }, sessions[1].token);
  check(nonHost.status === 403 && nonHost.data.code === "HOST_REQUIRED", "非房主可以开始对局。");
  const nonHostOptions = await call({ type: "updateOptions", code, version: latest.room.version, options: { mixedPortTrade: true } }, sessions[1].token);
  check(nonHostOptions.status === 403 && nonHostOptions.data.code === "HOST_REQUIRED", "非房主可以修改房间规则。");
  const desiredMixed = capacity === 3;
  const changed = success(await call({ type: "updateOptions", code, version: latest.room.version, options: { mixedPortTrade: desiredMixed, allowUndo: false } }, created.token), 200, `${label}修改开局前规则`);
  check(changed.room.version === latest.room.version + 1, "修改规则没有推进版本。");
  latest = await read(code, created);
  check(latest.room.options.mixedPortTrade === desiredMixed && latest.room.options.allowUndo === false, "修改后的房间规则没有持久保存。");
  check(latest.room.options.maxPlayers === capacity, "修改规则意外改变房间人数。");
  let snapshot = success(await call({ type: "start", code, version: latest.room.version }, created.token), 200, `${label}开局`);
  check(snapshot.room.status === "playing" && snapshot.room.game.phase === "setup_settlement", "开局未进入初始放置。");
  check(snapshot.room.game.options.mixedPortTrade === desiredMixed && snapshot.room.game.options.allowUndo === false, "开局引擎没有使用已保存规则。");
  const afterStart = snapshot.room.version;
  const lockedRules = await call({ type: "updateOptions", code, version: afterStart, options: { mixedPortTrade: !desiredMixed } }, created.token);
  check(lockedRules.status === 409 && lockedRules.data.code === "GAME_ALREADY_STARTED", "开局后仍允许更改规则。");
  for (const session of sessions) privateView(await read(code, session), session, sessions);
  console.log(`PASS ${label}：独立身份加入、人数限制、房主开局、手牌隔离。`);

  const activeId = snapshot.room.game.activePlayerId;
  const active = sessions.find((session) => session.playerId === activeId);
  const inactive = sessions.find((session) => session.playerId !== activeId);
  check(active && inactive, "未找到当前玩家或非当前玩家。");
  const activeView = await read(code, active);
  const legalVertex = activeView.room.legalActions.settlements[0];
  check(typeof legalVertex === "string" && legalVertex.length > 0, "初始放置未提供合法村庄位置。");
  const impersonated = await call({ type: "action", code, version: afterStart, action: { type: "buildSettlement", vertexId: legalVertex, playerId: activeId, actorId: activeId } }, inactive.token);
  check(impersonated.status === 422 && impersonated.data.code === "INVALID_ACTION", "客户端伪造当前玩家身份成功。");
  const stale = await call({ type: "action", code, version: afterStart - 1, action: { type: "buildSettlement", vertexId: legalVertex } }, active.token);
  check(stale.status === 409 && stale.data.code === "VERSION_CONFLICT", "过期房间版本可以写入。");
  const unchanged = await read(code, active);
  check(unchanged.room.version === afterStart && unchanged.room.game.phase === "setup_settlement", "被拒绝操作改变了游戏状态。");

  let placements = 0;
  while (["setup_settlement", "setup_road"].includes(snapshot.room.game.phase)) {
    check(placements < capacity * 4, "初始放置未在预期步数内结束。");
    const actor = sessions.find((session) => session.playerId === snapshot.room.game.activePlayerId);
    check(actor, "初始放置指向未知玩家。");
    const view = await read(code, actor);
    const legal = view.room.legalActions;
    const action = view.room.game.phase === "setup_settlement"
      ? { type: "buildSettlement", vertexId: legal.settlements[0] }
      : { type: "buildRoad", edgeId: legal.roads[0] };
    check(typeof (action.vertexId ?? action.edgeId) === "string", "初始放置没有合法位置。");
    snapshot = success(await call({ type: "action", code, version: view.room.version, action }, actor.token), 200, `${label}初始放置`);
    check(snapshot.room.version === view.room.version + 1, "合法放置没有恰好推进一个版本。");
    placements++;
  }
  check(placements === capacity * 4 && snapshot.room.game.phase === "roll", "初始放置结束后的回合阶段错误。");
  for (const session of sessions) {
    const view = await read(code, session);
    privateView(view, session, sessions);
    check(view.room.game.board.vertices.filter((vertex) => vertex.owner === session.playerId).length === 2, "玩家未获得两座初始村庄。");
    check(view.room.game.board.edges.filter((edge) => edge.owner === session.playerId).length === 2, "玩家未获得两条初始道路。");
  }
  console.log(`PASS ${label}：越权与过期写入被拒绝，${placements} 步合法初始放置完成。`);

  const roller = sessions.find((session) => session.playerId === snapshot.room.game.activePlayerId);
  const waiting = sessions.find((session) => session.playerId !== roller.playerId);
  const beforeRoll = await read(code, roller);
  const wrongRoll = await call({ type: "action", code, version: beforeRoll.room.version, action: { type: "roll", dice: [99, 99] } }, waiting.token);
  check(wrongRoll.status === 422 && wrongRoll.data.code === "INVALID_ACTION", "非当前玩家可以掷骰。");
  const roll = await call({ type: "action", code, version: beforeRoll.room.version, action: { type: "roll", dice: [99, 99] } }, roller.token);
  let randomness;
  if (roll.status === 503 && roll.data.code === "RANDOM_UNAVAILABLE") {
    const unchangedRoll = await read(code, roller);
    fixedBoard(beforeRoll.room.game.board, unchangedRoll.room.game.board);
    check(unchangedRoll.room.version === beforeRoll.room.version, "随机服务失败仍推进房间版本。");
    check(unchangedRoll.room.game.phase === "roll", "随机服务失败仍推进游戏阶段。");
    check(JSON.stringify(unchangedRoll.room.game.dice) === JSON.stringify(beforeRoll.room.game.dice), "随机服务失败仍写入骰子结果。");
    check(unchangedRoll.room.game.actionSequence === beforeRoll.room.game.actionSequence, "随机服务失败仍写入游戏动作。");
    randomness = "unavailable_without_fallback";
    console.log(`PASS ${label}：大气随机接口暂不可用；明确返回错误，状态未推进、未回退。`);
  } else {
    const rolled = success(roll, 200, `${label}大气随机掷骰`);
    fixedBoard(beforeRoll.room.game.board, rolled.room.game.board);
    const dice = rolled.room.game.dice;
    check(Array.isArray(dice) && dice.length === 2 && dice.every((value) => Number.isInteger(value) && value >= 1 && value <= 6), "服务端没有替换客户端伪造骰子。");
    check(rolled.room.version === beforeRoll.room.version + 1 && rolled.room.game.phase !== "roll", "有效掷骰没有正确推进状态。");
    privateView(rolled, roller, sessions);
    randomness = "available";
    console.log(`PASS ${label}：大气随机接口可用；客户端点数被忽略，合法双骰完成结算。`);
  }
  const refreshed = await read(code, roller);
  fixedBoard(beforeRoll.room.game.board, refreshed.room.game.board);
  console.log(`PASS ${label}：掷骰前后及重新读取后，棋盘坐标、地形、建筑位置与归属保持不变。`);
  results.push({ players: capacity, multiplayer: "passed", randomness });
}

try {
  const crossOrigin = await call({ type: "create", name: "跨站测试" }, undefined, { origin: "https://unrelated.invalid" });
  check(crossOrigin.status === 403 && ["CROSS_ORIGIN_REQUEST", "HTTP_ORIGIN_BLOCK"].includes(crossOrigin.data.code), "跨站创建房间未被阻止。");
  console.log("PASS HTTP：跨站写入被拒绝，同源请求使用独立 Bearer 身份。");
  await runRoom(3);
  await runRoom(5);
  console.log(`PASS 本地 HTTP 集成验收：${checks} 项断言通过。`);
  console.log(JSON.stringify({ assertions: checks, rooms: results }));
} catch (error) {
  // Errors contain descriptions/status codes only; no responses or session objects.
  console.error(`FAIL ${error instanceof Error ? error.message : "未预期的验收错误。"}`);
  process.exitCode = 1;
}
