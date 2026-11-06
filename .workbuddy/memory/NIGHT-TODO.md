# 夜间推进清单

> 目标（用户已确认）：**联机可跑**
> 传输层已定为：自建 Node WebSocket，房间在内存持有 GameState，按 `viewFor()` 裁剪后广播。
> 范围：localhost + 同一 WiFi 内网 IP，不做公网部署、不做云服务。
> 节奏：每小时一轮，每轮只做一个任务，做完必须测试全绿。

---

## 基线状态（2026-11-06 01:50）

- `packages/engine`：117 个测试全绿，`tsc` 零错误
- `packages/protocol`：7 个测试全绿（前后端共用消息契约）
- `apps/server`：23 个测试全绿（含真实 socket 集成），`tsc` 零错误，`esbuild` 打包 176KB 单文件
- `apps/web`：29 个测试全绿，`tsc` 零错误，`vite build` 产出 34.7KB JS / 14.9KB CSS
- 规则已闭环：开局 / 掷骰 / 产出 / 弃牌 / 建造 / 发展卡 / 交易 / 借港 / 最长路 / 最大军 / 计分 / 胜负 / 视角投影
- 传输层：**已可联机**。`/ws?sharecode=xxx` → JOIN / START / COMMAND → 按座位裁剪后广播 STATE
- 前端：**摆位闭环**。点路口→点边→服务端结算→两端同步；摆完自动进 play
- 未做：掷骰 7 的弃牌面板与地块高亮（T4）、建造与交易面板（T5/T6）、断线重连体验（T7）、单端口发布（T9）


---

## 任务列表

每轮只挑**一个未完成项**。完成后勾掉并写日志。

### T0 · 验证部署可行性 ✅ 已完成（2026-11-05 23:30）
> 结论：**支持 WebSocket**，但连接必须带 sharecode。

- [x] 已用最小 WS echo 服务发布验证（零依赖手写握手，`probe/ws-check`）
- [x] **不带 sharecode** → `wss://ws-check.app.workbuddy.host/` 返回非 101，被反向代理拦下
- [x] **带 sharecode** → `wss://ws-check.app.workbuddy.host/?sharecode=OE7OJUOCS2` → OPEN + CONNECTED + ECHO 全通
- [x] 线上探针地址：https://ws-check.app.workbuddy.host/?sharecode=OE7OJUOCS2

**对架构的影响**：
1. 按自建 WebSocket 走，不需要退回云数据库监听
2. 前端必须从 `location.search` 取 `sharecode`，拼进 WS URL：`wss://host/?sharecode=xxx`
3. 反向代理用 sharecode 做鉴权，说明**任何未授权的第三方连不进来**，安全性反而是加分项
4. 发布平台把 Node 服务当作单端口 HTTP 服务跑，`PORT` 环境变量 + `0.0.0.0` 必须遵守

### T1 · 服务端骨架 ✅ 已完成（2026-11-05 23:45）

- [x] `apps/server`：Node + `ws`，端口 8787（`process.env.PORT` 优先），监听 `0.0.0.0`
- [x] 房间对象：`Room { id, board, game, sockets: Map<seat, SocketLike>, members }`
- [x] 消息：`JOIN {roomId, name}` / `START` / `COMMAND {cmd}` / `PING`
- [x] 收到 COMMAND → `applyCommand` → 成功则给房间内每个人推 `STATE {seq, events, view}`
- [x] 失败则只回给发起人 `REJECT {reason}`
- [x] 验收：两个 ws 客户端连同一房间，A 发 `ROLL_DICE`，两人都收到同一 seq 的新视图 ✅（`test/server.test.ts`）

**实现要点（后续复用）**：
- `src/room.ts` 只依赖 `SocketLike { send(data) }`，不认识 ws，单测用假 socket 跑
- **座位以连接为准**：`COMMAND` 里的 `seat` 一律被覆盖，客户端改 JSON 也顶不了别人的号
- `sync()` 由调用方触发（不是 join 里直接广播），保证 `WELCOME` 一定先于第一条 `STATE`
- 未开局推 `LOBBY`，开局后推 `STATE`；断线只标记 `connected:false`，座位不释放
- 打包用 `build.mjs`（esbuild JS API）→ `dist/server.cjs` 单文件，发布只需 `node dist/server.cjs`

### T2 · 前端骨架 ✅ 已完成（2026-11-06 00:40）

- [x] `apps/web`：Vite + 原生 TS（无框架）
- [x] 从 `prototype/ui.html` 迁移视觉（海洋、地块插画、港口、手牌弧、底栏按钮厚度）
- [x] 渲染改为消费 `PlayerView`，零硬编码数据
- [x] 验收：页面显示服务端推来的真实棋盘（真浏览器 + 真 WS + 真服务端，19 格 / 9 港 / 4 建筑 / 4 路全对得上）

**实现要点（后续复用）**：
- 协议抽成 `packages/protocol`，server 的 `src/protocol.ts` 只做 `export *`，前后端共用一份契约
- WS 统一走同源 `/ws`：开发期 Vite 代理到 8787，发布期 Node 直接处理 upgrade。**不要再写 dev/prod 两套路径**（首次验收就栽在这：构建后连的是 `/`，被静态服务吃掉了）
- 几何不硬编码 19 格：从 `view.tiles` 的 key（`u,row`）反推每行格数再 `buildGeometry`，30/37 格将来零改动
- 入场动画只放一次（`#board.no-anim` / `#hand.no-anim`），否则每条 STATE 重绘都会让棋盘闪一下
- 骰子滚动动画结束后**必须回填服务端点数**（`spinDice` 计时器里清 `lastDice` 再 `paintDice`），否则屏幕上留一对假骰子
- `?name=&room=` 直达链接：分享 / 刷新都能回到原座位（依赖服务端「同名重连」）
- 调试钩子 `window.__hex`（view / seat / client / wsUrl），自动化验收直接读它，不参与业务逻辑

### T3 · 开局流程打通 ✅ 已完成（2026-11-06 01:50）

- [x] 进入房间后显示「等待开局 / 开局摆位」
- [x] 当前摆位玩家能点顶点放村庄 + 选边放路
- [x] 8 次摆位完成后自动进入正式回合
- [x] 验收：两个标签页同步看到摆位进度变化

**实现要点（后续复用）**：
- 摆位提示抽成 `apps/web/src/placement.ts`（纯函数，无 DOM），可单测；`setupInfo / candidateVertices / candidateEdges / setupSeats`
- 座位顺序直接 `import { setupSequence }`，不在前端复制蛇形规则
- 热区是 SVG 里的 `[data-vertex]` / `[data-edge]` 元素，**监听挂在 `<svg>` 上做事件委托**，整块 innerHTML 重画也不丢监听
- 选中村庄后只画它的邻边（`vertices: [picked]` + `edges`），否则玩家不知道该点哪条
- 换人摆位就清掉「已点村庄」的半截状态（用 `step:seat` 签名比对）
- 未轮到自己时 `overlay = undefined`，一个热区都不画 —— 省得点了全是 REJECT
- `view.setup.step` 是两端一致的唯一进度源；摆位条、顶部 phase-flag、日志都从它推导
- 摆位条 `pointer-events:none`，否则会挡住棋盘左下角的港口

### T4 · 掷骰与产出 ✅ 已完成（2026-11-06 10:10）

- [x] 掷骰按钮 → 服务端结算 → 所有客户端骰子动画 + **地块高亮** + 资源数字更新
- [x] 掷 7 进入弃牌流程：需要弃牌的玩家看到选择面板，其他人看到「等待 X 弃牌」
- [x] 验收：掷 7 后弃牌锁生效（截图见 `/tmp/d1.png`，面板显示「0/4」）

**实现要点（后续复用）**：
- `scene.ts` 的 `renderBoard` 早就有 `highlight` 参数，但调 `tileMarkup` 时**漏传第三个参数**，而 `styles.css` 里也**根本没有 `.prod` 定义** —— 两处都缺，所以高亮一直是死代码。补传参 + 补呼吸动画后才生效
- 高亮用 **2.6s 缓慢呼吸**（不是闪一下）：掷完到下次掷骰之间要一直能看出「这轮哪些地出产」
- 弃牌面板放 **棋桌右下角**，不放居中浮层：弃牌时玩家正要看底部手牌，挡了就很难受
- 面板四种资源行固定顺序（木砖羊麦矿），与手牌区一致，减少寻找成本
- 「谁该弃几张」来自 `view.pendingDiscards`（公开信息），「弃哪几张」纯本地选择，凑齐后整单发 `DISCARD`

**顺手修的安全漏洞**：
服务端原本 `applyCommand(board, game, { ...cmd, seat })` 直接透传客户端 JSON，**玩家可以指定 `dice` 字段作弊**。
现在默认剥离 `dice`，只有 `HEXFONT_FAKE_DICE=1` 的验收环境才放行（测试与 seed 用）。
新增单测：连掷 5 次都传 `[1,1]`，断言至少有一次不是 —— 钉死这条。

**seed-room.ts 修了三个 bug**（造验收场景时暴露的）：
1. 4 人满员会自动开局，脚本又发 `START`，导致消息错位 → 改成 `names.length < 4` 才发
2. `act()` 拿的是队列里最早的 STATE，会把视图覆盖回旧快照 → 改成所有连接共享回调更新同一个 `view`
3. 即使共享了 view，广播仍有先后，会读到上一条命令的 STATE → **按 `seq` 严格递增等待**才彻底解决

新增参数：`--seven`（反复掷骰直到有人要弃牌）、`--roll`（掷固定 2+3，验证产出高亮）。

### T5 · 建造
- [ ] 建造面板：路 / 村 / 城，资源不足时灰显并说明原因
- [ ] 棋盘进入放置模式，合法位置高亮
- [ ] 验收：建成后所有人同步看到新建筑

### T5 · 建造 ✅ 已完成（2026-11-06 10:40）

- [x] 建造面板：路 / 村 / 城，资源不足时**标红缺哪几种并禁用**
- [x] 棋盘进入放置模式，合法位置显示黄色虚线（复用摆位的 `BoardOverlay`）
- [x] 验收：`?build=road` 打开后，甲已有建筑的邻边出现虚线（`/tmp/b7.png`）

**实现要点**：
- 候选位算法抽成 `apps/web/src/build.ts`（纯函数 + 10 个单测），与 `placement.ts` 同构
- 三种模式的规则：道路看「空边 + 与自己建筑/路相连」；村庄看「空顶点 + 周围无建筑 + 挨自己的路」；城市看「自己的未升级村庄」
- 面板与弃牌面板**同位置互斥**（弃牌锁期间服务端只收 DISCARD，两个面板不会同时出现）
- 建造按钮的启用条件是「自己的回合 + 无弃牌锁」，**不要求先掷骰**（变体 V-1）
- 建成后自动退出放置模式（一次一个），避免连点误造
- 新增 `?build=road|settlement|city` 调试参数，仅供自动化验收直接进入某种模式

**踩坑**：
1. **`vite preview` 会缓存构建产物** —— 重新 `vite build` 后不重启 preview，页面还是旧代码，表现为「改了没反应」甚至白屏。排查时先重启 preview
2. 同帧内「渲染 + 改 DOM」会互相打架，`requestAnimationFrame` 延后一帧才稳
3. 测试断言写错两处：城市缺的其实是麦+矿两种；只铺一条路时，路另一端必然被自己的村庄按距离规则挡住（候选为空才是对的）

### T6 · 交易
- [ ] 交易面板：选对象 → 填给/要 → 发送
- [ ] 对方收到请求，接受/还价/拒绝
- [ ] 当前玩家可执行银行 4:1 与港口比例
- [ ] 允许零对价（一方给 0 张）
- [ ] 验收：交易后双方手牌同步更新

### T6 · 交易 ✅ 已完成（2026-11-06 11:05）

- [x] 交易面板：选对象 → 填给/要 → 发出
- [x] 对方看到报价横幅，可接受/拒绝；发起方可撤回
- [x] 允许零对价（一方给 0 张）
- [x] 验收：`/tmp/t3.png`（面板）、`/tmp/t5.png`（乙视角看到「甲 给 木1 要 麦1」+ 接受/拒绝）

**关键设计：报价不是引擎的一部分**
引擎的 `TRADE_PLAYER` 是「协议已达成，执行划转」。真实流程要「报价 → 接受」的协商层，
这层放在 `Room` 里（`offer` 字段 + 4 个方法），不污染纯规则引擎。

- 同一时间只允许**一条**报价（桌上只有一个人说话，多挂会变拍卖行）
- 报价**公开广播**（桌游里人人听得见），重连时随 `WELCOME` 补发
- 接受时才校验资源 —— 报价方看不到对方手牌，挂着一条对方给不起的报价是正常的
- **回合结束报价作废**（不能跨回合讨价还价）
- 客户端传的资源清单要 `sanitizeCount`：只留五种资源、正整数

**协议新增**：`OFFER` / `OFFER_ACCEPT` / `OFFER_REJECT` / `OFFER_CANCEL` 四个客户端消息，
以及服务端 `OFFER` 广播（`offer: TradeOfferView | null`）。

**踩坑（第二次同样的坑）**：`vite preview` 缓存构建产物。
改完代码 build 了但没重启 preview，页面还是旧的，白屏/连不上。
上次已经记过一次，这次又栽了 —— **改完后端协议或前端代码，必须重启 preview 再验证。**

### T7 · 断线重连 ✅ 已完成（2026-11-06 12:35）

- [x] 同名重连回到原座位，状态一致
- [x] 座位在整局期间保留，掉线不踢
- [x] 验收：`scripts/reconnect-check.mjs`（不开浏览器）

**实测结果**（房间 recon1，回合 7）：
```
座位 0 → 0，回合 7 → 7，手牌 2 → 2，建筑 8 → 8，全对
```
带报价的房间（recon2）重连后 `WELCOME.offer` 也能拿回来。

**实现说明**：
- 服务端本来就在断线时只标记 `connected:false`，不释放座位；`JOIN` 同名即重连
- **没有做 30 分钟 TTL**。朋友局里掉线的人回来还能接着打比「腾位置」重要，
  座位保留到整局结束。真要限制可以后续加，但不该现在加
- 前端 `net.ts` 已有指数退避重连 + `setConnection('reconnecting')` 提示

### T8 · 收尾 ✅ 已完成（2026-11-06 12:55）

- [x] 根目录 `README.md`：启动、两人玩、目录结构、已知限制
- [x] `pnpm dev` 一条命令起 server + web（**实测 8790 与 5173 都 HTTP 200**）
- [x] `pnpm build && pnpm start` 单端口模式
- [x] README 补了「8787 被占用怎么办」

**已知限制清单**（已写进 README）：
4 人（引擎支持 3–6 人但无 UI 入口）／一次一条报价／座位不释放／
手机棋盘偏小无缩放／房间只在内存、重启即丢／无观战／无音效。

### T9 · 部署上线 ✅ 已完成（2026-11-06 13:25）
- [x] 发布前问了用户，用户确认发布
- [x] 发布后实测线上 WebSocket 带 sharecode 能连（WELCOME + LOBBY 全通）
- [x] 线上地址：https://hexfront.app.workbuddy.host/?sharecode=EWCTT4T5YE

---

## 决策记录（夜里自己拍板的，明早 review）

> 遇到歧义时按 `06-variant-rules.md` → `01-PDR.md` 的顺序判断，决定写在这里。

| 时间 | 问题 | 决定 | 理由 |
|---|---|---|---|
| 23:30 | 传输层能否用 WebSocket | **能，但必须带 sharecode** | 实测：不带 sharecode 被反向代理拦（非 101），带上则 OPEN + ECHO 全通 |
| 23:30 | 部署形态 | 单端口 HTTP 服务（Node） | 发布沙箱只给一个端口，`PORT` + `0.0.0.0` |
| 23:42 | 房间容量与开局时机 | 容量默认 4；满员自动开局；未满员时房主发 `START` 可提前开局 | 4 人房永远等不齐人就没法测；两人局要能立刻开。`START` 只要求 ≥2 人 |
| 23:43 | 断线占座的边界 | 同名重连回原座位（原座在线则 `SEAT_TAKEN`），座位不释放 | T7 要 30 分钟保座，先把「按名字认人」这条地基打上；顶号必须挡 |
| 23:44 | 客户端传来的 `seat` 是否信任 | 不信任，一律用连接所属座位覆盖 | 否则改一行 JSON 就能替别人行动，服务端权威形同虚设 |
| 00:20 | 消息契约放哪 | 抽成 `packages/protocol` 单独包 | 前端要说同一种话，复制一份必然漂移；server 的 `protocol.ts` 只做转出，测试不受影响 |
| 00:28 | WS 路径 | **统一 `/ws`**（不再分 dev/prod） | 首次验收发现构建产物连 `/` 被静态服务吃掉；同源同路径才是唯一不会翻车的写法 |
| 00:28 | 前端地图尺寸 | 由 `view.tiles` 的 `u,row` 反推行数 | 19/30/37 格共用一套渲染，服务端换图前端零改动 |
| 00:30 | 前端是否做合法性判断 | 不做，只做「可用性提示」 | 铁律：一切变更走 COMMAND，服端裁决。按钮灰显只是省事，不是规则 |
| 00:36 | 入场动画 | 只在首帧播，后续 STATE 不重播 | 每条广播都重播会让棋盘常闪，玩起来像卡顿 |
| 00:38 | 直达链接 | 支持 `?name=&room=` 自动入座 | 刷新与分享都要能回原座，且这是自动化验收的唯一入口 |
| 01:44 | 摆位合法点在前端算不算「前端判规则」 | **算了，但只作提示**，裁决仍在服务端 | 视图里已有 buildings/roads，距离规则可推导；不画热区玩家只能瞎点。用单测把「提示的每个点引擎都接受」钉死，防漂移 |
| 01:45 | 选中村庄后还显示其他路口吗 | 不显示，只留该村庄的邻边 | 显示其他路口会让玩家以为可以换村，而引擎要求村庄与道路同一条命令原子提交 |
| 01:46 | 摆位进度条放哪 | 棋盘左下角（不居中） | 居中会压住底部的港口徽章；左下角是水面，天然空着 |
| 01:47 | 摆位进度要不要本地乐观更新 | 不要，只认 `view.setup.step` | 抢跑会在被 REJECT 时留下错误进度；等一次广播只有几十毫秒 |

---

## 阻塞项（需要用户确认，但不阻塞推进）

> 遇到这类问题：记下来，换下一个任务继续做，不要停。

- [ ] 玩家棋子在城市/村庄上的具体造型
- [ ] 掷骰动画的时长与节奏
- [ ] 手机端棋盘是否需要手势缩放

---

## 本地跑法（本轮已实测）

```bash
# 1) 服务端（8787）
cd apps/server && npx tsx src/index.ts

# 2) 前端（5173，/ws 自动代理到 8787）
cd apps/web && npx vite

# 3) 打开 http://localhost:5173/?name=甲&room=main
#    第二个人：换个浏览器窗口 / 手机同 WiFi 用 http://<内网IP>:5173/?name=乙&room=main
#    人满 4 个自动开局；2 人时在浮层点「开始游戏」
```

造一局「已摆位完成」的房间（前端联调 / 自动化验收用）：

```bash
cd apps/server && npx tsx scripts/seed-room.ts e2e 2
node scripts/web-e2e.mjs "http://127.0.0.1:4173/?name=甲&room=e2e" /tmp/shot.png
```

造一局「停在摆位第 0 步」的房间，跑双标签页摆位验收（T3）：

```bash
# 服务端换 8899（8787 常年被陌生进程占着）
cd apps/server && PORT=8899 npx tsx src/index.ts
cd apps/web && HEXFRONT_WS_TARGET=ws://127.0.0.1:8899 npx vite preview --port 4173

cd apps/server && PORT=8899 npx tsx scripts/seed-room.ts final 2 --setup
node scripts/web-setup-e2e.mjs "http://127.0.0.1:4173/?room=final" /tmp/shot.png
# 只看不点（E2E_SHOT_ONLY=1 看热区；=2 先点一个路口，检查「已选村庄 + 虚线边」）
E2E_SHOT_ONLY=2 node scripts/web-setup-e2e.mjs "http://127.0.0.1:4173/?room=hints" /tmp/hint.png
```

> 注意：端口 8787 曾被别的进程占着（返回 `missing or invalid Authorization bearer`），
> 遇到时先 `lsof -nP -iTCP:8787 -sTCP:LISTEN` 看清楚再动。

---

## 硬约束

1. 不得删除或重写已通过测试的规则模块（`packages/engine/src/rules/`）
2. 不得修改 `docs/` 下的规则文档（`06` 是最高优先级依据）
3. 每轮结束必须测试全绿；如果基线红了，本轮唯一任务是修绿
4. 不引入重型框架（React/Vue 等），除非明确证明必要
5. 前端不能直接改状态，所有变更必须走 `COMMAND` → 服务端 → 广播
