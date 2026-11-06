# 重构阶段 C：协议 v2、报价时序与行动矩阵

> 日期：2026-11-06（Asia/Shanghai）
> 依据：`docs/10-refactor-guide.md` 第 1、7、8、10.3、12（阶段 C）、13.2、14 节。
> 状态：**阶段 C 已完成，停在验收点**；未做阶段 D 的前端完整流程、阶段 E 美术、阶段 F 发布。
> 回滚点：`1f6210c`（阶段 A+B 交付）。本阶段之后的回滚命令：`git reset --hard 1f6210c`。
> 前置：用户以「勉强合格」验收阶段 B 并同意进入 C；**B 的真机点选与 CDP 视口截图仍未执行，属已知风险**。

---

## 1. 本阶段做了什么

| 层 | 文件 | 改动 |
|---|---|---|
| 协议 | `packages/protocol/src/index.ts` | 升级到 v2：`OfferView{id,createdAt,expiresAt}`、`OfferSnapshot{offers,version,serverTime,nextSendAt}`、`OFFERS` 广播、按 ID 的 `OFFER_ACCEPT/REJECT/CANCEL`、可选 `rid`、`JOIN` 保留 `v`、`JOIN_FAILED.PROTOCOL_MISMATCH`、新增 `OfferRejectReason` 与 `RATE_LIMITED`；数值常量 `OFFER_TTL_MS=10_000`、`OFFER_SEND_COOLDOWN_MS=3_000`、`MAX_LIVE_OFFERS_PER_PLAYER=1` |
| 引擎 | `packages/engine/src/engine.ts` | `pendingRobber` 从「只放行 MOVE_ROBBER」改为按 8.2 矩阵：放行建造 / 银行 / 借港 / 玩家交易，继续禁 5 种发展卡命令与 `END_TURN` |
| 服务端房间 | `apps/server/src/room.ts` | 单条 `offer` 字段 → 多条队列；可控时钟 `now()`；ID / 时间戳 / 列表版本 / 冷却表 / 有限期过期 ID 表；原子替换、按 ID 处理、串行接受、三个清空时点、懒清理与 `purgeExpired()`、恢复快照、`rid` 回显 |
| 服务端路由 | `apps/server/src/server.ts` | JOIN 校验 `v`（不匹配直接拒绝）、WELCOME 带 `snapshot` 与 `stateSeq`、报价命令传 `offerId` 与 `rid`、传输层每秒 60 条限流、每 1s 过期清理广播 |
| 前端适配 | `apps/web/src/{net,main,ui}.ts` | 按 ID 发接受/拒绝/撤回；`setOffers(snapshot, viewer)` 适配多报价（只显示第一条相关报价 + 总数）；WELCOME/OFFERS 恢复快照；STATE 用 `seq` 防旧更新覆盖；新错误码文案与版本不匹配提示 |
| 验收脚本 | `apps/server/scripts/{seed-room.ts,bot.ts,reconnect-check.mjs}` | 三个脚本的 JOIN 补 `v`，否则会被新服务端拒绝（指南 10.3「检查整个收发链路」） |
| 文档 | `06`、`08`、`README`、本文件 | 规则变更与过时状态订正 |

**前端只做协议适配，不是阶段 D 的完整 UI**：多报价列表/详情抽屉、倒计时、发送冷却秒数、收件人视角完整转换、断线恢复流程都还没做，相关 `it.todo` 留给 D。

---

## 2. 协议 v2 是不兼容升级

- `PROTOCOL_VERSION` 1 → 2；`decodeClientMessage('JOIN')` 现在**保留 `v`**，服务端逐条比对，缺失或不一致直接 `JOIN_FAILED { reason:'PROTOCOL_MISMATCH' }`。
- 服务端不再发送单条 `OFFER` 消息，改发 `OFFERS { snapshot, reason, offerId? }`；`decodeServerMessage` 也不再识别 `OFFER`。
- 没有 `offerId` 的 `OFFER_ACCEPT/REJECT/CANCEL` 在解析层直接返回 `null`，**不会**退化成「处理当前那条」。
- 旧前端 + 新服务端会被拒绝入座；新前端 + 旧服务端会收到无法解析的 `OFFERS`。发布必须前后端同版本（指南 12 阶段 F）。

### 2.1 全链路核对（指南 10.3）

| 收发点 | 处理 |
|---|---|
| `net.ts join()` | 已带 `v: PROTOCOL_VERSION` |
| `net.ts accept/reject/cancelOffer()` | 改为带 `offerId`，可选 `rid` |
| `main.ts WELCOME` | 读 `snapshot`、`stateSeq` |
| `main.ts OFFERS / STATE` | 新消息 + `seq` 防旧覆盖 |
| `ui.ts` | `setOffers` 与回调全部带 ID |
| `server.ts JOIN / WELCOME / 报价路由 / COMMAND` | 全部同步 |
| `server.test.ts` | `TestClient.send()` 自动补 `v`；另有专门用例验证不带 `v` 被拒 |
| `seed-room.ts` / `bot.ts` / `reconnect-check.mjs` | 三个脚本 JOIN 补 `v`（mjs 里硬编码 2 并注释需与常量同步） |

---

## 3. 报价时序的实现要点

- **时钟权威**：`Room` 注入 `now()`（默认 `Date.now`，测试用可控时钟）。`expiresAt = createdAt + 10_000`；`acceptOffer` 每次都用服务端时钟复查，即使清理定时器没跑也不能误成交。
- **冷却**：每位玩家成功发出后 `nextSendAt = now + 3_000`，存在 Room 内存里，重连不清除；无效请求不更新冷却；撤回不退还冷却。
- **原子替换**：所有校验（座位 / 权限 / 弃牌锁 / 内容 / 冷却）都在替换之前；新请求失败时旧报价保留。成功后先移除本人旧报价再加入新报价，ID 全新、重新计时。
- **串行裁决**：`acceptOffer` 在**一次同步处理**内完成「查 ID → 查过期 → 校验收件人 → 引擎结算 → 删该 ID → 广播」；JS 单线程保证不会插入另一条消息。资源不足时**保留报价至到期**并提示，不悄悄改数量。
- **明确原因**：有限期（60s）记录最近过期的 `offerId`，区分 `OFFER_EXPIRED` 与 `OFFER_NOT_FOUND`；替换/清空的旧 ID 返回 `OFFER_NOT_FOUND`，别人的报价返回 `OFFER_NOT_FOR_YOU` / `OFFER_FORBIDDEN`。
- **三个清空时点**：掷 7（用权威 `state.dice` 判断，不信客户端传的）、`END_TURN`、`phase === 'ended'`；广播 `OFFERS.reason` 分别为 `ROLL_SEVEN` / `END_TURN` / `GAME_END`。
- **权限**：`seat === current || to === current`；弃牌期间 `pendingDiscards` 非空时禁止创建与接受报价；强盗待移动时交易已恢复。
- **负载保护**：业务冷却之外，服务端每连接每秒 60 条消息的传输层限流（`RATE_LIMITED`），避免错误请求刷屏。

## 4. 第 8.2 节行动矩阵（引擎 + 服务端一致）

| 状态 | 弃牌 | 建造/银行/借港 | 玩家交易 | 发展卡 | 结束回合 |
|---|---|---|---|---|---|
| 普通行动 | 不适用 | 当前玩家可做 | 至少一方为当前玩家 | 按原规则 | 已掷骰才可 |
| 有人尚未弃牌 | 仅需要弃牌者 | 禁 | 不能创建或接受 | 禁 | 禁 |
| 弃完、强盗待移动 | 不适用 | **恢复** | **恢复**（受冷却） | **仍禁**（引擎 `ROBBER_PENDING`） | **仍禁** |
| 强盗已处理 | 不适用 | 正常 | 正常 | 正常 | 按原规则 |

`packages/engine/test/robber.test.ts` 中「弃牌清空后除 MOVE_ROBBER 外一律被锁（含 TRADE_BANK）」的旧断言已按指南 14.8 同步改写：现在断言银行兑换**真的成交**、发展卡与结束回合仍被拒。

---

## 5. 验收结果

| 命令 | 结果 |
|---|---|
| `pnpm test` | **290 passed + 2 todo**：engine 139+2todo / protocol 20 / server 61 / web 70，全绿 |
| `pnpm typecheck` | 四包全部通过 |
| `pnpm build` | 成功；`apps/web/dist/assets/index-BofJmwxw.js` 54.70 kB、`index-2ILt2oS4.css` 25.56 kB、`dist/server.cjs` 193.3 KB |

阶段 A 留下的 **22 条目标 todo 已全部转成真实断言**（protocol 5 条、server 11 条、engine 引擎层 4 条）；仅剩 2 条属于阶段 D 的 UI 项故意保留为 `todo`：
「强盗待办可暂时收起去建造/交易」与「游戏结束优先于普通面板的前端呈现」。

### 5.1 不靠 UI 也能验证的验收项（指南阶段 C 完成门槛）

越权（非当前玩家之间报价、非收件人接受、撤回别人报价）、过期（9.999s 成交 / 恰好 10s 拒绝 / 定时器未跑也拒绝 / 客户端慢时钟不影响服务端）、冷却（连发、无效请求不顺延、重连不绕过、撤回不退）、重复请求（旧 ID、已接受 ID、掷 7 后再接受）、资源争用（两条报价不会扣成负数、资源不足保留报价）、并发交错（接受与掷 7、重发替换旧的 ID）、恢复快照（版本 / 服务端时间 / 下次可发时间 / 只恢复未过期）、`rid` 关联与版本不匹配入座 —— 均有服务端测试覆盖，见 `apps/server/test/contract-offers.test.ts`（23 条）与 `packages/protocol/test/contract-protocol.test.ts`（11 条）。

---

## 6. 未完成 / 明确不在本阶段

- 阶段 D：前端多报价列表与详情抽屉、倒计时与冷却秒数、给/要视角完整呈现、完整命令入口、断线恢复与离线反馈、棋盘相机与手势接入 `apps/web`（当前仍无双指缩放）。
- 阶段 E 美术、阶段 F PWA / 发布 / 回退。
- 阶段 B 的真机点选与 CDP 视口截图（用户以「勉强合格」验收，仍属风险）。
- 指南 10.3 的独立发布事项：不可猜测的恢复凭证、服务端快照持久化、公共分数信息公开规则 —— 未实施，需单独立项。

### ⚠️ 发布相关的硬边界

`release/` 仍是 15:22 的旧打包（v1 前端 + 旧服务端），**与本阶段的 v2 协议不兼容**。本阶段没有更新 `release/`、没有触碰线上房间（指南 14.9）。`pnpm build` 只更新了 `apps/web/dist` 与 `apps/server/dist/public`。正式发布时必须前后端同版本一起上，并安排活动房间排空；直接用旧 `release/` 配新前端会导致 `PROTOCOL_MISMATCH`。

---

## 7. 回滚与下一步

```bash
git reset --hard 1f6210c     # 撤销阶段 C 全部改动，回到 A+B
git log --oneline -3         # 核对当前位置
```

**下一步**：请验收阶段 C（重点看报价过期/冷却/替换的边界与 8.2 矩阵是否符合预期）。确认后进入**阶段 D：前端完整流程** —— 接新协议与相机，补齐第 6 节所有入口、断线恢复、触屏说明与焦点管理，并以一次完整多人对局验证；届时仍按逐段验收给出 diff、测试结果与回滚命令。
