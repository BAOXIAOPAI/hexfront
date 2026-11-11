# 阶段 D 通用横屏交付与放行记录

> 日期：2026-11-09（Asia/Shanghai）
> 决策：**阶段 D 放行（用户于 2026-11-09 明确判定）**，同时**完整保留真实的未测试口径**。
> 放行 ≠ 全部验证通过。本文第 4 节逐条列出确实没测、没取证、没复跑的项，不因放行而删除或改写。
> 历史判定链：`15` §13 与 `probe/phase-d-browser-verify-report.json` 判 FAIL（11-07）→ 通用横屏复跑 `gate=CONCERNS`（11-08，advisory）→ **用户决策放行（11-09）**。历史快照一律保留原文，不追溯改判。
> **2026-11-09 放行后补验**：按文末交接语从 §4 开工，新增 §4.7 记录复跑（55/1/42/16）、26 条单测、终局复验（6/6）与 D01-09 根因；**4.1–4.6 历史快照与所有历史报告文件原样保留**。补验只消除「本环境可补」的缺口，4.4 的真机 / 目标浏览器未取证、`FLOW-09` 的 4 浏览器页面全 UI 完整对局仍保持原状。
> 依据文档：[`15`](./15-phase-d-review.md) · [`16`](./16-android-device-verification.md) · [`17`](./17-universal-landscape-ux.md) · `probe/phase-d-universal-landscape-*.{md,mjs,json}`

---

## 1. 本次交付范围与方案

**用户诉求**：实际玩家不会特意安装/使用 Chrome，浏览器就是 iOS Safari 或其他手机自带浏览器，要求「做一个比较通用的」横屏；打开网站就应该横过来，而不是弹卡片让人自己转。

**已拍板方案**：CSS 自旋转 + 系统方向锁定渐进增强。

- 竖屏对局时网页自己把整个界面 `rotate(90deg)` 铺成横屏画布，**不依赖任何浏览器 API**；
- 支持 `screen.orientation.lock` 的浏览器仍优先请求系统横屏（体验更好），失败/不支持/超时则自动落回自旋转；
- 系统方向被锁死时，用户把手机物理横过来内容正好正着显示——这是绕开 iOS Safari、微信内置、厂商浏览器限制的关键。

**不通用之路已被实测排除**：`cmd window user-rotation` 强制系统旋转时，华为浏览器把网页压成中间竖条；夸克拒绝 `screen.orientation.lock`；iOS Safari 根本没有该 API、iPhone 上 `requestFullscreen` 也不可用。详见 `16` §1.1/§1.3。

---

## 2. 放行依据（只列已验证的部分）

| 项 | 结果 | 来源 |
|---|---|---|
| 全量测试 | **435 passed + 2 todo**，0 failed（engine 139+2 / protocol 20 / server 62 / web **214**，18 files） | 主理人 2026-11-09 独立实跑 `pnpm test` |
| 类型检查 | 4 包 `tsc --noEmit` 全 Done | 同上 `pnpm typecheck` |
| 构建 | `vite build` ✓ 34 modules；`dist/index.html` 9.69 kB、CSS 43.71 kB、JS 105.98 kB；`server.cjs` 193.3 KB | 同上 `pnpm build`（产物 `index-BeCU9yk5.js` / `index-CxoW2zG1.css`） |
| 跨浏览器 CDP 复跑 | **44 PASS / 0 FAIL / 23 NOT_RUN / 14 BLOCKED**，共 81，`fullModeExecuted=true`，`gate=CONCERNS`（quality-lead advisory） | `probe/phase-d-universal-landscape-report.json`，2026-11-08T12:27:52Z |
| 能力快照 | 13 PASS / 0 FAIL / 58 NOT_RUN / 10 BLOCKED，`gate=NOT_CONCLUDED`（明确不是验收结论） | `probe/phase-d-universal-landscape-capability-report.json` |
| 真机（Android Edge） | 自转后真实触摸命中精确（点 A 候选不串 B）、40 CSS px 拖动只平移相机不误建造、三个缩放按钮均改变 `viewBox` | `probe/phase-d-universal-landscape-device-evidence.json` + `android-07..25-*.png` |
| 真机全链路 | 「回车 → 入房 → 4 人自动开局 → 自转 S2 生效」成立；纯软键盘两次「下一步」也可提交 | 同上，`enterSubmits: true` |
| 两个实跑缺陷 | ① 转向提示复活（`UL-UX09`）修复后 PASS；② `enterkeyhint`（`#f-name=next` / `#f-room=go`）与引导文案已在 `ui.ts:322/326/331` 落地 | 源码核对 + `UL-UX09` 状态 |

**质量门性质**：严格口径下自动化复跑给的是 **CONCERNS**（不放行建议）。本次放行是**用户行使决策权**，不是把 CONCERNS 改写成 PASS；放行后第 4 节全部条目依然成立。

---

## 3. 判定

> **阶段 D：放行（用户决策，2026-11-09）。**
> 判定依据：已验证部分无实现性回归、两个实跑真实缺陷已修复/落地、全量测试与构建通过；用户接受第 4 节列出的未测试项作为已知边界。
> **本判定不改变任何自动化报告里的状态值**：`15` §13 的 FAIL 历史快照、`probe/phase-d-browser-verify-report.json` 的 `gate=FAIL`、`probe/phase-d-universal-landscape-report.json` 的 `gate=CONCERNS` 全部原样保留。放行是决策，不是数据改写。

---

## 4. 未测试口径（完整保留，逐条如实）

### 4.1 阶段 D 历史缺口（`15` §13 / `probe/phase-d-browser-verify-report.json`，FINAL_REVIEW）

历史报告 `gate=FAIL`，114 项 checks：**46 PASS / 2 FAIL / 45 NOT_RUN / 21 BLOCKED**。该文件是 11-07 的实跑快照，**本轮未重跑该脚本**（`UL-G05` 只做汇编核对，未改判任何首轮状态）。

`UL-G05` 汇编核对结论（主理人 2026-11-09）：逐项比对 `D-*` / `CASE-*` / `EXIT-*` 与首轮检查表，**未新增 FAIL**；上面 2 项 FAIL 与 21 项 BLOCKED 均为**历史原值**，不代表当前代码已被该脚本重新验证，也不因放行而消除。

| ID | 历史状态 | 说明 |
|---|---|---|
| `D01-10` | FAIL | 弃牌加减（`.dp-step`）与提交（`#discard-ok`）真实点击；后续代码有修复，但**该脚本未复跑，当前代码状态未经此脚本验证** |
| `FLOW-07` | FAIL | 发展卡购买与使用（骑士/筑路/垄断/丰饶）；同上 |
| `D03-01`…`D03-07` | 7 项 BLOCKED | **D-03 发展卡真实 UI 全部未验证** |
| 完整多人对局 | 未达成 | 浏览器真实对局**未走到 `phase=ended`** |
| 真机清单 D1–D8 | 见 `16` §4 | 0 项完整 PASS；2 项 PARTIAL（D5 标签回收、D6 单指触摸/缩放），其余 NOT_RUN / BLOCKED |

### 4.2 通用横屏复跑的 14 项 BLOCKED（`probe/phase-d-universal-landscape-report.json`）

| ID | 类别 | 未测原因 |
|---|---|---|
| `UL-R01`…`UL-R06` | 真机 6 项 | 本会话无 iPhone / iOS Simulator；Android 设备只有 1 台且已休眠；缺支持 lock 的 Chrome 真机侧 |
| `UL-UX03` (A-3) | 真机必需 | 自转后棋盘真实命中在 Android Edge 已取得部分证据，脚本按规格保持结构性 BLOCKED；证据另存 `device-evidence.json`，不用于解除 BLOCKED |
| `UL-UX04` (A-4) | 真机必需 | 同上；A-4a/A-4b 由 quality-lead 人工裁定 PASS，范围**仅 Android Edge + 华为系统输入法** |
| `UL-UX06` (A-6) | 真机必需 | 安全区 `--ul-safe-*` 四边在 Android 上均为 `0px`（无刘海数据）；iPhone 灵动岛 / Android 挖孔 / 手势条未验 |
| `UL-UX13` (A-13) | 真机必需 | **无法让用户物理转动手机**；未使用 ADB 强制旋转冒充，方向习惯 `+90deg` /「向左横过来」是未验证假设 |
| `UL-B03` / `UL-B04` | 种子态 | 未造掷 7 / 弃牌、强盗 `pendingRobber` 种子态 |
| `UL-D04` | 真机刘海 | 真机刘海 / 圆角 / 浏览器栏 / 软键盘，无 iOS 真机 |
| `UL-G04` | SUPERSEDED | 旧「进入横屏按钮 9 PASS 基线」已废弃主路径，登记为**有意变更、非回归**；不得用它证明无回归 |

### 4.3 通用横屏复跑的 23 项 NOT_RUN（分解，避免误读为「产品全未测」）

- `UL-CAP-01…10` + `UL-ENV-01/02`（12 项）：能力快照专项，只在 `--mode=capability-only` 跑；已独立产出 13 PASS 的 capability 报告，**不是产品功能未测**。
- `UL-C04` / `UL-C05`：需服务端命令计数、可控 STATE 广播补证。
- `UL-F05`、`UL-G01`、`UL-G03`、`UL-G05`：需其他脚本 / 汇编补证（G05 由本次汇编承接）。
- `UL-UX07`：S0→S2 已实测；**WELCOME 带 view 恢复路径**与「结束页→回到房间」未完整补跑。
- `UL-UX08`：9 态中 7 态取得运行时观测；**S1 瞬时态、S3 超时分支**需单测状态迁移表补证。
- `UL-UX10`：A-10 已改为按 `docs/17` §4.3.1 的 **P1–P8 八条复活路径逐条验证**；CDP 仅部分观测「提示出现 1 次」，**切后台 / 来电 / 刷新重置与 P3（每次 STATE 与 HUD 重绘）、P5（resize 连发）未逐条跑完**，状态保持 NOT_RUN 而非 PASS。
- `UL-UX11`：按钮 rect / 字号 / 对比度 / `aria-live` / 焦点 / 减少动效标记已实测；**播报次数、开关实际效果、真机文字渲染**需人工 + 真机补证。
- `UL-UX12`：三分支降级文案已可见且无禁用旧提示；**逐字一致断言**待单测补证。

### 4.4 目标浏览器 / 设备未取证（这是「通用」目标最关键的缺口）

| 目标 | 状态 | 说明 |
|---|---|---|
| **iOS Safari** | 未取证 | 本方案首要目标，无 iPhone / iOS Simulator |
| **微信内置浏览器** | 未取证 | 无取证环境 |
| **国产自带浏览器（夸克 / 华为）** | 未取证 | 上轮打开 `127.0.0.1:8794` 均为错误页且服务端无请求；Edge 正常。厂商 WebView 不暴露 `chrome_devtools_remote`，读不到页面内部值 |
| **Android Chrome lock 成功路径** | 未取证 | 虽检出 `com.android.chrome` 的 devtools socket（Chrome 157），但 lock 成功真机链路未跑 |
| **第三方输入法**（搜狗 / 百度 / 讯飞） | 未取证 | 设备只启用华为系统输入法，本轮不安装第三方 IME |
| **A-13 用户物理转动手机** | 无法自动化 | 属人工体验项，ADB 强制旋转不能替代 |

### 4.5 源码已落地但未经复验（放行后尤其要记住）

1. `apps/web/src/ui.ts:322/326/331` 的 `enterkeyhint` 与引导文案于 2026-11-08 20:25 落地，**之后再未做真机复验**：Gboard 是否真的从「下一步」变成「前往 / 完成」、引导句是否清晰可读，均无证据。`device-evidence.json` 里仍记录着补验当时「缺 `enterkeyhint` 与引导文案」的旧结论。
2. `dvh/dvw`、`visualViewport` 事件时序在微信 X5 / 夸克 / 华为 WebView 的取值未实机验证。
3. `lock` resolve 却不改视口、全屏进入触发的 resize 抖动、旋转后中文亚像素渲染、44px 触控目标实测、正立层 `z-index:70` 与结束页/抽屉的视觉遮挡，均只有单测 / 级联求值，无真机目视。
4. transform 后 `:focus-visible` 焦点描边是否被旋转容器裁切、SVG 命中在 WebKit 上的亚像素表现，未实测。

### 4.6 明确不在本轮范围

真机后台语音房 / 锁屏 / 标签回收 / 网络切换、服务端权威拒绝与报价竞态、性能基线、完整多人对局到结束、`UL-B03/B04` 种子态、阶段 E 美术与阶段 F PWA。

### 4.7 2026-11-09 放行后补验（新增记录，不改写 4.1–4.6 的历史快照）

> 本节是**交接语「直接从第 4 节开始」的落地记录**。范围只限「本环境（macOS + 无头 Chrome + 协议级 bot）能补的证据」；
> 4.4 的目标浏览器 / 设备未取证、A-13 物理转机、第三方 IME 一律**保持未取证**，不因本节任何 PASS 而改判。
> 历史报告原样保留：`probe/phase-d-browser-verify-report.2026-11-07-FAIL-snapshot.json`（46/2/45/21，FAIL）、
> `probe/phase-d-universal-landscape-report.2026-11-08-CONCERNS-snapshot.json`（44/0/23/14，CONCERNS）。
> 复跑结果另存 `probe/phase-d-browser-verify-report.2026-11-09-rerun.json`，**不覆盖** `phase-d-browser-verify-report.json`。

**① 历史 browser-verify 脚本（--mode=full --players=4 --shots）实跑复跑，55 PASS / 1 FAIL / 42 NOT_RUN / 16 BLOCKED，gate=CONCERNS**

| 历史缺口 | 复跑状态 | 说明 |
|---|---|---|
| `D01-10` 弃牌加减 / 提交真实点击 | **PASS**（原 FAIL） | `.dp-step[data-delta=1]` 与 `#discard-ok` 真实鼠标指针点击，`0 / 4 → 提交` 成功；`seededStates` 含 `seven` / `layout-discard-pending` |
| `FLOW-07` 发展卡购买与使用 | **BLOCKED**（原 FAIL） | 真实指针点了 `#btn-buy-dev`，确认条未出现：候选座位资源 `wood2/brick1/sheep3/wheat0/ore0`，买卡需羊麦矿，**资源不足**；按脚本诚信口径不写 PASS、也不写 FAIL。D-03 使用链路见下行 |
| `D03-01`…`D03-07` 发展卡真实 UI | **7 项全 PASS**（原全 BLOCKED） | 骑士选点→相邻玩家/不抽牌→提交；筑路第一条→第二条候选→「已选 2 条路」→提交/取消；`dev-knight` / `dev-roads` 种子态已造 |
| `D01-09` 回到全局恢复 viewBox | **FAIL（新增）** | 见 ③ 根因：**脚本判据缺陷，不是产品回归**；原值保留不改判 |
| `FLOW-09` / `EXIT-05` 完整对局 | **仍 NOT_RUN** | 方法 A 全 UI 推进 60 回合空转（`buildAttempts=0`、`turn=1`、`hasRolled=false`），**未到 `phase=ended`**；按最严格口径保持 NOT_RUN，不用本节其它证据改判 |
| `EXIT-07` 全量命令 | **PASS** | 435 passed + 2 todo、typecheck 4 包、build 成功（补验前基线） |

**② 本环境可补的单测已补齐：`apps/web/test/phase-d-closure.test.ts`（26 条，全 PASS）**

按 `docs/17` §4.3.1 的 **P1–P8 逐条独立**断言「转向提示不复活」；补 `UL-UX08` 状态迁移表（S1 不停留 / S3 超时按 S5 / S4 假成功不撤自转 / S6→S2 / S7↔S8）、`UL-UX12` 三分支文案逐字 + 禁用旧主提示/技术黑话的否定断言、`UL-UX11` 两种减少动效开关 + 静态 a11y 标记、`UL-UX07` 带 view 的 WELCOME 恢复路径（`Ui.render` 真实启用自转）与结束页→回到房间、18 §4.5 的 `enterkeyhint` / 引导文案静态对账。全量回归：**461 passed + 2 todo**（web 240 / 19 files），typecheck 四包通过。
> 口径：这些是**单测**，只证明代码路径与文案不漂移，**不冒充浏览器 / 真机**；`UL-UX03/04/06/13` 结构性 BLOCKED 不变。

**③ `D01-09` 复跑 FAIL 的根因（数学层定点复验，已写进单测）**

复跑观测 `viewBoxInitial=-666.672… -469.172… 995.4 632`、`viewBoxReset=-497.7 -316 995.4 632`：宽高一致，原点差 168.97，恰等于 `(W/2 + panX)/s` 的偏移。说明脚本在 `phase-d-browser-verify.mjs:1991` 读到的 `vb0` **是前面拖动流程留下非零 pan 的快照**，而 `:2002` 的判据 `vb3 === vb0` 把「带 pan 的初值」当成了基准；`camera.reset()` 回到 `zoom=1/pan=0` 的规范值（`-497.7 -316 …`）是**正确行为**。单测同时验证「规范初值下 zoom→reset 严格回到 vb0」与「带 pan 初值下必然不等」。`phase-d-closure.test.ts` 的这两条断言是根因证据，**历史复跑报告里的 FAIL 原样保留，不改写、不改判**。

**④ `UL-B03` / `UL-B04`「未造种子态」的原因已实质消除**

复跑的 `seededStates` 含 `seven`、`layout-discard-pending`、`layout-robber-seed`、`layout-robber-discards-done`、`seven-pending`；`D01-10`（弃牌加减真实指针）与 `D04-05`（选地块 → `#robberbar [data-action=steal]` 真实指针）均 PASS。即「掷 7 / 弃牌 / 强盗 pendingRobber 种子态」在**同一套 browser-verify 脚本**里已造出并用真实指针验证。
> 但 `probe/phase-d-universal-landscape-check.mjs` 自身按矩阵口径**不造种子态、结构性保持 BLOCKED**（`:1667–1669`）；本报告不改 ULS 报告的 14 项 BLOCKED，只如实记录「缺种子态」这一**原因**不再成立。

**⑥ 完整对局终局 + 结束页：`probe/phase-d-closure-check.mjs`（6/6 PASS，`gate=PASS(NARROW_SCOPE)`）**

独立端口 8801 / CDP 9421 / 房间 `qa-close-*`，**不碰线上房间**。4 个真实 WS bot 串行入座（满员自动开局，不加 `--host`），协议级推进到 **turn 326、`phase=ended`、乙 10 分获胜（8:10:4:4）**；bot 退出后座位置保留，用**真实 Chrome 页面以「甲」同名重连**：

| ID | 结果 | 观测 |
|---|---|---|
| `CL-01` | PASS | 单端口服务 `/health` 200 |
| `CL-02` | PASS | 4 bot 完整对局到 ended：胜者 1「乙」，比分 `[8,10,4,4]`，4 个 bot 都独立打印同一终局 |
| `CL-03` | PASS | 重连玩家通过**带 `view` 的 WELCOME** 直接进入已结束对局（`room.ts:222` / `server.ts:248`），浏览器 `__hex.view.phase==='ended'`、`winner=1`、`turn=326` —— 这是 **UL-UX07「WELCOME 带 view 恢复路径」** 的实跑证据 |
| `CL-04` | PASS | `#end-screen` 可见，含「乙 获胜（10 分）」与四人分数、手牌数，`#end-back` 存在 |
| `CL-05` | PASS | 真实指针点「回到房间」→ `mode=off`、结束页收起、回 S0（`UL-UX07` / E6） |
| `CL-06` | PASS | `/health` 显示仍是同一已开局房间（`players:4, started:true, turn:326`），未重开、未丢状态 |

证据：`probe/phase-d-closure-report.json`、`probe/phase-d-closure-shots/01-game-ended.png` / `02-back-to-room.png`。
> **口径边界（刻意写窄）**：这是「**协议级 bot 推进 + 真实浏览器验证终局 UI**」的组合证据，**不是**「4 个浏览器页面全 UI 打完一局」。因此 `phase-d-browser-verify.mjs` 的 `FLOW-09` / `EXIT-05` **仍保持 NOT_RUN**，不用本报告改判；`gate=PASS(NARROW_SCOPE)` 只表示本脚本 6 条窄范围检查通过，不改写 `15` §13 的 FAIL 与 ULS 的 CONCERNS。

**⑤ 仍需真机 / 人工 / 其它会话补齐（本节未消除）**

- `UL-C04` 服务端命令计数、`UL-C05` 可控 STATE 广播不重置相机：仍需协议集成补证，保持 NOT_RUN；
- `UL-UX10` 的「切后台 / 来电 / 刷新重置」在**真机**未跑（单测已覆盖 P1–P8 的代码路径，不替代真机）；
- `UL-UX11` 播报次数、屏幕阅读器、旋转后中文真机渲染；`UL-UX12` 真机逐字目视；
- 4.4 全部目标浏览器 / 设备、A-13、第三方 IME、`FLOW-07` 可买卡的富资源种子态、`FLOW-09` 的 4 浏览器页面全 UI 完整对局。

---

## 5. 已知风险与缓解

| 风险 | 影响 | 缓解 / 后续动作 |
|---|---|---|
| iOS Safari / 微信内置未取证 | 「任何浏览器通用」的核心主张尚未在首要目标上验证 | 借一台 iPhone，按 `probe/phase-d-universal-landscape-plan.md` §5.4 补 A-1/A-4/A-6/A-13 真机证据三件套 |
| 国产自带浏览器未取证 | 夸克 / 华为「中间竖条」在页面内自转下是否绕开，未实测 | 先解决这两家浏览器访问本地测试地址失败的问题，再取对比截图 |
| 旋转方向 `+90deg` 是未验证假设 | 用户可能习惯反向转机，看到上下颠倒 | `panels.ts:82` 的 `LANDSCAPE_ROTATION` 是单杠杆，方向词 / 箭头 / 安全区 / 相机角度全派生；真机复核后只翻这一处 |
| 系统方向锁死时前端拿不到「用户是否已横过来」 | 转向提示无法检测后自动消失 | 规格已定为「一次 + 淡出 + 可关 + 会话记忆」，不伪称能自动检测 |
| A-10 完整复活路径未跑完 | 后续渲染改动可能重新打开某条复活路径 | 按 `docs/17` §4.3.1 P1–P8 逐条补单测，优先 P3 / P5 → **§4.7② 已补 26 条单测（代码路径），真机切后台/来电仍缺** |
| 历史 2 项 FAIL 未复跑 | 弃牌加减、发展卡真实 UI 的当前状态缺脚本证据 | 重跑 `phase-d-browser-verify.mjs --mode=full` 或补针对性用例 → **§4.7① 已复跑：D01-10 PASS、D03 全 7 项 PASS、FLOW-07 因资源不足 BLOCKED** |
| 完整对局未到 `phase=ended` | 终局与结束页路径缺端到端证据 | 后续补 4 人完整对局 → **§4.7⑥ 已用「4 bot 协议推进 + 真实浏览器验证终局」补到 turn 326 / 乙 10 分；`FLOW-09` 的 4 浏览器页面全 UI 版本仍 NOT_RUN** |

**放行不等于这些风险已解决**；它们是放行时用户明确接受的已知边界。§4.7 只补了本环境可补的部分，未把任何风险改写成「已解决」。

---

## 6. 交付物清单

| 路径 | 内容 |
|---|---|
| `docs/17-universal-landscape-ux.md` | UX 规格：S0–S8 状态机、C1–C8 决策、A-1…A-14 验收条目、§4.3.1 P1–P8 复活路径 |
| `docs/18-universal-landscape-delivery.md` | 本文：交付汇编、放行判定、未测试口径 |
| `probe/phase-d-universal-landscape-plan.md` | 81 条跨浏览器复验矩阵与 Runbook |
| `probe/phase-d-universal-landscape-check.mjs` | CDP 复验脚本（`--mode=capability-only|full`、`--scenario`、`--shots`） |
| `probe/phase-d-universal-landscape-report.json` | 阶段二实跑报告（44/0/23/14，CONCERNS） |
| `probe/phase-d-universal-landscape-capability-report.json` | 能力快照（NOT_CONCLUDED） |
| `probe/phase-d-universal-landscape-device-evidence.json` | 真机原始观测（A-3 / A-4 / A-6 / A-13） |
| `probe/phase-d-universal-landscape-shots/*.png` | 真机与 CDP 截图证据链 |
| `apps/web/index.html`、`src/{layout,panels,camera,ui}.ts`、`test/**` | 实现与行为测试（放行时 web 214 / 18 files；§4.7 补验后 **web 240 / 19 files，461 passed + 2 todo**） |
| `probe/phase-d-browser-verify-report.2026-11-07-FAIL-snapshot.json` | 历史 FAIL 快照备份（46/2/45/21），复跑不覆盖 |
| `probe/phase-d-browser-verify-report.2026-11-09-rerun.json` | §4.7① 放行后复跑（55/1/42/16，CONCERNS） |
| `probe/phase-d-universal-landscape-report.2026-11-08-CONCERNS-snapshot.json` | 历史 CONCERNS 快照备份（44/0/23/14） |
| `apps/web/test/phase-d-closure.test.ts` | §4.7② 26 条收口单测（P1–P8 / 状态迁移表 / 三分支文案 / 减少动效 / WELCOME 恢复 / D01-09 根因 / enterkeyhint） |
| `probe/phase-d-closure-check.mjs`、`probe/phase-d-closure-report.json`、`probe/phase-d-closure-shots/*.png` | §4.7⑥ 完整对局终局 + 结束页复验（6/6 PASS，NARROW_SCOPE） |

**SUPERSEDED（有意变更，非回归）**：`probe/phase-d-landscape-button-check.mjs` 的 9 PASS / 0 FAIL 基线验证的是旧「进入横屏」主按钮必经关卡，该主路径已按 `17` §2.4/§4.1 废弃；登记位置 `probe/phase-d-universal-landscape-report.json` → `run.supersededBaselines[0]` 与计划 §2 / §4.4。

---

## 7. 环境与副作用（放行时状态）

- 测试端口 8792 / 8793 / 8794 / 9415 / 5183 **全部空闲**；临时服务、bot、CDP Chrome、临时 profile 均已清理。
- ADB 设备在真机复验后已断开（`adb devices` 为空）；`adb reverse` / `forward` 已移除；设备旋转 / WiFi / 显示尺寸设置此前已恢复原状。
- **未执行任何 git 写操作**（无 commit / reset / checkout / clean）；工作区有大量未提交改动。
- `pnpm build` 按正常构建刷新了被跟踪的 `apps/web/dist/**` 与 `apps/server/dist/public/**`。
- 未安装/卸载手机应用、未实际拨号、未碰 `release/` 与线上房间。

---

## 8. 复现命令

```bash
pnpm test && pnpm typecheck && pnpm build

# 能力自检（秒级，不起服务）
node probe/phase-d-universal-landscape-check.mjs --mode=capability-only

# 完整跨浏览器复验（独立端口 + 独立房间，真实指针）
node probe/phase-d-universal-landscape-check.mjs --mode=full --shots

# §4.7① 历史脚本放行后复跑（结果另存，勿覆盖历史报告）
node probe/phase-d-browser-verify.mjs --mode=full --players=4 --shots
# 复跑前先备份：cp probe/phase-d-browser-verify-report.json probe/phase-d-browser-verify-report.2026-11-07-FAIL-snapshot.json
# 复跑后：cp <新报告> probe/phase-d-browser-verify-report.2026-11-09-rerun.json
#          cp <历史快照> probe/phase-d-browser-verify-report.json

# §4.7② 收口单测
cd apps/web && npx vitest run test/phase-d-closure.test.ts

# §4.7⑥ 完整对局终局 + 结束页（独立端口 8801 / CDP 9421）
node probe/phase-d-closure-check.mjs --shots

# 真机（需设备）：adb reverse + 独立服务，厂商浏览器须
# uiautomator dump 取 bounds 算中心再 input tap；测完按计划 §5.4 恢复设备设置
```

---

## 9. 一句话交接

**代码可用、自动化全绿、阶段 D 已由用户放行；但「iOS Safari / 微信内置 / 国产自带浏览器通用」这句话还没有真机证据，A-13 物理转机、第三方 IME、`UL-C04/C05` 协议补证、`FLOW-07` 富资源种子态、`FLOW-09` 的 4 浏览器页面全 UI 完整对局仍缺。下一位接手请直接从第 4 节开始，不要从第 2 节开始 —— 2026-11-09 已从 §4 补验过一轮，进展与剩余边界逐条记在 §4.7，历史快照（4.1–4.6 与所有历史报告）一律未改写。**
