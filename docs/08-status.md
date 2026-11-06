# 实现状态

> 更新时间：2026-11-06 13:10
> 这份文档是**新会话的入口**。先读它，再读 `06-variant-rules.md`。

---

## 一句话现状

> ⚠️ 2026-11-06 起进入重构，请先读 [`11-phase-a-baseline.md`](./11-phase-a-baseline.md)（阶段 A 基线、实测与规则契约）和 [`10-refactor-guide.md`](./10-refactor-guide.md)（目标行为）。本文件描述的是**改造前的代码事实**，不是重构目标；文末「下一会话建议」中的 5–6 人扩展已被指南列为暂缓项。

规则引擎、服务端、前端都已完成并联调通过，**阶段 A 实测 268 个测试通过、22 条目标 todo**，本地可玩。
唯一没完成的是**发布上线**——被账号权限卡住（见文末）。

---

## 怎么跑

```bash
pnpm install
pnpm dev          # 服务端 8787 + 前端 5173
```

两个人：`http://<内网IP>:5173/?name=乙&room=main`

完整说明见根目录 `README.md`。

---

## 代码与文档的对应关系

| 文档 | 对应的代码 | 一致性 |
|---|---|---|
| `06-variant-rules.md` | `packages/engine/src/rules/` | ✅ 已实现 |
| `01-PDR.md` 的 FR 条目 | 同上 | ✅ 基本覆盖 |
| `02-rules-spec.md` | 同上（仅作参照） | ⚠️ 被 06 覆盖，别照它实现 |
| `03-trade-and-ux.md` | `apps/web/src/ui.ts` | ✅ 「当前玩家=交易所」已实现 |
| `04-architecture.md` | `apps/server/`、`apps/web/` | ⚠️ 技术栈部分已过时（见下） |
| `07-visual-design.md` | `apps/web/src/styles.css`、`scene.ts` | ✅ 海洋版，木桌方案已弃用 |

---

## 文档没写、但代码里已经定的事

这些是夜间和今天实现时拍的板，**已生效**。如果不同意，改代码的同时要改这里。

| 项 | 决定 | 代码位置 |
|---|---|---|
| 弃牌取整 | **向上取整**（9 张弃 5 张），玩家自选弃哪几张（V-9） | `rules/roll.ts` `discardCount()` |
| 借港租金（原 Q-02） | 系统只做代换，租金语音自理，**不记账** | `rules/trade.ts` `portTransfer()` |
| 无主请求超时（原 Q-06） | 报价在**回合结束时作废** | `server/src/room.ts` `END_TURN` 分支 |
| 借港次数（原 Q-03） | 不限制 | 同上 |
| 骰子 | **服务端剥离客户端传来的 `dice`**，防作弊；仅 `HEXFONT_FAKE_DICE=1` 放行 | `server/src/room.ts` `command()` |
| 报价数量 | 同一时间只允许**一条** | `server/src/room.ts` `makeOffer()` |
| 断线座位 | 保留到**整局结束**，不做 30 分钟 TTL | `room.ts` `leave()` |
| 传输层 | 自建 WebSocket，**连接必须带 `?sharecode=`**（平台代理鉴权） | `web/src/net.ts` `wsUrlFor()` |
| 前端框架 | Vite + 原生 TS，不引 React/Vue | `apps/web` |

---

## 04-architecture.md 里已经过时的部分

| 原文说法 | 实际 |
|---|---|
| 「v0.2 接 WorkBuddy 云服务」 | 改为**自建 Node WebSocket**，云服务只用于发布托管 |
| 「WebSocket 方案待定」 | 已定，且实测发布环境支持（带 sharecode） |
| 「事件溯源（D-13）」 | 未采用。当前是「命令 → 引擎返回新状态 → 广播全量视图」，简单够用 |

---

## 代码结构速查

```
packages/engine/src/
  board.ts       六边形几何（(u,row) 网格，19/30/37 格通用）
  state.ts       GameState、港口推导、弃牌张数
  rules/
    setup.ts     蛇形摆位 + 距离规则 + 第二轮产出
    roll.ts      掷骰、产出、弃牌
    build.ts     路/村/城 + 资源与连通校验
    dev.ts       发展卡 + 强盗移动
    trade.ts     玩家间交易 / 银行港口 / 借港
    score.ts     最长路(DFS 最长简单路径) / 最大军 / 计分
    view.ts      视角投影：别人的手牌内容在结构上就不存在

apps/server/src/
  room.ts        房间、座位、报价协商层（不含规则）
  server.ts      HTTP + WS 单端口，静态托管 dist/public

apps/web/src/
  net.ts         WS 客户端（sharecode、自动重连）
  ui.ts          渲染与点击，不判规则
  scene.ts       棋盘 SVG
  build.ts / placement.ts / discard.ts   纯函数提示层（有单测）
```

---

## 测试

```bash
pnpm test        # 实测数量见 11-phase-a-baseline.md，勿沿用 224
pnpm typecheck
```

验收脚本（不开浏览器）：

```bash
cd apps/server
npx tsx scripts/seed-room.ts demo 4                 # 造一局已摆位
npx tsx scripts/seed-room.ts seven 4 --seven        # 造「待弃牌」局
npx tsx scripts/seed-room.ts rich 4 --rounds 12     # 造资源充足局
node scripts/reconnect-check.mjs demo 甲             # 验断线重连
```

---

## 发布为什么没完成

`workbuddy_sites_deploy` 返回 `SITES_ACCOUNT_MISMATCH`：
工作区的应用记录里只有昨晚那个「WS 连通测试」（`wbapp_PbUTeDWjQDM1pc9g39wCl6`），
它属于**另一个账号**，当前账号无权覆盖。

**代码和构建都没问题**，单端口模式本地实测通过（index/assets/health 全 200）。

三条出路：
1. 切回原账号发布（最干净，原链接不变）
2. 放弃那个测试应用、清掉工作区关联后重发（会得到新链接）
3. 暂时不发布，局域网内玩

---

## 下一会话建议的起手式

1. 读这份 → 读 `06-variant-rules.md` → 需要细节再翻 `01`/`03`
2. 跑一次 `pnpm test` 确认基线
3. 若要继续开发，优先做：**5-6 人 30 格地图的 UI 入口**（引擎已支持，只缺界面）
4. 若要发布，先解决账号问题，别再改代码
