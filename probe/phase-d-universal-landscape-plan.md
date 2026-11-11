# 通用横屏（Universal Landscape）跨浏览器复验矩阵 · 阶段一准备

> **状态：ULS-03 阶段一交付物，只准备复验能力，不是验收结论。**
> 本会话**未实跑完整浏览器复验**、未运行 `pnpm test / typecheck / build`、
> 未连接任何线上房间、未碰 `release/`、未执行任何 git 写操作。
> 全部游戏检查项初始为 `NOT_RUN`；真机项结构性 `BLOCKED`。
> 共 **81 条检查项**，其中 `docs/17` §7 的 A-1…A-14 各有专属检查 ID `UL-UX01`…`UL-UX14`（§3.11）；
> A-3 / A-4 / A-6 / A-13 为真机必需项，结构性 `BLOCKED`，CDP 不得单独判通过。
> 等 `engineering-lead` 实现完成、`design-strategist` UX 规格定稿后由主理人唤醒实跑。

---

## 0. 背景与被测方案

- 用户决策：游戏要在**任何浏览器**（iOS Safari、微信内置、华为/夸克/小米等厂商自带浏览器）打开都呈现横屏。
- 拍板方案：**CSS 自旋转 + 系统方向锁定渐进增强**。
  - 竖屏时网页自己 `rotate(±90deg)` 铺成横屏画布，**不依赖任何浏览器 API**；
  - 支持 `screen.orientation.lock` 的浏览器优先请求系统横屏；
  - 锁定失败 / API 不存在 / 被拒 → 自动落到 CSS 自旋转，不给用户留「必须手动转手机」的死路。
- 历史真机证据（`docs/16-android-device-verification.md` §1.1~§1.3）必须纳入矩阵：
  1. `screen.orientation.lock('landscape')` 需用户手势、多数浏览器还要求先全屏；**iOS Safari 完全没有该 API**；
  2. 夸克（Android 12 / 华为 ADY_AL00）真机点击「进入横屏」被拒，代码当时正确降级为「请手动旋转」；
  3. 华为浏览器在强制系统横屏下把网页**按竖屏宽度渲染在中间一条竖条 + 两侧黑边**；夸克则铺满。
     → 因此**判定旋转与否必须以 CSS 视口实测为准，不能只信系统报告的 orientation**。
  4. 该设备未暴露 `chrome_devtools_remote`，**厂商浏览器无法用 CDP 读页面状态**，真机证据只能是截图 + 真实 `input tap` + 服务端日志。
- 既有基线：`probe/phase-d-landscape-button-check.mjs` 最终 **9 PASS / 0 FAIL**（390×844 竖屏真实指针点击 + 三档横屏视口回归）；
  `probe/phase-d-browser-verify-report.json` 采用「初始 NOT_RUN、只写实际观测」的诚信状态机；
  代码回归基线 **387 passed + 2 todo**、`pnpm typecheck` 四包通过、`pnpm build` 成功（`docs/16` §1.2）。

---

## 1. 口径、状态机与证据类型

### 1.1 状态（与 `phase-d-browser-verify-report.json` 完全一致）

| 状态 | 含义 | 禁止写法 |
|---|---|---|
| `PASS` | 实际执行、取得原始观测值、满足**预先写明**的判据 | 不得因「有测试文件」「源码看起来修好了」「UA 改成 iOS」写 PASS |
| `FAIL` | 实际执行、观测值与判据不符 | 不得把源码推断写成实测失败 |
| `NOT_RUN` | 本轮未执行到 | 不得留白、不得写成通过 |
| `BLOCKED` | 前置缺失（无设备、无服务、造不出状态、契约未定） | 不得用 CDP 模拟解除真机项的 BLOCKED |

**结构性保证**：`probe/phase-d-universal-landscape-check.mjs` 的 `CHECK_DEFS` 在报告对象构造时
逐条 `status: 'NOT_RUN'`，只有通过 `rep.pass() / rep.fail() / rep.blocked()` 并写入 `observed` 才改变状态。
`--mode=capability-only` 只允许 `UL-CAP-*` / `UL-ENV-*` 变化，其余一律保持 `NOT_RUN`。

### 1.2 证据类型标记

| 标记 | 含义 | 边界 |
|---|---|---|
| **CDP·真实指针** | `Input.dispatchMouseEvent` / `Input.dispatchTouchEvent` 派发真实 pointer 链后读 UI / `__hex.view` / `viewBox` | 真实浏览器，**不是真机** |
| **CDP·真实视口** | `Emulation.setDeviceMetricsOverride` 设真实 CSS 视口后读 `getComputedStyle` / `getBoundingClientRect` / `elementFromPoint` | 是真实 CSS 视口，**不是真机**（指南 13.1） |
| **CDP·能力模拟** | `Page.addScriptToEvaluateOnNewDocument` 在页面脚本前剥离 / mock `lock` / `requestFullscreen` / `orientationchange` | 能力分支模拟，**不等于 iOS Safari / 厂商浏览器真机** |
| **CDP·日志** | `Runtime.consoleAPICalled(error)` / `Runtime.exceptionThrown` / `unhandledrejection` | 只证明无异常，不证明功能正确 |
| **真机 ADB** | `screencap` + `input tap` + `uiautomator dump` + 服务端日志 | 厂商浏览器无 CDP，页面内部值读不到 |
| **单测** | `pnpm test`（web / engine / server） | 不冒充浏览器 / 真机 |
| **协议集成** | `apps/server/test`、`apps/web/test` 的可控时钟 / 竞态用例 | 不冒充 UI 手感 |
| **人工** | 真机录屏目视复核、UX 可读性判断 | 必须附证据三件套 |
| **汇编** | 主理人汇总 test/typecheck/build 数量与状态文档 | 不替代实测 |

### 1.3 诚信红线

1. **绝不**用 jsdom、模拟视口、单测、UA 伪装、mock 的 `lock` 成功冒充真机或真实浏览器通过。
2. CDP 的 iOS Safari / 厂商浏览器模拟只证明**降级分支的代码路径**；矩阵里所有真机项保持 `BLOCKED`。
3. `Runtime.evaluate` 只用于**读**（DOM / computed style / `__hex.view` / 探针计数）与**注入能力模拟**；
   被复验的界面动作一律由 CDP `Input` 域派发真实指针，不用 `el.click()` / `dispatchEvent` 代替。
4. `Page.addScriptToEvaluateOnNewDocument` 注入的 mock 必须在每个 scenario 的 `notes` 里原样记录，报告不得隐藏。
5. 旋转态判定优先读实现方暴露的**显式契约标记**；若契约缺失，只能按几何推断并标注 `INFERRED`，
   不得把几何推断写成最终验收结论。

---

## 2. 待确认的验收契约（请主理人转 engineering-lead / design-strategist）

脚本对旋转态的判定需要一组稳定、可机读的标记。**若实现不提供，脚本会退化为几何推断，
相关检查项统一标注 `INFERRED — 需人工复核`，不判 PASS。**

| 契约 | 建议值 | 用途 |
|---|---|---|
| `document.documentElement.dataset.orientationMode` | `pre-game` / `css-rotate` / `system-locked` / `native-landscape` / `dismissed` | 区分「入房不旋转」「自旋转」「锁定成功取消旋转」「视口本身横屏」「用户出口」 |
| `document.documentElement.dataset.rotationDeg` | `90` / `-90` / `0` | 判双重旋转、方向正确性 |
| `window.__hex.view` | 保持既有（含 `phase`），供判断「收到开局 STATE」 | UL-C03 的观测源 |
| 既有 DOM id | `#portrait-gate` `#portrait-landscape` `#portrait-hint` `#portrait-dismiss` `#portrait-help` `#board` `#board-stage` `.rail` `#zoom-in/out/reset` `#discard` `#robberbar` `#setupbar` `#confirm-strip` `#toast` | UL-G02 DOM 对账；下游 `phase-d-landscape-button-check.mjs` / `phase-d-browser-verify.mjs` 依赖 |

**旋转几何口径（避免误判）**：在 390×844 竖屏视口里铺一块 844×390 的横屏画布并旋转 90° 后，
- 元素的 **computed `width/height`（布局盒）= 844×390**（横屏）；
- 元素的 **`getBoundingClientRect()`（视觉包围盒）≈ 390×844**（竖屏形，恰好盖满视口）；
- `getComputedStyle().transform` 为 `matrix(0,1,-1,0,…)` 或 `matrix(0,-1,1,0,…)`（±90°）。

因此**不能**用「bbox 宽 > 高」判断是否自旋转，脚本同时记录三种原始值。
子元素（按钮 / 棋盘热区）的 `getBoundingClientRect()` 是视觉坐标，可直接作为 CDP `Input` 派发坐标，
但实现内部若拿 `offsetX` / 未变换的 SVG 局部坐标做命中，就会错位 —— 这正是 B 组要测的风险。

> **重要回归提醒**：`docs/17-universal-landscape-ux.md` §2.4 / §4.1 已明确：
> 旧 `#portrait-landscape`「进入横屏」主按钮**不得再是必须点按的关卡**，主路径改为无模态自转 + 轻提示条；
> `screen.orientation.lock` 只由「常驻可选方向入口」或「对局中已有手势搭车」触发（§2.5）。
> 因此本脚本**不假设该按钮存在**：`clickOrientationEntry()` 按 id / 文案 / aria-label / title 识别方向入口，
> 找不到时退回点 `#zoom-in` 提供一次已有手势（并在 `observed` 里如实注明 `gesture-piggyback`）。
> 若该按钮 / `#portrait-gate` 被有意废弃，必须登记为**有意变更**并同步更新
> `probe/phase-d-landscape-button-check.mjs`（当前 9 PASS 基线）与
> `apps/web/test/phase-d-fix-landscape.test.ts`（9 条 click 行为测试），
> 否则旧脚本会以「元素不存在」失败，不能静默当作回归通过。

### 2.1 UX 规格 §7 可验收条目 → 本矩阵映射

按主理人 ULS-03 补充要求，**A-1…A-14 逐条在脚本里各有一个专属检查 ID `UL-UX01`…`UL-UX14`**
（见 §3.11），全部初始 `NOT_RUN`，只有实跑观测才可能 PASS/FAIL；A-3/A-4/A-6/A-13 结构性 `BLOCKED`。
下表是「UX 条目 → 专属 ID → 原有 UL-* 支撑项」的映射，专属 ID 是裁定入口，UL-* 是原始证据来源。

| UX 条目 | 专属检查 ID | 原有支撑检查 ID | 覆盖程度 / 待补证 |
|---|---|---|---|
| A-1 iOS Safari 模拟 | `UL-UX01` | `UL-A01` `UL-A02` `UL-A04` `UL-F04` | CDP 能力模拟可判自转 / 无异常 / 无模态关卡 / 禁用旧文案；**逐字文案**与真机 iPhone 另由单测 + A-13 补证 |
| A-2 厂商拒绝锁定 | `UL-UX02` | `UL-A03` `UL-F04` | 自转保持、rejection 被 catch、`lock` 调用 ≤1 次、提示 ≤1 次、无失败卡片；**画面不闪**需真机目视 |
| A-3 自转后真实点击命中（最高优先级） | `UL-UX03` | `UL-B01` `UL-B02` `UL-B05` `UL-B06` `UL-B07` `UL-G06` `UL-R01` `UL-R03` | **真机必需、BLOCKED**：真机 `input tap` + `uiautomator dump`；点 A 不落 B、拖动不误建造、相机不重置、选点不丢。CDP 真实指针只作辅助观测，**不得单独判通过** |
| A-4 入房软键盘 | `UL-UX04`（A-4a/A-4b） | `UL-C01` `UL-C02` `UL-R05` | **Android Edge 已补验：A-4a PASS / A-4b PASS**（输入正立+中文可输入；硬件 Enter 与软键盘「下一步 ×2」均可提交）。**iOS Safari / 微信内置仍 BLOCKED**；后续要求补 `enterkeyhint` + 引导文案。**此项对应补齐 `docs/16` §4 D8 的键盘部分** |
| A-5 三档横屏回归 | `UL-UX05` | `UL-E02` `UL-E03` `UL-E04` `UL-G07` `UL-A09` `UL-E01` | 对齐 `docs/16` §1.2 的 503/658/736 px 参考值与 9 PASS 基线；另查自转画布铺满、无黑边 / 中间竖条；四人玩家条与按钮文字需截图目视 |
| A-6 旋转后安全区 | `UL-UX06` | `UL-D01` `UL-D02` `UL-D03` `UL-D04` | **真机必需、BLOCKED**：`env(safe-area-inset-*)` 重映射、刘海/挖孔/手势条不压顶栏与底部固定按钮；CDP 只记几何与 computed padding |
| A-7 阶段迁移 | `UL-UX07` | `UL-C01` `UL-C03` `UL-C04` `UL-C07` | S0→S2 已可测；**带 view 的 WELCOME 恢复路径**与「结束页→回到房间退出自转」需造重连/结束态补跑（partial） |
| A-8 状态机 **S0–S8 共 9 态**（主理人已更正编号，非 S0–S9） | `UL-UX08` | `UL-A01` `UL-A06` `UL-A07` `UL-F01` `UL-E05` | 以 `docs/17` **§3.1 状态表**为准：S0 入房 / S1 瞬时 / S2 自转主态 / S3 尝试锁定 / S4 锁定成功 / S5 失败回落 / S6 竖屏出口 / S7 真横屏 / S8 回竖屏。CDP 可采样 8 态；S1 同帧瞬时态与 S3 超时按 S5 需单测状态迁移表 + 人工检查表（partial） |
| A-9 出口与恢复 | `UL-UX09` | `UL-F01` `UL-F02` `UL-F03` `UL-B09` | 「重新铺成横屏」真实指针恢复、≥44×44 实测、S6 信息不空白、恢复不叠加；屏幕阅读器与完整键盘顺序需人工 |
| A-10 不反复弹 / 会话记忆 | `UL-UX10` | `UL-F01` `UL-F02` `UL-A07` | MutationObserver 统计 ≥3 次 resize + S7↔S8 下提示 ≤1 次；切后台、接电话、刷新重置需浏览器生命周期 + 真机（partial） |
| A-11 可访问性 | `UL-UX11` | `UL-B09` `UL-F05` `UL-D03` | CDP 实测按钮 rect / 字号 / 对比度 / `aria-live` / 焦点 / 减少动效标记；播报次数、两种开关实际效果、屏幕阅读器、旋转后中文真机渲染需人工 + 真机（partial） |
| A-12 降级三分支文案 | `UL-UX12` | `UL-A02` `UL-A03` `UL-A04` `UL-F04` | 三分支场景（① API 缺失 ② 请求被拒 ③ 无法区分/Promise pending 超时）真实文案扫描；**禁用旧主提示**「请检查系统旋转锁定设置」等可实测；逐字一致断言待 C3 文案拍板后由单测补证 |
| A-13 方向习惯与能力实机复核 | `UL-UX13` | `UL-R01` `UL-R02` `UL-R03` `UL-R05` | **真机必需、BLOCKED**：iPhone Safari + ≥2 种国产内置浏览器，用户**物理转动手机**，不是 `cmd window user-rotation` ADB 强制旋转；明确为未验证假设 |
| A-14 指南 4.2 依赖剥离 | `UL-UX14` | `UL-A01` `UL-A02` `UL-B01` `UL-B02` | 运行时剥离 `lock` + `requestFullscreen` 后自转仍生效、真实指针可操作；静态评审由主理人汇编，完整「入房→摆位→建造/交易」链路需阶段二补跑 |

> **A-10 / A-13 的已知取舍（不得写成通过条件）**：`docs/17` §2.3 明确「系统方向锁死时，前端无可靠信号判断用户是否已物理横过来」，
> 因此转向提示只允许「**一次 + 淡出 + 可关 + 会话记忆**」。矩阵与脚本**不把「提示应自动消失」写成判据**，
> 只判「一次会话出现 ≤1 次」「可关闭」「可恢复」「刷新重置」。
> 旋转方向：UX §2.1 规定唯一 `rotate(90deg)`（配套「向左横过来」），但附录 C1 仍为**待用户拍板项**。
> 本矩阵在 `UL-E05` / `UL-A01` 记录实测 `deg`，容忍 ±90°，不因 `-90deg` 直接判 FAIL；
> 待用户拍板后再收紧为 `+90` 单一常量。

---

## 3. 复验矩阵（81 条 · 全部对应脚本 `CHECK_DEFS` 的检查 ID）

> 81 = CAP 10 + ENV 3 + A 能力分支 9 + B 指针命中 9 + C 生命周期 7 + D 安全区 4
> + E 视口 7 + F 出口 5 + G 回归 7 + R 真机 6 + **UX 规格 A-1…A-14 专属 14**（§3.11）。
> 其中 10 条结构性 BLOCKED（R 组 6 + UX 真机必需 4）。

> 阶段一状态列：`NOT_RUN`（未执行）/ `BLOCKED`（无设备）/ `PASS`（仅能力自检实跑，见 §4.3）。
> 判据均为**实跑前预先写明**，不允许事后调整。

### 3.1 CAP · 浏览器 / CDP 能力自检（10 条，`--mode=capability-only` 可实跑）

| ID | 检查点 | 预先写明的判据 | 证据类型 | 执行方式 |
|---|---|---|---|---|
| `UL-CAP-01` | CDP 连通与版本 | `/json/version` 返回 Chrome 版本 + target WS 可连 | CDP·能力模拟 | 无头 Chrome 独立端口 |
| `UL-CAP-02` | 竖屏真实 CSS 视口 | 390×844 / 375×667，`innerWidth/innerHeight` 精确、`dpr=2`、`matchMedia('(orientation: portrait)')===true` | CDP·真实视口 | `setDeviceMetricsOverride` + `Runtime.evaluate` |
| `UL-CAP-03` | 三档横屏真实 CSS 视口 | 667×375 / 844×390 / 932×430 精确且 `landscape===true` | CDP·真实视口 | 同上 |
| `UL-CAP-04` | 矛盾方向可构造 | 视口 390×844 同时 `screenOrientation=landscapePrimary(angle 90)` 可下发，并如实记录 `screen.orientation.type` 与 `matchMedia` 原始值（模拟华为竖条坑） | CDP·真实视口 | 同上，原始值入报告 |
| `UL-CAP-05` | 新文档注入可剥离 API | 页面脚本执行前 `screen.orientation.lock === undefined`、`documentElement.requestFullscreen === undefined`，且探针计数存在 | CDP·能力模拟 | `addScriptToEvaluateOnNewDocument` |
| `UL-CAP-06` | 可 mock 锁定成功 | `lock` 返回 resolved、`orientationchange` 派发、`orientation.type/angle` 可被改写为横屏，探针记录调用 | CDP·能力模拟 | 同上 |
| `UL-CAP-07` | 旋转矩阵可测 | fixture 元素 `getComputedStyle().transform` 解析出 ≈±90°；**布局**宽高（computed `width/height`）与 `getBoundingClientRect()` 视觉宽高互换 | CDP·真实视口 | fixture `data:` 页 |
| `UL-CAP-08` | 旋转后命中测试 | `elementFromPoint(rect.center)` 返回被旋转元素本身（或其可点子节点） | CDP·真实视口 | fixture |
| `UL-CAP-09` | 旋转后真实指针可达 | mouse + touch 均产生 `pointerdown/pointerup/click`，记录 `pointerType` 与 `clientX/clientY` | CDP·真实指针 | `Input.dispatchMouseEvent` / `dispatchTouchEvent` |
| `UL-CAP-10` | 证据采集能力 | 截图非空 PNG；`console.error` / `exceptionThrown` / `unhandledrejection` 可被收集 | CDP·日志 | `Page.captureScreenshot` + Runtime 事件 |

### 3.2 ENV · 环境隔离（3 条）

| ID | 检查点 | 判据 | 证据类型 |
|---|---|---|---|
| `UL-ENV-01` | 独立端口 | `capability-only` 不起任何服务；`full` 仅监听 `127.0.0.1` 独立端口（默认后端 8793 / vite 5183 / CDP 9415），不碰用户 8787 / 5173 / 8792 | 汇编 + 环境 |
| `UL-ENV-02` | 独立房间 | 房间号 `qa-ul-<...>`（≤24 字符、`[a-z0-9_-]`、非 `main`），不带 sharecode，不连线上房间 | 汇编 + 环境 |
| `UL-ENV-03` | 测完清理 | 关闭后端/vite/所有 target/Chrome，删除本脚本自建临时 profile；报告记录清理结果 | 汇编 + 环境 |

### 3.3 A · 能力分支 / 降级路径（9 条）

| ID | 场景 | 预先写明的判据 | 证据类型 | 关联 |
|---|---|---|---|---|
| `UL-A01` | **iOS Safari 模拟**：注入剥离 `screen.orientation.lock` 与 `requestFullscreen`，iOS Safari UA，390×844 竖屏 | 开局后 `orientationMode==='css-rotate'`（或几何推断旋转）；旋转容器**布局宽≈innerHeight、布局高≈innerWidth**（横屏画布），旋转后 `getBoundingClientRect()` 覆盖竖屏视口（w≈innerWidth、h≈innerHeight）；rail/board 可见。**注意**：90° 旋转后视觉 bbox 是竖屏形，不能用「bbox 宽>高」判定 | CDP·能力模拟 + 真实视口 | iOS Safari |
| `UL-A02` | 同上，**不依赖系统 API** | `probe.locks===0` 且 `probe.fullscreens===0`（或调用被安全 catch）；无 `unhandledrejection`；不出现「必须手动旋转」作为唯一出口；不反复弹提示 | CDP·能力模拟 + 日志 | 指南 4.2 |
| `UL-A03` | **厂商浏览器拒绝 lock**：mock `lock()` 抛 `NotAllowedError`；`requestFullscreen` 亦拒绝 | 落到自旋转；rejection 被 catch（无 `unhandledrejection`）；有可见降级说明或自旋转实际生效，不假装成功 | CDP·能力模拟 + 日志 | 夸克 / 华为真机史 |
| `UL-A04` | **API 缺失**：`screen.orientation` 整体缺失 / `lock` 为 `undefined` | 不自旋转失败：无异常、落到自旋转；不因 `typeof api.lock` 抛 TypeError | CDP·能力模拟 | 微信 / 老 WebView |
| `UL-A05` | `requestFullscreen` 被拒但 `lock` 可用 | 全屏失败不阻断后续分支；最终仍呈现横屏（锁定成功或自旋转），无静默失败 | CDP·能力模拟 | 历史坑 |
| `UL-A06` | **系统锁定成功**：mock `lock` resolve + 改写 `orientation.type/angle` + 派发 `orientationchange` | 取消 CSS 旋转（`rotationDeg===0` 或 computed transform 无 ±90°），`orientationMode==='system-locked'`，横屏布局正常，无双重旋转 | CDP·能力模拟 + 真实视口 | Android Chrome |
| `UL-A07` | 锁定成功后转回竖屏（`orientationchange` → portrait） | 重新启用自旋转，且旋转角恰为 ±90° **一次**（不叠加为 180°） | CDP·能力模拟 | 生命周期 |
| `UL-A08` | **lock 假成功**：resolve 但 `orientation`/视口仍竖屏 | 不误取消自旋转（防止「声称已横屏、实际仍竖屏」） | CDP·能力模拟 | 诚信防呆 |
| `UL-A09` | **系统报告横屏但 CSS 视口仍竖屏**（华为浏览器 `docs/16 §1.1` 竖条坑） | 以视口实测为准自旋转；旋转后画布铺满可视区，无中间竖条 / 两侧黑边（截图 + rect 复核） | CDP·真实视口 + 人工 | 历史缺陷 |

### 3.4 B · CSS 自旋转后的真实指针命中（9 条 · 本方案最高风险区）

> 旋转后 `Input` 坐标是**视觉视口坐标**，而实现内部若用 `offsetX` / SVG 局部坐标 / 未变换的 `clientX-clientY`
> 做命中或拖动阈值，会出现「看得到点不到」「点 A 选到 B」「拖一下就建造」。
> 所有动作必须 `elementFromPoint` 先核命中，再派发真实指针，再读 UI 结果。

| ID | 检查点 | 预先写明的判据 | 证据类型 |
|---|---|---|---|
| `UL-B01` | 棋盘候选点选 | 真实指针点 `#board [data-vertex]`（或等价热区）中心，`elementFromPoint` 命中该元素；出现预览 / 确认条 / `.picked`，且选中 ID 与目标一致 | CDP·真实指针 |
| `UL-B02` | 缩放按钮 | 点 `#zoom-in` / `#zoom-out` / `#zoom-reset`：三个按钮真实可点，`zoom-in/out` 逐次改变 `#board viewBox`；**不**顺带选中棋盘位置、不弹确认条；`reset` 是否回到初值单独记录原始值（不据此改判，因为 out 未必精确抵消 in） | CDP·真实指针 |
| `UL-B03` | 弃牌加减 | `--seven` 种子态下点 `#discard .dp-step`：`.dp-count` 按预期增减，`#discard-ok.disabled` 同步 | CDP·真实指针 |
| `UL-B04` | 强盗按钮 | 选地块后点 `#robberbar [data-action=steal]`，`pendingRobber` 归 false / 按钮生效 | CDP·真实指针 |
| `UL-B05` | 拖动不误建造 | 视觉**水平**与**垂直**两方向各一次 >8 CSS px 拖动；无确认条、无新增建筑/道路、无 `picked` | CDP·真实指针 |
| `UL-B06` | 双指不误建造 | 双指 pinch 后抬手：无确认条、无新增建筑；镜头不回弹 | CDP·真实指针 |
| `UL-B07` | 命中一致性 / 层级 | 关键按钮 rect 中心 `elementFromPoint` 返回自身或其可点子节点（不被 `.overlay` / gate / toast 遮挡，对齐历史 `z-index 30→45` 坑） | CDP·真实视口 + 真实指针 |
| `UL-B08` | 触屏同样生效 | 触屏 `pointerType==='touch'` 的 tap 在旋转后与鼠标同样生效（不只测 mouse） | CDP·真实指针 |
| `UL-B09` | 触控目标尺寸 | 旋转后关键按钮视觉 rect ≥44×44 CSS px（指南 5.2 设计目标），相邻热区不重叠误触 | CDP·真实视口 |

### 3.5 C · 阶段门槛与生命周期（7 条）

| ID | 检查点 | 预先写明的判据 | 证据类型 |
|---|---|---|---|
| `UL-C01` | 入房阶段不旋转 | 未收到开局 STATE（`__hex.view` 为空 / `phase!=='setup'`）时 `orientationMode==='pre-game'` 且无 ±90° 旋转；昵称 / 房间 / 加入可真实点击 | CDP·真实指针 + 真实视口 |
| `UL-C02` | 软键盘阶段不旋转 | 输入框 focus + `visualViewport` resize 模拟下不启用旋转；**真机键盘**另由 `UL-R05` 补证（此项只作浏览器级） | CDP·真实视口（**不替代真机**） |
| `UL-C03` | 开局 / 恢复后启用 | 阶段信号以 **`view !== null` / 入房浮层隐藏** 为准（UX §1.2：重连恢复的 `WELCOME` 也会直接带 `msg.view`，只等 STATE 会漏掉恢复玩家）；收到后从 `pre-game` 切到 `css-rotate` / `system-locked`，记录切换前后原始值与时间点 | CDP·真实视口 |
| `UL-C04` | 旋转无副作用 | 旋转前后：座位不变、待确认 `picked` 不丢、不提交草稿；服务端命令计数不因旋转增加（指南 4.2） | CDP·真实指针 + 协议集成 / 服务端日志 |
| `UL-C05` | 相机不重置 | 缩放后触发 STATE 广播并切旋转态，`viewBox` 保持不变（指南 5.1 / 13.2⑬） | CDP·真实视口 |
| `UL-C06` | 全链路无异常 | 入房 → 开局 → 旋转 → 锁定/降级 → 回竖屏 全程 `consoleErrors` 为空、无 `unhandledrejection` | CDP·日志 |
| `UL-C07` | 重新计算可视区域 | 旋转后确认条 / 抽屉 / 当前任务不滚出视野，关键确认按钮 rect 在视口内（指南 4.2 / 4.1） | CDP·真实视口 |

### 3.6 D · 安全区 / 刘海（4 条）

| ID | 检查点 | 预先写明的判据 | 证据类型 |
|---|---|---|---|
| `UL-D01` | 不遮挡 | 旋转后顶栏、底部动作、确认按钮 rect 完全落在视觉视口内（0 ≤ x/y 且 right/bottom ≤ innerWidth/innerHeight） | CDP·真实视口 |
| `UL-D02` | safe-area 映射 | `env(safe-area-inset-*)` 在旋转后映射到正确的**视觉边**（旋转 90° 后 top↔left 会互换）；用探针元素读 computed padding 原始值 | CDP·真实视口 |
| `UL-D03` | 无溢出 / 黑边 | `documentElement.scrollWidth ≤ clientWidth`、无横向滚动；截图目视无竖条 / 黑边 / 裁切 | CDP·真实视口 + 人工 |
| `UL-D04` | 真机刘海 / 圆角 / 浏览器栏 / 键盘 | 真机实测 | **真机 ADB + 人工 → BLOCKED** |

### 3.7 E · 视口矩阵（7 条）

| ID | 视口 / 场景 | 预先写明的判据 | 证据类型 |
|---|---|---|---|
| `UL-E01` | 竖屏 390×844、375×667 | 自旋转画布铺满：布局宽≈innerHeight、布局高≈innerWidth（误差 ≤2px），旋转后 bbox 覆盖视口且 rail/board 可见 | CDP·真实视口 |
| `UL-E02` | 横屏 667×375 | 不重复旋转（`rotationDeg===0`）、gate `display:none`、rail 展开、board-stage 宽度 >0 且无遮挡 | CDP·真实视口 |
| `UL-E03` | 横屏 844×390 | 同上 | CDP·真实视口 |
| `UL-E04` | 横屏 932×430 | 同上 | CDP·真实视口 |
| `UL-E05` | 动态切换 portrait→landscape→portrait | 每次只发生 0 或 ±90° 一种旋转，不叠加、不漏旋转；逐次记录 `rotationDeg` / `orientationMode` | CDP·真实视口 |
| `UL-E06` | 1024×768 平板 / 1366×768 桌面 | **不误触发**自旋转（宽屏本就横屏/可横屏布局） | CDP·真实视口 |
| `UL-E07` | 方法学对账 | 每档记录 `innerWidth/innerHeight/dpr/orientation.type/angle/matchMedia` 原始值（**仅方法学能力，不代表布局通过**） | CDP·真实视口 |

### 3.8 F · 「仍按竖屏查看」出口（5 条）

| ID | 检查点 | 预先写明的判据 | 证据类型 |
|---|---|---|---|
| `UL-F01` | 不反复弹 | 点击 `#portrait-dismiss`（或新出口）后，连续多次 `resize` / `orientationchange` / STATE 广播，卡片/提示保持收起，`dataset.dismissed==='1'` | CDP·真实指针 + 真实视口 |
| `UL-F02` | 可恢复 | 存在可见恢复入口（设置/帮助/显式按钮），真实点击后能重新启用旋转或再次给出提示；记录点击前后状态 | CDP·真实指针 |
| `UL-F03` | 出口无副作用 | dismiss 后座位不变、不提交草稿、横屏视口下仍不显示竖屏卡片 | CDP·真实指针 + 协议集成 |
| `UL-F04` | 不静默失败 / 不假装成功 | 拒绝 / 缺失 lock 时，要么自旋转实际生效，要么有可见说明；绝不出现「toast 说已切横屏但视口仍竖屏且未旋转」 | CDP·能力模拟 + 真实视口 |
| `UL-F05` | 信息可及性 | 状态提示不靠颜色 / 声音 / hover 单独传递；文案在旋转后可读、焦点可见（指南 4.3 / 13.2⑳） | CDP·真实视口 + 人工 |

### 3.9 G · 回归（7 条）

| ID | 检查点 | 预先写明的判据 | 证据类型 |
|---|---|---|---|
| `UL-G01` | 全量测试基线 | `pnpm test` **387 passed + 2 todo** 不退化、`pnpm typecheck` 四包通过、`pnpm build` 成功（本阶段**禁止运行**） | 单测 + 汇编 |
| `UL-G02` | DOM id 对账 | §2 所列 id 全部存在；若有意删除需登记为变更并同步既有脚本 / 测试；不得静默失效 | CDP·真实视口 + 汇编 |
| `UL-G03` | 相机手势回归 | 8 CSS px 拖动阈值、双指缩放、`pointercancel` / 多指加入 / 失焦不残留手势状态，`viewBox` 连续可读 | CDP·真实指针 |
| `UL-G04` | 一键横屏基线 | `probe/phase-d-landscape-button-check.mjs` **9 PASS / 0 FAIL** 不退化（若按钮被废弃，按 §2 登记变更） | CDP·真实指针 + 汇编 |
| `UL-G05` | 阶段 D 复验不退化 | `phase-d-verification-plan.md` 的 `D-*` / `CASE-*` / `EXIT-*` 不因本改造新增 FAIL；引用既有报告，不重跑冒充 | 汇编 |
| `UL-G06` | SVG 坐标转换 | 旋转后 `getScreenCTM()` 与 `getBoundingClientRect()` 一致，`client→SVG` 转换无 X/Y 反转；点选命中目标 ID | CDP·真实视口 + 真实指针 |
| `UL-G07` | 三档横屏布局回归 | 对齐既有 9 PASS 基线：gate 隐藏、rail 展开、board-stage 宽度（历史 503/658/736 px 作参考值，不作硬性判据） | CDP·真实视口 |

### 3.10 R · 真机手工项（6 条 · 本会话全部 `BLOCKED`）

| ID | 设备 / 浏览器 | 场景 | 判据 | 证据类型 |
|---|---|---|---|---|
| `UL-R01` | iPhone Safari 真机 | 无 lock、无可靠 fullscreen | 开页即横屏画布；真实手指点棋盘/按钮命中；不弹无解提示 | 真机 ADB/人工（无设备） |
| `UL-R02` | 华为 / 小米 / OPPO 等厂商自带浏览器 | 拒绝或不支持 lock | 落到 CSS 自旋转；无竖条 / 黑边 / 竖屏宽度渲染 | 真机 ADB + 人工 |
| `UL-R03` | 微信内置浏览器（iOS WKWebView / Android XWEB·X5） | 从分享链接打开 | CSS 自旋转生效、WS 可达、能入房、旋转后按钮可点 | 真机 ADB + 人工 |
| `UL-R04` | Android Chrome（支持 lock） | 系统锁定成功 | 取消自旋转、不双重旋转；物理转回竖屏可重新自旋转 | 真机 ADB + 人工 |
| `UL-R05` | 真机物理旋转 + 软键盘 + 电话/语音后台返回 | 组合 | 不丢座位 / 不提交草稿 / 不无限弹提示 / 安全区不遮挡 | 真机 ADB + 人工 |
| `UL-R06` | 真机 dismiss 出口与恢复 + 刘海/圆角/浏览器栏 | 组合 | 不反复弹、可恢复、信息层级 1 始终可见 | 真机 ADB + 人工 |

### 3.11 UX 规格 §7 A-1…A-14 专属检查 ID（14 条）

> 按主理人 ULS-03 补充要求新增：**每条 A-* 各有唯一检查 ID**，全部在脚本 `CHECK_DEFS` 里初始 `NOT_RUN`，
> 由 `runUxChecks()` 依据 `uxSupplement.scenarios` / `uxSupplement.cdp` 的**实际观测**裁定，
> 绝不因「有检查项 / 源码看起来实现了」写 PASS。
> A-8 状态机以 `docs/17` §3.1 的 **S0–S8 共 9 态**为准（主理人已更正 S0–S9 笔误）。

| ID | 对应 UX 条目 | 预先写明的判据（摘要） | 证据类型 | 阶段一状态 |
|---|---|---|---|---|
| `UL-UX01` | A-1 iOS Safari 模拟 | 无 lock / 无 requestFullscreen 下直接自转；无异常、无全屏模态关卡、主提示无旧文案与技术黑话 | CDP·能力模拟 + 真实视口 | NOT_RUN |
| `UL-UX02` | A-2 厂商拒绝锁定 | 自转保持 / 立即生效；`lock` 调用 ≤1 次、提示 ≤1 次、无失败卡片、无异常 | CDP·能力模拟 + 真实视口 | NOT_RUN |
| `UL-UX03` | A-3 自转后真实点击命中 | 真机 `input tap` + `uiautomator dump`：点 A 不落 B、拖动不误建造、相机不重置、选点不丢 | **真机 ADB + 人工**（CDP 仅辅助） | **BLOCKED** |
| `UL-UX04` | A-4 入房软键盘（**补 `docs/16` §4 D8 缺口**）；design-strategist 已拆为 A-4a（输入可用）/ A-4b（完成路径可达） | A-4a：输入框正立不裁切、中文可输入、无自转；A-4b：CTA 可见可滚到 **或** 回车/软键盘动作可提交，至少一条 | **真机 ADB + 人工** | 脚本 `BLOCKED`；**quality-lead 真机裁定：A-4a PASS / A-4b PASS（Android Edge，附 enterkeyhint 后续要求）** |
| `UL-UX05` | A-5 三档横屏回归 | 667/844/932 三档 gate 隐藏、rail 展开、stage 宽度 >0、不重复旋转；自转画布铺满无黑边 / 中间竖条（503/658/736 为参考值） | CDP·真实视口 + 人工 | NOT_RUN |
| `UL-UX06` | A-6 旋转后安全区 | `env(safe-area-inset-*)` 重映射，刘海 / 挖孔 / 手势条不压顶栏与底部固定按钮 | **真机 ADB + 人工**（CDP 仅辅助） | **BLOCKED** |
| `UL-UX07` | A-7 阶段迁移 | LOBBY→STATE、带 view 的 WELCOME 恢复路径、结束页→「回到房间」退出自转；不发命令 / 不丢座位 / 不提交草稿 | CDP·真实视口 + 协议集成 | NOT_RUN |
| `UL-UX08` | A-8 状态机 S0–S8 共 9 态 | 逐态覆盖；S1 不停留、S3 超时按 S5、S7/S8 不弹提示、`forced`/`hintShown` 记忆位一致 | CDP·真实视口 + 单测 + 人工 | NOT_RUN |
| `UL-UX09` | A-9 出口与恢复 | 出口 / 恢复 ≥44×44、键盘可达、S6 信息不空白、真实点击「重新铺成横屏」回 S2 且不叠加提示 | CDP·真实指针 + 真实键盘 + 人工 | NOT_RUN |
| `UL-UX10` | A-10 不反复弹 / 会话记忆 | ≥3 次 resize + S7↔S8 + 切后台 + 接电话，转向提示**总计 ≤1 次**；刷新视为新会话；**不把「提示应自动消失」写成判据** | CDP·真实视口 + 浏览器生命周期 + 真机 | NOT_RUN |
| `UL-UX11` | A-11 可访问性 | `aria-live` 关键态各一次 / S7-S8 不播、焦点圈不裁、实测 rect ≥44×44、正文 ≥12 CSS px、对比度 ≥4.5:1、两种减少动效开关、不只靠颜色/动画/声音 | CDP·真实视口 + 真实键盘 + 人工 + 真机 | NOT_RUN |
| `UL-UX12` | A-12 降级三分支文案 | ① API 缺失 ② 请求被拒 ③ 无法区分（Promise pending / 超时）三分支逐字断言；**不得出现**「请检查系统旋转锁定设置」「请手动把手机横过来」等旧主提示与技术黑话 | CDP·能力模拟 + 单测（文本断言） | NOT_RUN |
| `UL-UX13` | A-13 方向习惯与能力实机复核 | iPhone Safari + ≥2 种国产内置浏览器，用户**物理转动手机**（非 ADB 强制旋转）；记录是否自然、有无反向转 / 亚像素模糊 / 黑边 / 竖条，明确为未验证假设 | **真机 ADB + 人工** | **BLOCKED** |
| `UL-UX14` | A-14 指南 4.2 依赖剥离 | 运行时禁用 `lock` + `requestFullscreen` 后自转仍完整可用、棋盘/缩放真实指针可操作；静态评审 + 运行时验证 | CDP·能力模拟 + 真实指针 + 静态评审 | NOT_RUN |

**脚本侧实现要点（保证「只有实跑观测才可能 PASS/FAIL」）**
- 新增 `lock: 'pending'` 模拟（Promise 永不 settle）与场景 `degrade-undistinguishable`，用于 A-12 ③ / E2「S3 超时按 S5」；
  `full` 模式共 8 个能力分支场景。
- 注入探针新增 `__UL_HINT__`（只读 MutationObserver，统计转向提示隐藏→可见次数）与 `injectErrors`；
  `scanCopy()` 扫描提示 / toast / `role=status` 文案并禁用旧主提示；`readA11y()` 实测 rect / 字号 / 对比度 / `aria-live` / 焦点 / 减少动效；
  `pressTab()` 派发**真实键盘事件**；`clickRestoreEntry()` 用**真实指针**点击「重新铺成横屏」。
- 真机必需项 `UX_REAL_DEVICE_IDS = [UL-UX03, UL-UX04, UL-UX06, UL-UX13]` 由 `blockRealDevice()` **结构性 BLOCKED**；
  其 CDP 辅助观测只写入 `uxSupplement`，绝不改判为 PASS。
- 需单测 / 人工 / 真机补证的部分一律 `partial`（NOT_RUN + 原始观测）或 `BLOCKED`，不假装全覆盖。

---

## 4. 脚本与运行方式

### 4.1 交付物

| 文件 | 作用 |
|---|---|
| `probe/phase-d-universal-landscape-plan.md` | 本文件：81 条矩阵（含 §3.11 的 UX A-1…A-14 专属 14 条）、契约、真机清单、Runbook |
| `probe/phase-d-universal-landscape-check.mjs` | 新增 CDP 脚本：`--mode=capability-only`（默认，秒级、不起服务）/ `--mode=full`（阶段二实跑，8 个能力分支场景 + 共享检查 + `runUxChecks()` 裁定 UX 14 条） |
| `probe/phase-d-universal-landscape-report.json` | 脚本产出的结构化报告；沿用「初始 NOT_RUN、只写实际观测」状态机；含 `uxSupplement` 原始观测区 |

### 4.2 命令

```bash
cd /Users/baoxiaopai/Project/卡坦岛线上桌游

# 阶段一 / 阶段二前置：只跑能力自检（不起服务、不实跑对局、不跑全量命令）
node probe/phase-d-universal-landscape-check.mjs --mode=capability-only

# 阶段二（等主理人唤醒后再跑）：起独立 127.0.0.1 服务 + 独立房间 + 真实指针
node probe/phase-d-universal-landscape-check.mjs --mode=full --shots

# 2a) 能力快照另存，避免覆盖 full 报告
node probe/phase-d-universal-landscape-check.mjs --mode=capability-only --out=probe/phase-d-universal-landscape-capability-report.json

# 2b) 真机（Android / Edge）
#   PORT=8794 HOST=127.0.0.1 node apps/server/dist/server.cjs
#   adb reverse tcp:8794 tcp:8794 && adb forward tcp:9224 localabstract:chrome_devtools_remote
#   adb shell am start -a android.intent.action.VIEW -d 'http://127.0.0.1:8794/?name=ULP1&room=qa-ul-dv2' -p com.microsoft.emmx
#   （用 Node WebSocket 发 JOIN v:2 补 3 人；页面状态走 CDP，触摸走 input tap / dispatchTouchEvent）

# 只跑单条能力分支场景（调试用，仍需独立服务；单场景模式不跑共享检查，UX 项会如实标 NOT_RUN/BLOCKED）
node probe/phase-d-universal-landscape-check.mjs --mode=full --scenario=ios-safari
node probe/phase-d-universal-landscape-check.mjs --mode=full --scenario=degrade-undistinguishable

# 使用已由主理人起好的独立服务（不额外起进程）
node probe/phase-d-universal-landscape-check.mjs --mode=full --base-url=http://127.0.0.1:8793
```

可选参数：`--chrome=<path>`、`--cdp-port=9415`、`--backend-port=8793`、`--vite-port=5183`、
`--base-url=`、`--room=qa-ul-...`、`--players=4`、`--scenario=<id>`、`--shots`、`--keep-profile`、`--help`。
默认端口与既有 8787 / 5173 / 8791 / 8792 / 9411 / 9413 **全部错开**。

### 4.3 阶段一实际执行范围与结果（本会话实测）

- 仅运行 `node probe/phase-d-universal-landscape-check.mjs --mode=capability-only`。
- 该模式**不启动任何 HTTP/WS 服务**、不连房间、不跑 `pnpm test/typecheck/build`、不产生游戏验收结论。
- 结果（`probe/phase-d-universal-landscape-report.json`）：
  **13 PASS / 0 FAIL / 58 NOT_RUN / 10 BLOCKED，共 81 条，`gate=NOT_CONCLUDED`**，
  `reportScope=PHASE1_CAPABILITY_SNAPSHOT`。
  13 条 PASS = `UL-CAP-01..10`（10 条能力）+ `UL-ENV-01..03`（3 条环境隔离）；
  游戏检查项（A/B/C/D/E/F/G 共 48 条 + `UL-UX01..14` 中非真机必需 10 条）**0 条 PASS**、全部 `NOT_RUN`；
  10 条 BLOCKED = R 组 6 条 + UX 真机必需 4 条（`UL-UX03/04/06/13`）。
- 自检发现并修掉 1 个真实脚本缺陷：`Page.addScriptToEvaluateOnNewDocument` 执行时
  `document.documentElement` 为 `null`，导致 `requestFullscreen` 剥离抛 `TypeError` 且**静默中断后续注入**
  （`UL-CAP-05` 首轮 FAIL：`lockType=undefined` 但 `fullscreenType=function`）。
  已改为在 `Element.prototype` / `Document.prototype` 上打补丁，并在探针里记录 `injectErrors`；
  重跑后 `UL-CAP-05` PASS、`injectErrors=[]`。这正是能力自检的价值：避免阶段二把注入失败误读成产品缺陷。
- `UL-CAP-04` 原始观测（矛盾方向，值得实现方注意）：请求 `390×844` + `landscapePrimary(angle 90)` 时，
  页面读到 `screen.orientation.type='landscape-primary'` / `angle=90`，
  但 `matchMedia('(orientation: portrait)')===true`、`innerWidth=390 / innerHeight=844`。
  **证明系统报告的方向与 CSS 视口可能矛盾**，旋转判定必须以视口实测为准（对应 `UL-A09` 与 `docs/16 §1.1` 华为竖条坑）。
- `UL-CAP-07` 原始观测：`transform=matrix(0,1,-1,0,390,0)`、`deg=90`、
  computed 布局 `844×390`、`getBoundingClientRect()` `390×844` —— 复证 §2 的旋转几何口径。
- 新增 `UX-HELPERS` 能力项：在 capability-only 阶段用真实浏览器预跑 `scanCopy()` / `readA11y()`
  表达式（结果见 `uxSupplement.cdp.capabilitySanity`，实测 `scanCopy.ok=true`、`readA11y.ok=true`），
  避免阶段二才暴露表达式错误。fixture 无方向入口 / 恢复入口，另两个 helper 留到 full 模式执行。

### 4.4 阶段二实跑结果（2026-11-08，实现交付后）

**主机浏览器（CDP，真实无头 Chrome 156 + 真实指针）**：
`node probe/phase-d-universal-landscape-check.mjs --mode=full --shots`
→ **44 PASS / 0 FAIL / 23 NOT_RUN / 14 BLOCKED，`gate=CONCERNS`**（UX09/10 修复后复跑）（`probe/phase-d-universal-landscape-report.json`）。
- 8 个能力分支场景全部执行；`UL-A01/A02/A03/A04/A05/A06/A07/A08/A09` 与 `UL-UX01/02/05/09/10/14` 取得实测状态。
- B 组真实指针：`UL-B01`（候选点选+消歧）、`UL-B02/B08`（缩放，鼠标+触屏）、`UL-B05/B06`（拖动/双指不误建造）、`UL-B07/B09`（命中与 44px）全部 PASS；`UL-B03/B04` 因未造掷 7/强盗种子态保持 BLOCKED。
- C/D/E/F/G：`UL-C03/C06/C07`、`UL-D01/D02/D03`、`UL-E01..E07`、`UL-F01..F04`、`UL-G01/G02/G06/G07` PASS；`UL-C04/C05/F05/G03` 为 partial（需服务端命令计数 / 可控 STATE 广播 / 人工），`UL-G05` 待汇编。
- **UX09/10 缺陷已修复并复验（2026-11-08 20:25 复跑）**：engineering-lead 按根因做了三层收口——
  `dismissPortrait()` 补 `tipClosed=true` + `clearHintTimers()`；`resumeLandscape()` 再保险；
  新增 `hintStripRendered` 使 `showHintStrip()` 整个会话最多渲染一次；并修掉「淡出 180ms 窗口内点恢复导致 hud 卡 opacity:0」的同源隐患。
  本轮复跑：`UL-UX09` **PASS**，恢复后 `hint.shows=1`、`#landscape-hud` 保持 `lh-settled`；`UL-UX10` 的 burst 计数 `shows=1`（仍为 partial/NOT_RUN，仅因「切后台/接电话/刷新重置」未覆盖，不是缺陷）。
  > 注：本轮 `tsx` 后端冷启动偶发挂起，脚本已加 `dist/server.cjs` 回退；本次修复仅前端，server 未变，报告 `environmentNotes` 已写明实际启动方式。
- `UL-UX02` 的「提示重复」曾因 FOUC 误计为 2 次，已改为样式稳定后计数 + 1.2s 去抖，复跑为 1 次（与上述 UX09/10 根因不同）。
- **UL-G01 独立复核 PASS**：quality-lead 亲自执行 `pnpm test`（engine 139+2 todo / protocol 20 / server 62 / web 208 = 429 passed + 2 todo）、`pnpm typecheck`（4 包 Done）、`pnpm build`（成功），与 engineering-lead 自报一致；原始输出记入报告 `run.fullCommands`。注意 `pnpm build` 重新生成了 `apps/web/dist` 与 `apps/server/dist/public`（构建产物，非源码）。
- CAP 能力项不在 full 模式执行；另存一份能力快照：`probe/phase-d-universal-landscape-capability-report.json`（13 PASS / 0 FAIL / 58 NOT_RUN / 10 BLOCKED）。

**真机（Android，Edge + ADB + CDP）**：见 §5.5 与 `probe/phase-d-universal-landscape-device-evidence.json`。

**阶段二发现（非阻断，待用户/design-strategist 拍板）**
1. **A-4 真机（已补验，结论更新）**：A-4a 输入可用 **PASS**；A-4b **PASS**——硬件 Enter 可提交，纯软键盘「下一步 ×2」也可提交（第 1 次聚焦房间号时「加入」上移可见，第 2 次提交）。早前「必须先收键盘」的判断已被补验推翻；剩余要求是补 `enterkeyhint` + 引导文案（否则两个输入框都显示「下一步」）。iOS Safari / 微信内置仍 BLOCKED。
2. **A-11 可访问性（CDP 采样，A-11 仍 partial）**：多个次级标签字号 10–11 CSS px（UX §5.5 要求正文 ≥12px）；`点一个发亮的路口放村庄` 对比度约 3.6:1、`待处理` 4.17、`0 / 8` 4.33、`尚未掷` 4.32（低于 4.5:1）；`#btn-buy-dev` 采样 1.04 疑似 disabled 态，需确认是否豁免。按钮命中区实测最小 44×44、Tab 焦点 `outline: 3px solid` 均已达标。
3. **B03/B04 未造种子态**：掷 7 弃牌与强盗待移动需要 `seed-room --seven` 独立房间，本轮未跑，保持 BLOCKED；建议下一轮用 `--scenario` 之外的单房间补跑，避免污染主场景。

**仍为 BLOCKED 的 14 项**：`UL-B03` `UL-B04`（缺种子态）、`UL-D04` `UL-R01..R06` `UL-UX03/04/06/13`（真机必需，部分已有 Android 证据，见 §5.5）。
> 判定：**gate = CONCERNS（advisory）**。理由：真机必需项仍缺 iOS Safari / 支持 lock 的 Chrome；A-4 真机发现「键盘遮挡加入按钮」未修复；`UL-B03/B04` 未造状态。**不得判 PASS。**

### 4.4 阶段二执行前提（缺一不跑）

1. `engineering-lead` 实现完成并自报 test/typecheck/build 通过；
2. `design-strategist` UX 规格定稿，§2 契约已确认（或明确接受 `INFERRED` 标注）；
3. 主理人显式唤醒；
4. 端口 `9415 / 8793 / 5183` 空闲，独立房间，不带 sharecode，不连线上房间。

---

## 5. 真机手工项与证据三件套

### 5.1 证据三件套（每项缺一不可，缺则 `BLOCKED`）

1. **全程屏幕录制**（含操作时间点、浏览器/系统状态栏可见）；
2. **关键帧截图**（每步：竖屏开页 → 旋转完成 → 指针命中 → 出口/恢复 → 横屏布局），
   截图需能看出 UA / CSS 视口角标（或另附 `viewport` 探针读数）；
3. **服务端日志 / 房间状态**（WELCOME / STATE / 命令计数），用于证明「旋转不发命令、不丢座位、不提交草稿」。

附加记录字段：机型 / 系统版本 / 浏览器包名与版本 / UA / CSS 视口（竖、横）/ dpr /
是否物理转动手机 / 系统自动旋转开关 / `adb reverse` 通道状态（使用前 `adb reverse --list` **只读**确认，
重复执行会重置通道）/ 执行人 / 日期时间。
**只写「看起来正常」不算证据**；截图 + log 必须能逐帧复核。

### 5.2 厂商浏览器的已知取证限制（`docs/16 §1.1`）

- 华为 / 夸克未暴露 `chrome_devtools_remote` → **无法用 CDP 读页面内部值**；
  真机证据只能是 `screencap` + `uiautomator dump` 取精确 bounds + `input tap` 真实触摸 + 服务端日志。
- 历史教训：目测坐标会点偏（(628,1465) 误触 dismiss 边界），**必须用 `uiautomator dump` 取 bounds 算中心**。
- `cmd window user-rotation lock 1` + `set-ignore-orientation-request true` 的强制横屏会产生
  「竖条 + 黑边」的伪横屏，不得据此判定布局通过；CSS 自旋转方案下应优先用**真实用户视角**观测。
- 测完必须恢复设备：`user-rotation lock 0` / `set-ignore-orientation-request false` /
  `fixed-to-user-rotation disabled` / `wm size reset` / `accelerometer_rotation=1`，并清理服务与 reverse 通道。

### 5.3 本会话设备可用性（只读实测，2026-11-08）

| 项 | 只读观测 | 结论 |
|---|---|---|
| ADB | `/opt/homebrew/bin/adb`，设备 `3EY0224402017936` / `ADY_AL00` / Android 12 在线 | **有 1 台 Android 真机** |
| 屏幕状态 | `mWakefulness=Asleep`、`mCurrentRotation=ROTATION_0` | 休眠、竖屏，未唤醒/未操作 |
| 浏览器包 | `com.quark.browser`、`com.huawei.browser`、`com.tencent.mm`（微信）在列；**无 Chrome** | 可覆盖部分厂商 / 微信 Android，无 lock 成功路径 |
| iOS | 无 iPhone、无可用 iOS Simulator（`xcrun simctl` 无设备） | **不具备** |
| CDP 远程 | 厂商浏览器 / 微信 WebView 无 `chrome_devtools_remote` | 真机页面内部值读不到 |
| 本阶段任务 | 明确「只准备、不实跑完整流程」 | **不执行任何真机用例** |

> **判定：真机层整体 `BLOCKED`。** 虽有一台 ADB 可见的华为 Android 设备，但
> ① 阶段一不实跑；② 缺 iOS Safari（本次方案的首要目标）；③ 缺支持 lock 的 Android Chrome；
> ④ 厂商/微信浏览器无 CDP，且设备当前休眠。
> 因此 `UL-R01..R06` **全部 BLOCKED**，不得把这台设备或历史 `docs/16` 的证据写成通用横屏真机通过。
> 阶段二可申请用它补 `UL-R02 / UL-R05 / UL-R06` 的**部分** ADB 证据，仍需 iOS 与 Chrome 补齐。

### 5.5 阶段二真机实测结果（2026-11-08，已执行）

设备：华为 `ADY_AL00` / Android 12 / 1256×2760 @540dpi；浏览器 **Microsoft Edge Android `EdgA/156.0.4314.56`**（Chromium 156）。
方法：`adb reverse tcp:8794` + 单端口服务 + 1 个 Edge 页面 + 3 个 Node WebSocket 补位凑满 4 人自动开局；
页面状态用 Edge CDP 读取（`chrome_devtools_remote` 可用），触摸用 `adb input tap` 与 `Input.dispatchTouchEvent`，截图 `screencap`。
完整原始值见 `probe/phase-d-universal-landscape-device-evidence.json`。

| 项 | 结果 | 关键原始观测 |
|---|---|---|
| **A-3 真实命中** `UL-UX03` | **PASS（仅 Android/Edge 范围，部分判据）** | `mode=css` / `--ul-rotation=90deg`；`adb input tap 892 879` 命中原点视觉中心 → 出现候选消歧 A/B；点 A 后 `picked=["-14549,-19600"]`（精确等于 A，未串到 B）；40 CSS px 拖动只平移相机（`viewBox y -307.22→-211.75`），`picked` 保留、无确认条；三个缩放按钮真机触摸均改变 `viewBox`。未完成摆位提交与双指手感。 |
| **A-4a 输入可用** `UL-UX04` | **PASS（Android/Edge）** | `mode=off`、`#f-name` y=277.6~319.2 完整可见、中文「小满测试」可输入、IME `mInputShown=true`、`visualViewport` 668→342。 |
| **A-4b 完成路径可达** `UL-UX04` | **PASS（Android/Edge，条件：补 enterkeyhint/引导）** | `<form id="join-form">` + `button[type=submit]`；**硬件 Enter**（`input keyevent 66`）在 `#f-name` 内提交成功：URL 变 `?room=qa-ul-dv6&name=回车证据丙`，`/health` 新增 `qa-ul-dv6 players:1 started:false`，`#sheet` 由表单切换为「1 / 4 人在座」等待页；再补 3 个 WS → `players:4 started:true turn:1`，浏览器 `overlayHidden=true / mode=css / --ul-rotation=90deg / phase=setup`（**回车→入房→自动开局→自转全链路成立**）。**纯软键盘路径**同样可用：Gboard 因缺 `enterkeyhint` 两个输入框都显示「下一步」，第 1 次点按焦点移到房间号（「加入」随面板上移可见），第 2 次点按提交成功。**溢出层实测**：`#overlay` 668×668、`overflow:visible`；`.sheet` 373×373、`overflow:visible`；仅聚焦昵称时「加入」bottom 444.2 vs `visualViewport` 342.2，**被键盘盖住 102px 且两层都不可滚动**。后续要求：补 `enterkeyhint`（next/go）+ §1.2.1 引导文案；若 C8 决定做滚动，必须让 `#overlay` 高度跟随 `visualViewport` 并设 `overflow:auto`（或新增滚动包裹层 + `align-items:start`），只改 `.sheet` 无效。 |
| **A-6 安全区** `UL-UX06` | **PARTIAL（Android 无法验证刘海）** | `--ul-safe-*` 四边均 `0px`；HUD/出口矩形均在 372×668 内、无横向滚动。iPhone 刘海/灵动岛与挖孔机仍 BLOCKED。 |
| **A-13 物理转动** `UL-UX13` | **BLOCKED** | 无法让真实用户物理转动手机；未使用任何 ADB 强制旋转，按 docs/17 附录 A R1 不得判 PASS。 |
| 厂商浏览器（夸克/华为） | **本轮未取证** | 两者打开 `http://127.0.0.1:8794` 均显示错误页，服务端无请求；Edge 正常。另检出 `com.android.chrome` 的 devtools socket（Chrome 157），可作下一轮 lock 成功路径补证。 |

截图：`android-07-game-started.png`（自转铺满 + 正立 HUD）、`android-08-vertex-tap.png`（消歧）、
`android-10-after-zoom-drag.png`（缩放/拖动后）、`android-11/12-keyboard*.png`、`android-13-join-chinese.png`。

### 5.4 UX A-3 / A-4 / A-6 / A-13 真机必需项的专门记录要求

| 项 | 设备 / 浏览器 | 必须采集的证据（在三件套之外） | 对应历史缺口 |
|---|---|---|---|
| A-3 `UL-UX03` | iPhone Safari + ≥1 国产内置浏览器 | `uiautomator dump` 取候选点 bounds → `input tap` 真实触摸 → 点 A 不落 B 的候选 ID 对照；>8 CSS px 拖动后无建造；缩放后收 STATE 的 `viewBox` 与选点 ID 前后对照；全程录屏手部可见 | `docs/16` §2 第 10/11 项、指南 §5.2 |
| A-4 `UL-UX04` | iPhone Safari + ≥1 国产内置浏览器，375×667 / 390×844 | 中文软键盘弹出前后输入框 rect / 焦点圈截图；实际输入中文昵称与房间号并成功入房；全程无自转、无转向提示 | **`docs/16` §4 D8（安全区 / 刘海 / 浏览器栏 / 软键盘 / 分享链接内置浏览器）此前 NOT_RUN，本项正面补齐其中键盘与内置浏览器部分** |
| A-6 `UL-UX06` | 有刘海/灵动岛的 iPhone + Android 挖孔机 | 横握后顶栏玩家条 / 房间号与底部「掷骰子/建造/交易/结束回合」四角截图；`viewport-fit=cover` 未被破坏；记录 `env(safe-area-inset-*)` 映射后的视觉边 | `docs/16` §4 D8 的安全区部分 |
| A-13 `UL-UX13` | iPhone Safari + ≥2 种国产内置浏览器（华为/夸克/小米/微信内置） | **用户物理转动手机**（禁用 `cmd window user-rotation` 等 ADB 强制旋转）；记录向左横过来是否自然、是否有人反向转、自转后内容是否正立、亚像素模糊 / 黑边 / 中间竖条；明确标注为**未验证假设**，不写成通过 | `docs/16` §1.3 的强制旋转不是物理转动；`docs/17` 附录 A R1 |

> **禁止**：用 `Emulation.setDeviceMetricsOverride`、CDP 截图、无头 Chrome、jsdom、单测或 ADB 强制旋转
> 去解除上述 4 条的 BLOCKED（指南 §13.1）。CDP 侧可产出 `uxSupplement.cdp` 辅助观测，但**不判 PASS**。
> 另：A-13 涉及「系统方向锁死时前端拿不到用户是否已物理横过来」这一已知取舍，
> 验收只判「一次 + 淡出 + 可关 + 会话记忆」，**不判「提示应自动消失」**。

---

## 6. 覆盖范围 / 不覆盖范围

**本矩阵覆盖**
- 三条能力分支（无 API / API 拒绝 / 锁定成功）与两条防呆分支（假成功、系统横屏但视口竖屏）；
- CSS 自旋转后**真实指针命中**与坐标系反转风险（B 组，本方案最高风险）；
- 入房 / 软键盘 / 开局 STATE 阶段门槛与旋转无副作用；
- 安全区映射、四档视口（390×844、667×375、844×390、932×430）+ 平板 / 桌面；
- 出口不反复弹 / 可恢复 / 不静默失败；
- 既有 387+2 基线、DOM id 对账、相机手势与三档横屏布局回归；
- `docs/17` §7 A-1…A-14 全部 14 条各有专属检查 ID（§3.11），其中 A-1/A-2/A-5/A-12 禁用旧文案 / A-9 恢复 / A-11 可访问性 / A-14 API 剥离等已具备可执行的 CDP 判据；
  A-8 按 §3.1 的 **S0–S8 共 9 态**逐态留痕。

**本矩阵不覆盖（明确排除，不得冒充通过）**
- iOS Safari / 微信内置 / 厂商浏览器的**真实渲染与手感**（→ `UL-R-*` 与 `UL-UX03/04/06/13`，BLOCKED）；
- A-3 真机 `input tap` + `uiautomator dump`、A-4 中文软键盘（补 `docs/16` §4 D8）、A-6 刘海/挖孔/手势条、A-13 用户物理转动手机 —— **CDP 截图、模拟视口、单测一律不得单独判通过**（指南 §13.1）；
- 真机后台电话/语音、锁屏、标签回收、WiFi↔蜂窝切换（→ `phase-d-device-checklist.md` D1~D8，仍 BLOCKED）；
- 服务端权威拒绝、报价竞态与时钟边界（→ `apps/server/test`，指南 13.3 分工）；
- 性能基线 / 帧时间 / 首屏资产（→ 阶段 E `CASE-22`）；
- 完整多人对局到结束（→ `phase-d-browser-verify.mjs --mode=full` / `EXIT-05`）；
- `pnpm test / typecheck / build` 本阶段**禁止运行**（源码在改，结果无意义）。

---

## 7. 阶段二 Runbook 与判定

```bash
# 0) 端口与设备只读确认
lsof -nP -iTCP:9415 -sTCP:LISTEN ; lsof -nP -iTCP:8793 -sTCP:LISTEN ; lsof -nP -iTCP:5183 -sTCP:LISTEN
adb devices -l ; adb reverse --list        # 只读，勿重复执行 adb reverse

# 1) 能力自检复核
node probe/phase-d-universal-landscape-check.mjs --mode=capability-only

# 2) 实现完成后实跑（独立服务 + 独立房间 + 真实指针；8 个能力分支场景 + 共享检查 + UX 裁定）
node probe/phase-d-universal-landscape-check.mjs --mode=full --shots

# 2b) 单场景调试（A-12 ③ / E2 Promise 超时）
node probe/phase-d-universal-landscape-check.mjs --mode=full --scenario=degrade-undistinguishable

# 3) 既有基线回归（由主理人安排，源码稳定后）
node probe/phase-d-landscape-button-check.mjs
pnpm test && pnpm typecheck && pnpm build

# 4) 读报告（含 UX 专属 14 项）
node -e "const r=require('./probe/phase-d-universal-landscape-report.json');console.log(r.summary);console.log(r.checks.filter(c=>c.area==='UX-规格').map(c=>c.id+':'+c.status).join(' '))"
node -e "const r=require('./probe/phase-d-universal-landscape-report.json');console.log(JSON.stringify(r.uxSupplement,null,2).slice(0,4000))"
```

判定流程：
1. 逐项审核 `observed` 原始值（不是只看 PASS 计数），核对 `pointerEvidence` / `scenarioMocks` / `uxSupplement` / `consoleErrors` / `cleanup`；
2. 结合 `design-strategist` UX 规格（含 §3.1 S0–S8 状态表）、`engineering-lead` 全量命令原始输出、真机清单汇总表；
3. quality-lead 出具 **PASS / CONCERNS / FAIL** 建议（**advisory**，最终放行由用户决定）；
4. **任一真机 `UL-R-*` 或真机必需 `UL-UX03/04/06/13` 仍 BLOCKED，或 B 组真实指针命中任一 FAIL，判定不得为 PASS**；
5. 高影响动作（发布签字）必须人工审批；脚本不执行任何 git 写操作。

---

## 8. 参照

- `docs/10-refactor-guide.md` §4.1 / §4.2 / §4.3 / §5.1 / §5.2 / §13.1 / §13.2 / §13.3 / §14
- `docs/17-universal-landscape-ux.md` §1.2 / §2.1 / §2.5 / §3.1 / §4 / §5 / §7（A-1~A-14 可验收条目与状态机；见本计划 §2.1 映射）
- `docs/16-android-device-verification.md` §1.1 / §1.2 / §1.3（历史真机证据、浏览器限制、已踩的坑）
- `probe/phase-d-landscape-button-check.mjs`（9 PASS / 0 FAIL 基线，真实指针 + `elementFromPoint` + 三视口回归）
- `probe/phase-d-browser-verify.mjs` / `probe/phase-d-browser-verify-report.json`（诚信状态机、能力快照、final review）
- `probe/phase-d-verification-plan.md`（既有 114 项矩阵与阶段二 Runbook）
- `probe/phase-d-device-checklist.md`（D1~D8 真机清单与证据三件套）
