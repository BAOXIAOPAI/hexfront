# 重构阶段 A：基线、实测结果与规则契约

> 日期：2026-11-06（Asia/Shanghai）
> 依据：`docs/10-refactor-guide.md` 第 12 节阶段 A；第 1、7、8 节的已确认决定。
> 状态：**阶段 A 已完成，逐段验收暂停点**。本阶段只新增基线、测试与文档，**未修改任何应用源码**，未运行真机、未发布、未覆盖 `release/` 与线上版本。
> 下一阶段按指南第 12 节应为**阶段 B（横屏交互原型）**，见 `12-phase-b-prototype.md`；阶段 C 在 B 之后。初稿曾误写成「A → C」，已订正。

---

## 1. 可恢复版本基线

本轮开始时目录不是 Git 仓库（指南 A 第 2 条）。经用户确认后在项目内建立基线：

| 项 | 值 |
|---|---|
| 基线提交 | `887043d` — `chore: 重构前基线快照（指南阶段 A）` |
| 提交时间 | 2026-11-06 17:38:24 +0800 |
| 纳入文件 | 113 个（含 `docs/`、`apps/web/dist`、`apps/server/dist/public`、`release/`） |
| 新增 `.gitignore` | 仅忽略 `node_modules/`、`.DS_Store`、`*.log`；构建产物**故意纳入**，用于核对源码与产物是否同步 |
| 提交后工作区 | 干净（`git status --short` 无输出） |

**回滚**：丢弃本阶段全部改动并回到基线，执行 `git reset --hard 887043d`；只回滚单个文件用 `git restore <路径>`。基线提交只新增 `.git/` 与 `.gitignore`，未改动任何原有文件。

---

## 2. 实测基线（不沿用旧文档数字）

| 命令 | 结果 |
|---|---|
| `pnpm test`（基线提交前） | **248 个全绿**：engine 132 / protocol 9 / server 37 / web 70。`08-status.md` 与 `docs/README.md` 写的「224」已过时 |
| `pnpm typecheck` | 四个包全部 `Done`，无错误 |
| `pnpm build` | 成功。Vite 31 modules，`dist/assets/index-C3OUP-fd.js` 54.01 kB、`index-2ILt2oS4.css` 25.56 kB；`dist/server.cjs` 185.5 KB |
| `pnpm test`（加入契约测试后） | **268 passed + 22 todo**：engine 137+6 / protocol 17+5 / server 44+11 / web 70。全绿 |
| `pnpm typecheck`（加入契约测试后） | 四个包全部通过 |

Vitest 把 `it.todo` 计为 skipped，不是失败；它们是指南第 13.2 节验收条目的占位，阶段 C 实现后逐条改成真实断言。

## 3. 源码入口与构建产物的关系

- `pnpm build` 之后 `git status --short` **只显示本阶段新增的测试文件**，没有任何产物差异 → 当前 `apps/web/dist`、`apps/server/dist/public`、`apps/server/dist/server.cjs` 与源码同步，且构建可复现。
- `apps/web/dist/assets/*` 与 `apps/server/dist/public/assets/*` 的 SHA-256 完全一致（`server.cjs` 构建时会把前端 dist 复制到 `dist/public`）。
- **`release/` 是更旧的一版，不由 `pnpm build` 更新**：

| 位置 | 文件 | 时间 |
|---|---|---|
| 当前构建 | `apps/web/dist/assets/index-C3OUP-fd.js`、`index-2ILt2oS4.css` | 16:28（本轮重建后内容不变） |
| 发布包 | `release/public/assets/index-HQmKGSS3.js`、`index-BYbB3Jx7.css` | 15:22 |
| 当前构建 | `apps/server/dist/server.cjs` | 17:38 重建，内容与基线一致 |
| 发布包 | `release/server.cjs` | 15:22，SHA-256 与当前构建不同 |

结论：按指南 1.1 与 14.9，**不声明线上版本与源码一致**，本阶段也不把指南当部署授权。`release/` 与线上房间原样不动，发布与回退留到阶段 F 单独处理。

---

## 4. 现状缺陷与目标行为（分开记录）

### 4.1 已用可执行断言固化的现状缺陷

| 指南条目 | 现状（本阶段证明为真） | 证据测试 |
|---|---|---|
| 2. P0 / 7.3 | 新报价直接覆盖 `Room.offer`，`OFFER_ACCEPT` 无 ID；旧页面的「接受」会成交一条用户没看过的新报价（给 1 木 → 被换成给 3 木，成交后木头归零） | `apps/server/test/contract-offers.test.ts` 第 1 个用例 |
| 7.1 | 房间同时只保留 1 条报价；A/B/C 先后挂价，前两条被静默覆盖 | 同上 |
| 7.1 | 非当前玩家也能向另一个非当前玩家报价 | 同上 |
| 7.2 | 无 3 秒冷却（连发两次都成功）、无 10 秒期限（报价对象只有 `from/to/give/get`，没有 `id/createdAt/expiresAt`） | 同上 |
| 7.2 / 8.1 | 掷 7 **不清空**报价；房间只在 `END_TURN` 分支清理 | 同上 |
| 7.3 | `OFFER_ACCEPT/REJECT/CANCEL` 都不带 `offerId`；`OFFER`/`WELCOME` 只带单条 `offer`，没有列表、版本、服务端时间 | `packages/protocol/test/contract-protocol.test.ts` |
| 10.3 | `decodeClientMessage('JOIN')` 丢掉 `v`，`PROTOCOL_VERSION` 目前无法真正拒绝错位客户端 | 同上 |
| 8.2 | **弃完、强盗待移动时，引擎把除 `MOVE_ROBBER` 外的一切全锁**（含建造/银行/借港/玩家交易），与指南要求「恢复建造、交易、兑换」冲突 | `packages/engine/test/contract-actions.test.ts` |

### 4.2 已实现且阶段 C 必须保留的行为（回归基线）

- 弃牌 8 张起、弃一半向上取整，9 张弃 5 张，由玩家自选具体牌；数量不符拒绝提交。
- 有人尚未弃牌时只放行 `DISCARD`（`DISCARD_PENDING`），包括拒绝挪强盗与结束回合。
- 强盗移动完成后恢复行动，`END_TURN` 不再被强盗锁拦住。
- `END_TURN` 清空报价、座位以连接为准、客户端传的 `dice` 默认被剥离、他人隐藏手牌在视角里根本不存在。

### 4.3 已知测试冲突（阶段 C 必须同步处理）

`packages/engine/test/robber.test.ts:106` 的用例断言「弃牌清空后，除 `MOVE_ROBBER` 外一律被锁」，其中明确包含 `TRADE_BANK` 应返回 `ROBBER_PENDING`。指南 8.2 已确认该状态下银行兑换应恢复。阶段 C 修改 `engine.ts:69` 的前置锁时**必须同步更新这条断言**；指南 14.8 明确允许为确认的规则变更更新旧断言，其余规则仍做回归保护。

---

## 5. 本阶段新增的契约测试

| 文件 | 内容 |
|---|---|
| `packages/protocol/test/contract-protocol.test.ts` | 第 1 节数值契约（10 秒 / 3 秒 / 每人 1 条 / 8 张起向上取整 / 三个清空时点）+ 协议现状缺陷 + 5 条阶段 C 协议目标 `todo`。文件内 `CONTRACT` 是这些数值的单一来源 |
| `apps/server/test/contract-offers.test.ts` | P0 报价接受竞态复现 + 单报价/无冷却/无期限/权限/掷 7 不清空等现状证据 + 11 条阶段 C 服务端目标 `todo` |
| `packages/engine/test/contract-actions.test.ts` | 弃牌取整与自选回归 + 8.2 行动矩阵现状（含与目标矩阵的冲突说明）+ 6 条阶段 C 引擎目标 `todo` |

三个文件共新增 **20 个真实断言 + 22 个目标 `todo`**，全部能在当前代码上跑绿；目标行为不写成「已实现」。

---

## 6. 阶段 A 完成门槛核对

| 门槛 | 状态 |
|---|---|
| 确认源码入口与构建产物关系，记录现有画面及关键流程 | ✅ 已核对源码、dist、release 的时间与哈希；`docs/shots/` 现有截图仅作历史参考，**尚未采集本轮浏览器画面**（留待阶段 B 真机/浏览器验证） |
| 有可恢复版本基线 | ✅ `887043d`，113 文件，工作区干净，附回滚命令 |
| 跑 test / typecheck / build 并记录实际结果 | ✅ 见第 2 节，不沿用 224 |
| 第 1、7、8 节转成测试用例，先覆盖旧报价接受竞态 | ✅ 见第 5 节，竞态为首个用例 |
| 现状缺陷与目标行为分开记录 | ✅ 第 4 节 |
| 明确第 10 节独立发布事项的采用范围 | ⏸ 本轮不处理身份凭证、内存房间持久化、JOIN 版本链路、公共分数信息公开规则；留到阶段 C/F 单独立任务 |

> 「现有浏览器画面」一项只做到核对已有截图与构建产物，未做本轮真机/浏览器采集。若验收要求严格，可先启动本地服务补一张当前界面截图再进入阶段 C。

---

## 7. 本阶段明确未做

- 阶段 B 横屏原型与真机点选/双指测试、阶段 E 美术素材与动效、阶段 F PWA 与发布回退。
- 不改动 `release/`、不触碰线上房间、不反复覆盖现有线上游戏（指南 14.9）。
- 不把 `it.todo` 当成已完成能力；不把本文件当成部署授权。

**下一步（顺序已订正）**：用户确认阶段 A 后，先做**阶段 B 横屏交互原型**（见 `12-phase-b-prototype.md`），再进阶段 C —— 协议与服务端规则（多报价、ID、过期、冷却、替换、清空、恢复快照与错误码；放开弃牌完成后的建造/交易；补并发与时钟边界测试）。届时需逐处给出 diff、测试结果与回滚命令。
