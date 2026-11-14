> **历史/专项资料提示（2026-11-14）**：先读 [CURRENT](./CURRENT.md) 和 [当前修复任务书24](./24-production-fix-guide.md)。本文保留历史事实与未被覆盖的细节，不作为最新任务入口；冲突以当前用户决定及24为准。

# 晴湾纸雕 · 桌面接入（本轮）

> 2026-11-10。基准：`design/desktop/papercut.html`（B · 晴湾纸雕，已选定）。
> 范围：**真实对局主画面**的布局、美术、玩家条、手牌、建造流程接入。
> 不做：重新选风格、手机适配、部署、替换规则引擎/协议/网络恢复/棋盘几何。
> 前置：开工前已把未提交工作完整备份（见 §0）。

---

## 0. 基线保护（开工前完成）

| 项 | 值 |
|---|---|
| 分支 / HEAD | `master` / `6646d6a` |
| 未提交 | 131 项（含 `apps/web/src/*` 改动、阶段 D 测试、`design/`、`docs/19`、`docs/20`、`docs/shots/*`、`probe/*`） |
| 备份 | `.workbuddy/backups/desktop-integration-20261110-1702/`：WIP commit `44f8aa3`（ref `refs/backup/desktop-integration-20261110`）、`tracked-changes.patch`、`index.backup`、`git-status*.txt`、`worktree-snapshot.tar.gz`（110MB，313 文件） |
| 破坏性操作 | 无；未 `reset --hard` / `clean` / 覆盖目录 |
| 基线检查 | `pnpm typecheck` PASS；`pnpm test` PASS（engine 20 / server 62 / web 240 = 322） |
| 基线截图 | `docs/shots/pc0-baseline-1440.png`（真实房间 `desk1`，4 人已开局、8 建筑 8 路、1440×900，Chrome headless 实拍） |

真实房间运行方式（不占用既有 8787 服务）：后端 `PORT=8791 npx tsx src/index.ts`，
Vite `HEXFRONT_WS_TARGET=ws://127.0.0.1:8791 npx vite --port 5175`，
`PORT=8791 npx tsx scripts/seed-room.ts <room> 4 --rounds N` 造局，
`probe/desktop-shot.mjs` 用 CDP 实拍（见 §5）。

---

## 1. 原型组件 ↔ 现有正式代码对应关系

事实来源：`design/desktop/js/app.js`（DOM 生成）、`board.js`（SVG）、`css/papercut.css`（token）、`css/base.css`（布局），
与 `apps/web/src/ui.ts`/`panels.ts`/`scene.ts`/`index.html`。

| 原型组件（生成函数 / class） | 正式代码接入点 | 本轮处理 |
|---|---|---|
| `.app` 三行 grid（topbar / main / shelf）；`--top-h/--shelf-h/--rail-w/--gap/--pad` | `index.html .shell` + `layout.css` 三行 grid | **重构**：`.shell` 改 3 行 `顶栏/主区/底栏`；新增 `<footer class="shelf" id="shelf">` 承载手牌与操作；保留全部旧 id |
| 顶栏 品牌 `.brand` | `index.html .conn-chip` + `#turn-chip` 区域 | **美化**：品牌名/房间/连接状态合成 papercut 品牌块；保留 `#room-id`、`#conn-dot` |
| 玩家 chip `topPlayers()` → `.pchip/.pavatar/.pname/.pscore/.pmeta/.pbadge`、`.current/.warn` | `ui.ts paintPlayers()` → `#players .player/.ava/.pname/.pmeta/.ptrack/.phand/.pscore` | **改 HTML 模板**：用同一份 `PlayerView.players[]` 生成纸雕 chip（名字首字头像、分数、手牌/发展卡数、成就 pill、当前高亮、≥8 风险）；保留全部 class 与 `class="phand"` |
| 回合盒 `.turnbox`（ROUND / 甲行动中 / 阶段副标） | `ui.ts paintTurn()` → `#turn-ava/#turn-text/#phase-flag` | **改文案与容器**：顶栏右侧回合块；数据源仍是 `view.turn/current/hasRolled/phase` |
| 任务卡 `taskCard()` 及 6 变体 → `.card.task-card/.eyebrow/.task-seal/.task-foot`、`.pending-chip` | `panels.ts renderSituation()` → `#situation`（当前是「标签·文本」条） | **升级为任务卡**：同一时刻一张，读 `phase/hasRolled/pendingDiscards/pendingRobber`；`say()` 数据契约不变；棋盘上继续显示为轻量卡片，不遮棋盘；文本仍由 `describeEvent`/`renderSituation` 决定 |
| 桌上提议 `offerCard()` / `offerTicket()` → `.offer[data-offer]/.otime/.swap/.accept` | `ui.ts paintOfferBar()` → `#offer` 横幅 + `panels.ts renderOffers()/offerCard()` → 抽屉 `#extra-panel` | **横幅升级为报价票**：常驻右栏上方「桌上的提议」摘要（数量来自服务端 `OFFERS.snapshot`）+ 点开抽屉看完整列表；接受/拒绝/撤回仍按 `offerId`；倒计时由 `panels.tick()` 用 `expiresAt - serverNow()` 渲染，**不本地裁决** |
| 手牌资源卡 `handCards()` → `.res-card[data-res]/.res-ico/.res-name/.res-count/.port-tag`、`.empty`、弃牌 `.picked/.pick-badge` | `ui.ts paintHand()` → `#hand .card/.cband/.cnum/.cname`；`paintDiscard()` → `#discard .dp-*` | **移到底栏 + 改纸雕卡**：5 类资源卡（图标 + 中文名 + 大数字 + 港口标签），零资源灰化不隐藏；数量只来自 `view.me.resources`；弃牌选择仍走 `#discard` 面板与 `cb.onDiscard`，新增「持有 N / 已选 N」反馈 |
| 发展卡堆 `devZone()` → `.dev-stack/.dev-fan/.dev-copy/.locked` | `ui.ts paintDevCards()` → `#devcards .devcard` + `#btn-buy-dev` | **改纸雕扇形卡堆**：数量来自 `view.me.devCards.length`；锁定态读 `pendingDiscards/pendingRobber`；购买仍 `cb.onBuyDev()` → `BUY_DEV_CARD` |
| 操作区 `actions()/discardActions()` → `.action-main/.btn.primary.roll-btn/.action-row/.action-note` | `ui.ts paintActions()` → `#btn-roll/#btn-end/#btn-build/#btn-trade`；`panels.ts renderRailActions()` → `#rail-actions` | **移到底栏**：主按钮（掷骰）+ 次按钮行（建造/交易/兑换/结束回合）；禁用原因仍由 `paintActions` 与 `renderBlocked` 的 `title`/文案给出；`#rail-actions` 保留为发展卡/银行/港口/帮助入口 |
| 交易抽屉 `renderDrawer()` 两步（我想收到 / 我愿给出）→ `.trade-drawer/.tr-line/.trade-condition/.send-btn` | `ui.ts paintTrade()` → `#trade` + `panels.ts renderOffers()/offerDraftHtml()` → `#extra-panel` + `#drawer-foot` | **本轮不重做两步交易**（属 §6 后续流程）：保持现有「我给/我要」+ 服务端报价草稿；仅换纸雕抽屉外框与按钮层级；**规则/offerId/冷却/TTL 全不动** |
| 棋盘事件 slip `renderBoardEvent()` → `.board-event/.event-dice` | `ui.ts paintDice()` → `#die1/#die2` + `pushEvents()` → `#log/#feed-text` | **新增事件 slip**：左下角骰子 slip，点数读 `view.dice`（服务端）；`spinDice()` 假随机动画仍是表演，落定后 `paintDice(view)` 回到权威值；`data-info-only` 不拦截棋盘 |
| 岛上动静 / 日志 | `ui.ts pushEvents()` → `#log`；`paintSidebox()` → `#sidebox` | 右栏底部「岛上动静」摘要，保留 `#log`；隐藏信息（别人手牌内容）绝不渲染 |
| 棋盘 SVG `Board.render()`（viewBox `0 0 1040 720`，HEX_SIZE=56） | `scene.ts renderBoard()`（viewBox 由几何算，PAD=92）+ `geometry.ts`/`camera.ts` | **只换皮不动几何**：保留 `geo`/顶点边 key/`data-vertex|data-edge|data-tile`/layer 顺序/`roadMarkup` 无 filter；把地形色/纸边/数字圆片/港口/棋子/强盗/海面渐变/装饰改成纸雕配色与形状；`camera.ts`/`geometry.ts`/`placement.ts`/`build.ts` 逐字不动 |
| 建造高亮 `overlayData()`/`.build-overlay` → `.ov-hit[data-edge|data-vertex|data-tile]`、`+`/`✓` | `scene.ts overlayMarkup()` → `<g data-layer="hits">` + `ui.ts applyHit()`/`showConfirm()` | **改视觉**：墨底 + 奶油 + 黄虚线 + 中点徽章；命中层仍大于线宽；确认/取消仍在 `#confirm-strip`（右栏任务区），Esc 取消草稿逻辑不变 |
| 缩放工具 `.cam-btn[data-act=zoom-*]`、tooltip、toast | `#cam-tools/#zoom-in/#zoom-out/#zoom-reset`、`#tipbox`、`#toast` | 换成纸雕圆形按钮（+ / − / ↺）；相机仍走 `camera.zoomAt/reset`；toast 改深墨底奶白字 |
| 设计 token `papercut.css:2-43` | `apps/web/src/styles.css :root` / `layout.css :root` / `theme.ts` | **新增 `papercut.css`** 作为最后加载的主题层，用 `body[data-theme=papercut]` 变量覆盖；`theme.ts` 的 `TERRAIN_COLOR/PLAYER_HEX/INK*` 与 SVG 内联色同步为纸雕值 |
| 动效（掷骰 680ms / 步骤切换 180ms / 数量脉冲 / 抽卡飞行 / 建造落下） | `ui.ts spinDice()`、`paintHand()` 入场、`panels.ts toast` | **只加不阻塞状态的轻动效**：CSS transform/opacity；`prefers-reduced-motion` 与 `[data-reduce-motion=1]` 降级；**动画不延迟游戏状态更新**（收到 STATE 立即 `render()`） |

### 1.1 明确「不接入 / 不用原型模拟逻辑」的边界

| 原型本地模拟 | 正式实现（本轮保持） |
|---|---|
| `window.GAME_STATE` 静态快照 + 前端 mutation | 唯一状态源 `main.ts view = PlayerView`（WELCOME/STATE），`send(Command)` 变更 |
| 报价倒计时 `startTradeClock`（每秒 `seconds-=1`，只在面板打开推进） | `OFFERS.snapshot.expiresAt/serverTime/nextSendAt`，`panels.tick()` 每 200ms 渲染倒计时，服务端裁决 |
| 固定掷 7 / 本地随机骰点 | 客户端只发 `ROLL_DICE`，点数来自服务端 `view.dice`；`spinDice()` 纯表演 |
| 丙弃牌 1.05s 模拟、本地算 `ceil(hand/2)` | `view.pendingDiscards` 由引擎给，`DISCARD` 命令等服务端 ack |
| 本地 `legalSpots()` 算建造合法位、前端扣资源 | `build.ts candidatesFor()` 只算「亮哪里」，`BUILD_*` 由服务端裁决 |
| 本地强盗/抽牌/兑换/买发展卡/结束回合只 toast | 全部走既有命令与 STATE 回写 |
| 8.5s 后注入演示报价 | 无；只有真实 `OFFERS` 广播 |
| 结束回合不切换玩家 | `END_TURN` → 服务端推进 → 全桌 STATE |

---

## 2. 本轮完成范围

- 真实对局主画面：**顶栏（品牌 + 玩家条 + 回合）、中间棋盘、右侧任务/报价/日志、底栏（手牌 + 发展卡 + 操作）** 的桌面布局（1280×720 / 1440×900）。
- 美术：纸雕主题 token、纸面/海面材质、6 地形、数字圆片、港口、村庄/城市/道路/强盗、资源卡、按钮、任务卡、报价票、事件 slip。
- 玩家条、手牌、建造流程（点建造 → 合法位置高亮 → 选点 → 右栏确认 → 提交 → 服务端 STATE 回写）完整可跑。
- 报价计时沿用服务端、骰子结果沿用服务端、动画不延迟状态更新（三条硬约束，§4.3 验证）。

## 3. 修改文件清单

| 文件 | 改动 |
|---|---|
| `apps/web/index.html` | 重构为三行纸雕 shell（顶栏 / 主区 / 底栏手牌架）；**全部旧 id、data-board-input / data-board-ui / data-info-only、#landscape-hud 在 #shell 之外、styles.css→layout.css 顺序、viewport-fit=cover 保持不变**；新增 `#shelf / #rail-task / #board-event / #rail-offer-count` 与可见镜像按钮；阶段 D 右栏手牌/pinned 节点移入 `.rail-legacy / .rail-pinned`（桌面由 CSS 收起） |
| `apps/web/src/papercut.css` | **新增**，最后加载的桌面主题层：token、三行 grid、顶栏玩家 chip、任务卡、报价票、右栏、5 张资源卡、发展卡堆、操作区、抽屉、事件 slip、动效与 `prefers-reduced-motion` 降级、1280/1366 紧凑规格、≥1180px 撤销整页自转、<1180px 提示 |
| `apps/web/src/theme.ts` | 纸雕配色（地形 base/deep/light、玩家色、屋顶首字、道路虚线纹理、墨/纸/强调色）；`isLight` 保持纯函数语义 |
| `apps/web/src/scene.ts` | **只换皮**：纸雕地形/数字圆片/港口/村庄城市/道路/强盗/海面渐变/太阳帆船/建造高亮；`viewBox`/`PAD`/几何/`data-vertex|data-edge|data-tile`/`data-layer` 顺序/`roadMarkup` 4 条线且无 filter **逐字不动** |
| `apps/web/src/ui.ts` | `paintPlayers/paintHand/paintDevCards/paintOfferBar` 输出纸雕组件（数据仍只来自 `PlayerView`）；`resourceGlyph()` inline SVG 资源图标；`render()` 末尾 `syncShelf()`；`pickBuild()` 选完类别收起大抽屉；港口标签只标自己真正占用的港 |
| `apps/web/src/panels.ts` | `say()` 同步渲染右栏任务卡 `#rail-task`（同一时刻一张），`#situation` 文本契约不变 |
| `apps/web/src/shelf.ts` | **新增**，底栏可见按钮 → 既有逻辑按钮的点击转发 + 状态/手牌镜像；不重复实现任何规则入口 |
| `apps/web/test/desktop-papercut.test.ts` | **新增** 10 条行为测试：三行结构、无重复 id、底栏桥接不重复提交、三条硬约束、棋盘几何契约、≥1180px 撤销自转 |
| `probe/desktop-shot.mjs` / `desktop-build-flow.mjs` / `desktop-dice-flow.mjs` / `desktop-offer-timing.mjs` | **新增** CDP 真实浏览器截图与 UI 链路验证工具（无第三方依赖，Node 全局 WebSocket） |
| `apps/server/scripts/desktop-seed-rich.ts` | **新增** 本地验收造局脚本（只走协议命令、安全骰子跳过 7，依赖 `HEXFONT_FAKE_DICE=1` 验收后端） |
| `docs/21-desktop-integration.md` | 本文件 |
| `docs/shots/pc0-baseline-1440.png`、`pc1-*.png` | 接入前基线 + 接入后真实房间截图（见 §5） |

**未改**：`packages/engine/**`、`packages/protocol/**`、`apps/server/src/**`（`room.ts` 的骰子剥离/报价 TTL 逻辑逐字未动）、`apps/web/src/{main,net,camera,geometry,placement,build,discard,robber,decor,format,tips}`、`layout.css`、`styles.css`；`panels.ts` 只新增 `renderTaskCard()` 并在 `say()` 内调用（原有渲染/事件/报价计时逻辑未动）。
> 注意：`main.ts / net.ts / build.ts` 在 `git status` 里显示为已修改，但那是**开工前 WIP 基线自带的阶段 D 改动**；以备份 commit `44f8aa3` 为基准核对，本轮对这三个文件**零改动**（`git diff 44f8aa3 -- <file>` 为空）。规则引擎、协议、网络恢复、棋盘几何本轮均未触碰。

## 4. 实际运行与测试结果

### 4.1 自动检查（仓库根）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **PASS**（engine / protocol / web / server 全部 Done） |
| `pnpm test` | **PASS**：engine 139 passed + 2 todo、protocol 20、server 62、web **250** = **471 passed + 2 todo**（基线 322，新增 10 条纸雕接入测试 + 10 条 web 既有） |
| `pnpm build` | **PASS**：`vite build` 36 modules → `dist/assets/index-CxIbCGRO.css` 71.66 kB / `index-DKIqn2pS.js` 114.77 kB；`node build.mjs` → `dist/server.cjs` 193.3 KB，`dist/public ← apps/web/dist` |

> 构建更新了受跟踪产物 `apps/web/dist/*` 与 `apps/server/dist/public/*`（指南 §9.1 要求列明），未手工改 dist 修问题。

### 4.2 真实房间 / 真实浏览器（Chrome headless + CDP，非模拟视口代替真机）

后端 `PORT=8791`（普通）/ `PORT=8792` + `HEXFONT_FAKE_DICE=1`（验收造局，生产端该开关关闭）；
Vite `5175`（普通）/ `5176`（验收）；`?name=甲&room=<room>` 真实 JOIN → WELCOME → STATE。

| 证据 | 结果 |
|---|---|
| `docs/shots/pc0-baseline-1440.png` | 接入前基线：4 人已开局、8 建筑 8 路、1440×900，页面无滚动 |
| `docs/shots/pc1-rich-normal-1440.png` | **普通对局**：4 人玩家 chip、任务卡「轮到你 · 可先交易或建造，再掷骰」、5 张资源卡、金色掷骰按钮、结束回合禁用且写明「本回合尚未掷骰」 |
| `docs/shots/pc1-papercut-1280.png` | **1280×720**：`docScroll=[1280,720]` 无整页滚动；顶栏 64 / 主区 520（棋盘 946×520、右栏 292×520）/ 底栏 122，手牌与主动作完整可见 |
| `docs/shots/pc1-papercut-1366.png` | **1366×768**：`docScroll=[1366,768]` 无滚动；顶栏 64 / 棋盘 1032×568 / 右栏 292×568 / 底栏 122 |
| `docs/shots/pc1-build-road-highlight-1440.png` | **建造高亮**：真实点「建造→道路」后棋盘 5 条合法边显示金色 `+` 徽章，右栏任务卡与棋盘同时可见，无遮挡抽屉 |
| `docs/shots/pc1-build-flow-done-1440.png` + `probe/desktop-build-flow.mjs` | **建造完整链路**（全真实指针点击）：`roads 8→9`、木/砖 `1→0`（服务端扣费）、确认条「在此建造道路？成本 木1 砖1」、`consoleErrors=[]` |
| `docs/shots/pc1-dice-rolled-1440.png` + `probe/desktop-dice-flow.mjs` | **骰子来自服务端 / 动画不延迟状态**：点击后 150ms 时 `view.dice=[5,3]` 已由服务端 STATE 更新，而骰面 DOM 仍是动画中的 `1,2`；动画落定后 `#die1/#die2=5,3` 与 `view.dice` 一致（`stateUpdatedDuringAnimation=true`、`finalMatchesServer=true`） |
| `docs/shots/pc1-offer-timing-1440.png` + `probe/desktop-offer-timing.mjs` | **报价计时沿用服务端**：真实房间 `offerdemo2`（甲当前）+ 乙 发 OFFER；抽屉 `[data-cd]` 倒计时 `剩余 9.2s → 7.0s`（`countdownDecreased=true`），右栏「桌上的提议」计数 `1`；超过 10s TTL 后卡片 `ended=1 / expired / 按钮禁用`，计数归 `0`（`noAutoRenew=true`），不自动续期；`consoleErrors=[]` |
| 控制台 | 上述所有页面 `consoleErrors=[]`，无 pageerror / console.error；资产（全 inline SVG + CSS）无 404 |

### 4.3 三条硬约束的验证口径

1. **报价计时沿用服务端**：协议 `OFFER_TTL_MS=10_000` / `OFFER_SEND_COOLDOWN_MS=3_000`；`OfferView` 的 `id/createdAt/expiresAt` 由服务端分配，`OfferSnapshot` 带 `serverTime/nextSendAt/version`。前端 `panels.ts` 只做 `serverOffset = snapshot.serverTime - Date.now()`、`serverNow()` 与 `tick()` 每 200ms 渲染 `o.expiresAt - serverNow()` 到 `[data-cd]`，`offerSendGate()` 统一裁决冷却/权限/弃牌锁；`desktop-papercut.test.ts` 断言这些字符串与常量，浏览器端观察倒计时递减与 10s 后卡片原地失效、不自动续期。
2. **骰子结果来自服务端**：客户端只发 `ROLL_DICE`（不带点数），`ui.ts spinDice()` 的 `Math.random()` 仅 10 帧表演，落定后 `paintDice(this.view)` 回到 `view.dice`；`apps/server/src/room.ts` 明确剥离客户端 `dice`（`HEXFONT_FAKE_DICE` 仅本地验收）。实测见上表。
3. **动画不延迟游戏状态更新**：`main.ts` 收到 STATE 立即 `ui.render(view, events)`；纸雕动效只改 `transform/opacity`（`pc-slip-in / pc-tumble / pc-pulse / pc-prod`），不 gating 任何提交；`prefers-reduced-motion` 与 `[data-reduce-motion=1]` 全量降级。实测「点击后 150ms 状态已更新、动画仍在表演」。

## 5. 尚未接入 / 未验证清单（后续轮次）

**本轮明确未做（不是回归，是范围外）**：
- 交易「两步图形选择」重设计（我想收到 / 我愿给出、滑条、收到的提议 tab）：现有「我给/我要」+ 服务端报价草稿逻辑继续用，只换了抽屉外框与按钮层级。
- 入房页 / 等待页 / 结算页换皮：仍是阶段 D 的 `#overlay > #sheet` 与 `#end-screen`（功能可用，未做纸雕美术）。
- 发展卡行动（骑士/垄断/丰饶/筑路）完整流程换皮、银行/借港兑换完整 UI、弃牌/强盗/掷 7 流程换皮、断线恢复提示换皮：功能链路保留，呈现仍是旧面板。
- 自托管 Noto Sans SC + Inter 字体与 OFL 许可文件：当前用系统字体栈回退（PingFang SC / Hiragino Sans GB）。
- `ART-ASSETS.md` 的独立 SVG/PNG 资产文件：本轮用 inline SVG + CSS 实现，未落 `public/assets/ui/papercut/` 独立文件清单。
- 抽发展卡 / 强盗抽牌的背面卡飞行动效、成交资源脉冲：只做了按钮按下、卡牌 hover、骰子翻滚、事件 slip 入场、产出呼吸。

**未验证 / NOT_RUN**：
- 至少一局「四个浏览器客户端」从入房到终局再回房的完整 UI 对局（本轮只做了单浏览器 + 协议造局 + 真实 UI 建造/掷骰链路；机器人对局不算四浏览器 UI 完整对局）。
- Edge / macOS Safari 覆盖（本轮只实测 Chrome headless，Safari 未装/未测，不宣称支持）。
- 真机平板 / 手机、PWA、系统方向锁、软键盘：桌面专项不做；<1180px 只给「建议放大窗口」提示，不自动旋转整页。
- 200% 缩放、色盲工具复核、长昵称/大数量/报价并存并快速过期等边界的浏览器走查。
- 部署（用户明确不部署）。

**保留但桌面不激活**：ULS CSS 自转、方向锁、正立层 HUD、手机专用测试与报告（阶段 D 产物，桌面 ≥1180px 由 papercut.css 撤销自转、隐藏 HUD；不删除、不伪装成 PASS）。

## 6. 回滚

未提交工作已备份：WIP commit `44f8aa3`（`refs/backup/desktop-integration-20261110`）+ `.workbuddy/backups/desktop-integration-20261110-1702/` 全量归档。
本轮改动可用 `git diff` 审阅；如需整体回退到接入前状态，从该 WIP commit 恢复，不要对未提交文件执行 `reset --hard` / `clean`。

---

## 7. 四浏览器 UI 验收（2026-11-11/12）与发现的真实缺陷

用 `probe/acceptance-4browser.mjs`（4 个独立 CDP target = 4 个浏览器客户端，
全部真实指针点击）在**发布产物**（`node dist/server.cjs`，非 Vite）上跑完整对局。

### 7.1 已通过的流程

| 环节 | 结果 |
|---|---|
| 四客户端入房 + WELCOME/STATE | PASS（4 个独立座位、各自私有视图） |
| 开局摆位 8 步（村庄+道路+确认） | PASS（`buildings 8 / roads 8`） |
| 掷骰 | PASS（55+ 次，点数来自服务端） |
| 回合推进 | PASS（实测推进到 turn=98） |
| 弃牌（单人/多人同时） | PASS（11+ 次，`progress N/N → accepted=true`） |
| 强盗移动 + 抽牌 | PASS（14+ 次，含「返回强盗任务」路径） |
| 建造（道路） | PASS（roads 8→14，服务端扣资源） |
| 控制台 | 全程 `consoleErrors=[]` |

### 7.2 验收中发现并修复的 3 个真实产品缺陷

这三个都是**只有真实多人长对局才会暴露**的问题，单元测试与单浏览器走查抓不到：

**缺陷 1 · 多人同时弃牌时选择被清空**

`paintDiscard()` 用 `${turn}:${need}:${total}` 作为「换一笔弃牌」的签名。
`total` 是「还有几个人要弃」。多人同时弃牌时，别人先弃完会让 `total` 从 2 变 1，
于是**我正在选、尚未提交的牌单被清空**，确认按钮永远不可用。

修复：签名改为 `${turn}:${need}`（只认回合与自己的需求）。
回归测试：`desktop-papercut.test.ts` → 「弃牌选择在多人同时弃牌时不被清空」。

**缺陷 2 · 抽屉撑出横向溢出，把整块画布推出视口**

`.shell` 用 `overflow: hidden`，但抽屉的 `translateX(105%)` 仍会撑出可滚动区域
（实测 `scrollWidth 1878 > clientWidth 1440`）。浏览器的 focus / scrollIntoView
会把画布横向推走，实测 `#board-stage` 左边界变成 **-416**、弃牌面板 `-405`，
`elementFromPoint` 返回 `null` —— **所有按钮都点不到**。

修复：`.shell` 改 `overflow: clip`；抽屉改 `position: fixed`（不再参与溢出计算）。
修复后 `scrollWidth 1440 == clientWidth 1440`、`#board-stage [22,78,1054,658]` 正常。
回归测试：`desktop-papercut.test.ts` → 「布局不产生横向溢出」。

**缺陷 3 · 建造草稿残留导致强盗永远无法结算（会卡死对局）**

玩家点了「建造」但还没选位置时掷出 7：`buildMode` 残留，而 `boardInteraction()`
里 `buildMode` 优先于强盗待办 → **强盗热区永远不出现**（实测 `tiles: 0`），
玩家无法结算、无法结束回合，对局卡死（实测 turn=64 空转 2000+ 次）。

修复：`render()` 在 `pendingRobber` 且无待确认位置时清除 `buildMode`。
回归测试：`desktop-papercut.test.ts` → 「掷出 7 时清掉未完成的建造草稿」。

### 7.3 仍未达成的验收目标

- **未打到 10 分终局**：三轮长对局分别跑到 **turn=98 / 65 / 61** 仍未结束。
  原因**不是流程缺陷**，而是：
  1. 随机资源分布让村庄（木1砖1羊1麦1）长期凑不齐；
  2. 验收脚本的建造策略只会在「建造菜单全 disabled」时才去银行兑换，
     而道路（木1砖1）几乎总可建，于是资源持续被路消耗、村庄永远差一两种资源。
  这一项**保持 NOT_RUN（终局段）**，不写成 PASS。若要补，需要更聪明的资源规划策略
  （或直接在验收里用 2:1 港口换齐），不是修产品代码。
- 结算页 / 回到房间：随终局一起未验证。
- Edge / Safari、真机平板手机、200% 缩放、色盲复核：仍 NOT_RUN。
