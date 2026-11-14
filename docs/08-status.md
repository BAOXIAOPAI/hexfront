> **历史/专项资料提示（2026-11-14）**：先读 [CURRENT](./CURRENT.md) 和 [当前修复任务书24](./24-production-fix-guide.md)。本文保留历史事实与未被覆盖的细节，不作为最新任务入口；冲突以当前用户决定及24为准。

# 实现状态

> **2026-11-10 计划调整（尚未实施）：** 后续以 [`19-desktop-first-guide.md`](./19-desktop-first-guide.md) 为建设入口，先完成桌面体验与视觉，暂缓平板/手机专项。保留 D 阶段通用成果，不要求先补齐全部手机证据再开展桌面建设。本次仅更新文档，没有重新运行测试；下方数字与验收结论为对应日期的历史记录。

> 更新时间：2026-11-07 15:50
> 这份文档是**新会话的入口**。先读它，再读 `06-variant-rules.md`。

---

## 一句话现状

> ✅ **2026-11-09 最新：阶段 D 已由用户判定放行**，但**完整保留未测试口径**（放行 ≠ 全部验证通过）。通用横屏（CSS 自旋转 + 系统锁定渐进增强）已实现并交付，权威结论见 [`18-universal-landscape-delivery.md`](./18-universal-landscape-delivery.md)，UX 规格见 [`17-universal-landscape-ux.md`](./17-universal-landscape-ux.md)。
> 当前独立实测：**435 passed + 2 todo**（engine 139+2 / protocol 20 / server 62 / web 214、18 files）、`pnpm typecheck` 四包通过、`pnpm build` 成功；跨浏览器 CDP 复跑 **44 PASS / 0 FAIL / 23 NOT_RUN / 14 BLOCKED**（advisory `CONCERNS`）。
> **仍未取证：iOS Safari、微信内置、国产自带浏览器（夸克/华为）、A-13 用户物理转机、第三方 IME、`UL-C04/C05` 协议补证、`FLOW-09` 的 4 浏览器页面全 UI 完整对局。** 这些是放行时用户明确接受的已知边界，完整清单见 `18` 第 4 节；下方 11-07 的「未通过 / FAIL」表述是**历史快照，保留不改写**。
> ✅ **2026-11-09 放行后补验（详见 `18` §4.7，历史快照一律未改写）**：`pnpm test` **461 passed + 2 todo**（web 240 / 19 files）、typecheck 四包通过；历史 browser-verify 脚本复跑 **55 PASS / 1 FAIL / 42 NOT_RUN / 16 BLOCKED**（`D01-10` 转 PASS、`D03-01..07` 全转 PASS、`FLOW-07` 因资源不足 BLOCKED）；新增 26 条收口单测把 `A-10` 的 P1–P8、`UL-UX08/11/12/07`、`enterkeyhint` 钉成断言；独立复验 `probe/phase-d-closure-check.mjs` **6/6 PASS**，用「4 bot 协议推进 + 真实 Chrome 同名重连」跑到 **turn 326 / `phase=ended` / 乙 10 分**，验证结束页与「回到房间」。**口径边界**：这不是 4 个浏览器页面全 UI 打完一局，`FLOW-09`/`EXIT-05` 仍 NOT_RUN；复跑里 1 项 FAIL（`D01-09`）已定位为脚本判据缺陷（`vb0` 取自带 pan 的状态），非产品回归。

> ⚠️ 2026-11-06 起进入重构，请先读 [`14-phase-d.md`](./14-phase-d.md)（阶段 D 实现交付）与 [`10-refactor-guide.md`](./10-refactor-guide.md)（目标行为）。本文件多数内容仍是**改造前的代码事实**；阶段 C 升级协议 v2、阶段 D 重排横屏前端并接入相机与全部流程，权威规则见 `06` 的 0.0 节。文末「下一会话建议」中的 5–6 人扩展已被指南列为暂缓项。

> **2026-11-07 阶段 D 修复后：代码修复完成，验收仍未通过。** 验收报告 [`15-phase-d-review.md`](./15-phase-d-review.md) 的第 13 节是结论：D-01~D-06 六项缺陷与横屏布局收尾已修完、新增 66 条行为测试；浏览器实跑核心链路与掷 7 行动矩阵通过；但**浏览器完整对局未走到结束、真机清单未跑完**，按用户选定的最严格口径质量门判定 FAIL。
> **同日傍晚补做 Android 真机调试**，见 [`16-android-device-verification.md`](./16-android-device-verification.md)：1 台华为 ADY_AL00 部分覆盖真机证据，发现并修复 `SEAT_TAKEN` 冷启动致命页（D-07），但质量门**仍为 FAIL**。剩余待办见 `15` 第 13.6 节与 `probe/phase-d-device-checklist.md`。

规则引擎、服务端、前端都已完成并联调通过，**当前实测 387 passed + 2 todo**（`pnpm test`，四包；含 SEAT_TAKEN 与一键横屏新增测试）；`pnpm typecheck` 与 `pnpm build` 通过。手机竖屏打开会显示「进入横屏」主按钮（点击后请求全屏 + 锁定横屏，不支持的浏览器降级为手动旋转提示），实现与复验见 `16` §1.2。
唯一没完成的是**发布上线**——被账号权限卡住（见文末）；`release/` 仍是 v1 旧打包，与 v2 协议不兼容。

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
| 无主请求超时（原 Q-06） | 阶段 C 改为**每条报价 10 秒过期**；掷 7、回合结束、游戏结束清空全部；不再只是回合结束作废 | `server/src/room.ts` `clearOffers()` |
| 借港次数（原 Q-03） | 不限制 | 同上 |
| 骰子 | **服务端剥离客户端传来的 `dice`**，防作弊；仅 `HEXFONT_FAKE_DICE=1` 放行 | `server/src/room.ts` `command()` |
| 报价数量 | 阶段 C 改为**每人最多 1 条、房间可多条并存**；重发原子替换，发送后冷却 3 秒 | `server/src/room.ts` `makeOffer()` |
| 协议版本 | 阶段 C 升到 **v2**，JOIN 必须带 `v`，服务端拒绝错位客户端；按 ID 处理报价 | `packages/protocol/src/index.ts` |
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
  camera.ts      阶段 D：viewBox 相机 + Pointer Events 手势 + 最近合法候选
  panels.ts      阶段 D：抽屉 / 确认条 / 第 6 节新增入口 / 多报价列表
  layout.css     阶段 D：横屏信息架构（styles.css 继续管既有画风）
```

---

## 测试

```bash
pnpm test        # 实测数量见 14-phase-d.md，勿沿用 224
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
