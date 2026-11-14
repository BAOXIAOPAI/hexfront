> **历史/专项资料提示（2026-11-14）**：先读 [CURRENT](./CURRENT.md) 和 [当前修复任务书24](./24-production-fix-guide.md)。本文保留历史事实与未被覆盖的细节，不作为最新任务入口；冲突以当前用户决定及24为准。

# 文档 23 · L-1～L-5 实施报告

> 2026-11-12。按 [`23-lobby-map-setup-guide.md`](./23-lobby-map-setup-guide.md) §8 与 [`23-L0-spec-check.md`](./23-L0-spec-check.md) 已冻结决定实施。
> 本轮**未另建项目、未迁移框架**；保留既有变体规则、交易 10s/3s/每人一条、掷 7 行动边界、桌面纸雕方向；未做手机适配、未部署；用户原有未提交文件（`docs/README.md`、两份文档 23 规划）原样保留，只在 README 追加索引。

## 1. 已冻结决定（L-0，用户确认）

| 编号 | 决定 |
|---|---|
| A | 扩展盘官方 **11 港**：5 通用 3:1 + 6 专用 2:1（羊毛 2 个，其余各 1）；沿岸固定 11 槽位，只随机类型 |
| A-附 | 扩展盘 **30 格 / 2 沙漠**，地形木6 砖5 羊6 麦6 矿5 沙漠2；数字袋 28 个（2/12 各 2，3–11 各 3）；发展卡仍 25 张 |
| B | 双沙漠强盗按 **seed 确定性选定**一个，写进地图快照广播；全场只有一个强盗 |
| C | **不引入额外前瞻约束**，沿用现有距离规则；跨人数选图允许开始但 UI 提示拥挤；代放无合法候选时暂停报错 |
| D | 7–8 人只做功能验收，拥挤度作为观察项，不宣称官方支持 |
| E | **房主创建房间时一次性设定人数上限 4–8**；满员且全员在线准备后房主点击开始；取消满员自动开局，无动态降低目标人数流程 |
| 计时 | 每次「村庄＋道路」独立 **180 秒**，末位两次各一份预算；断线不暂停；超时系统随机合法代放 |
| 随机 | 服务端权威、seed 可复现、配比守恒、任意 6/8 不共边；地图 seed 不复用为骰子/发展卡随机源 |

## 2. 分阶段改动

### L-1 大厅与房主（协议 v3 + 服务端 Room + 前端大厅）

- 协议升到 **v3**（`packages/protocol/src/index.ts`）：JOIN 带 `players`（创建者设人数）、`READY`、`SET_ROOM_CONFIG`、`REROLL_MAP`、`SET_ORDER`、`RANDOMIZE_ORDER`、`START(configVersion)`；新增 `LOBBY_CONFIG`、`SETUP_TIMER`、`SETUP_AUTO_PLACED` 推送；`WELCOME` 带 `lobby/map/timer/settings` 权威快照；旧客户端仍由 JOIN 版本校验判 `PROTOCOL_MISMATCH`。
- 服务端 `Room`（`apps/server/src/room.ts`）：首位创建者成为 `hostSeat`；服务端再次校验房主权限（前端禁用按钮只是呈现）；`configVersion` 原子锁定；人数/地图/顺序/重抽变化清全员准备，昵称/在线状态变化不清；房主断线 60 秒宽限后移交给最早入房且在线者，原房主回来不夺回；**取消满员自动开局**；已开始拒绝加人/改配置/重排/重抽；同身份重连继续允许且乱序重连不串座。
- **夹具边界**：产品默认 4 人、需准备、手动开始；旧 2–3 人交易/视角测试通过 `RoomOptions`（`minPlayers`/`autoStartOnFull`/`skipReadyCheck`/`board`）显式保留，未向产品放宽。
- 前端新增独立大厅模块 `apps/web/src/lobby.ts`：席位与准备状态、地图预览、蛇形顺序与上下调整、人数/地图配置、拥挤/自定义提示、开始按钮、倒计时；入房表单支持「创建房间」并选人数。
- **邀请链接与随机房间号**（后续按用户反馈新增，`apps/web/src/invite.ts`）：首页自动生成 `形容词-名词-4位随机` 房间号（符合服务端 `^[a-z0-9_-]{1,24}$`），提供「换一个」与「复制邀请链接」。链接只带 `room`（**不带 name**，朋友需自己填昵称，不误用房主身份），并原样透传平台鉴权 `sharecode`；点击链接进来时 `?room=` 预填房间号，且**不会被随机号覆盖**。剪贴板优先 `navigator.clipboard`，失败回退 `execCommand`，再失败提示手动复制（链接框可点选全选）。
- **首页文案重写**：删掉「同一 WiFi 下」「各开一个浏览器窗口」「输完按键盘上的『前往』」「同名重连…座位被占用会被拒绝」等不准确/自相矛盾的表述，改为「把邀请链接发给朋友，对方点开填昵称即可进来，不需要在同一网络下」及准备/开始规则说明。
- **架构结论：邀请链接不依赖 WorkBuddy 云管理**。房间只是服务端内存里的 `Map<roomId, Room>`，房间号就是 URL 参数；本功能纯前端字符串 + URL + 剪贴板，服务端零改动。唯一与平台相关的是 `sharecode`，复制链接必须透传，否则发布环境 WS 连不上。
- **地图预览为真正的六边形棋盘**（后续按用户反馈改进）：直接复用引擎 `buildGeometry` / `cornersOf` 渲染 SVG，19/30 格按真实 (u,row) 网格排布；数字带 pips 点阵、6/8 红色粗描边、沙漠画 `⌁` 并标强盗起点、港口标签贴在真实沿岸边中点。不是一排彩色方块。
- **拼接修正**：初版曾把六边形半径写成 27、中心坐标仍按引擎 `HEX_SIZE=56` 排布，导致蜂窝出现大片空隙。现统一用 `HEX_SIZE` 作为预览半径，缩放完全交给 SVG viewBox，六边形紧密共享边；并加了回归断言（相邻中心距 = `R·√3`、`minD/r = √3`），防止坐标与半径比例再次脱节。
- **资源质量提示**：按指南 §3 的 `6−|7−n|` 理论产出权重统计五类资源，给出「此图可能缺矿／木相对充足／较均衡」等直观提示，并附免责说明「仅作抢位参考，不保证实际掷骰结果」；独立复核 6/8 不相邻，异常时提示重抽。
- 预览截图证据：[docs/shots/23-lobby-hex-preview.png](./shots/23-lobby-hex-preview.png)（真实 Chrome headless 渲染）。

### L-2 地图生成（引擎 `mapgen.ts`）

- `generateMap(kind, seed, version, budget)`：种子化 PRNG（mulberry32），Fisher–Yates 洗地形 → 红点（6/8）回溯挑互不相邻地块 → 其余数字随机填 → 港口槽位几何固定、只洗类型 → seed 确定性选双沙漠强盗。
- `validateMap(spec)` 校验配比守恒、红点不共边、港口槽位、强盗在沙漠；`BASE_RECIPE` / `EXT_RECIPE` 单列配置。
- 有搜索预算与明确失败反馈（`SEARCH_EXHAUSTED` / `BAD_CONFIG`），失败保留上一张合法地图，不无上限循环。
- `createGame` 支持快照指定的 `ports` / `robberTile`；`MapSnapshot` 全员同一份，客户端不得自行 `Math.random` 生成。

### L-3 人数与扩展盘

- `PLAYER_COLORS` 扩到 8 色；`PLAYER_HEX` / `PLAYER_MARK`（甲乙丙丁戊己庚辛）/ `ROAD_DASH`（8 种纹理）同步补齐，不只靠颜色区分。
- `GameState.actionOrder` 是稳定的 seat 排列；**不排序 `players[]`、不重排 socket→seat 映射**，因此私有手牌视图、昵称、颜色、重连凭证天然不串座。
- 选地 = `actionOrder + reverse(actionOrder)`；正常首回合从 `actionOrder[0]` 开始；`endTurn` 沿 `actionOrder` 循环。
- `buildGeometry` 已支持 `[3,4,5,6,5,4,3]` 30 格；`geometryForTileKeys` 从视图地块 key 反推行结构，前端无需改几何核心。

### L-4 顺序与计时

- 房主可上下移动或随机排序，调整后清全员准备；开局后锁进 `GameState.actionOrder`。
- 每个选地步骤独立 180 秒：进入新步骤重新起算，上一步剩余不累积；末位连续两次各一份预算；断线不暂停；动画/广播不推迟计时。
- 超时由 `autoPlace()` 从合法 (村庄, 道路) 候选中**先均匀选村庄、再均匀选其道路**，走与手动完全相同的 `applyCommand(PLACE_SETTLEMENT)` 入口，不跳过距离/连接限制；广播「某某超时，系统代放」。
- `gameId + setupStep + version` 防重复计时器/多次代放；deadline 后迟到提交被拒并回推最新状态；合法提交抢在 deadline 前会取消超时任务。
- 无合法候选时暂停开局并广播 `NO_LEGAL_PLACEMENT`，不空转、不跳过、不伪造建筑。
- 代放也按既有 `setupGrant` 规则正确发放第二次落子资源。

### L-5 验收

- `pnpm test`：**588 passed + 2 todo**（engine 169+2 / protocol 37 / server 90 / web 292），`pnpm typecheck` 四包通过，`pnpm build` 成功。
- `probe/invite-browser-check.mjs`：真实 Chrome headless **9/9 通过、零页面错误**（随机号合法、链接带 room/透传 sharecode/不带 name、换号同步链接、复制反馈、邀请链接预填不被覆盖）；报告 `probe/invite-browser-report.json`，首页截图 `docs/shots/23-join-invite.png`。
- `probe/l0-board-feasibility.mts`：19 格容量 27 / 30 格容量 40；4–8 人 × 两盘共 32000 局摆位模拟 0 死局；6/8 不共边构造 10000 种子 0 失败。
- `probe/l5-endtoend.mjs`：真实 WS，产品默认配置，4/5/6/7/8 人五个场景全通过（含 4 人 400 回合 / 8 人 400 回合、65–73 次掷 7 与完整弃牌/强盗链路、零拒绝）。
- `probe/l5-fullgame.mjs`：**两局真实打到 `phase=ended`**
  - 4 人标准盘：胜者甲，比分 `10:4:3:6`（约 101 回合）
  - 8 人扩展盘：胜者己，比分 `2:3:3:3:5:10:3:2`（约 94 回合，8 人自定义玩法）
  - 两局均含建造/升级城市/银行兑换/发展卡，零错误；报告见 `probe/l5-fullgame-report.json`。
- `apps/server/scripts/bot.ts` 适配 v3 协议（JOIN players / READY / START configVersion / 动态几何），并补上文档 §3 点名的「脚本策略」缺陷修复（银行 4:1 兑换凑村庄成本、避免盲目铺路耗尽木砖），使 bot 能稳定把对局打到终局。**这不改变任何正式规则**，只改验收脚本决策。
- 桌面截图：新增 `docs/shots/23-lobby-hex-preview.png`（六边形地图预览真实 Chrome 渲染）；其余沿用 `docs/shots/` 既有证据。全 UI 浏览器完整对局仍未取证。

## 3. 必测清单对照（指南 §8 L-5）

| 必测项 | 证据 |
|---|---|
| 非房主越权 | `lobby-v3.test.ts` 房主权限组；L5 场景 `nonHostRejected` |
| 设置改变清准备 | `lobby-v3.test.ts` 准备与手动开始组；L5 场景 `configClearsReady` |
| 重复开始 | `lobby-v3.test.ts` 重复开始；L5 场景 `duplicateStartRejected` |
| 最后一人加入不自动开局 | `lobby-v3.test.ts`；L5 场景 `noAutoStart` |
| 房主断线移交 | `lobby-v3.test.ts` 房主权限组（60s 可控时钟） |
| 乱序重连不串座 | `lobby-v3.test.ts` 排序与身份隔离组 |
| 所有玩家均放两村两路 | `lobby-v3.test.ts` 完整摆位；L5 场景 `setup` |
| 系统代放与手动提交竞争 | `lobby-v3.test.ts` 计时组（迟到提交拒绝、抢在 deadline 前取消） |
| 超时后资源按第二次落子规则发放 | `lobby-v3.test.ts`「第二次落子规则」 |
| 减少动态模式不影响计时 | 本轮无「动态模式」开关，计时不受任何前端动画影响（服务端 `now()` 权威） |
| 4 人既有流程回归 | 服务端 62 旧测试 + 前端 253 旧测试全绿；L5 4 人场景 |
| 旧客户端拒绝 | 协议 v3 版本校验；`v3-lobby.test.ts` |
| 服务重启恢复 | **未宣称支持**：对局仍为内存状态，新增 countdown 未引入持久化（指南明确不得宣称） |

## 4. 多人预览 / 排序一致性证据

- `mapgen.test.ts`：200 个种子 × 两盘全部通过 `validateMap`；同 seed 复现、不同 seed 不同；`createGame` 后地形/数字/港口与快照逐格一致。
- `lobby-v3.test.ts`（前端）：同一份 `MapSnapshot` 换观察者后摘要一致（全员同一预览）；排序不改玩家数组/昵称/颜色/私有视图；乱序重连回原座。
- `l5-endtoend.mjs`：`boardApplied` / `mapSnapshot`（tiles、ports、deserts、seed、boardVersion）在每个场景由服务端广播后断言。

## 5. 未完成项与已知边界

1. **浏览器 UI 截图**：已新增 `docs/shots/23-lobby-hex-preview.png`（地图预览单组件真实 Chrome 渲染）；L-5 的「4 浏览器页面全 UI 完整对局」仍是历史 NOT_RUN 口径，未在本轮改判。协议级 bot 已真实打到 `phase=ended`，但不冒充全 UI 浏览器对局。
2. **拥挤度量化**（冻结 D1）：只做功能验收；`l5-fullgame-report.json` 的 `observations` 记录了「4 人 × 19 格标准盘」「8 人 × 30 格扩展盘」及「7–8 人不宣称官方支持」，未设硬指标。8 人局实际约 94 回合结束，未观察到摆位死局或规则阻塞。
3. **服务重启恢复**：对局仍是内存状态，不支持服务重启后恢复；新增 180 秒计时未引入持久化。
4. **08 / 06 历史表述**：`08-status.md`、`06-variant-rules.md` §8 仍写「选地阶段总时长 3 分钟」，与文档 23「每次独立 180 秒」冲突。按 README 优先级以文档 23 为准；历史快照未改写，需在后续文档整理时加注。
5. **发展卡 25 张**：按冻结 A-附保留，未随地图扩展改动牌堆。
6. **骰子/发展卡随机源**：仍用 `Math.random()`，与地图 seed 完全独立；未复用公开种子。

## 6. 改动文件清单

- 引擎：`types.ts`（8 色）、`board.ts`（MapSpec 快照字段）、`mapgen.ts`（新）、`state.ts`（actionOrder / 快照 / createGame 选项）、`rules/setup.ts`、`rules/roll.ts`、`rules/view.ts`、`index.ts`；测试 `mapgen.test.ts`、`action-order.test.ts`（新）。
- 协议：`src/index.ts`（v3 全量）；测试 `v3-lobby.test.ts`（新）、`protocol.test.ts` / `contract-protocol.test.ts`（版本与新消息）。
- 服务端：`src/room.ts`（重写大厅/房主/计时）、`src/server.ts`（v3 路由）、`scripts/bot.ts`（v3 适配）；测试 `lobby-v3.test.ts`（新）、`helpers.ts` / 三个旧测试（夹具边界）。
- 前端：`lobby.ts`（新）、`main.ts`、`net.ts`、`ui.ts`、`theme.ts`、`styles.css`；测试 `lobby-v3.test.ts`（新）、`phase-d-fix-resume.test.ts`（v3 字段）。
- 文档 / 验收：`23-L0-spec-check.md`（新）、`23-implementation-report.md`（本文件）、`README.md`（索引）、`probe/l0-board-feasibility.mts`、`probe/l5-endtoend.mjs` + 报告、`probe/l5-fullgame.mjs` + 报告。
