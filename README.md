# 六角拓荒

一个跑在浏览器里的卡坦岛变体桌游：Vite + 原生 TypeScript 的 SVG 前端，加一个 Node + WebSocket 服务端。服务端权威裁决，前端只发命令、只渲染。

**不需要待在同一个局域网** —— 已经部署在公网，打开链接、把邀请链接发给朋友就能开局。

## 线上开一局

👉 **https://hexfront.app.workbuddy.host/?sharecode=EWCTT4T5YE**

- 需要电脑浏览器，窗口 **≥ 1280×720**（推荐 1440×900）。项目只做桌面端，手机和平板会看到尺寸门槛提示。
- 链接里的 `sharecode` 不能删：托管平台的反向代理靠它放行 WebSocket，直接访问裸域名会返回 403。
- 步骤：填昵称 → 点「创建房间」并设定人数（4–8）→ 复制邀请链接发给朋友 → 全员准备后由房主开始。

房间号只允许小写字母、数字、`-`、`_`，最长 24 位；直接打开首页会自动给一个随机号（如 `quiet-harbor`）。

## 本地开发

```bash
pnpm install
pnpm dev
```

会同时启动两个进程：

| 进程 | 地址 | 作用 |
|---|---|---|
| 服务端 | `http://0.0.0.0:8787` | 房间管理、规则裁决、WebSocket |
| 前端 | `http://localhost:5173` | 界面（`/ws` 自动代理到 8787） |

打开 http://localhost:5173 就能玩。

> **8787 被占用？** 换个端口，服务端和前端必须指同一个：
>
> ```bash
> PORT=8790 HEXFRONT_WS_TARGET=ws://127.0.0.1:8790 pnpm dev
> ```
>
> 然后访问 `http://localhost:5173`（前端端口不变）。

## 和朋友一起玩

**线上（推荐）**：创建房间后点「复制邀请链接」发过去，对方填个昵称就能进，跨网络也能连。

**本地局域网**（调试用）：`pnpm dev` 起来后，让朋友打开

```
http://<你的内网IP>:5173/?room=<房间号>
```

同一 WiFi 下才通。查自己的内网 IP：

```bash
ipconfig getifaddr en0
```

两种方式都认这几个 URL 参数：

| 参数 | 作用 |
|---|---|
| `room` | 房间号。带了这个参数就不会被随机号覆盖，刷新也沿用 |
| `name` | 昵称。带了会跳过表单直接坐回原座位 |
| `players` | 创建房间时的人数上限（4–8） |
| `sharecode` | 平台鉴权，仅线上需要；「复制邀请链接」会自动带上 |

## 一局怎么开始

- **人数 4–8**，房主建房间时设定上限。改人数会按推荐换盘（4–5 人 → 标准盘 19 格，6–8 人 → 扩展盘 30 格），重复提交同一个人数不会重新洗图。
- 大厅能看到**棋盘预览**（地形、数字、港口、强盗）和资源稀缺/富余提示；房主可以重掷地图、手动选盘、随机或手动指定**选地顺序**。
- 坐满目标人数、全员在线且准备后，**房主手动点开始** —— 没有「满员自动开局」，人数不够也开不了。
- 开局摆位：每次「村庄 + 相邻道路」独立 **180 秒**，超时由系统随机合法代放，不会把整局卡死。
- 断线后用同一个昵称重连会坐回原座位，座位在整局期间保留。

## 协议版本

当前是 **v4**（不兼容升级）。`CREATE` / `JOIN` 都带版本号，服务端只接受 `PROTOCOL_VERSION = 4`，旧客户端会被 `JOIN_FAILED: PROTOCOL_MISMATCH` 拒绝。

所以改协议时**前后端必须同批发布**：`packages/protocol/src/index.ts` 里的常量一变，旧前端就连不上新服务端。

## 单人测试：陪玩 bot

不想拉人也能打完整一局。`apps/server/scripts/bot.ts` 会连进房间占一个座位，自动摆位（挑高产地点）、掷骰、掷 7 弃牌/挪强盗、资源够就建（城 > 村 > 路）、结束回合。

```bash
cd apps/server

# 陪你打一局：你先进房创建 4 人局，再起 3 个 bot 把座位坐满
npx tsx scripts/bot.ts "wss://hexfront.app.workbuddy.host/ws?sharecode=EWCTT4T5YE&room=abc" 甲 --players 4
npx tsx scripts/bot.ts "wss://hexfront.app.workbuddy.host/ws?sharecode=EWCTT4T5YE&room=abc" 乙 --players 4
npx tsx scripts/bot.ts "wss://hexfront.app.workbuddy.host/ws?sharecode=EWCTT4T5YE&room=abc" 丙 --players 4

# 四个 bot 自动对打（验证用；--host 在全员准备后负责开局，--fast 加速节奏）
npx tsx scripts/bot.ts "ws://127.0.0.1:8787/ws?sharecode=DEV&room=botfight" 甲 --host --players 4 --fast
npx tsx scripts/bot.ts "ws://127.0.0.1:8787/ws?sharecode=DEV&room=botfight" 乙 --players 4 --fast
npx tsx scripts/bot.ts "ws://127.0.0.1:8787/ws?sharecode=DEV&room=botfight" 丙 --players 4 --fast
npx tsx scripts/bot.ts "ws://127.0.0.1:8787/ws?sharecode=DEV&room=botfight" 丁 --players 4 --fast
```

`--players` 要和房间人数一致；`--debug` 打印每回合手牌与候选数。bot 只发协议命令，规则全由服务端裁决，被拒（REJECT）会退避走保底流程，不会卡死对局。

双人交互测试（摆位同步、交易横幅、弃牌锁）用**同浏览器双窗口**更直观：两个窗口开同一个 `?room=`、不同 `?name=`，左右分屏各坐一边。

## 目录结构

```
packages/
  engine/     纯规则引擎：棋盘几何、开局、掷骰、建造、发展卡、交易、计分
  protocol/   前后端共用的消息契约与版本号（客户端只能请求，不能告知结果）
apps/
  server/     Node + ws 的服务端：房间、大厅、广播、按人裁剪视角
  web/        Vite + 原生 TS 的前端：大厅浮层、SVG 棋盘、只渲染和发命令
prototype/    早期视觉稿（静态，保留作参考）
design/       桌面纸雕视觉原型与交付规范
docs/         规则规格、变体决策、技术方案与验收证据
```

**分层铁律**：前端不判断合法性，所有变更走 `COMMAND → 服务端裁决 → 广播`。服务端不信任客户端传来的座位号和骰子点数。

## 测试

```bash
pnpm test        # 654 passed + 2 todo，共 50 个测试文件
pnpm typecheck   # 类型检查
```

分模块跑：

```bash
cd packages/engine && npx vitest run    # 177 passed + 2 todo
cd packages/protocol && npx vitest run  # 39
cd apps/server && npx vitest run        # 114
cd apps/web && npx vitest run           # 324
```

服务端还有几个脚本用于不开浏览器的验收：

```bash
# 造一局「已摆位完成」的房间
cd apps/server && npx tsx scripts/seed-room.ts demo 4

# 造一局「刚掷出 7、有人要弃牌」的房间（可能跑几轮）
npx tsx scripts/seed-room.ts seven 4 --seven

# 造一局「资源充足」，用于建造/交易验收
npx tsx scripts/seed-room.ts rich 4 --rounds 12 --offer

# 验证断线重连：同名重连后座位与状态不变
node scripts/reconnect-check.mjs demo 甲
```

> `--seven` / `--rounds` 需要服务端以 `HEXFONT_FAKE_DICE=1` 启动，
> 否则服务端会剥离客户端指定的骰子（生产环境必须剥离，防作弊）。

## 单端口部署

发布到静态托管以外的环境时，服务端会自己托管前端产物：

```bash
pnpm build
pnpm start          # 只跑一个端口，默认 8787
```

`apps/server/dist/server.cjs` 是打包好的单文件，`PORT` 环境变量可选。

发布到 WorkBuddy 的托管环境时，WebSocket 连接**必须带 sharecode**：页面从 `location.search` 读取并拼进 WS URL，否则会被反向代理拦下（非 101）。

## 已知限制

| 项 | 现状 |
|---|---|
| 端 | 只支持桌面端 ≥ 1280×720；手机、平板、更小的窗口只显示门槛提示 |
| 人数 | 4–8 人；标准盘 19 格 / 扩展盘 30 格 |
| 交易 | 两步报价（我想收到 → 我愿给出）；每人同时最多 1 条存活报价，10 秒寿命、3 秒冷却；没有还价和多方撮合 |
| 断线 | 座位在整局期间保留，同名可坐回；没有超时托管 |
| 存档 | 房间只存在内存里，服务端重启即丢 |
| 观战 | 没有 |
| 音效 | 没有 |

## 文档

| 文件 | 内容 |
|---|---|
| `docs/CURRENT.md` | **当前状态、已实施范围与发布状态（先读这个）** |
| `docs/24-production-fix-guide.md` | 本轮修复要求与已确认规则 |
| `docs/01-PDR.md` | 产品需求与验收标准 |
| `docs/02-rules-spec.md` | 规则规格（可测试的条目） |
| `docs/06-variant-rules.md` | 变体决策与理由 |
| `docs/07-visual-design.md` | 视觉设计规范 |
