# 六角拓荒

一个跑在浏览器里的卡坦岛变体桌游。纯前端 + 一个 Node 服务端，实时同步，支持局域网多人对局。

规则上做了几处改动（当前玩家当交易所、零对价转移、借港代换、掷 7 弃牌向上取整等），完整清单见 `docs/06-variant-rules.md`。

---

## 快速开始

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

---

## 怎么两个人玩

**同一条命令启动后**，再开一个浏览器窗口（或手机连同一个 WiFi）：

```
http://<你的内网IP>:5173/?name=乙&room=main
```

两个人用不同 `name`、同一个 `room` 就会坐到同一桌。

- **4 人满员自动开局**；不足 4 人时，在浮层点「开始游戏」
- `?name=` 会写进地址栏，**刷新或关掉重开都回到原座位**
- 房间号只允许小写字母、数字、`-`、`_`

查自己的内网 IP：

```bash
ipconfig getifaddr en0
```

---

## 线上版

已发布：https://hexfront.app.workbuddy.host/?sharecode=EWCTT4T5YE

链接自带 sharecode（反向代理凭它放行 WebSocket），房间号靠 `&room=xxx` 区分。

---

## 单人测试：陪玩 bot

不想拉人也能打完整一局。`apps/server/scripts/bot.ts` 会连进房间占一个座位，
自动摆位（挑高产地点）、掷骰、掷 7 弃牌/挪强盗、资源够就建（城>村>路）、结束回合：

```bash
cd apps/server

# 陪你在任意房间打一局（你先进房点「开始游戏」，bot 后进）
npx tsx scripts/bot.ts "wss://hexfront.app.workbuddy.host/ws?sharecode=EWCTT4T5YE&room=abc" 机器人

# 两个 bot 自动对打（验证用，--host 的负责开局，--fast 加速节奏）
npx tsx scripts/bot.ts "ws://127.0.0.1:8787/ws?sharecode=DEV&room=botfight" 甲 --host --fast
npx tsx scripts/bot.ts "ws://127.0.0.1:8787/ws?sharecode=DEV&room=botfight" 乙 --fast
```

`--debug` 打印每回合手牌与候选数；bot 只发协议命令，规则全由服务端裁决，
被拒（REJECT）会退避并走保底流程，不会把对局卡死。

双人交互测试（摆位同步、交易横幅、弃牌锁）用**同浏览器双窗口**更直观：
两个窗口开同一个 `?room=`、不同 `?name=`，左右分屏各坐一边。

## 目录结构

```
packages/
  engine/     纯规则引擎：棋盘几何、开局、掷骰、建造、发展卡、交易、计分
  protocol/   前后端共用的消息契约（客户端只能请求，不能告知结果）
apps/
  server/     Node + ws 的服务端：房间、广播、按人裁剪视角
  web/        Vite + 原生 TS 的前端：只渲染和发命令，不存规则状态
prototype/    早期视觉稿（静态，保留作参考）
docs/         规则规格、变体决策、技术方案
```

**分层铁律**：前端不判断合法性，所有变更走 `COMMAND → 服务端裁决 → 广播`。
服务端不信任客户端传来的座位号和骰子点数。

---

## 测试

```bash
pnpm test        # 全仓 224 个测试
pnpm typecheck   # 类型检查
```

分模块跑：

```bash
cd packages/engine && npx vitest run
cd apps/server && npx vitest run
cd apps/web && npx vitest run
```

服务端还有两个脚本用于验收，不开浏览器：

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

> `--rounds` / `--seven` 需要服务端以 `HEXFONT_FAKE_DICE=1` 启动，
> 否则服务端会剥离客户端指定的骰子（生产环境必须剥离，防作弊）。

---

## 单端口部署

发布到静态托管以外的环境时，服务端会自己托管前端产物：

```bash
pnpm build
pnpm start          # 只跑一个端口，默认 8787
```

`apps/server/dist/server.cjs` 是打包好的单文件，`PORT` 环境变量可选。

发布到 WorkBuddy 的托管环境时，WebSocket 连接**必须带 sharecode**：
页面从 `location.search` 读取并拼进 WS URL，否则会被反向代理拦下（非 101）。

---

## 已知限制

| 项 | 现状 |
|---|---|
| 人数 | 4 人。引擎支持 3–6 人和 30/37 格地图，但界面只有 4 人的入口 |
| 交易 | 一次只能挂一条报价；没有还价和多方撮合，靠语音协商 |
| 断线 | 座位在整局期间保留，不会因为掉线被踢；没有超时托管 |
| 手机 | 棋盘会缩得比较小，还没做双指缩放 |
| 存档 | 房间只存在内存里，服务端重启即丢失 |
| 观战 | 没有 |
| 音效 | 没有 |

---

## 文档

| 文件 | 内容 |
|---|---|
| `docs/01-PDR.md` | 产品需求与验收标准 |
| `docs/02-rules-spec.md` | 规则规格（可测试的条目） |
| `docs/06-variant-rules.md` | 变体决策与理由 |
| `docs/07-visual-design.md` | 视觉设计规范 |
