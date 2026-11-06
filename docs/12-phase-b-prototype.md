# 重构阶段 B：横屏交互原型与验证边界

> 日期：2026-11-06（Asia/Shanghai）
> 依据：`docs/10-refactor-guide.md` 第 4、5、6、7.4、8.3、9.3、12（阶段 B）、13.1 节。
> 状态：**原型与逻辑验证已完成；用户于 2026-11-06 18:09 以「勉强合格」验收，同意进入阶段 C**。
> 但指南 12 的「真机可以稳定选中目标」与 CDP 视口截图仍未执行，属**已知风险**，不得写成已完成项。
> 本阶段只新增 `prototype/` 与 `probe/` 下的文件和文档，**未修改 `apps/`、`packages/`、`release/` 或线上版本**，未接入服务端、未改协议、未做美术与 PWA。

---

## 0. 顺序订正

阶段 A 记录（`11-phase-a-baseline.md` 初稿）曾把下一步写成「A → C」，跳过了阶段 B。指南第 12 节的顺序是 **A → B → C → D → E → F**。B 的原型部分不依赖真机，也不依赖 C 的协议升级，因此本轮按序补做 B，并把 `11` 的下一步表述订正为 B。阶段 C 顺延到 B 验收之后。

---

## 1. 交付物

| 文件 | 作用 |
|---|---|
| `prototype/mobile-b.html` | 隔离原型：自包含、无外部依赖、确定性数据、不连服务端。覆盖默认、建造预览、交易列表、弃牌、强盗待办五类状态，另含竖屏入房/等待 |
| `prototype/mobile-b-viewports.html` | 视口核对页：9 张固定 CSS 尺寸 iframe，覆盖 667×375、844×390、932×430、375×667、390×844、1024×768、1366×768，以及各状态组合 |
| `probe/phase-b-smoke.mjs` | jsdom 运行时冒烟测试（14 项），验证脚本不崩、状态切换、相机与广播、候选失效、弃牌提交、触控与帮助约定 |
| `probe/phase-b-viewport-check.mjs` | Chrome CDP 视口核对脚本：用 `Emulation.setDeviceMetricsOverride` 设置真实 CSS 视口，读取布局数据并截图。**本环境被沙箱拦截，未产出截图**，留待本机运行 |

原型通过 URL 参数切换确定性状态，便于复现与截图：
`?state=default|build|trade|discard|robber|lobby`，`&autopick=1` 自动选一个候选展示确认条，`&drawer=offers|help|dev|bank|robber` 展开指定抽屉，`&debug=0` 隐藏调试栏，`&badge=1` 显示实际 CSS 视口角标。

---

## 2. 指南条目覆盖对照

| 指南条目 | 原型中的落地 | 备注 |
|---|---|---|
| 4.1 横屏信息架构 | 顶栏 44px（连接 / 玩家条 / 设置帮助）、棋盘主舞台、右侧 `clamp(160px,22vw,192px)` 行动区、按需出现的选点确认条与情境提示、侧抽屉 | 右侧行动区分「可滚动分组」与「固定底部关键确认」；当前任务不滚出视野 |
| 4.1 抽屉 | 侧向展开、列表内部滚动、确认按钮固定在抽屉底部；`data-picking=1` 时自动收起大抽屉 | 对应「选择棋盘位置时收起大抽屉」 |
| 4.1 玩家信息 | 玩家条直接显示手牌张数与分数，当前玩家突出；待弃牌者有文字标记 | 不只为装饰牺牲辨识度 |
| 4.1 待处理交易 | 行动区「交易」按钮显示数量徽标，不堆横幅 | 指南 7.4 |
| 4.2 竖屏 | 常驻横屏建议卡 + 连接状态、回合摘要、我的手牌、待处理任务、设置与恢复入口；提示可收起且不反复弹出；不锁方向、不调全屏 API | 旋转只重算可视区域，不重置相机、不丢待确认选择 |
| 4.3 信息层级 | 连接/当前玩家/必须完成的任务常驻；资源、分数、港口比例、发展卡按需查看；最近动作在宽屏详情面板 | 拒绝原因显示在操作附近（如结束回合按钮 `title` 与固定底部原因条），不只写日志 |
| 5.1 相机与手势 | 独立相机状态（zoom / pan / center）；单指平移、双指缩放、桌面拖动与滚轮；+ / − / ⌂ 按钮；缩放围绕手势中心；Pointer Events 处理 pointercancel、多指加入/抬起、失焦、resize 与 orientationchange | `DRAG_THRESHOLD_PX = 8` CSS px，指南要求真机调整 |
| 5.1 touch-action | 仅 `.board-wrap` 与 SVG 设 `none`；抽屉与行动区保留 `pan-y` / `auto` | 表单与列表滚动不被吞掉 |
| 5.2 热区与选择 | 不靠重叠透明圆扩热区：按屏幕坐标计算最近合法候选（19 格去重出 54 个顶点），`MAX_HIT_PX=30`，前两名差距 `<12px` 时给 A/B 候选按钮消歧；候选点半径按 `4/k()` 换算成固定屏幕像素 | 合法候选是操作帮助，不做战术推荐 |
| 5.2 预览与确认 | 先显示虚线虚影 + 成本 + 缺口，确认后才改本地展示；取消只撤本地选择并说明「服务器未发生任何变化」 | 不把虚影画成已建成建筑 |
| 5.3 渲染稳定性 | SVG 拆成 terrain / numbers / roads / buildings / robber / candidates / preview 七层；`upsert(data-key)` 按稳定 key 增量更新；广播只更新动态层，不替换 SVG 容器 | 模拟 STATE 后相机保持、不误建造 |
| 5.3 选点复查 | 「使当前候选失效」模拟服务端更新：清除预览、给出原因、不悄悄改选别处 | 对应验收矩阵「建造确认前收到他人更新」 |
| 6 关键流程 | 建造预览、掷骰/结束回合反馈、发展卡列表与可用状态、银行/借港说明、骑士等卡说明、交易列表 | 只做交互骨架，**完整命令入口属阶段 D** |
| 7.4 报价展示 | 列表显示发起人、「我付出/我收到」（按收件人视角转换）、剩余时间、固定位置操作按钮；过期后详情变「已过期」并禁用原操作；发送按钮显示冷却秒数 | 倒计时/冷却为本地模拟，真实实现以服务端时间为准 |
| 8.3 弃牌 / 强盗 | 专用弃牌面板（应弃、已选、各资源剩余、44px 加减）、数量不符禁用提交、他人只看到谁未完成；强盗待办独立入口可收起，结束回合与发展卡禁用并给出具体原因 | 与指南 8.2 目标矩阵一致 |
| 9.3 反馈 | 减少动态效果开关；保留静态高亮与文字；触屏用「?」打开成本/手势/规则说明替代 hover tooltip | 不靠颜色、音效或 hover 传递唯一信息 |

**诚信标注**：原型里「确认后资源变化」「强盗已处理」「交易接受」都是本地预览提示，不代表服务端已裁决；真实实现必须等权威 STATE。指南 9.3 明确禁止「服务端未确认就当成功」。报价倒计时与冷却同样是本地模拟，服务端时间基准与去重属阶段 C。

---

## 3. 验证结果

| 验证 | 结果 |
|---|---|
| 原型脚本语法 | `node --check` 通过（1 个 script 块） |
| jsdom 运行时冒烟 | **14/14 通过**（`node probe/phase-b-smoke.mjs`）：五类状态 + 竖屏全部无运行时异常；19 格静态层、54 顶点候选生成；交易收件人视角转换；弃牌数量校验与提交；强盗待办禁用项；缩放 1.00 → 1.25 后模拟 STATE 仍为 1.25 且不误建造；候选失效清除预览并解释；减少动效与触屏帮助 |
| CSS 静态约定 | 44px 触控目标（`--tap`）、`100dvh` + `env(safe-area-inset-*)`、仅棋盘 `touch-action:none`、横竖屏/低高度/宽屏/减少动效四类断点，均由冒烟测试断言 |
| `pnpm test` / `pnpm typecheck` | 本阶段未改任何被测源码，仍为阶段 A 的 268 passed + 22 todo / 四包通过；**未重跑**（无源码改动） |
| CDP 真实视口截图 | ❌ **未产出**，见下节 |
| 真机验收 | ❌ 未做 |

### 3.1 CDP 视口核对为什么没跑成

`probe/phase-b-viewport-check.mjs` 已写好并可在本机直接运行，但本会话的沙箱拦截了浏览器启动时的 `file-delete`：

1. 用系统 `/Applications/Google Chrome.app`：被拦 `~/Library/Application Support/Google/RLZ/RlzStore.plist` 与 macOS 签名克隆临时文件；把 `HOME` 隔离到 `/tmp` 仍绕不过（RLZ 走系统 API 拿真实用户目录）。
2. 改用下载到 `/tmp` 的独立 Chromium headless shell：被拦浏览器清理自身 `/private/tmp/hexfront-phase-b-chrome/Default/**` 下的 `LOG.old`、`*.dbtmp`、`temp-index` 等临时文件。

因此 `docs/shots/phase-b-*.png` 与 `probe/phase-b-viewport-report.json` **尚未生成**，本文件不引用不存在的截图。没有为绕过限制申请沙箱外权限，也没有改动用户目录里的任何文件。

### 3.2 阶段 B 完成门槛核对

| 门槛 | 状态 |
|---|---|
| 隔离原型 / 可切换新布局，确定性数据覆盖五类状态 | ✅ |
| 667×375 等低高度下棋盘面积、确认按钮、交易列表与软键盘 | ⚠️ 原型已实现并有可打开的核对页，但**未由自动化截图核对**；软键盘需真机 |
| 点选/拖动区分、缩放和候选消歧 | ✅ 逻辑层已实现并由 jsdom 覆盖相机与失效复查；**手势手感未经真机** |
| 真机可以稳定选中目标，不依靠精细点按 | ❌ 未做 |
| 状态和错误始终可见，关键面板不遮住所需对象 | ⚠️ 结构上已保证（固定确认条、抽屉底部固定按钮），需视口截图/真机复核 |

**结论：不能宣称阶段 B 已通过。** 指南 13.1 明确「模拟视口不是实机替代」，13.3 明确真机人工项不由截图替代。

---

## 4. 本机补齐验证的步骤

```bash
# 1) 直接打开核对页（最简单，能看到 9 个视口的实际布局）
open prototype/mobile-b-viewports.html
open prototype/mobile-b.html        # 可交互原型，调试栏可切状态/模拟广播

# 2) 跑逻辑冒烟（jsdom 装在 /tmp，不进项目依赖）
mkdir -p /tmp/phase-b-dom && cd /tmp/phase-b-dom && npm init -y && npm install jsdom
cd <项目目录> && node probe/phase-b-smoke.mjs

# 3) 需要真实 CSS 视口截图时（无沙箱环境）
cd /tmp/phase-b-dom && PLAYWRIGHT_BROWSERS_PATH=/tmp/phase-b-browsers npx playwright install chromium
cd <项目目录> && node probe/phase-b-viewport-check.mjs
# 产物：docs/shots/phase-b-*.png、phase-b-viewports-grid.png、probe/phase-b-viewport-report.json
# 脚本用 CDP 的 Emulation.setDeviceMetricsOverride，不是 --window-size（09 文档记录过外窗尺寸会误判）
```

脚本默认优先用 `/tmp/phase-b-browsers/chromium_headless_shell-1254/.../chrome-headless-shell`，可用 `HEXFRONT_CHROME` 环境变量指定其他浏览器。

---

## 5. 本阶段明确未做

- 不接 WebSocket、不发 COMMAND、不写服务端状态；原型里的「确认」只改本地展示并明确提示。
- 不做协议升级、多报价服务端裁决、冷却与过期的权威实现（阶段 C）。
- 不补齐第 6 节全部真实命令入口、断线恢复与后台流程（阶段 D）。
- 不做统一地形/资源插画、纸卡材质、动效节奏与性能采样（阶段 E）。
- 不做 manifest、Service Worker、发布与回退（阶段 F）；`release/` 与线上房间原样未动（指南 14.9）。
- 不加入 5–6 人扩展、选地倒计时、内置语音等暂缓项。

---

## 6. 回滚与下一步

本阶段全部文件都是新增，基线仍是 `887043d`。回滚：`git reset --hard 887043d`（会一并撤销阶段 A 的改动）；只撤销本阶段：`git clean -n` 先看清单，确认后再处理新增文件。

**下一步**：请先在浏览器里打开 `prototype/mobile-b-viewports.html` 与 `prototype/mobile-b.html` 验收布局与手势，并安排至少一台 iPhone 与一台中低端 Android 做真机点选/双指/后台语音验证。B 的真机项确认后，再进入**阶段 C（协议与服务端规则）**；C 完成后才是 D/E/F。
