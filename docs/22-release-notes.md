> **历史/专项资料提示（2026-11-14）**：先读 [CURRENT](./CURRENT.md) 和 [当前修复任务书24](./24-production-fix-guide.md)。本文保留历史事实与未被覆盖的细节，不作为最新任务入口；冲突以当前用户决定及24为准。

# 发布决策与约束（本轮不发布）

> 2026-11-10。记录「这一版怎么上线」的调研结论、待办与硬性技术约束。
> 本轮用户决定：**先不发布；后续考虑部署到自己的 GitHub**。鉴权问题「之后再说」。
> 本文只是决策记录与约束清单，不代表已经部署，也没有改动任何部署配置。

---

## 0. 一句话结论

**这个项目从来没有接入 WorkBuddy 云服务，只把 WorkBuddy 当作「托管 Node 容器 + 反向代理」。**
因此它可以脱离 WorkBuddy 部署到任何能跑 Node 常驻进程的环境；
但**不能部署到 GitHub Pages**（纯静态托管，跑不了 WebSocket 服务端）。

---

## 1. 事实核对（为什么说「没有接入云服务」）

| 查证点 | 实际状态 | 证据 |
|---|---|---|
| 依赖清单 | 服务端只有 `ws`；前端只有 `vite`/`vitest`/`typescript`。**零云 SDK** | `apps/server/package.json`、`apps/web/package.json` |
| 服务端是否读取 `sharecode` | **从不读取**。注释写明「反向代理要求 WS 连接带 `?sharecode=xxx`，**服务端无需处理**（平台在代理层鉴权）」 | `apps/server/src/server.ts:7`、`src/index.ts:20`（仅日志） |
| 架构文档 | 云服务（数据库/认证/存储）是 **v0.2 预留接入点，从未实现** | `docs/04-architecture.md` §8 |
| 状态文档 | 「『v0.2 接 WorkBuddy 云服务』→ 改为**自建 Node WebSocket**，云服务只用于发布托管」 | `docs/08-status.md` §传输层 |
| 历史记录 | 「规则引擎纯函数、对局状态在服务端内存、WS 直连，**零云依赖**」；「启动云服务反而白耗资源点」 | `.workbuddy/memory/2026-11-06.md` |

**结论**：WorkBuddy 在这个项目里只承担「发布托管」一个角色，不承担数据、认证、函数计算。
换成任何 VPS / 容器平台 / PaaS，架构上都不需要改代码。

---

## 2. 发布产物与运行方式（已验证）

```bash
pnpm build
# → apps/web/dist                     （前端静态）
# → apps/server/dist/server.cjs       （服务端单文件，193.3 KB）
# → apps/server/dist/public/          （前端被复制进来，服务端自己托管）
```

运行（**单端口、前后端同源**，这是关键）：

```bash
cd apps/server
PORT=8801 HOST=0.0.0.0 node dist/server.cjs
```

- 环境变量只需 `PORT`（多数平台注入）与 `HOST=0.0.0.0`（容器外才能连进来）。
- HTTP 静态页 + WebSocket 由同一个端口提供，不需要额外配 CORS 或双端口。

**2026-11-10 实测（真实发布产物，非 Vite）**：
- `GET /` 返回新版首页（含 `papercut`），引用的 CSS 含纸雕 token；
- `GET /health` → `{"ok":true,...}`；
- 浏览器真实对局：`conn=open`、`tiles=19`、`players=4`、`handCards=5`、`consoleErrors=[]`；
- 截图：`docs/shots/pc1-prod-build-1440.png`。

---

## 3. 硬性约束：不能部署到 GitHub Pages

| 约束 | 说明 |
|---|---|
| **GitHub Pages 只托管静态文件** | 没有常驻进程、没有 WebSocket。本项目服务端是 `ws` + `http.createServer` 的长驻进程（`apps/server/src/server.ts:143,181`），Pages 跑不起来 |
| 资源路径是绝对路径 | `vite.config.ts` 未设 `base`，产物引用 `/assets/...`；放到 `user.github.io/repo/` 这类子路径会 404 |
| 对局状态在内存 | 服务端重启 = 进行中的对局丢失（目前无持久化，这是既有设计，不是本轮引入） |

**能用的 GitHub 相关方案**：
- **GitHub 只做代码仓库**，部署到别的平台（Fly.io / Railway / Render / 自己的 VPS / 云服务器）——推荐。
- 想用 GitHub 生态部署，选支持常驻进程与 WebSocket 的 PaaS（如 Fly.io / Railway / Render），或自己的 VPS + `systemd`/`pm2` + Nginx。

**仓库当前没有任何部署配置**（无 `Dockerfile`、`Procfile`、`fly.toml`、`vercel.json`、CI workflow）。
真要上线时需要按目标平台补一份，本轮不做。

---

## 4. 待决问题：鉴权（用户指示「之后再说」）

现状：
- `sharecode` 由 **WorkBuddy 反向代理**校验，服务端源码**零处读取**。
- 因此一旦脱离该代理部署到公网，**没有任何鉴权**：知道地址的人都能进房、抢座位、看到公开对局信息。

上线前需要三选一（本轮不实施）：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 服务端校验 `sharecode` | `JOIN` 时比对 query/env 里的 `sharecode`，不符则 `JOIN_FAILED` | 小改 `server.ts` + 补测试；与平台约定下沉到应用层 |
| B. 反向代理鉴权 | Nginx / Cloudflare Access 等 | 应用零改动，运维复杂度上升 |
| C. 不处理 | 靠「朋友间口口相传」 | 最快，但地址泄露即可被陌生人进房 |

---

## 5. 若将来仍走 WorkBuddy 托管（路线 A）

**注意：平台指针指向的 `release/` 是 11-06 的旧 v1，不含本轮纸雕改动。**

- `.wbapp_19LFId1yKptDDcBO2i5k9o.genie` 的 `localDir` = `<repo>/release`
- `release/public/index.html` 的 `papercut` 命中 = **0**；`apps/server/dist/public/index.html` = **4**
- `release/server.cjs` 189,472 B（11-06） vs `apps/server/dist/server.cjs` 197,901 B（11-10）

**所以不能直接点平台发布**，否则发出的是旧版。正确做法：

```bash
pnpm build
rm -rf release/public release/server.cjs
cp -R apps/server/dist/public release/public
cp apps/server/dist/server.cjs release/server.cjs
# 核对：grep -c papercut release/public/index.html  → 应为 4
```

已知历史阻塞：`docs/08-status.md` 记录 `workbuddy_sites_deploy` 返回 `SITES_ACCOUNT_MISMATCH`
（应用记录属于另一个账号）。这是平台侧账号权限问题，代码侧无法解决，需在平台上确认。

> `docs/19-desktop-first-guide.md:62,336` 明确：`release/` 是旧 v1 打包，不要拿来部署 v2；
> 发布时应从当次源代码重建。

---

## 6. 上线前检查清单（本轮未执行，留待发布轮）

- [ ] 从当次源码 `pnpm build` 重建，不用旧 `release/` 或旧 `dist`
- [ ] 核对前后端 `PROTOCOL_VERSION` 一致（当前 `2`，见 `packages/protocol/src/index.ts:16`）
- [ ] 确认 `PORT` / `HOST` 注入正确，`/health` 返回 `ok:true`
- [ ] 确认 WebSocket 走同源 `/ws`（`net.ts:51`），HTTPS 下自动 `wss:`
- [ ] 决定鉴权方案（§4）
- [ ] 说明「服务端重启丢对局」是已知行为
- [ ] 确认 `HEXFONT_FAKE_DICE` **未**在线上开启（该开关允许客户端指定骰子，仅本地/验收用）
- [ ] 浏览器实测：入房、摆位、掷骰、建造、报价、重连

---

## 7. 本轮状态

- **未发布**，未做任何外发动作。
- **未新增/修改任何部署配置**。
- 工作区仍有 151 项未提交改动（含本轮接入与既有 WIP），`master` 无远程仓库；
  将来推 GitHub 前需要先决定如何整理提交（本轮不处理）。
