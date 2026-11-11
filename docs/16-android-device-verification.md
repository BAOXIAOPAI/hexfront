# 阶段 D 真机（Android）补测报告

> 日期：2026-11-07 16:30–17:00（Asia/Shanghai）
> 设备：华为 `ADY_AL00` / Android 12（SDK 31）/ 1256×2760 @ 540dpi / 华为浏览器 `com.huawei.browser`
> 连接：USB ADB + `adb reverse tcp:8792 tcp:8792`（手机 `127.0.0.1:8792` → 主机单端口服务），**不依赖同一 WiFi**
> 服务：`PORT=8792 HOST=0.0.0.0 node apps/server/dist/server.cjs`（本次 `pnpm build` 产物）
> 对局配置：**1 台真机（P1）+ 3 个协议 bot 补位**，如实注明，不把 bot 写成浏览器玩家
> 口径：沿用用户选定的最严格档。本文只记录**实际观测**；CDP 模拟视口、单测、jsdom 一律不算真机通过。
> 结论：真机层从「无设备、8 项全 BLOCKED」变为「1 台 Android 部分覆盖」；**阶段 D 质量门当时仍为 FAIL（未通过）**。
> **后续（2026-11-09）**：用户已判定阶段 D 放行，但完整保留未测试口径；本报告是 11-07 的历史真机快照，保留原文。新的通用横屏方案、放行依据与权威未测试清单见 [`18-universal-landscape-delivery.md`](./18-universal-landscape-delivery.md)，UX 规格见 [`17`](./17-universal-landscape-ux.md)。

---

## 1. 环境与准备（实际踩过的坑）

| 项 | 观测 |
|---|---|
| `adb` | `/opt/homebrew/bin/adb` 1.0.41 / 37.0.1，可用 |
| 设备发现 | 初始 `adb devices` 为空；用户接入后出现 `3EY0224402017936` |
| 初始状态 | 屏幕休眠 + 锁屏；`input keyevent 26` 唤醒、上滑即可解锁（无密码） |
| WiFi | `Wifi is disabled`；`cmd wifi enable` 被 `Uid 2000` 权限拒绝，`svc wifi enable` 成功但仍 `not connected` |
| 浏览器 | **无 Chrome**；仅 `com.quark.browser` / `com.huawei.browser` / `com.huawei.webview`；未暴露 `chrome_devtools_remote`，因此**无法用 CDP 读取页面状态**，证据以 `screencap` 截图 + `input tap` 真实触摸为主 |
| 网络方案 | 改用 `adb reverse`，手机访问 `127.0.0.1:8792` 直达主机，HTTP 与 WS 均验证连通 |
| 旋转 | `settings put system user_rotation 1` 与 `cmd window set-user-rotation` 均无效，`mCurrentRotation=ROTATION_0`（华为浏览器锁方向）→ **真机横屏布局未验证** |

> 注意：`adb reverse` 通道会在浏览器被强杀后丢失，且**重复执行 `adb reverse tcp:8792 tcp:8792` 会重置通道**，可能人为制造半开连接。后续复现需在每步前用 `adb reverse --list` 只读确认。

### 1.1 追问复盘：为什么之前是竖屏，横屏能不能自动打开

用户追问后重新排查，结论：**游戏没有锁方向**，之前是调试侧三个原因叠加。

1. 产品按指南 4.2「不把系统方向锁定或全屏 API 当成必要前提」；`layout.css` 只在 `@media (orientation: portrait) and (max-width:700px)` 显示「建议横屏对局」卡，横屏会自动隐藏。竖屏是**系统报告的方向**，不是游戏强制。
2. 第一次用的命令是错的：`cmd window set-user-rotation lock 1` 不存在（`cmd window -h` 显示正确子命令是 `user-rotation`）。`settings put system user_rotation 1` 只写了 Settings 数据库，WindowManager 仍是 `USER_ROTATION_FREE` / `mCurrentRotation=ROTATION_0`。
3. 调试时把 `accelerometer_rotation` 关成 0，且**没有物理转动手机**，重力传感器一直报竖屏。

用正确命令重试后**系统横屏确实打开**：

```bash
adb shell cmd window user-rotation lock 1
adb shell cmd window set-ignore-orientation-request true   # 必需：浏览器自己请求了 portrait
adb shell cmd window fixed-to-user-rotation enabled
```

→ `mCurrentRotation=ROTATION_90`、`overrideConfig ... w778dp h332dp land`（CSS 视口约 778×332，贴近目标 844×390）、截图尺寸 2760×1256。

**但真机横屏布局仍无法据此验收**：系统虽已横屏，华为浏览器与夸克都把网页内容**按竖屏宽度渲染在中间一条竖条里、两侧大面积黑边**（`17`~`21` 号截图）。已尝试并均无效：`wm size 2400x1080` 触发显示重排、横屏状态下冷启动浏览器、改用夸克浏览器。这是「强制忽略 Activity 方向请求后 WebView 视口不重排」的浏览器兼容性问题，**不是游戏 CSS 的问题**——用这种伪横屏截图判定布局会得到错误结论，因此本报告不把它算作横屏通过。

要真正补齐真机横屏验收，需要其一：
- 用户**物理把手机横过来**（自动旋转已恢复开启），由重力传感器触发系统旋转；或
- 安装支持横屏的 Chrome（还能顺带用 CDP 直接读页面状态与三视口）。

现有横屏证据仍只有首轮 CDP 真实 CSS 视口（667×375 / 844×390 / 932×430）+ `docs/shots/phase-d-verify-20261107073501-02-setup-phase.png`。

### 1.2 产品需求落地：检测到手机竖屏 → 一键「进入横屏」

用户随后澄清：关心的不是调试时怎么转设备，而是**产品行为** —— 手机打开这个站，应该能直接横过来，而不是只弹「建议横屏」让人自己转。已按「加进入横屏按钮」方案实现。

**浏览器硬限制（所以不能零交互静默旋转）**：`screen.orientation.lock('landscape')` 必须由用户手势触发，多数浏览器还要求文档先进入全屏；iOS Safari 完全没有该 API。因此做成「检测竖屏 → 自动展示醒目主按钮 → 点击时全屏 + 锁定横屏 → 不支持/被拒时降级为手动旋转说明」。

| 文件 | 改动 |
|---|---|
| `apps/web/index.html` | portrait-gate 新增主按钮 `#portrait-landscape`「进入横屏」与 `#portrait-hint` 降级提示；文案从「建议」改为主动引导 |
| `apps/web/src/layout.css` | `.portrait-gate` 默认 `display:none`、仅竖屏媒体查询展开（锁定成功后自动收起，不等 STATE）；`z-index` 30 → **45**；新增主按钮与提示样式 |
| `apps/web/src/panels.ts` | 构造时即 `syncPortraitGate()`；`requestLandscape()` 同步发起 fullscreen 保留用户手势，再 `lock('landscape')`，`.catch` 给可操作降级说明；监听 `orientationchange` / `resize` 即时同步显隐 |
| `apps/web/test/phase-d-fix-landscape.test.ts` | 新增 9 条真实 click 行为测试（构造即展开、层级回归、全屏+lock、全屏被拒仍 lock、iOS 无 lock 降级、lock 被拒降级、方向变化收起、不反复弹） |
| `probe/phase-d-landscape-button-check.mjs` | 真实无头 Chrome 156 + CDP，390×844 @2 手机竖屏 CSS 视口，真实指针点击，产出 `probe/phase-d-landscape-button-report.json` |

**CDP 复验中发现并修掉的 2 个真实缺陷**：
1. 卡片原先只在有 `PlayerView` 的 `render()` 里同步显隐 → 入房阶段 `gateHidden:true`、按钮 rect 为 0、点击落空。改为**构造时即同步**（入房阶段还没有 view 也必须看得到入口）。
2. `.portrait-gate` 的 `z-index:30` 被 `.overlay` 入房浮层(`40`)盖住 → `elementFromPoint` 命中 `DIV.seat.open`，按钮**看得到却点不到**。提到 45（仍低于 `.end-screen` 50 / `.toast` 60）。

**最终 CDP 结果**：`fail: []`；`hitTarget = BUTTON#portrait-landscape`、`clicks:1`、`fullscreens:1`、`locks:["landscape"]`；headless 拒绝方向锁定后 hint 与 toast 均显示「浏览器没有允许切换方向，请手动把手机横过来，或检查系统的旋转锁定设置。」，卡片保留、**无静默失败**。截图 `docs/shots/phase-d-landscape-button-check.png`。

**回归（新构建的横屏视口）**：因改动了 `.portrait-gate` 的 `display` / `z-index`，用同一 CDP 脚本在 4 人开局后的对局中画面复核三档横屏视口，**9 PASS / 0 FAIL**：

| 视口 | 竖屏卡片 | 右侧行动区 | 棋盘舞台宽 |
|---|---|---|---|
| 667×375 | `display:none` | 展开 | 503 px |
| 844×390 | `display:none` | 展开 | 658 px |
| 932×430 | `display:none` | 展开 | 736 px |

目视复核 `844×390` 与 `667×375`：四人玩家条完整不溢出、棋盘无遮挡、摆位提示为顶部紧凑条、资源卡为紧凑图标+数量、底部「掷骰子 / 建造 / 交易 / 结束回合」2×2 文字完整无换行截断。说明一键横屏的改动**没有破坏对局中的横屏布局**，也复证了第 10 节布局收尾。

**回归（代码）**：前端 166 passed、全仓 **387 passed + 2 todo**、`pnpm typecheck` 四包通过、`pnpm build` 成功（产物 `index-B5V3fCUv.js` / `index--XASYweT.css`）。

**注意**：CDP 是真实浏览器但不是真机；iOS Safari 降级路径目前只有单测覆盖。真机点击复验与真机横屏布局见 §1.3（设备重新接入后已补）。

### 1.3 真机复验：一键横屏按钮 + 真机横屏对局布局

设备重新接入后（默认浏览器已变为 `com.quark.browser` 夸克），用 `adb reverse` 直连 8792 完成最后两步。

**按钮真实点击**（用 `uiautomator dump` 取精确 bounds，不再靠截图目测）：
- 「进入横屏」`bounds=[101,1282][1154,1448]`，中心 **(627,1365)**；「仍在竖屏查看」`[101,1465][1154,1617]`。此前目测点 (628,1465) 恰好落在 dismiss 上边界，误触发「已收起提示，本次不会反复弹出」，不是产品问题。
- `input tap 627 1365` 后：`mCurrentRotation` 仍 `ROTATION_0`；**toast 与卡片内橙色提示块同时显示**「浏览器没有允许切换方向，请手动把手机横过来，或检查系统的旋转锁定设置。」；卡片保留、按钮可重试、**无静默失败、无假装成功**（截图 `28-after-real-tap.png`）。
- 结论：**夸克（Android 12 / 华为 ADY_AL00）拒绝方向锁定**，这台设备的默认浏览器无法一键自动横屏；代码按设计正确降级。要真正一键横屏，需安装 Android Chrome 或走 PWA 安装（manifest `orientation: landscape`）。

**真机横屏对局布局（此前缺口，已补齐）**：
- `cmd window user-rotation lock 1` + `set-ignore-orientation-request true` + `fixed-to-user-rotation enabled` → `ROTATION_90`。与华为浏览器不同，**夸克在强制横屏下完整铺满**，没有中间竖条与两侧黑边，且 `syncPortraitGate()` 自动收起了竖屏卡片。
- 用 3 个极简 WS 客户端（只发 `JOIN v:2`）补位凑满 4 人，服务端自动开局进入 `phase=setup`。
- 真机截图 `phase-d-android-20261107-31-real-landscape-game.png`（2760×1256）：顶栏四人玩家条与房间号完整不溢出、六边形棋盘及中心强盗/编号/港口清晰无遮挡、「开局摆位·第 1 轮 0/8」为棋盘上方紧凑条、右侧资源卡为紧凑图标+数量、底部「掷骰子 / 建造 / 交易 / 结束回合」2×2 文字完整、无卡片残留、无黑边 —— 复证 D-02 与第 10 节布局收尾。
- **方法局限**：靠系统强制旋转而非用户物理转动手机，浏览器为夸克；真实用户手动旋转后的手感与状态仍需人工确认。

**设备恢复**：`cmd window user-rotation lock 0` → `free 0`、`set-ignore-orientation-request false`、`fixed-to-user-rotation disabled`、`wm size reset`、`accelerometer_rotation=1`、`user_rotation=0`；复核 `mCurrentRotation=ROTATION_0`、`USER_ROTATION_FREE`、物理尺寸 1256×2760。WiFi 为用户自行开启，未改动；服务、bot、`adb reverse` 全部清理。

---

## 2. 逐项真机观测

| # | 场景 | 实际观测 | 证据 | 判定 |
|---|---|---|---|---|
| 1 | 竖屏入房 + WS 连接 | 「房间 MAIN / QA2」、P1（你）在线、1/4 人在座 | `phase-d-android-20261107-07-qa2-join.png` | PASS |
| 2 | 竖屏建议横屏卡 | 显示「连接：已同步 · 房间已加入」「当前回合：P1」「我的手牌 0 张 · 分数 0」「待处理 0 条报价」，提示可收起不反复弹 | `phase-d-android-20261107-03-refresh.png` | PASS |
| 3 | **强杀浏览器重开、同名回原座位** | 重开后显示「连接：已同步」并拿到完整权威视图（当前回合/手牌/报价） | 同上 | PASS（D-06 恢复链路） |
| 4 | 半开连接导致视图滞后 | 服务端已 4 人开局（`started:true`），手机仍显示「1/4 人在座」且标「在线」 | `phase-d-android-20261107-01-stale-view.png` | 记录（待办） |
| 5 | 强杀后 1s 内重开 | 「进不去这张桌子 / 这个名字已经有人在用」致命页 | `phase-d-android-20261107-05-seat-taken.png` | **修复前缺陷，见第 3 节** |
| 6 | `adb reverse` 通道丢失 | 「暂时无法打开该网页」，点「刷新页面」+ 重建通道后恢复 | `phase-d-android-20261107-02-reopen.png` | 环境限制 |
| 7 | 棋盘渲染（竖屏） | 六边形棋盘完整、中心沙漠/编号/港口清晰，**无大块浅色浮层遮挡**；「开局摆位·第 1 轮 0/8」为顶部紧凑条；缩放 +/−/⌂ 可见 | `phase-d-android-20261107-09-board.png` | PASS（D-02） |
| 8 | **缩放按钮真实触摸** | 点「+」后棋盘明显放大，占满可用宽度 | `phase-d-android-20261107-10-zoom-in.png` | PASS（D-01 复验②） |
| 9 | 「⌂」回到全局 | 棋盘复位 | `phase-d-android-20261107-11-zoom-reset.png` | PASS |
| 10 | **棋盘选点真实触摸** | 点路口弹出「两个候选很接近 / 请明确选一个，不会自动替你挑」A/B 消歧确认条 | `phase-d-android-20261107-12-pick-vertex.png` | PASS（D-01 + 指南 5.2） |
| 11 | 点 A 候选 | 确认条关闭、棋盘出现橙色选中路口预览 | `phase-d-android-20261107-13-after-ambiguity.png` | PASS |
| 12 | 修复后复验 SEAT_TAKEN | **不再出现致命页**，顶栏保持「房间 QA2 / 连… / 等待开局」，持续退避重试 | `phase-d-android-20261107-14-recovering.png` | PARTIAL |
| 13 | 同上，39s 后 | 仍停在「等待开局」，未入座；`/health` 的 `connected` 一直为 4 | `phase-d-android-20261107-15-after-retry.png` | 未闭环（见第 3 节） |

---

## 3. 真机发现的产品缺陷与本轮修复

### D-07（新增）：`SEAT_TAKEN` 冷启动直接判致命

- **复现**：强杀浏览器 → 1s 内用同名 `P1` 重开 → 服务端旧连接仍是半开、座位未释放 → `JOIN_FAILED { reason:'SEAT_TAKEN' }` → 前端显示「进不去这张桌子」，用户被卡死。
- **根因**：`apps/web/src/net.ts`（修复前 311 行）只对 `this.reconciling && SEAT_TAKEN` 做 300ms 重试；**冷启动路径不在 `reconciling`，直接 `onFatal`**。服务端心跳 30s（`server.ts:141`），旧座位要等心跳超时才释放，这个窗口在真机上真实存在。
- **修复**（`apps/web/src/net.ts`）：
  - 新增 `SEAT_TAKEN_RETRY_MS = 2000`、`SEAT_TAKEN_MAX_RETRIES = 30`（60s 窗口，覆盖服务端心跳）；
  - `JOIN_FAILED` 对 `SEAT_TAKEN` 统一做有限退避重试（受控重连仍用 300ms 快路径），期间 `setStatus('reconnecting')` 让 UI 显示恢复状态；次数用尽才 `onFatal`；
  - 拿到 `WELCOME` 时把计数归零；`close()` 一并重置；
  - 其他失败原因（房间满 / 协议不匹配 / 恶意顶号）**仍立即判致命**，未被退避逻辑吞掉。
- **回归测试**：`apps/web/test/phase-d-fix-resume.test.ts` 新增 3 条（冷启动退避成功 / 次数用尽才致命 / 其他原因仍致命）。前端包 **157 passed**、全仓 **378 passed + 2 todo**，`pnpm typecheck` 通过、`pnpm build` 成功（新产物 `index-NNyM6nfn.js`）。
- **真机复验**：按同一路径强杀后立即重开，加载新产物后**不再出现致命页**（14 号截图），改为保持连接/恢复状态并持续重试 —— 明确改善。但 **39s 后仍未入座**（15 号截图，`connected` 恒为 4）：说明服务端半开连接的释放比 30s 心跳预期更慢（或 `adb reverse` 重置放大了半开窗口）。
- **未闭环项**：需在服务端侧处理「同名重连顶掉半开连接」或缩短心跳检测，并补对应并发用例。**本轮未改服务端**，如实保留。

---

## 4. 真机清单 D1~D8 对照（`probe/phase-d-device-checklist.md`）

| 项 | 状态 | 说明 |
|---|---|---|
| D1 iPhone Safari 后台电话/语音房 | BLOCKED | 无 iPhone；且 ADB 不覆盖 iOS |
| D2 Android 后台语音房并行 | NOT_RUN | 未擅自拨号；只做了强杀/重开 |
| D3 锁屏 | NOT_RUN | 屏幕可唤醒解锁，但本轮未走锁屏→回前台完整流程 |
| D4 WiFi ↔ 蜂窝 / 半开连接 | NOT_RUN | 设备 WiFi 原本关闭，本轮用 USB reverse 绕开，未做真实网络切换 |
| D5 标签回收后重开 | **PARTIAL** | 强杀重开拿到完整权威视图（PASS）；极端时序下命中 D-07（已修，仍未完全闭环） |
| D6 双指 / 拖动阈值 / 误触手感 | **PARTIAL** | 单指真实点击、缩放按钮、歧义消歧、选中预览均 PASS；**双指手势未测**（无 CDP，多点触控需 `sendevent`） |
| D7 10 秒报价后台过期 | NOT_RUN | 未构造报价 + 后台 10s 场景 |
| D8 安全区 / 软键盘 / 内置浏览器 | NOT_RUN | 已在华为浏览器（一种内置浏览器）验证入房与棋盘，但软键盘与安全区未专项测 |

**结论**：8 项中 0 项可判完整 PASS，2 项 PARTIAL，其余 NOT_RUN / BLOCKED。真机证据从「无」变为「1 台中低端 Android 的部分覆盖」，但远未满足清单要求。

---

## 5. 其他观察项（不影响功能，留阶段 E）

1. 竖屏收起建议卡时的 toast「已收起提示，本次不会反复弹出」与顶部摆位紧凑条**短暂重叠**。
2. 选中路口后棋盘出现橙色预览，但 `setupbar` 的指引文字仍停留「点一个发亮的路口放村庄」（提示文字未随 `pickedVertex` 重绘），功能本身正常。
3. 真机窄竖屏下顶栏「房间 (」「摆位 · 第…」等文字被省略号截断——属设计内的紧凑处理，但可再评估信息优先级。

---

## 6. 对质量门的影响

`docs/15-phase-d-review.md` 第 13.5 节的 **FAIL 判定维持不变**：

- 浏览器完整对局仍未到 `phase=ended`；
- 真机仍无 iPhone、8 项清单未跑完；真机横屏**布局**已在 §1.3 取得证据（但靠系统强制旋转 + 夸克，非用户物理旋转），一键横屏按钮在真机上走的是降级路径；
- D-03 发展卡真实 UI 仍未验证；
- 本轮新增的 D-07 虽已修复并回归，但真机复验只到「不再立刻致命」，**服务端半开释放未闭环**。

变化仅限于：真机层不再全是 BLOCKED，新增 1 台 Android 的部分证据 + 1 个已修复的真实缺陷。`15` 第 13 节的判定是 15:50 时的快照，保留原文不改写。

---

## 7. 副作用与清理（已执行）

| 项 | 处理 |
|---|---|
| 设备 WiFi | 用 `svc wifi disable` 恢复为初始 `disabled` |
| 旋转 / 显示设置 | `cmd window user-rotation free 0`、`set-ignore-orientation-request false`、`fixed-to-user-rotation disabled`、`wm size reset`、`user_rotation=0`、`accelerometer_rotation=1`；复核 `mCurrentRotation=ROTATION_0`、物理尺寸 1256×2760 |
| `adb reverse` | 通道已移除（清理时报 `listener not found`，说明已自动失效） |
| 临时服务 8792 / 3+3 个 bot | 已全部关闭，`8792` 端口 0 listener |
| 设备 | 仍正常连接 `adb devices`，未安装/卸载任何应用 |
| 项目 | 未提交 git、未发布、未碰 `release/`、未改服务端/引擎/协议、未连线上房间 |

**本轮仅改 2 个源码/测试文件**：`apps/web/src/net.ts`、`apps/web/test/phase-d-fix-resume.test.ts`；`pnpm build` 按正常构建刷新了 `apps/web/dist` 与 `apps/server/dist/public`。

---

## 8. 截图证据清单（`docs/shots/`）

**真机 `screencap` 原图**（`phase-d-android-20261107-` 前缀，1256×2760 竖屏 / 2760×1256 横屏）：

`01-stale-view` · `02-reopen` · `03-refresh` · `04-landscape`（实为竖屏，旋转未生效） · `05-seat-taken` · `06-recovered`（同 05） · `07-qa2-join` · `08-setup` · `09-board` · `10-zoom-in` · `11-zoom-reset` · `12-pick-vertex` · `13-after-ambiguity` · `14-recovering` · `15-after-retry` · `16-landscape-lobby`（黑屏，休眠） · `17-landscape-lobby` · `18-landscape-settled` · `19-landscape-cold` · `20-resize` · `21-quark`

设备重新接入后：`23-landscape-btn-before`（新卡片） · `24-after-tap`（误点 dismiss） · `25-before2` · `26-toast`（误点 toast） · `27-hint` · **`28-after-real-tap`（真机点击「进入横屏」后的降级提示，关键证据）** · `29-after-real-tap-settled` · `30-quark-landscape`（系统横屏铺满） · **`31-real-landscape-game`（真机横屏 4 人开局对局中布局，关键证据）**

**真实浏览器 CDP 截图（不是真机）**：

- `phase-d-landscape-button-check.png` —— 390×844 手机竖屏，点击「进入横屏」后的降级提示
- `phase-d-landscape-vp-667x375.png` / `-844x390.png` / `-932x430.png` —— 三档横屏 CSS 视口、**4 人开局后的对局中画面**（bot 补位）

勿与 4 张 `web-*-2026-11-06.png` 旧图混淆。

---

## 9. 复现要点

```bash
D=<设备序列号>
adb -s "$D" reverse tcp:8792 tcp:8792          # 只在 --list 为空时执行
PORT=8792 node apps/server/dist/server.cjs &    # 单端口，托管最新 dist
adb -s "$D" shell 'am start -a android.intent.action.VIEW -d "http://127.0.0.1:8792/?name=P1&room=qa2"'
adb -s "$D" exec-out screencap -p > shot.png     # 截图
adb -s "$D" shell input tap <x> <y>              # 真实触摸
# bot 补位：cd apps/server && npx tsx scripts/bot.ts "ws://127.0.0.1:8792/ws?room=qa2" 乙
```

URL 必须用**外层单引号包整条 am 命令、内层双引号包 URL**，否则 `&room=` 会被 shell 吞掉。
