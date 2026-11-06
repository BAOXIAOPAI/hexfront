# 六角拓荒 · 夜间自动推进 — 执行记录

## 2026-11-05 23:45 · 第 1 轮
- 基线：绿（engine 117 测试 / tsc 0 错）
- 完成任务：T1 服务端骨架（`apps/server`，23 测试全绿 + tsc 0 错 + esbuild 打包验证）
- 下一轮起点：T2 前端骨架（Vite + 原生 TS，迁移 `prototype/ui.html`，消费 PlayerView）
- 环境注意：pnpm 11.5 的 esbuild 构建许可已修好（pnpm-workspace.yaml 的 allowBuilds 必须为布尔），改动后 `pnpm -r` 脚本才不再报错

## 2026-11-06 00:45 · 第 2 轮
- 基线：绿（engine 117 / server 23 / 双端 tsc 干净）
- 完成任务：T2 前端骨架（`apps/web`：Vite + 原生 TS，消费 PlayerView；17 前端测试全绿、tsc 0 错、vite build 31KB）
- 顺带重构：新包 `packages/protocol` 承载消息契约，server 侧改为转出，契约不再各写一份
- 端到端验收通过：真 Chrome（CDP）+ 真 WS + 真服务端，19 格/9 港/4 建筑对账一致，掷骰后骰子与日志正确
- 修掉三个只在真机验收暴露的问题：构建后 WS 连 `/` 被静态服务吃掉、骰子动画留假点数、每帧重播入场动画
- 下一轮起点：T3 摆位交互（顶点/边热区 + 双端进度同步），引擎侧命令已就绪
- 环境注意：8787 端口被陌生进程占用且会返回鉴权错误，验收改用 8899；先看 lsof 再怀疑代码
- 产物：`docs/shots/web-desktop-2026-11-06.png`、`apps/server/scripts/{seed-room.ts,web-e2e.mjs}`

## 2026-11-06 01:52 · 第 3 轮
- 基线：绿（engine 117 / protocol 7 / server 23 / web 17，四边 tsc 干净）
- 完成任务：T3 开局摆位（新增 `apps/web/src/placement.ts` 纯逻辑 + 棋盘热区 + 左下角摆位进度条；web 测试 17→29）
- 端到端验收通过：双标签页真 Chrome，甲摆位→乙同步 step=1→按 [0,1,1,0] 摆完 4 手→phase=play、4 村 4 路、摆位条收起；控制台 0 错误
- 返工一处：候选边初版对比度太低（浅金虚线压在沙滩上不可见），改深金 + 白晕 + 流动虚线
- 下一轮起点：T4 掷骰与产出（地块高亮 + 掷 7 弃牌面板与弃完才能继续的锁）
- 环境注意：8787 仍被陌生进程占用，本轮全程用 8899 + `vite preview` 4173（配 `HEXFRONT_WS_TARGET`）
- 产物：`docs/shots/web-setup-2026-11-06.png`、`docs/shots/web-setup-hint-2026-11-06.png`、`apps/server/scripts/web-setup-e2e.mjs`
