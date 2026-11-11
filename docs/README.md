# 文档索引

> **2026-11-10 原型第二轮优化：** [晴湾纸雕优化任务书](./20-papercut-refinement.md)与[可复制 AI 提示词](./20-papercut-refinement-prompt.md)：两步滑条交易、可读性和轻量游戏动效。仅为待实施要求。

> **2026-11-10 后续建设入口：** [`19-desktop-first-guide.md`](./19-desktop-first-guide.md)。接下来优先完成桌面布局、游戏交互与美术，平板/手机专项适配暂缓。包含 PC-0～PC-5 实施顺序、规则保留清单、验收要求与可复制的 AI 提示词。此为新计划，不代表代码已完成；下方 D 阶段记录保留为历史事实。

> ✅ **2026-11-09 最新：阶段 D 已由用户判定放行**，但**完整保留真实的未测试口径**（放行 ≠ 全部验证通过）。通用横屏（CSS 自旋转 + 系统锁定渐进增强）已交付：放行时 **435 passed + 2 todo**、typecheck/build 通过、跨浏览器复跑 44 PASS / 0 FAIL / 23 NOT_RUN / 14 BLOCKED。权威结论与**未测试清单**见 [`18-universal-landscape-delivery.md`](./18-universal-landscape-delivery.md) 第 4 节，UX 规格见 [`17`](./17-universal-landscape-ux.md)。
> ✅ **同日放行后补验**（`18` §4.7，历史快照一律未改写）：**461 passed + 2 todo**；历史 browser-verify 复跑 55/1/42/16（`D01-10`、`D03` 全 7 项转 PASS）；新增 26 条 P1–P8 / 状态迁移 / 降级文案单测；独立终局复验 6/6 PASS（4 bot 打到 turn 326 / `phase=ended`，真实 Chrome 同名重连验证结束页与「回到房间」）。**仍未取证**：iOS Safari、微信内置、国产自带浏览器（夸克/华为）、A-13 物理转机、第三方 IME、`FLOW-09` 的 4 浏览器页面全 UI 完整对局、`UL-C04/C05` 协议补证、`FLOW-07` 富资源种子态。
> 下方 2026-11-07 的「质量门 FAIL / 阶段 D 继续保持未通过」是**历史快照**，保留不改写。

> **2026-11-07 阶段 D：代码修复完成，验收仍未通过。** 六项缺陷（D-01~D-06）与横屏布局收尾已修完，387 passed + 2 todo、typecheck/build 通过；手机竖屏新增「进入横屏」一键按钮（见 `16` §1.2）；浏览器实跑核心链路与掷 7 行动矩阵通过，但**浏览器完整对局未到结束、真机清单未跑完**。按最严格口径质量门判定 FAIL，阶段 D 继续保持「未通过」。开工前先读 [`15-phase-d-review.md`](./15-phase-d-review.md) 第 13 节（修复与再验收结果、剩余待办），第 1–12 节是初检历史快照；Android 真机补测与 D-07 修复见 [`16-android-device-verification.md`](./16-android-device-verification.md)。`14` 记录实现交付。

> **2026-11-06 重构规划补充：** 移动端与交互改造请先读 [`10-refactor-guide.md`](./10-refactor-guide.md)。其中记录本轮确认的横屏方向、多报价时限与冷却、掷 7 处理方案；这些是待实施目标，不代表以下历史实现状态已经更新。

> **2026-11-06 阶段 A 已完成：** 可恢复基线、实测结果、现状缺陷与规则契约见 [`11-phase-a-baseline.md`](./11-phase-a-baseline.md)。本文件与 `08-status.md` 里的「224 个测试全绿」是历史数字，已过时。

> 状态：**已实现**，本地可玩。上线未完成（账号问题）。测试数量以当次 `pnpm test` 输出为准。
> **别再从零读文档**——先看 `08`，它会告诉你现在到哪一步了。

## 文档清单

| 顺序 | 文档 | 内容 | 什么时候看 |
|---|---|---|---|
| 最新计划 | [`19-desktop-first-guide.md`](./19-desktop-first-guide.md) | **桌面优先建设指南、视觉与交互规格、阶段任务、验收和 AI 交接提示词** | ⭐️ **接下来实施先看** |
| 0 | [`08-status.md`](./08-status.md) | **实现状态、代码与文档的对应、已拍板但没写进规则文档的决定** | ⭐️ **每次开工先看** |
| 1 | [`06-variant-rules.md`](./06-variant-rules.md) | **变体规则——实际实现依据，最高优先级** | 改规则前必读 |
| 2 | [`01-PDR.md`](./01-PDR.md) | 产品定位、设计原则、功能需求 | 想知道"为什么这么做" |
| 3 | [`03-trade-and-ux.md`](./03-trade-and-ux.md) | 交易模型、交互流程、移动端布局 | 动交互和界面时 |
| 4 | [`07-visual-design.md`](./07-visual-design.md) | 视觉规范（色值、字体、组件） | 调视觉时 |
| 5 | [`05-decisions.md`](./05-decisions.md) | 决策清单 | 查历史决策 |
| 6 | [`04-architecture.md`](./04-architecture.md) | 技术选型 ⚠️ **部分过时，见 08** | 了解骨架，但别照抄结论 |
| 7 | [`02-rules-spec.md`](./02-rules-spec.md) | 官方规则基线，**仅作参照** | 对比"偏离官方多少" |
| 8 | [`11-phase-a-baseline.md`](./11-phase-a-baseline.md) | 重构阶段 A：基线提交、实测结果、现状缺陷与规则契约 | ⭐️ 重构期间开工前先看 |
| 9 | [`12-phase-b-prototype.md`](./12-phase-b-prototype.md) | 重构阶段 B：横屏隔离原型、视口核对、验证结果与真机待办 | 动布局与手势前先看 |
| 10 | [`13-phase-c.md`](./13-phase-c.md) | 重构阶段 C：协议 v2、多报价/时钟/冷却、8.2 行动矩阵、并发验收 | 改交易与掷 7 结算前先看 |
| 11 | [`14-phase-d.md`](./14-phase-d.md) | 重构阶段 D：横屏前端、相机手势、完整流程入口、连接恢复与验证差距 | ⭐️ 改前端前先看 |
| 12 | [`15-phase-d-review.md`](./15-phase-d-review.md) | 阶段 D 初检验收报告与修复清单（§1–12）+ 修复与再验收结果（§13） | 历史判定快照（2026-11-07 FAIL） |
| 13 | [`16-android-device-verification.md`](./16-android-device-verification.md) | Android 真机补测：环境、逐项观测、D-07 缺陷与修复、真机清单对照 | 真机调试 / 恢复链路 |
| 14 | [`17-universal-landscape-ux.md`](./17-universal-landscape-ux.md) | 通用横屏 UX 规格：S0–S8 状态机、C1–C8 决策、A-1…A-14 验收条目、P1–P8 复活路径 | ⭐️ 改横屏/提示/入房交互前先看 |
| 15 | [`18-universal-landscape-delivery.md`](./18-universal-landscape-delivery.md) | 通用横屏交付汇编、**阶段 D 放行判定**、**完整未测试口径** | ⭐️ **当前结论与已知边界以此为准** |

## 文档间的优先级

```
06-variant-rules.md   ← 最高（实现依据）
        ↓ 覆盖
02-rules-spec.md      ← 官方基线，只作参照

08-status.md          ← 记录「代码已经这么做了，但 06 还没写」的条目
```

**冲突处理**：`06` 与 `08` 打架时，`08` 反映的是当前代码的真实行为；
以代码为准，然后回头把 `06` 改对。

## 已过时的说法（不要被误导）

- ~~「所有决策关闭前不写代码」~~ —— 代码已写完
- ~~「没写任何代码」~~ —— 见 `08-status.md`
- `04` 里「接 WorkBuddy 云服务」「WebSocket 方案待定」「事件溯源」三条均已改变

## 截图

`docs/shots/` 存的是各阶段界面截图，仅作对照参考，不代表最新版本。
