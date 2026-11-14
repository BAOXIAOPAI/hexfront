> **历史/专项资料提示（2026-11-14）**：先读 [CURRENT](./CURRENT.md) 和 [当前修复任务书24](./24-production-fix-guide.md)。本文保留历史事实与未被覆盖的细节，不作为最新任务入口；冲突以当前用户决定及24为准。

# 技术方案与架构

> 版本 **v0.3** · 2026-11-05
>
> **本轮约束：不接入 WorkBuddy 云服务，不写任何部署/后端联调代码。** 本文档只定选型与结构，供评审。
> 云服务接入点在第 8 节预留。
>
> ⚠️ **v0.3 说明**：变体规则（`06-variant-rules.md`）引入了**单一行动阶段**（掷骰位置完全自由）、任意人发起交易、借港、银行无限、允许赠予。
> 这些改动**没有推翻任何架构选型**——事件溯源、服务端权威、视角隔离全部继续有效。
> 状态机反而变简单了：不需要阶段切换逻辑，只要一个 `hasRolled` 布尔量。

---

## 1. 架构的第一原则

> **规则引擎必须能脱离网络、脱离 UI、脱离数据库独立运行并被完整测试。**

这不是技术洁癖，是"避免边做边改"的唯一硬保障。理由：

- 规则缺陷在 UI 里会伪装成"能玩"，直到第 20 局才发现计分错了
- 一旦 UI 先于引擎成型，任何规则修正都要同时改三处
- 引擎纯函数化后，一整局游戏可以在 50ms 内跑完——这让"随机模拟一万局查异常"成为可能

所以整个架构围绕一条线：**UI 是引擎的投影，引擎是真相的唯一来源。**

```
┌─────────────────────────────────────────────┐
│  浏览器（只是渲染器，不做任何规则判断）         │
│  React + SVG                                 │
└──────────────┬──────────────────────────────┘
               │ 只发 Command，只收 Event
               ▼
┌─────────────────────────────────────────────┐
│  服务端（权威）                                │
│  ┌───────────────────────────────────────┐  │
│  │  rules-engine  ← 纯函数、零依赖、100% 可测 │  │
│  └───────────────────────────────────────┘  │
│  ┌───────────────────────────────────────┐  │
│  │  game-session（房间/连接/广播/持久化）    │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

**关键铁律**：客户端**不允许**出现任何形如 `if (resources.wood >= 1) 允许建造` 的判断。合法性只由服务端裁决，客户端的高亮/灰显只是**服务端下发的提示字段**的渲染。

---

## 2. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 语言 | **TypeScript**（前后端统一） | 规则引擎与 UI 共享类型定义，坐标/资源枚举改一处全局生效 |
| 规则引擎 | 纯 TS，**零运行时依赖** | 可单测、可跑在 Node 与浏览器、可导出给 AI 训练 |
| 前端 | React + Vite | 生态成熟，热更新快；不用 Next.js（无 SSR 需求，徒增复杂度） |
| 渲染 | **SVG**（不用 Canvas） | 六边形是静态图形 + 位移/高亮动画。SVG 天生支持事件绑定、CSS 过渡、无障碍。Canvas 需要自己做命中检测，54 顶点逐个检测是自找麻烦 |
| 状态管理 | Zustand（轻量） | 单一 store 存 `GameState` + `UiState`，比 Redux 轻得多 |
| 样式 | Tailwind CSS | 移动端适配快，不用维护一堆 CSS 文件 |
| 后端 | Node 22 + Fastify | 轻、快、TS 原生友好 |
| 实时通信 | **原生 WebSocket（ws）** | 不用 socket.io：协议重、封装厚，而我们需要完全掌控重连与 seq 语义 |
| 存储 v0.1 | **SQLite**（better-sqlite3） | 单文件、零运维、同步 API 简单；事件表 + 快照表足够 |
| 存储 v0.2 | WorkBuddy 云服务 | 见第 8 节 |
| 测试 | Vitest | 与 Vite 同源，配置成本为零 |
| 部署 | 单机 Docker（v0.1） | 朋友局，一台小机器足够 |

---

## 3. 核心模型：事件溯源

### 3.1 三个概念

| 概念 | 含义 | 示例 |
|---|---|---|
| **Command** | 玩家意图，**可能非法** | `PLAY_KNIGHT { playerId, tileKey, stealFrom }` |
| **Event** | 引擎裁决后的既成事实，**一定合法** | `KNIGHT_PLAYED { playerId, from, to }` |
| **State** | 由全部 Event 折叠出的当前局面 | `GameState` |

```
Command ──[引擎裁决]──> Event[] ──[折叠]──> GameState
              ↑
         非法则拒绝，返回原因，不产生任何 Event
```

### 3.2 为什么选事件溯源（而不是直接存状态）

| 收益 | 说明 |
|---|---|
| **断线重连免费实现** | 重连 = 从某 seq 之后重放事件，无需额外写恢复逻辑（对应 FR-70） |
| **回放功能免费实现** | 一局游戏就是一个事件列表，v0.2 的回放直接读它 |
| **调试极其容易** | Bug 复现只需"这串事件"，不用描述"我当时点了什么" |
| **并发安全** | 事件有序落盘，竞争条件在写入时就被 seq 串行化 |
| **可审计** | 谁在何时做了什么，天然记录 |
| **测试友好** | 引擎输入是 (State, Command)，输出是 Event[]，纯函数易测 |

**代价**：状态需要重放才能得到 → 用**快照**解决（每 30 个事件存一次 State，重放最多 30 条）。

> 我认为这个取舍在本项目上压倒性划算。**请确认这个方向**（D-13）。

### 3.3 事件类型清单（v0.1）

按阶段分组，这是引擎的"对外契约"，定了就不轻易改：

**开局**
```
GAME_STARTED           { map, players, seatOrder, placementDeadline }
SETTLEMENT_PLACED      { playerId, vertex, roadEdge, isSecondRound }
PLACEMENT_WARNING      { remainingMs }                    // 二级超时开始
PLACEMENT_AUTO_PLACED  { playerId, vertex, roadEdge, reason: "timeout" }
```

**回合**
```
TURN_BEGUN             { playerId, turnNumber }              // 无阶段概念，动作顺序自由
DICE_ROLLED            { playerId, d1, d2 }
RESOURCES_PRODUCED     { grants: [{playerId, resource, count}] }   // 无 starved（银行无限）
SEVEN_ROLLED           { playerId }
DISCARD_REQUIRED       { requirements: [{playerId, count}] }
CARDS_DISCARDED        { playerId, cards }
ROBBER_MOVED           { playerId, from, to }
CARD_STOLEN            { thiefId, victimId, resource }   // 仅受害者的客户端知道具体资源
TURN_ENDED             { playerId }
```

**交易**（v0.2 重写：以当前玩家为中心的请求/审批）
```
TRADE_OFFERED          { offerId, fromId, toId, give, want }     // 任一方发起，但必须有一方是当前玩家
TRADE_COUNTERED        { offerId, byId, give, want }
TRADE_COMPLETED        { offerId, aId, bId, aGives, bGives }     // 任一方可为空（零对价/存牌）
TRADE_WITHDRAWN        { offerId, reason }                       // 含回合结束自动失效
BANK_TRADED            { playerId, give, want, ratio: 4 | 3 | 2 }
PORT_TRANSFERED        { executorId, beneficiaryId, give, want, ratio }
```

**建造**
```
ROAD_BUILT             { playerId, edge, free? }
SETTLEMENT_BUILT       { playerId, vertex }
CITY_BUILT             { playerId, vertex }
```

**发展卡**
```
DEV_CARD_BOUGHT        { playerId, count }               // 不给其他人看到是什么
DEV_CARD_PLAYED        { playerId, cardType }
MONOPOLY_RESOLVED      { playerId, resource, gains: [{playerId, count}] }
YEAR_OF_PLENTY_USED    { playerId, resources }
ROAD_BUILDING_USED     { playerId, edges }
LARGEST_ARMY_CHANGED   { fromPlayerId, toPlayerId }
```

**争夺与终局**
```
LONGEST_ROAD_CHANGED   { fromPlayerId, toPlayerId, length }
GAME_WON               { playerId, finalScores }
```

> ⚠️ **信息隔离事件**：`CARD_STOLEN` 的资源种类、`DEV_CARD_BOUGHT` 的具体卡，必须**按玩家视角过滤**后下发。这是服务端的责任，不是前端隐藏。
> 客户端拿到的 State 必须是"该玩家视角的 State"，不是全量 State。**这条必须在 M1 就定好，否则后期全部返工。**

---

## 4. 同步协议

### 4.1 消息格式

```
C → S: { type: "command", seq, cmd: { type: "BUILD_ROAD", payload } }
S → C: { type: "events",  fromSeq, events: [...] }
S → C: { type: "reject",  seq, reason: "INSUFFICIENT_RESOURCES" }
S → C: { type: "snapshot", state, seq }        // 首次进入/长时间断线
```

### 4.2 重连流程

```
1. 客户端持有 lastSeq（内存 + localStorage 双写）
2. 重连时发送 { type: "resume", gameId, lastSeq }
3. 服务端判断：
   - 缺失事件数 < 200 → 补发 events
   - 否则           → 直接发 snapshot + 后续
4. 客户端清空本地状态，从头折叠事件
```

**幂等保证**：每个事件有唯一 seq，重复应用同一 seq 直接丢弃。

### 4.3 延迟处理

朋友局不做延迟补偿（这是回合制，不需要）。但要做**乐观 UI**：

| 操作 | 是否乐观更新 |
|---|---|
| 掷骰 | 否（等待真实结果） |
| 建造 | **是**（本地先显示，被拒则回滚 + 提示） |
| 交易 | 否（涉及对方资源，必须等裁决） |
| 移动视角 | 是（纯前端） |

---

## 5. 规则引擎设计

### 5.1 接口

引擎唯一入口约为：

```
applyCommand(state: GameState, cmd: Command): 
  { ok: true, events: Event[], nextState: GameState } 
| { ok: false, reason: RejectReason }
```

纯函数，无 I/O、无随机（随机通过传入的 `rng` 参数注入，便于测试复现）。

> **随机数可注入是关键测试手段**：给定固定种子，一整局的骰子序列可复现，Bug 才可能被稳定重现。

### 5.2 内部模块

| 模块 | 职责 |
|---|---|
| `board/` | 六边形坐标、邻接表、地块/顶点/边生成（对应 R-00~R-04） |
| `validation/` | 所有合法性判断（距离规则、连通性、资源充足、数量上限） |
| `resources/` | 产出结算、弃牌计算（**银行无限，无库存逻辑**） |
| `trade/` | 请求/审批、还价、**零对价转移**、原子转移 |
| `port/` | 港口比例判定、**借港代换** |
| `build/` | 建造与上限 |
| `devcards/` | 牌堆、购买、打出 |
| `contention/` | 最长路算法、最大军 |
| `score/` | 分数计算与胜负判定 |
| `view/` | **视角投影**：`fullState → playerView(playerId)` |

### 5.3 最长路算法（单独说明）

这是引擎里最容易写错的一块（见 R-91/92），实现要求：

```
输入：玩家 P 的全部道路（边集合）、所有玩家的村庄/城市（顶点集合）
1. 构造图：只保留 P 的边，顶点为边端点
2. 移除被对手村庄/城市占据的顶点（对手建筑阻断通行）
3. 在该图上求最长简单路径（DFS 回溯，路网度数 ≤3，必要时可加剪枝）
4. 返回路径长度
```

**不能用"数边的总数"**，分叉时会错。**必须有针对性测试用例**：包括 Y 形分叉、环形、被对手村庄截断。

### 5.4 测试策略

| 类型 | 内容 |
|---|---|
| **条目测试** | `02-rules-spec.md` 每条 R-xx 至少一个用例，用例名直接用编号 |
| **错误清单测试** | 第 L 节「十大常见错误」每条一个反向用例 |
| **属性测试** | 随机生成 10000 次合法/非法 Command 序列，断言：状态永远合法；**资源守恒需换算法**——银行无限，不能用"银行+玩家 = 常数"，改用「玩家总手牌 = 累计产出 + 兑换所得 − 建造消耗 − 兑换付出 − 弃牌」 |
| **重放测试** | 任意事件序列折叠两次，结果必须完全相等 |
| **整局模拟** | 随机策略跑 1000 局，全部能正常结束（无死锁、无异常） |

> 「资源守恒」是个极强的断言——它能一次性抓出一大批加减错误，建议作为 CI 必过项。

---

## 6. 前端结构

```
src/
├── engine/              ← 与后端共用同一份（monorepo workspace）
├── net/                 连接、重连、seq 管理
├── store/               Zustand：gameState + playerView + uiState
├── board/               SVG 渲染
│   ├── HexTile.tsx
│   ├── Vertex.tsx       顶点热区（含偏移映射，见 03 文档第 6.3 节）
│   ├── Edge.tsx
│   └── Robber.tsx
├── hand/                手牌区
├── trade/               交易请求区、面板、还价
├── build/               建造模式与预览
├── hud/                 分数条、日志、提示
└── pwa/                 manifest、service worker
```

**渲染性能**：19 块 + 54 顶点 + 72 边 ≈ 150 个 SVG 节点，无性能压力。不需要虚拟化。动画用 CSS transition，不用动画库。

---

## 7. 数据与持久化

### 7.1 v0.1 表结构（SQLite）

```
games        (id, created_at, status, player_count)
events       (game_id, seq, type, payload, ts)     PRIMARY KEY (game_id, seq)
snapshots    (game_id, seq, state)                 -- 每 30 事件一份
```

**没有 `players` 表**——v0.1 无账号，玩家只是 `GAME_STARTED` 里的一段数据。

### 7.2 容量估算

一局 4 人卡坦约 400~600 个事件，单事件 JSON 约 200 字节 → 一局约 120KB。1000 局 = 120MB。SQLite 完全够，甚至不需要清理策略。

---

## 8. v0.2 云服务接入点（本轮不实现，仅预留）

设计上需要保证以下三处**后期可以替换而不改引擎**：

| 接入点 | v0.1 | v0.2 |
|---|---|---|
| 身份 | 昵称 + 房间号，无持久身份 | WorkBuddy 云服务认证（替换 `session/identity` 模块） |
| 存储 | SQLite | 云数据库（替换 `storage/` 接口实现，**引擎无感知**） |
| LLM（可选） | 无 | 规则问答 / AI 对手（独立模块，不侵入引擎） |

**为此，v0.1 的代码必须遵守一条约束**：`storage` 与 `identity` 都是**接口**，不是具体实现。所有其他地方只依赖接口。这条现在写进文档，是为了避免 M3 时重构。

---

## 9. 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| **六边形顶点在手机上点不准** | 高（直接影响可玩性） | 早期做原型的真机验证；兜底方案是"点选后弹出候选列表" |
| **交易并发竞态** | 高（会导致资源凭空产生） | 服务端串行裁决 + 成交前二次校验；引擎层就用资源守恒断言测试 |
| **信息泄露**（视角过滤遗漏） | 高（作弊/破坏体验） | 视角投影统一在 `view/` 一处实现，禁止其他地方直接读 fullState |
| **最长路算法错** | 中（错判胜负） | 独立实现 + 针对性测试集（分叉/环形/截断） |
| **规则歧义后期被发现** | 中（返工） | 本套文档就是应对：所有 `[歧义]` 项提前裁决 |
| **UI 先于引擎成型** | 中（大批返工） | M1 先做引擎，UI 严格后置 |

---

## 10. 需要你确认的技术决策

| D 项 | 问题 |
|---|---|
| **D-13** | 是否采用事件溯源架构？（我的建议：采用） |
| **D-14** | 前后端是否用 monorepo 共享引擎代码？（我的建议：是，pnpm workspace） |
| **D-15** | v0.1 是否只用 SQLite、不接任何云服务？（按你的要求默认是） |
| **D-16** | 是否接受"随机数种子可注入"的设计（为可复现调试）？（建议接受，零成本） |
