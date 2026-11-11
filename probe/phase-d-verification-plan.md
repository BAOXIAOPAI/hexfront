# 阶段 D 逐项复验矩阵（复验标准 → 脚本 / 用例 / 人工项）

> 状态：**阶段一准备文档，不是验收结论。本会话未实跑完整多人对局，未出具 PASS / CONCERNS / FAIL 判定。**
> 用户本轮拍板：验收口径取最严格一档 —— **必须补齐浏览器完整多人对局与真机证据才判定通过**；
> 本环境做不到时只交付代码修复与待办清单，阶段 D 继续如实标记「未通过」；
> **绝不把自动化测试、jsdom 冒烟或模拟视口写成浏览器 / 真机通过**。
> 依据：`docs/15-phase-d-review.md` §4~§9 复验标准、§10 布局收尾、§11 修复顺序、§12 退出条件；
> `docs/10-refactor-guide.md` 8.2 行动矩阵、13.1 设备与视口、13.2 功能与异常用例、13.3 测试分工。
> 配套文件：`probe/phase-d-browser-verify.mjs`（脚本）、
> `probe/phase-d-browser-verify-report.json`（当前为**阶段一能力快照**，非对局报告）、
> `probe/phase-d-device-checklist.md`（真机清单，8 项全部未执行）。

---

## 0. 状态与证据类型约定

### 0.1 状态取值（脚本报告与本文一致）

| 状态 | 含义 | 禁止的写法 |
|---|---|---|
| `PASS` | 实际执行、取得原始观测值、且满足预先写明的判据 | 不得因为「有测试文件」「源码看起来修好了」就写 PASS |
| `FAIL` | 实际执行、观测值与判据不符 | 不得把源码推断写成实测失败 |
| `NOT_RUN` | 本轮未执行到该项 | 不得写成通过；也不得留白 |
| `BLOCKED` | 前置条件缺失（无真机、服务未起、状态造不出来、资源不足） | 不得用浏览器模拟结果解除真机项的 BLOCKED |

**结构性保证**：`phase-d-browser-verify.mjs` 里所有检查项在报告对象构造时
初始状态就是 `NOT_RUN`，只有真正执行并写入 `observed` 才可能变成 `PASS` / `FAIL`。

### 0.2 证据类型

| 标记 | 含义 | 归属 |
|---|---|---|
| **浏览器·真实指针** | CDP `Input.dispatchMouseEvent` / `Input.dispatchTouchEvent` 派发真实 pointerdown→pointerup→click 后读取 UI / `window.__hex.view` / SVG `viewBox` | 本脚本 `full` 模式 |
| **浏览器·真实视口** | `Emulation.setDeviceMetricsOverride` 设置真实 CSS 视口后读 `getComputedStyle` / `getBoundingClientRect`；**不是真机** | 本脚本 `full` 模式 |
| **浏览器·生命周期** | `Page.setWebLifecycleState` 等浏览器级模拟；能测 UI 逻辑，**不能替代真机后台** | 本脚本 `full` 模式 |
| **协议集成** | `apps/server/test/*`、`packages/*/test/*` 的可控时钟 / 竞态 / 越权用例；`seed-room.ts` 只用于**造状态** | engineering-lead / 既有测试 |
| **单测** | engine / protocol / web 纯函数与 DOM 契约断言 | 既有 `pnpm test` |
| **真机人工** | iPhone Safari + 中低端 Android Chrome 实测，见 `phase-d-device-checklist.md` | **本会话无设备** |
| **汇编 / 文档** | 由主理人汇总 test/typecheck/build 数量与状态文档后人工判定 | 主理人 |

> 指南 13.3 测试分工原文：engine 单测 / server 协议测试 / 前端单测 / 浏览器集成 /
> 真机人工 / 性能记录。本矩阵严格按此分工映射，不把下游证据冒充上游证据。

### 0.3 阶段一实测结果（仅浏览器 / CDP 能力，不构成游戏复验结论）

`node probe/phase-d-browser-verify.mjs --mode=capability-only --players=4` 已实跑：

| 能力 | 结果 | 原始观测 |
|---|---|---|
| CDP 连上无头 Chrome | PASS | `Chrome/156.0.8078.80`，Protocol `1.3`，target WebSocket 连通 |
| 真实 CSS 视口 | PASS | 667×375 / 844×390 / 932×430 均 `innerWidth/innerHeight` 精确匹配、`dpr=2`、`landscape=true` |
| computed style | PASS | `getComputedStyle` 返回 `top/left/width/height/zIndex/position`，`getBoundingClientRect` 一致 |
| 真实鼠标指针事件 | PASS | `pointerdown / pointerup / click`，`pointerType=mouse` |
| 真实触屏指针事件 | PASS | `pointerType=touch` 的 down/up + 兼容 click |
| 触屏开关切换后鼠标仍可用 | PASS | 关闭 `setTouchEmulationEnabled` 后鼠标事件链完整 |
| 截图 | PASS | `Page.captureScreenshot` 产出 8587 字节 PNG |
| 多 target（4 个） | PASS | 4 个独立 `page` target 均可独立 `Runtime.evaluate` |

报告当前汇总：**PASS 12 / FAIL 0 / NOT_RUN 89 / BLOCKED 12**，`gate=NOT_CONCLUDED`，
`fullGameExecuted=false`。12 个 PASS = `capability` 区 9 条（`CAP-01..08` + 方法学能力项
`DEV-07`）+ `environment` 区 3 条（`ENV-01..03`）。
**101 条游戏 / 设备 / 矩阵 / 退出条件检查项里 0 条 PASS**（0 FAIL、89 NOT_RUN、12 BLOCKED）；
12 个 BLOCKED 全是真机相关项。按分区：`D-01` 15 NOT_RUN、`D-02` 6、`D-03` 7、
`D-04` 5、`D-05` 5、`D-06` 4+1B、`flow` 10、`matrix` 4、`device-matrix` 5+1B、
`guide-13.2` 21+1B、`real-device` 8B、`exit` 7+1B。

---

## 1. `docs/15-phase-d-review.md` §4 —— D-01 棋盘手势吞掉内部按钮点击

| # | 复验标准（原文摘要） | 脚本检查 ID | 执行方式 / 用例 | 证据类型 | 当前状态 |
|---|---|---|---|---|---|
| 4.1 | 鼠标与触屏均可确认/取消摆位和建造 | `D01-01` `D01-02` `D01-03` `D01-04` `D01-05` `D01-06` | 在 `--setup` 种子房间（协议造状态）用真实指针点 `#board [data-vertex]` → `[data-edge]` → `#confirm-strip [data-confirm=ok/cancel]`，交替 mouse / touch；比对 `buildings` 计数与确认条收起 | 浏览器·真实指针 | NOT_RUN |
| 4.2 | 放大、缩小、回到全局均改变正确的相机状态 | `D01-07` `D01-08` `D01-09` | 真实指针点 `#zoom-in` / `#zoom-out` / `#zoom-reset`，逐次读 `#board` 的 `viewBox` 属性；判据 `vb0≠vb1`、`vb1≠vb2`、`vb3===vb0` | 浏览器·真实指针 | NOT_RUN |
| 4.3 | 弃牌加减/提交、强盗玩家选择均能点击 | `D01-10` `D01-11` | `--seven` 种子房间；真实指针点 `#discard .dp-step`（mouse+touch 混合）读 `.dp-count` / `#discard-ok.disabled`；选地块后点 `#robberbar [data-action=steal]` | 浏览器·真实指针 | NOT_RUN |
| 4.4 | 点击任何浮层按钮不会顺带选择棋盘位置 | `D01-14` | 带热区状态下点 `.cam-tools` 浮层按钮；判据：按钮生效（`viewBox` 变化）+ `#board .hit-vertex.picked` 数量不变 + 确认条不出现 + 建筑数不变 | 浏览器·真实指针 | NOT_RUN |
| 4.5 | 拖动超过阈值后抬手不建造，双指结束后不误选 | `D01-12` `D01-13` | `Input.dispatchMouseEvent` 8 步 >8px 拖动；双指 `touchStart/Move/End` pinch；判据：无确认条、无新增建筑/道路 | 浏览器·真实指针 | NOT_RUN |
| 补充 | D-01 指针序列期间无未捕获异常 | `D01-15` | 收集 `Runtime.exceptionThrown` 与 `console.error` | 浏览器·日志 | NOT_RUN |

> 说明：报告明确指出「其余舞台内按钮属于同一风险范围，应逐一复验，不能直接写成全部已实测失败」。
> 本矩阵把 4.1/4.3 拆成逐按钮用例，不合并成一条「已测」。

---

## 2. §5 —— D-02 摆位提示框被拉伸（含 §10 布局收尾）

| # | 复验标准 | 脚本检查 ID | 执行方式 / 用例 | 证据类型 | 当前状态 |
|---|---|---|---|---|---|
| 5.1 | 667×375 / 844×390 / 932×430 横屏中提示为紧凑条，不形成纵向遮挡 | `D02-01` `D02-02` `D02-03` | 每个视口各自 `setDeviceMetricsOverride`；读 `#setupbar` / `#robberbar` / `#discard` 的 computed `top / bottom / height / width / z-index / position` 与 `getBoundingClientRect`；判据（预先写明）：可见面板高度 ≤ 视口高 50%、不覆盖视口中心、无 `top` 与 `bottom` 同时非 auto 的冲突拉伸、矩形在视口内 | 浏览器·真实视口 | NOT_RUN |
| 5.2 | 摆位 / 强盗 / 弃牌 / 建造确认同时按预期层级呈现，不遮住所需目标 | `D02-04` | 三个种子状态（setup / seven / robber）分别采集四面板 `zIndex` 与矩形交叠；判据：所需目标矩形不被更高层面板覆盖 | 浏览器·真实视口 | NOT_RUN |
| 5.3 | 页面初次动画结束后与后续 STATE 更新后布局一致 | `D02-05` | 同一视口先等入场动画结束采一份，再让第二名玩家入房触发 `sync` 广播采第二份；逐面板比对 computed 值与矩形（±1px） | 浏览器·真实视口 | NOT_RUN |
| §10.1 | 长房间号 / 长昵称 / 4 位玩家 / 大资源数量下顶栏、资源卡、底部按钮文字完整可读 | `D02-06` | 24 字符房间号、16 字符昵称、4 人、`--rounds` 造大资源；读顶栏/按钮矩形与 `scrollWidth`，检查文字换行与溢出 | 浏览器·真实视口 | NOT_RUN |
| §10.2 | 小横屏、竖屏、桌面及安全区按 13.1 矩阵执行 | `DEV-01` `DEV-03` `DEV-04` `DEV-05` | 见本文 §7 | 浏览器·真实视口 + 真机 | NOT_RUN |

> 报告原始缺陷读数：844×390 下 `setupbar` `top=8px / bottom=14px / height=324px / width=228px`。
> 判据里「高度 ≤ 50% 视口」即针对该 324/390≈83% 的拉伸；`conflictingInsets` 单独记录
> 「新 top 与旧 bottom 同时生效」，避免只验证新文件里一条规则就宣布通过。
> **面板不可见时不判 PASS**：脚本会返回 `measuredPanels`，若为空则该视口标 `NOT_RUN`。

---

## 3. §6 —— D-03 骑士与筑路选择丢失

| # | 复验标准 | 脚本检查 ID | 执行方式 / 用例 | 证据类型 | 当前状态 |
|---|---|---|---|---|---|
| 6.1 | 骑士选点后保留地块，进入合法抽牌对象选择，并能成功提交 | `D03-01` `D03-03` | 真实指针：`#rail-actions [data-panel=knight]` → `[data-act=knight-pick]` → `#board [data-tile]` → 读 `#drawer-body .d-panel h4` 是否「已选地块 X」（第二步）→ 点 `[data-act=knight-steal]` 提交 | 浏览器·真实指针 | NOT_RUN |
| 6.2 | 抽牌对象只包含所选地块相邻且有牌的玩家；无合法目标时正确处理 | `D03-02` | 读第二步 `knight-steal` chips 的 `data-val` 与标签（含手牌数），核对不含自己、不含 0 张玩家，且存在「不抽牌」选项 | 浏览器·真实指针 | NOT_RUN |
| 6.3 | 筑路保留所选道路，第二条候选基于假设第一条的合法状态计算 | `D03-04` `D03-05` | `roads` 面板 → 选 1 条边 → 读 h4「已选 N 条路」（原缺陷为「已选 0 条路」）；再选第 2 条，核对候选边集合排除已占用边 | 浏览器·真实指针 | NOT_RUN |
| 6.4 | 一条/两条提交、取消、广播更新、再次打开均有确定结果 | `D03-06` | 确认条「只要一条，提交」分支 + 取消 + 收到 STATE 后重开面板，逐次记录标题/计数/按钮 | 浏览器·真实指针 | NOT_RUN |
| 6.5 | 用真实 UI 完成至少一次骑士和一次筑路，不仅验证面板能打开 | `D03-07` | 6.1 + 6.3 均实际提交成功才算 PASS | 浏览器·真实指针 | NOT_RUN |

> 前提：需要手上有可打出的骑士/筑路卡。脚本在资源不足时对该组标 `BLOCKED` 并写明原因，
> **不会**用「面板能打开」代替「操作能完成」。阶段二可用 `--serve` + `seed-room.ts` 造含发展卡的手牌。

---

## 4. §7 —— D-04 强盗待移动时无法切换为建造选点

| # | 复验标准 | 脚本检查 ID | 执行方式 / 用例 | 证据类型 | 当前状态 |
|---|---|---|---|---|---|
| 7.1 | 弃牌完成后先建路/村/城可以正常选点并提交 | `D04-01` | `--seven` 种子房间全员弃完、`pendingRobber=true` 时，真实指针点 `#btn-build` → 选热区 → 确认；读 `buildings/roads` 变化 | 浏览器·真实指针 | NOT_RUN |
| 7.2 | 可暂时交易/兑换，再返回强盗任务 | `D04-02` | 同一状态下打开交易/兑换抽屉再关闭，确认仍能点棋盘地块移动强盗（强盗待办未被模式切换清除） | 浏览器·真实指针 | NOT_RUN |
| 7.3 | 强盗未处理不能结束回合或使用发展卡 | `D04-03` | 读 `#btn-end` / `#btn-buy-dev` / `[data-panel=knight]` 的 `disabled` 与 `#blocked-reason` 文案；服务端拒绝由 `apps/server/test` 的 `ROBBER_PENDING` 用例补证 | 浏览器·真实指针 + 协议集成 | NOT_RUN |
| 7.4 | 所有人尚未弃完时，以上资源变更仍由服务端拒绝 | `D04-04` `MATRIX-2` `CASE-11` | 浏览器侧记录建造/交易/兑换/发展卡禁用状态；**服务端权威拒绝**必须由 server 测试（可控时钟、越权命令）证明，不能用 UI 禁用代替 | 浏览器·真实指针 + 协议集成 | NOT_RUN |
| 补充 | 可在 UI 完成「移动强盗」两步 | `D04-05` | 真实指针选 `#board [data-tile]` → 点 `#robberbar [data-action=steal]`（触屏），读 `pendingRobber` 归 false | 浏览器·真实指针 | NOT_RUN |

---

## 5. §8 —— D-05 报价冷却控件未更新

| # | 复验标准 | 脚本检查 ID | 执行方式 / 用例 | 证据类型 | 当前状态 |
|---|---|---|---|---|---|
| 8.1 | 发送后显示冷却倒计时且不可重复发送 | `D05-01` | 真实指针编辑 `#trade .tp-step` 并点 `#trade-send`；打开 `#offer` 抽屉读 `#offer-send` 的 `textContent` 与 `disabled`；判据：文案含「发送冷却」且 `disabled===true`。同时记录按钮实际位于 `#drawer-foot` 还是 `#drawer-body`（原缺陷是 `tick()` 在 `drawerBody` 里找不到按钮） | 浏览器·真实指针 | NOT_RUN |
| 8.2 | 冷却期间草稿可编辑；结束后仅合法非空报价可发送 | `D05-02` | 冷却中点 `.d-chip` 加减观察草稿变化而按钮仍禁用；3.4s 后读文案恢复「发送报价」且 `disabled===false`；空报价仍禁用 | 浏览器·真实指针 | NOT_RUN |
| 8.3 | 断线、弃牌锁、回合变化后按钮状态及时更新 | `D05-03` | 分别在 `visibilitychange` / `--seven` 弃牌锁 / `END_TURN` 后读按钮状态 | 浏览器·生命周期 + 真实指针 | NOT_RUN |
| 8.4 | 刷新/重连不能绕过服务端冷却 | `D05-04` | 页面 `Page.navigate` 重载后再读 `nextSendAt` 与按钮；服务端权威由 `CASE-03` 的可控时钟用例证明 | 浏览器 + 协议集成 | NOT_RUN |
| 8.5 | 到期、替换或清除报价后，不让另一条接受按钮顶到手指下造成误点 | `D05-05` `CASE-16` | 两条并存报价 → 让第一条过期/撤回 → 读 `.d-card` 顺序与 `[data-act=accept]` 的 `getBoundingClientRect`，确认详情变「已过期」、原按钮禁用、不自动切到下一条 | 浏览器·真实指针 + 真机人工 | NOT_RUN |

> 报告特别注明「最后一项是既定指南的回归要求，本次未完成其浏览器并发验证」。
> 因此本行不能因为单测通过就写成 PASS。

---

## 6. §9 —— D-06 前台恢复缺少状态核对

| # | 复验标准 | 脚本检查 ID | 执行方式 / 用例 | 证据类型 | 当前状态 |
|---|---|---|---|---|---|
| 9.1 | 切后台再回前台，取得当前权威视图和未过期报价 | `D06-01` | 浏览器级 `Page.setWebLifecycleState frozen→active`，读 `document.visibilityState`、`#feed-text`、`shell[data-connected]`、`window.__hex.view` 与报价横幅；**明确标注这是浏览器生命周期模拟，不是真机后台** | 浏览器·生命周期 | NOT_RUN |
| 9.2 | 网络切换或半开连接不永久停在「正在核对」 | `D06-02` | 同上超时观察；真机半开连接须由 `REAL-04` 验证 | 浏览器·生命周期 + 真机人工 | NOT_RUN |
| 9.3 | 提交后确认前断线，回来能核对结果，不重复执行 | `D06-03` `CASE-17` | 浏览器侧观察「正在核对结果，不会自动重发」提示；**不重复成交**由 server 竞态用例（命令计数）证明 | 浏览器 + 协议集成 | NOT_RUN |
| 9.4 | 后台超过 10 秒的报价正确过期 | `D06-04` `D7` | 浏览器冻结 ≥11s 后读 OFFERS 快照 `expiresAt`/「已过期」；真机由清单 D7 验证 | 浏览器·生命周期 + 真机人工 | NOT_RUN |
| 9.5 | 真机后台电话/语音房、锁屏和标签回收后重开均有记录 | `D06-05` `REAL-01..05` `EXIT-06` | `phase-d-device-checklist.md` D1~D5 | **真机人工** | **BLOCKED（本会话无真机设备）** |

---

## 7. `docs/10-refactor-guide.md` 8.2 已确认的行动矩阵

矩阵优先级高于 UI 推断：服务端必须在「有人尚未弃牌」与「强盗待移动」两态下**权威拒绝**，
不能只靠前端禁用按钮（指南 8.2 原文与 `15 §7` 复验④一致）。

| 状态 | 弃牌 | 建造/银行/借港 | 玩家交易 | 发展卡 | 结束回合 | 脚本 ID | 证据类型 | 当前状态 |
|---|---|---|---|---|---|---|---|---|
| 普通行动 | 不适用 | 当前玩家可做 | 至少一方为当前玩家 | 按原规则 | 已掷骰才可 | `MATRIX-1` | 浏览器 + 协议集成 | NOT_RUN |
| 有人尚未弃牌 | 仅需要弃牌者 | 暂停 | 不能创建或接受 | 暂停 | 禁止 | `MATRIX-2` `D04-04` `CASE-11` | 浏览器 + 协议集成 | NOT_RUN |
| 弃完，强盗待移动 | 不适用 | 当前玩家可做 | 恢复，受冷却约束 | 禁用 | 禁止 | `MATRIX-3` `D04-01..03` `CASE-12` | 浏览器 + 协议集成 | NOT_RUN |
| 强盗已处理 | 不适用 | 正常 | 正常 | 正常 | 按原规则 | `MATRIX-4` `D04-05` | 浏览器 + 协议集成 | NOT_RUN |

脚本实现：用 `seed-room.ts <room> N --seven` **造状态**（协议命令，允许），
再由浏览器**真实指针**完成弃牌加减/提交、建造入口、交易抽屉、强盗选地块与选玩家；
每一步读 `window.__hex.view.pendingDiscards / pendingRobber` 与各按钮 `disabled`、
`#blocked-reason`、`#situation` 文案作为原始观测值。
服务端拒绝部分仍须由 `apps/server/test`（`contract-actions` / `contract-offers` 等）证明。

---

## 8. `docs/10-refactor-guide.md` 13.1 设备与视口矩阵

| 场景 | 建议尺寸 | 重点 | 脚本 ID | 证据类型 | 当前状态 |
|---|---|---|---|---|---|
| 小横屏 | 667×375 CSS px | 操作栏高度、抽屉滚动、确认位置 | `DEV-01` `D02-01` | 浏览器·真实视口 | NOT_RUN |
| 常见横屏 | 844×390、932×430 | 安全区、棋盘精度、报价列表 | `DEV-02` `D02-02` `D02-03` | 浏览器·真实视口 | NOT_RUN |
| 竖屏 | 375×667、390×844 | 入房、等待、旋转提示、键盘 | `DEV-03` `CASE-19` | 浏览器·真实视口 + 真机人工 | NOT_RUN |
| 平板 | 1024×768 附近 | 布局过渡、面板宽度 | `DEV-04` | 浏览器·真实视口 | NOT_RUN |
| 桌面 | 1366×768、1440×900 | 鼠标、键盘、焦点与宽屏信息展开 | `DEV-05` | 浏览器·真实视口 | NOT_RUN |
| 真机 | 至少 1 台 iPhone + 1 台中低端 Android | 双指、后台语音、网络切换、可读性 | `DEV-06` `REAL-06` `REAL-08` | **真机人工** | **BLOCKED（无设备）** |
| 说明 | — | 模拟视口不是实机替代；自动化须核对实际 viewport 与 CSS 像素，不能只设浏览器外窗大小 | `DEV-07` | 浏览器/CDP（方法学能力） | **PASS（阶段一能力实测）** |

> `DEV-07` 在脚本里归入 `capability` 区，PASS 仅表示「脚本确实读取了页面内
> `innerWidth/innerHeight/dpr` 并与请求一致」这一**方法学能力**，
> **不等于**任何设备视口下的布局或手感已通过；`DEV-01..06` 仍为 NOT_RUN / BLOCKED。

---

## 9. `docs/10-refactor-guide.md` 13.2 功能与异常用例（21 条 + 13.3 性能）

| # | 用例（原文摘要） | 脚本 ID | 执行方式 / 用例 | 证据类型 | 当前状态 |
|---|---|---|---|---|---|
| 1 | 非当前玩家可报价给当前玩家，不能给其他非当前玩家 | `CASE-01` | `offerTargets` 的协议权限用例 + 浏览器里非当前玩家打开报价抽屉读可选对象 | 协议集成 + 浏览器 | NOT_RUN |
| 2 | A/B/C 同时报价并存、不互相覆盖；每人最多一条 | `CASE-02` | server 多报价并存用例（可控时钟）+ 浏览器列表显示 3 条 | 协议集成 + 浏览器 | NOT_RUN |
| 3 | 3 秒内重复发送被服务端拒绝；刷新/重连不绕过冷却 | `CASE-03` `D05-04` | server 冷却/`nextSendAt` 用例 + 浏览器重载后按钮状态 | 协议集成 + 浏览器 | NOT_RUN |
| 4 | 冷却后重发生成新 ID，旧 ID 不可接受，10 秒重新开始 | `CASE-04` | server 用例：新 ID、旧 ID `OFFER_NOT_FOUND/OFFER_REPLACED`、`expiresAt` 重置 | 协议集成 | NOT_RUN |
| 5 | 报价到期边界、慢时钟、清理延迟时均不能误成交 | `CASE-05` | server 可控时钟边界用例（不用真实等待） | 协议集成 | NOT_RUN |
| 6 | 接受与掷 7、回合结束、本人重发交错时只执行正确结果 | `CASE-06` | server 并发/交错用例 | 协议集成 | NOT_RUN |
| 7 | 两条报价争用资源时不出现负数或重复扣减 | `CASE-07` | engine/server 资源结算用例 | 协议集成 | NOT_RUN |
| 8 | 赠予与索取可提交，空换空不可提交；收件人视角正确 | `CASE-08` | `offerPerspective` 单测 + 浏览器收件人视角文案 | 单测 + 协议集成 + 浏览器 | NOT_RUN |
| 9 | 掷 7 清空全部报价，所有人弃完前不能报价或成交 | `CASE-09` `FLOW-08` | `--seven` 场景读 OFFERS 快照清空 + 弃牌锁期间发送被拒 | 浏览器 + 协议集成 | NOT_RUN |
| 10 | 9 张弃 5 张，玩家自行选择；他人不知道弃牌构成 | `CASE-10` `D01-10` | `--seven` 场景读 `pendingDiscards` 计数、`#discard .dp-count`；他人视图只显示「等待弃牌」 | 浏览器 + 协议集成 | NOT_RUN |
| 11 | 有人尚未弃牌时，建造/交易/兑换/发展卡均被服务端拒绝 | `CASE-11` `MATRIX-2` | 同 §7 第 2 行；**必须有 server REJECT 证据** | 协议集成 + 浏览器 | NOT_RUN |
| 12 | 所有人弃牌后可建造/交易/兑换，强盗未处理不能结束回合或使用发展卡；强盗完成后恢复 | `CASE-12` `MATRIX-3/4` | 同 §7 第 3、4 行 | 浏览器 + 协议集成 | NOT_RUN |
| 13 | 缩放、平移时收到 STATE，不回到初始镜头、不触发误建造 | `CASE-13` `D01-07..09` | 缩放后让另一玩家触发广播，再读 `viewBox` 与建筑数 | 浏览器·真实指针 | NOT_RUN |
| 14 | 建造确认前收到他人更新，失效候选被撤销并说明原因 | `CASE-14` | 预览态触发 STATE，读确认条收起与 toast 文案（`recheckPending`） | 浏览器·真实指针 | NOT_RUN |
| 15 | 买发展卡、四种行动卡、银行、借港均有可用入口和失败提示 | `CASE-15` `FLOW-06` `FLOW-07` | 真实指针逐个打开面板并读 `#drawer-foot` / 拒绝 toast | 浏览器·真实指针 | NOT_RUN |
| 16 | 长报价过期后接受按钮不会移动到下一条并造成误点 | `CASE-16` `D05-05` | 同 §5 第 5 行；含真机手指下误点验证 | 浏览器 + 真机人工 | NOT_RUN |
| 17 | 网络在提交前/后分别中断，不静默丢操作、不重复成交 | `CASE-17` `D06-03` | server 竞态 + 浏览器「正在核对结果」提示 + 真机 D4 | 协议集成 + 浏览器 + 真机人工 | NOT_RUN |
| 18 | 电话/语音后台返回后，资源、当前玩家、强盗任务、报价与服务端一致 | `CASE-18` `REAL-01/02` | 清单 D1 / D2 | **真机人工** | **BLOCKED（无设备）** |
| 19 | 横竖屏切换不丢座位，不提交草稿，不无限弹提示 | `CASE-19` `DEV-03` | 浏览器 `setDeviceMetricsOverride` 横竖切换 + 真机旋转 | 浏览器·真实视口 + 真机人工 | NOT_RUN |
| 20 | 帮助可点击，焦点可见；不靠 hover/颜色/声音传递唯一信息 | `CASE-20` | 真实指针点 `#btn-help`，读焦点与静态文案 | 浏览器·真实指针 | NOT_RUN |
| 21 | 减少动态效果时仍能理解产出、成交、建造与轮次变化 | `CASE-21` | 点 `#btn-motion` 后读 `data-reduce-motion` 与静态高亮/文字 | 浏览器·真实指针 | NOT_RUN |
| 13.3 | 性能记录：交互反馈、拖动帧时间、长任务、首屏资产大小先记基线 | `CASE-22` | 阶段 E 性能采样；本轮只保留占位，不填数值 | 浏览器·性能采样 | NOT_RUN |

> 指南 13.3 明确「engine 单测 / server 协议测试 / 前端单测」分别承担规则与竞态；
> `CASE-01..08`、`CASE-11`、`CASE-17` 主要不是浏览器脚本能证明的，脚本里保持
> `NOT_RUN` 并注明归属，**不会用浏览器结果冒充协议集成结论**。

---

## 10. `docs/15-phase-d-review.md` §12 D 再验收退出条件

| # | 退出条件 | 脚本 ID | 判定责任 / 证据 | 证据类型 | 当前状态 |
|---|---|---|---|---|---|
| 1 | D-01 至 D-06 有修复及对应复验结果 | `EXIT-01` | 主理人汇编：engineering-lead 的修复 + 本文 §1~§6 全部复验结果 | 汇编 | NOT_RUN |
| 2 | 真实指针事件覆盖摆位确认、建造确认、缩放、弃牌、强盗按钮 | `EXIT-02` | `D01-01/02/05/06` + `FLOW-05` + `D01-07..11` 的 `pointerEvidence` | 浏览器·真实指针 | NOT_RUN |
| 3 | 两个以上浏览器玩家完成入房、开局、摆位、交易、建造、兑换和发展卡使用 | `EXIT-03` | `FLOW-01..07` 全部实测（≥2 个独立 CDP target） | 浏览器·真实指针 | NOT_RUN |
| 4 | 浏览器验证掷 7 的完整行动矩阵及报价清空 | `EXIT-04` | `FLOW-08` + §7 四个 `MATRIX-*` + `CASE-09` | 浏览器 + 协议集成 | NOT_RUN |
| 5 | 浏览器完整对局到结束；如尚未完成，状态继续标记「未通过完整对局验收」 | `EXIT-05` `FLOW-09` | `--mode=full` 有界尝试（`--max-turns`）直到 `phase=ended`；**未跑到就保持 NOT_RUN，绝不写 PASS** | 浏览器·真实指针 | NOT_RUN |
| 6 | 手机后台与手势测试结果单独记录；没有真机证据不得写成真机通过 | `EXIT-06` | `phase-d-device-checklist.md` 汇总表 8 项 | **真机人工 + 汇编** | **BLOCKED（无设备）** |
| 7 | test/typecheck/build 通过，实际数量与已知 todo 如实记录 | `EXIT-07` | engineering-lead 提供 `pnpm test` / `typecheck` / `build` 原始输出与数量 | 单测 + 构建 | NOT_RUN（阶段一禁止运行全量命令） |
| 8 | 状态文档区分实现、浏览器验收、真机验收和发布，避免「已完成」混用 | `EXIT-08` | 主理人更新 `docs/08-status.md` 等状态文档 | 文档 | NOT_RUN |

### §11 推荐修复顺序（用于阶段二排期，不是结论）

1. D-01 / D-02（看得见、点得着）→ 2. D-03 / D-04（发展卡闭环与强盗待办期间建造）
→ 3. D-05 / D-06（报价反馈与恢复链路）→ 4. 横屏布局收尾
→ 5. **多玩家真实浏览器主流程** → 6. 真机记录与状态文档更新。
阶段二复验必须等 engineering-lead 全部修复完成再一次性实跑，避免把中间态的
失败结果当成最终结论。

---

## 11. 完整链路（§12③）与脚本覆盖边界

### 11.1 `--mode=full` 会真实指针执行的链路

```
起独立服务（HOST=127.0.0.1、独立端口、独立 qa-dv-* 房间、不带 sharecode）
  → 2~4 个独立 CDP target 打开 ?name=甲/乙/丙/丁&room=...
  → 入房（URL 分享链接语义）→ 点「开始游戏」或满员自动开局
  → 摆位 4 次：真实指针点 [data-vertex] → [data-edge] → [data-confirm=ok]
  → 交易：#btn-trade → .tp-step 编辑 → #trade-send → 对方 #offer → 接受
  → 建造：#btn-build → .bp-item → 棋盘热区 → [data-confirm=ok]
  → 兑换：#rail-actions [data-panel=bank|port]
  → 发展卡：#btn-buy-dev → 骑士 / 筑路选点两步
  → 掷 7 行动矩阵：seed-room --seven 造状态 → 真实指针弃牌加减/提交
      → 建造/交易恢复 → 发展卡/结束回合禁用 → 选地块 + 选玩家移动强盗
  → 有界循环（--max-turns）尝试打到 phase=ended
  → 三视口布局采集 → 收集 console error → 关闭服务 / target / Chrome / profile
```

**硬约束**：浏览器端动作全部经 `Input.dispatchMouseEvent` / `Input.dispatchTouchEvent`
派发真实指针事件；`Runtime.evaluate` 只用于**读** `window.__hex.view`、DOM、
computed style、`viewBox`，**不用于触发界面逻辑、不调用 `client.command()`**。
`seed-room.ts` 仅用于协议造初始状态，并在报告 `seededStates` 里标注。

### 11.2 脚本能覆盖 / 不能覆盖（阶段二交接必须如实说明）

| 能覆盖 | 不能覆盖（须另行补证） |
|---|---|
| 真实指针点击是否生效（D-01 核心） | 真机后台电话/语音、锁屏、标签回收、网络切换、双指手感（→ 清单 D1~D8，BLOCKED） |
| 三个真实 CSS 视口下 computed 布局与遮挡（D-02） | 真机安全区/刘海/软键盘/内置浏览器（→ D8） |
| 骑士/筑路第二步、筑路计数（D-03 可观察结果） | 服务端权威拒绝、报价竞态与时钟边界（→ `apps/server/test`，指南 13.3） |
| 弃牌/强盗/报价冷却的 UI 可观察结果（D-04/05） | 完整对局必胜局面的构造（有界循环，跑不到就保持 NOT_RUN） |
| 浏览器生命周期模拟的前台恢复（D-06 部分） | 「半开连接」「重复成交」的传输层证明（→ 协议集成 + 真机 D4） |
| 完整多人链路的执行轨迹与 console error | 性能基线、帧时间、长任务（→ 阶段 E，`CASE-22`） |
| 自动清理（服务 / target / Chrome / 临时 profile） | `pnpm test/typecheck/build` 数量与 todo（→ engineering-lead） |
| 状态文档的四态区分（→ 主理人） | 质量门最终判定（→ quality-lead + 用户，脚本 `gate=NOT_CONCLUDED`） |

---

## 12. 阶段二执行 Runbook（engineering-lead 修复完成后）

```bash
cd /Users/baoxiaopai/Project/卡坦岛线上桌游

# 0) 确认端口空闲、不碰用户现有服务（8787 上已有 node 进程）
lsof -nP -iTCP:8791 -sTCP:LISTEN          # 应为空
lsof -nP -iTCP:5181 -sTCP:LISTEN          # 应为空
lsof -nP -iTCP:9411 -sTCP:LISTEN          # 应为空

# 1) 阶段一能力快照复核（可选，秒级，不起服务）
node probe/phase-d-browser-verify.mjs --mode=capability-only --players=4

# 2) 阶段二完整实跑（起独立 127.0.0.1 服务 + 多浏览器玩家 + 真实指针）
node probe/phase-d-browser-verify.mjs --mode=full --players=4 --shots --max-turns=60

# 3) 查看报告（脚本会覆盖 phase-d-browser-verify-report.json）
node -e "const r=require('./probe/phase-d-browser-verify-report.json');console.log(r.summary)"

# 4) 真机（本会话无设备；安排真机试玩时按清单执行）
#    open probe/phase-d-device-checklist.md
```

环境变量可覆盖：`HEXFRONT_CHROME`、`--cdp-port=`、`--backend-port=`、`--vite-port=`、
`--players=`、`--room=`、`--serve=vite|dist`、`--shots`、`--keep-profile`（调试用）。
`--serve=vite` 直接跑当前源码（无需 build，避免验证到旧 `apps/web/dist`）；
`--serve=dist` 只用于对照预构建产物，报告会明确标注可能不是最新源码。

### 阶段二产出与判定流程

1. 脚本输出 `probe/phase-d-browser-verify-report.json`（`reportScope=PHASE2_FULL_RUN`），
   每项带 `observed` / `expected` / `notes` / `status`。
2. quality-lead 逐项审核原始观测值（不是只看 PASS 计数），核对
   `pointerEvidence` / `layout` / `consoleErrors` / `seededStates`。
3. 结合 engineering-lead 的 test/typecheck/build 原始输出、真机清单汇总表，
   出具 **PASS / CONCERNS / FAIL** 判定与质量门建议（advisory，最终放行由用户决定）。
4. 若「浏览器完整对局到结束」或「真机证据」任一缺失：**判定不得为 PASS**，
   阶段 D 继续如实标记「未通过」，并列出剩余待办。
5. 高影响动作（发布签字）必须人工审批；本脚本不执行任何 git 写操作、不碰 `release/`、
   不连接线上房间、不修改用户目录文件。

---

## 13. 阶段一交付物清单

| 文件 | 内容 | 是否实跑 |
|---|---|---|
| `probe/phase-d-browser-verify.mjs` | 浏览器/CDP 复验脚本（capability-only / full 双模式），约 1970 行、113 个检查项，含真实指针辅助与诚信状态机（初始全 NOT_RUN） | 语法检查通过；`capability-only` 已实跑 |
| `probe/phase-d-browser-verify-report.json` | **阶段一能力快照**（`reportScope=PHASE1_CAPABILITY_SNAPSHOT`）：12 PASS（能力/隔离）/ 89 NOT_RUN / 12 BLOCKED，`gate=NOT_CONCLUDED` | 已生成；阶段二 `--mode=full` 会覆盖 |
| `probe/phase-d-device-checklist.md` | iPhone Safari / 中低端 Android Chrome 的 8 项真机用例、记录方式、证据要求；8 项全部标注「本会话无真机设备，未执行」 | 未执行（文档） |
| `probe/phase-d-verification-plan.md` | 本文件：§4~§9 每条复验标准、§12 每条退出条件、指南 8.2 / 13.1 / 13.2 全部关键项 → 脚本 ID / 用例 / 人工项 / 证据类型映射 | 未执行（文档） |

**阶段一不下结论**：未实跑完整对局、未出具 PASS/CONCERNS/FAIL 判定。
阶段 D 继续如实标记「未通过」，等待 engineering-lead 修复完成后唤醒执行阶段二。
