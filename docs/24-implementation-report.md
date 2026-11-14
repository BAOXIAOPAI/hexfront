# 文档 24 · 线上七项实测修复实施报告

> 2026-11-14 第二轮。按 [`24-production-fix-guide.md`](./24-production-fix-guide.md) 实施 F1–F7。
> **本轮未发布**：`pnpm build` 已生成 v4 产物，但未同步线上；部署须另行指示。
> 先读 [`CURRENT.md`](./CURRENT.md)。本文件记录「做了什么、怎么验证、还剩什么」。

## 0. 一句话结论

F1/F2/F3/F4/F5/F6 已实现并有行为测试 + 真实 Chrome 桌面验收（20/20）；F7 本地分布诊断完成，
但**线上环境开关与运行中二进制版本 BLOCKED**（无平台管理权限），线上逐次骰点对照 NOT_RUN。
F6 的「手牌泄漏」疑点未复现，结构审计无种类泄漏，但不能据此宣称已修复。

## 1. 用户确认的两条设计边界（本轮开始前）

| 编号 | 问题 | 用户裁决 |
|---|---|---|
| F5 混合边界 | 港口兑换时「收到资源」与「给出袋里某资源同类」怎么办 | **严格足额、禁止同类抵扣**：扣费前按原始给出袋逐项校验持有量，不允许用本次刚收到的那张抵扣本次成本 |
| 协议升级 | F1/F5 会破坏旧客户端 | **同意升到 v4**，沿用不兼容升级策略（JOIN 带 v、严格相等、旧版 `PROTOCOL_MISMATCH`） |

## 2. 逐项改动

### F1 · 创建者与房主（已实现）

**协议**（`packages/protocol/src/index.ts`）
- 新增 `CREATE { roomId, name, v, players? }`；`JOIN` 不再接受 `players`（解析时丢弃）。
- `JoinFailReason` 增加 `ROOM_NOT_FOUND` / `ROOM_EXISTS`。
- 新增 `SET_PLAYER_COUNT` / `SET_BOARD`，删除 `SET_ROOM_CONFIG`（旧消息解析为 `null` → `BAD_MESSAGE`）。

**服务端**
- `RoomRegistry.create(id, players)`：同一同步块内检查+登记，并发同名只有一人成功；`delete(id)` 用于建后入座失败时撤房间。
- `server.ts` `CREATE` 分支：原子创建 → 同连接入座（`Room.join` 给首位 `hostSeat`）→ `WELCOME`；入座失败则撤房。
- `JOIN` 分支：`registry.get(roomId)`，不存在直接 `JOIN_FAILED { ROOM_NOT_FOUND }`，**绝不隐式创建**。
- `sendWelcome()` 抽成公共函数，CREATE/JOIN 两条路径共用同一份权威快照。

**前端**
- `net.ts`：`Identity.intent: 'create' | 'join'`；`join()` 按 intent 发 CREATE 或 JOIN；
  `markJoined()` 在 WELCOME 后降级 intent 并清 `players`，**重连只发 JOIN**。
- `main.ts`：`onCreate` 设 `intent='create'`，`onJoin` 设 `'join'`；`fatalText` 增加两条中文原因。

**测试**：`apps/server/test/f1-create-join.test.ts`（6）、`apps/web/test/f1-net-intent.test.ts`（4）。

### F2 · 人数与棋盘联动（已实现）

**服务端**（`apps/server/src/room.ts`）
- 新增 `commitConfig()`：**先算地图后提交**。`tryGenerateMap()` 返回 `{board, snapshot} | null`，
  失败时 `commitConfig` 直接返回 `BOARD_NOT_READY`，**不修改任何状态**（配置/地图/版本/准备全保持）。
- `applyPlayerCount(seat, n, v)`：校验房主/版本/人数；**相同人数直接 `{ok:true}`**（不洗图、不清准备、不增版本）；
  人数变化 → `recommendedBoard(n)` + `boardChoice='auto'` + 必要时重抽。
- `applyBoard(seat, kind, v)`：明确手选，标记 `boardChoice='manual'`。
- `rerollMap()` 改用 `commitConfig`，失败同样完整回滚。
- `RoomOptions.mapFactory` 测试夹具：注入生成失败，产品路径恒为 `null`。

**前端**
- `lobby.ts`：`LobbyHandlers` 拆成 `onPlayerCount` / `onBoard`；`onChange` 按 `#lb-players` / `#lb-board`
  分别只发一条意图（**F2 缺陷根因就是原来把当前盘当手动选择一起提交**）。
- `net.ts`：`setPlayerCount()` / `setBoard()`。

**测试**：`apps/server/test/f2-player-count-board.test.ts`（12），覆盖 4→6/5→8/8→4、重复保存、
非房主越权、生成失败回滚、多人同步、跨人数组合可构造。

### F3 · 桌面范围收口（已实施）

- `panels.ts` 新增 `Panels.DESKTOP_MIN_W/H = 1280/720` 与 `isDesktopViewport()`。
- `updateLandscape()`：桌面视口一律 `next='off'`，不进入 css 自转、不弹转向提示、不做方向锁。
- 新增 `syncDesktopGate()`：低于 1280×720 且非手机（`>700px`）时显示静态 `#desktop-gate` 提示，
  文案「请使用电脑并扩大窗口；最低支持 1280×720，推荐 1440×900」。
- `index.html` 新增静态节点（避免运行期 `appendChild`，也便于测试）。
- `papercut.css` 增加 `.desktop-gate` 样式。
- **保留**：相机缩放/平移/滚轮/resize/断线重连/休眠恢复/快照校正（与本短路无关）。
- 手机竖屏 ULS 状态机仅在 `<700px` 视口保留（归档范围），不再作为桌面发布门槛。
- 测试调整：`phase-d-fix-landscape.test.ts` 中 1366×768 的旧断言由 `system` 改为 `off`，并注明 F3 理由。

### F4 · 棋盘选中文字与圆片对齐（已实施 + 两个附带修复）

**圆片几何**（`scene.ts` `tileMarkup`）
- 统一中心 `(t.x, t.y)`：主圆 `cy=t.y`、内圈 `cy=t.y`、数字 `y=t.y` + `text-anchor=middle` +
  `dominant-baseline=central`（单/双位同一套）、6/8 红环 `cy=t.y`、pips `cy=t.y+14.5` 围绕 `t.x` 对称。
- 纸雕阴影**独立绘制**：`<g filter="url(#soft)">` 内 `cy=t.y+3`、`opacity=".55"`，不再充当外圈。
- 数字/装饰包在 `<g pointer-events="none">`，避免起拖触发原生文本选择；外层 `.tile` 仍可命中。

**文字选择**（`styles.css`）
- `#board, #board text, #board .tile, #board [data-layer] { user-select:none; -webkit-user-select:none }`；
  不含 `*` 全局规则，输入框/邀请链接不受影响。

**附带修复（复验发现的既有可读性缺陷）**
1. `terrainDecor` 原本以 `t.y-4` 为中心，羊/麦穗/树/山会压住半径 18.4 的数字圆片，
   导致「数字读不出来」。现改为 `terrainDecor(terrain, t.x, t.y + 72, 0.56)`，并给 `decor.ts`
   的 `terrainDecor` 增加 `scale` 参数（默认 1，不影响其他调用）。
2. `robber()` 原本画在 tile 中心（`y+2`），整个盖住数字。现加 `data-role="robber"`，
   移到地块右下角 `translate(x+24, y+22) scale(0.82)`。

**测试**：`apps/web/test/f4-board-number.test.ts`（11，含装饰避让与强盗位置的源码契约断言）。

### F5 · 拆分银行与港口（已实现）

**引擎**（`packages/engine/src/rules/trade.ts` 重写）
- `BANK_RATIO=4`、`GENERIC_PORT_RATIO=3`、`SPECIFIC_PORT_RATIO=2` 单列常量。
- `tradeBank`：仅当前玩家、严格 4 张同类 → 1 张指定资源；**不再调用任何港口比例**。
- `tradePort`：`{ seat, port, give: 资源袋, get: 资源 }`。
  - 所有权：`ownedPort()` 只认港口边两端点的**己方村庄或城市**，`state.roads` 完全不参与。
  - 通用港：`give` 任意组合恰好 3 张；专用港：只允许对应资源恰好 2 张。
  - 资源袋校验：`cleanBag()` 拒绝负数/小数/非法键；扣费前按**原始给出袋**逐项校验足额。
- 删除 `portTransfer`、`portRatioFor`、`bestPortRatios`；`PORT_TRANSFER` 命令类型移除。
- `events.ts`：`PORT_TRANSFERRED` → `PORT_TRADED { player, port, give, get, ratio }`。
- `command.ts`：新增 `TRADE_PORT`，拒绝码增加 `BAD_PORT`。

**前端**
- `panels.ts`：行动区改为「银行兑换 · 4:1」「我的港口兑换」两个独立入口，删除「借港代换」。
- `renderBank()`：完整收付预览、同种/不足/非自己回合的明确原因。
- `renderPort()`：只列「我的港口」（`myPorts()` 从公开 view 推导端点建筑），通用港可混选、
  专用港显示对应图标与 2:1、总数/种类不符时禁用并说明。
- `format.ts`：`PORT_TRADED` 事件文案。

**测试**：`packages/engine/test/trade.test.ts` 重写为 F5 验收（21），覆盖无港/有港/城市也拥有/道路不拥有/
混合 1木1砖1羊→1矿/总数非 3/负数/小数/专用港非对应资源/非自己回合/缺资源/严格足额禁止同类抵扣/旧命令被拒。

### F6 · 两步交易接入正式协议（已实现）

`panels.ts` `offerDraftHtml()` 重写为两步：
- 第一步「我想收到」（`draft.get`）：上限固定 **99**，不按对方隐藏库存限制。
- 第二步「我愿给出」（`draft.give`）：上限 = `me.resources[r]`，零资源不可增加。
- 每行：资源名 +（给出侧）持有量 + 减/加按钮 + **整数滑条**（`input[type=range]`）+ 数量。
- 步骤条「① 我想收到 / ② 我愿给出」；第二步显示「完整条件：给「X」… → 收到 …」与「改第一步」。
- 底部：`收到的提议` / `下一步：我愿给出` → 第二步 `返回修改` / `发送给「玩家名」`。
- 草稿在切换步骤、返回列表、重绘之间都保留；不自动发送。
- 滑条用 `input`/`change` 事件委托（`onRange`），与加减按钮走同一套上限钳制。
- 保留既有 D-05 契约：发送按钮在 `drawerFoot`、`offerSendGate` 统一禁用原因、卡片原地失效不重排。
- 面板压缩样式（`papercut.css`）使 5 行滑条 + 摘要 + foot 在 1440×900 一屏内读完（实测 498px < 531px）。

**测试**：`apps/web/test/f5-f6-panels.test.ts`（16，含两步结构、上限差异、草稿保留、发送回调参数、全零禁用）。

### F7 · 骰子专项诊断（本地完成，线上 BLOCKED）

- `packages/engine/test/f7-dice-diagnosis.test.ts`（5）：12 万样本，
  **七频率 0.16776**（理论 1/6≈0.16667）、**卡方 11.13**（df=10，99.9% 临界 29.59）、
  最长连续未出七 **51** 次；断言仅用于验证「未被过滤/补偿」，**不作为「必须出七」的业务规则**。
- `probe/f7-dice-diagnosis.mjs` → `probe/f7-dice-report.json`：可存档报告 + BLOCKED 说明。
- **BLOCKED**：线上运行中服务的 `HEXFONT_FAKE_DICE` 与二进制版本——仓库只有只读 HTTP/WS 能力，
  无平台管理/容器访问权限，按任务书明确记 BLOCKED，不假装已查。
- **NOT_RUN**：线上真实房间逐次 `DICE_ROLLED` / `STATE.dice` / 前端动画对照——不在用户正在玩的房间做实验。

### F6 隐私疑点（结构审计通过，现象未复现）

`apps/server/test/f6-privacy-isolation.test.ts`（6）：
- 公共 `PlayerView` 的他人条目**只有** `handSize`，无 `resources`/`devCards`。
- 改变乙的羊数（2→5），甲的视图除 `handSize` 外**完全一致**（无种类泄漏）。
- `makeOffer` 不因对方库存不足而拒绝；乙接受时才由服务端校验并返回 `INSUFFICIENT_RESOURCES`，报价保留到到期。
- `OFFERS` 快照只含双方条件字段，无任何一方完整资源袋。
- 每个座位的 `STATE` 序列化后只有 1 个 `"resources"`（自己的 `me.resources`）。

## 3. 实际验证

| 项 | 命令/脚本 | 结果 |
|---|---|---|
| 单元+集成 | `pnpm test` | **654 passed + 2 todo**（engine 177+2 / protocol 39 / server 114 / web 324） |
| 类型 | `pnpm typecheck` | 四包 `Done` |
| 构建 | `pnpm build` | `index-CWuFJ8G-.js` 152785B / `index-9gOD5LoV.css` 79245B / `server.cjs` 231.0KB |
| 骰子分布 | `f7-dice-diagnosis.test.ts` | 七 0.16776、卡方 11.13、最长干旱 51 |
| 桌面 UI | `node probe/f24-desktop-ui-check.mjs` | **20/20 PASS**（真实 Chrome + CDP，1440×900 / 1280×720 / 1100 门槛） |
| UI 报告 | `probe/f24-desktop-ui-report.json` | passed 20 / failed 0 |
| 截图 | `docs/shots/f24-*.png` | 7 张（大厅、30 格 6 人、门槛提示、摆位棋盘、两步交易×2、1280×720） |

桌面 UI 验收覆盖的 20 项：
F1-01～04（两个显式按钮、加入不存在房间不建房间、创建者房主、加入者不抢房主）、
F2-01～06（6 人自动扩展盘、快照变化、手选标记、改回 4 人、2 人不能开始、满 4 人可开始）、
F3-01～04（1440 不自转、1100 出现门槛提示、开局后不自转、1280×720 无溢出）、
F4-01～03（board/text 均 `user-select:none`、主圆/内圈/数字同心且阴影独立下移 3px、输入框仍可选中）、
F5-01（两个独立入口且无「借港代换」）、
F6-01～02（第一步「我想收到」+ 下一步、第二步滑条与完整条件 + 按阶段禁用原因）。

## 4. 未完成与已知限制

1. **未发布**：线上仍是 v3，与本轮 v4 前后端互不兼容，必须同批发布。
2. **四浏览器完整对局未跑**：本轮是单浏览器 20 项 + 协议级补位玩家，不等于「四浏览器从创建到终局」。
3. **F7 线上部分 BLOCKED**：无平台管理权限，未读运行中服务的环境变量/版本。
4. **F6 隐私现象未在线上复现**：结构审计无泄漏，但用户报告的现象需要在隔离房复现后才能下结论。
5. **手机/平板不验收**：本轮明确只做桌面；ULS 手机状态机仅归档保留。
6. **对局仍内存保存**：服务重启丢局；同名恢复的身份风险未处理。
7. `release/` 未同步（本轮只 build，未 rsync）。

## 5. 改动文件清单

**协议**：`packages/protocol/src/index.ts`（v4、CREATE、SET_PLAYER_COUNT/SET_BOARD、新拒绝码）；
测试 `protocol.test.ts`、`contract-protocol.test.ts`、`v3-lobby.test.ts`。

**引擎**：`command.ts`（TRADE_PORT、BAD_PORT）、`engine.ts`、`events.ts`、`index.ts`、
`rules/trade.ts`（重写）；测试 `trade.test.ts`（重写）、`contract-actions.test.ts`、`robber.test.ts`、新增 `f7-dice-diagnosis.test.ts`。

**服务端**：`room.ts`（commitConfig/applyPlayerCount/applyBoard/create/delete/mapFactory）、
`server.ts`（CREATE/JOIN 分离、sendWelcome、SET_PLAYER_COUNT/SET_BOARD）；
测试 `server.test.ts`（首 JOIN→CREATE）、新增 `f1-create-join.test.ts`、`f2-player-count-board.test.ts`、`f6-privacy-isolation.test.ts`。

**前端**：`net.ts`（intent、setPlayerCount/setBoard）、`main.ts`（intent、onTradePort、fatalText）、
`lobby.ts`（onPlayerCount/onBoard、鸭子类型 onChange）、`panels.ts`（F3 桌面门槛、F5 银行/港口、F6 两步交易）、
`scene.ts`（F4 圆片几何、装饰避让、强盗位置）、`decor.ts`（scale 参数）、`styles.css`（#board user-select）、
`papercut.css`（desktop-gate、offer 压缩）、`index.html`（#desktop-gate）、`format.ts`（PORT_TRADED）；
测试新增 `f1-net-intent.test.ts`、`f5-f6-panels.test.ts`、`f4-board-number.test.ts`，
调整 `lobby-v3.test.ts`、`phase-d-fix-panels.test.ts`、`phase-d-fix-landscape.test.ts`。

**验收脚本**：新增 `probe/f24-desktop-ui-check.mjs` + `f24-desktop-ui-report.json` + 7 张截图；
新增 `probe/f7-dice-diagnosis.mjs` + `f7-dice-report.json`。

**文档**：`docs/CURRENT.md`（更新事实与发布状态）、本文件。
