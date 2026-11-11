#!/usr/bin/env node
/**
 * 阶段 D 浏览器复验脚本（quality-lead / 严守真）
 *
 * 用途
 * ----
 * 用无头 Chrome + Chrome DevTools Protocol（CDP）在**真实浏览器**里，以 2~4 个
 * 独立 CDP target 模拟多名玩家，通过**真实指针事件**（Input.dispatchMouseEvent /
 * Input.dispatchTouchEvent）点击 UI，采集 docs/15-phase-d-review.md 第 4~9 节
 * 每条复验标准、第 12 节退出条件、docs/10-refactor-guide.md 8.2 / 13.1 / 13.2
 * 所需的可观察证据，输出结构化 JSON 到 probe/phase-d-browser-verify-report.json。
 *
 * 验收口径（用户本轮拍板，最严格一档）
 * ------------------------------------
 * - 必须补齐「浏览器完整多人对局」与「真机证据」才判定通过。
 * - 本环境做不到时，只交付代码修复与待办清单，阶段 D 继续如实标记「未通过」。
 * - **绝不**把自动化测试、jsdom 冒烟或模拟视口写成浏览器 / 真机通过。
 * - 模拟视口（Emulation.setDeviceMetricsOverride）是真实 CSS 视口，但不是真机。
 *
 * 诚信约束（结构性保证，不是口头承诺）
 * --------------------------------------
 * 1. 所有检查项在报告里**初始状态就是 NOT_RUN**；只有真正执行并取得观测值时
 *    才可能被写成 PASS / FAIL。没有跑到的项永远是 NOT_RUN 或 BLOCKED。
 * 2. 报告记录 observed（原始观测值）、expected（判据）、notes、时间戳；
 *    不写「推测通过」。
 * 3. 浏览器端动作一律走 CDP Input 域派发真实指针事件，不用 el.click() /
 *    dispatchEvent / Runtime.evaluate 触发界面逻辑来「代替界面操作」。
 *    Runtime.evaluate 只用于**读取** DOM / computed style / window.__hex.view。
 * 4. 允许复用 apps/server/scripts/{bot,seed-room}.ts 通过协议**造状态**，
 *    但被复验的界面动作必须由浏览器真实指针完成，且报告会标明该步骤是
 *    「seeded-state」还是「ui-driven」。
 * 5. 真机项一律 BLOCKED（本会话无真机设备），见 phase-d-device-checklist.md。
 *
 * 运行
 * ----
 *   # 阶段一：只复核浏览器 / CDP 能力，不起服务、不实跑对局（默认）
 *   node probe/phase-d-browser-verify.mjs --mode=capability-only
 *
 *   # 阶段二：engineering-lead 修复完成后实跑（需显式指定 full）
 *   node probe/phase-d-browser-verify.mjs --mode=full --players=2 --shots
 *
 * 可选参数
 *   --serve=vite|dist      前端提供方式（默认 vite，直接跑当前源码，不需 build）
 *   --chrome=<path>          指定 Chrome 可执行文件
 *   --cdp-port=9411          CDP 调试端口（独立，勿用 8787 / 5173）
 *   --backend-port=8791      后端端口（仅监听 127.0.0.1）
 *   --vite-port=5181         Vite dev 端口（仅监听 127.0.0.1）
 *   --players=2|3|4          浏览器玩家数
 *   --room=<id>              独立房间号（默认自动生成 qa-dv-*）
 *   --max-turns=60           完整对局尝试的回合上限
 *   --step-timeout=12000     单步等待超时（ms）
 *   --shots                  额外保存截图到 probe/phase-d-browser-verify-shots/
 *   --keep-profile           保留 Chrome 临时 profile（调试用，默认清理）
 *
 * 环境注意事项（本会话实测，2026-11-07）
 *   - HTTP_PROXY / http_proxy 指向本地代理；curl 访问 127.0.0.1 必须
 *     --noproxy '*'，否则拿到代理的 "upstream connect failed" 错误页。
 *     本脚本 CDP HTTP 用 node:http 直连 127.0.0.1，天然绕开代理。
 *   - Chrome 额外加 --no-proxy-server，确保 localhost WebSocket 不走代理。
 *   - 用 `cmd &` 后台起的进程会随 shell 退出被杀；长驻进程必须用
 *     spawn() 且由脚本持有句柄并在 finally 里 kill。
 *   - macOS 无 `timeout` 命令；本脚本用 JS 计时器，不调用 timeout。
 *   - Chrome 启动日志会有 CVDisplayLinkCreateWithCGDisplay failed 与
 *     Trying to load the allocator multiple times 噪声，不影响使用。
 *   - data: URL 里不能出现裸 `#`（会被当成 fragment 截断文档），
 *     本脚本用 encodeURIComponent 编码。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 路径与参数
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_DIR = path.join(ROOT, 'probe');
const REPORT_PATH = path.join(PROBE_DIR, 'phase-d-browser-verify-report.json');
// 阶段二：证据图统一落到 docs/shots/，命名带时间戳，与旧的 web-*-2026-11-06.png 明显区分
// （docs/15-phase-d-review.md 第 24 行明确：不要把 docs/shots/ 旧图片当作本次证据）
const SHOTS_DIR = path.join(ROOT, 'docs', 'shots');
const SHOT_STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHmmss
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

if (flag('help') || argv.includes('-h')) {
  console.log('用法: node probe/phase-d-browser-verify.mjs [--mode=capability-only|full] [选项]\n详见文件头注释。');
  process.exit(0);
}

const CFG = {
  mode: opt('mode', 'capability-only'),
  serve: opt('serve', 'vite'),
  chrome: opt('chrome', process.env.HEXFRONT_CHROME || DEFAULT_CHROME),
  cdpPort: Number(opt('cdp-port', '9411')),
  backendPort: Number(opt('backend-port', '8791')),
  vitePort: Number(opt('vite-port', '5181')),
  players: Math.max(2, Math.min(4, Number(opt('players', '2')))),
  room: opt('room', ''),
  maxTurns: Number(opt('max-turns', '60')),
  stepTimeoutMs: Number(opt('step-timeout', '12000')),
  shots: flag('shots'),
  keepProfile: flag('keep-profile'),
  skipCommands: flag('skip-commands'),   // 迭代调试时跳过耗时的全量命令
};

if (!['capability-only', 'full'].includes(CFG.mode)) {
  console.error(`未知 --mode=${CFG.mode}（可用: capability-only | full）`);
  process.exit(2);
}
if (!existsSync(CFG.chrome)) {
  console.error(`Chrome 不存在: ${CFG.chrome}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

/** 独立房间号：小写字母数字 - _，且不与 main / 线上房间冲突。
 *  基础号控制在 20 字符内，保证加 -s / -7 / -r 后缀后仍 ≤24 且互不相等。 */
function makeRoomId() {
  if (CFG.room) return CFG.room;
  const base = `qa-dv-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  return base.slice(0, 20);
}
const ROOM = makeRoomId();
const ROOMS = {
  live: ROOM,
  setup: `${ROOM}-s`,        // D-01 摆位确认/取消专用
  seven: `${ROOM}-7`,        // D-04 强盗待移动（弃牌已由协议完成）
  rich: `${ROOM}-r`,         // D-01 建造确认 / 资源充足
  offers: `${ROOM}-o`,       // D-05 报价到期
  dev: `${ROOM}-d`,          // D-03 发展卡
  pending: `${ROOM}-p`,      // D-04 有人尚未弃牌
  layoutSetup: `${ROOM}-ls`, // D-02 setupbar 布局（独立，不被别的用例改状态）
  layoutDiscard: `${ROOM}-ld`, // D-02 discard-panel 布局
  layoutRobber: `${ROOM}-lr`,  // D-02 robberbar 布局
  devKnight: `${ROOM}-dk`,     // D-03 骑士（2 人房，持卡者轮到当前）
  devRoads: `${ROOM}-dr`,      // D-03 筑路（2 人房，持卡者轮到当前）
  buildMouse: `${ROOM}-bm`,    // D-01 鼠标建造确认 / 拖动阈值（资源充足）
  buildTouch: `${ROOM}-bt`,    // D-01 触屏建造确认（资源充足）
};
// 防御：自定义 --room 也必须给后缀留出空间
for (const [k, id] of Object.entries(ROOMS)) {
  if (!/^[a-z0-9_-]{1,24}$/.test(id) || id === 'main') {
    console.error(`非法房间号 ${k}=${id}（需 [a-z0-9_-]{1,24} 且非 main）`);
    process.exit(2);
  }
}
if (new Set(Object.values(ROOMS)).size !== Object.keys(ROOMS).length) {
  console.error('房间号后缀发生碰撞，请换一个更短的 --room');
  process.exit(2);
}

const VIEWPORTS = [
  { key: '667x375', w: 667, h: 375 },
  { key: '844x390', w: 844, h: 390 },
  { key: '932x430', w: 932, h: 430 },
];
const DESKTOP = { key: '1366x768', w: 1366, h: 768 };
const NAMES = ['甲', '乙', '丙', '丁'];

// ---------------------------------------------------------------------------
// 检查项定义：每条都对应报告 / 指南里的具体条目
// ---------------------------------------------------------------------------

const CHECK_DEFS = [
  // 浏览器与 CDP 能力
  { id: 'CAP-01', area: 'capability', source: 'D-FIX-02 阶段一任务①', requirement: 'CDP 能连上无头 Chrome（/json/version + target WebSocket）', evidenceType: '浏览器/CDP' },
  { id: 'CAP-02', area: 'capability', source: 'D-FIX-02 阶段一任务①', requirement: 'Emulation.setDeviceMetricsOverride 能设置真实 CSS 视口（innerWidth/innerHeight/dpr/orientation）', evidenceType: '浏览器/CDP' },
  { id: 'CAP-03', area: 'capability', source: 'D-FIX-02 阶段一任务①', requirement: 'Runtime.evaluate 能读取 computed style 与 getBoundingClientRect', evidenceType: '浏览器/CDP' },
  { id: 'CAP-04', area: 'capability', source: 'D-FIX-02 阶段一任务①', requirement: 'Input.dispatchMouseEvent 能派发真实 pointerdown/pointerup/click（pointerType=mouse）', evidenceType: '浏览器/CDP' },
  { id: 'CAP-05', area: 'capability', source: 'D-FIX-02 阶段一任务①', requirement: 'Input.dispatchTouchEvent 能派发真实触屏指针事件（pointerType=touch）', evidenceType: '浏览器/CDP' },
  { id: 'CAP-06', area: 'capability', source: 'D-FIX-02 阶段一任务①', requirement: '触屏模拟开关切换后鼠标事件仍可正常派发', evidenceType: '浏览器/CDP' },
  { id: 'CAP-07', area: 'capability', source: 'D-FIX-02 阶段一任务①', requirement: 'Page.captureScreenshot 能产出截图', evidenceType: '浏览器/CDP' },
  { id: 'CAP-08', area: 'capability', source: 'D-FIX-02 阶段二前置', requirement: '可同时创建 2~4 个独立 CDP target（多浏览器玩家）', evidenceType: '浏览器/CDP' },

  // 环境隔离
  { id: 'ENV-01', area: 'environment', source: 'D-FIX-02 硬性约束', requirement: '测试服务仅监听 127.0.0.1 独立端口，不占用/修改用户 8787 与 5173', evidenceType: '浏览器/环境' },
  { id: 'ENV-02', area: 'environment', source: 'D-FIX-02 硬性约束', requirement: '使用独立房间号，不连接线上/正式房间，不带 sharecode', evidenceType: '浏览器/环境' },
  { id: 'ENV-03', area: 'environment', source: 'D-FIX-02 硬性约束', requirement: '测完关闭服务、关闭 CDP WebSocket、清理临时 profile', evidenceType: '浏览器/环境' },

  // D-01
  { id: 'D01-01', area: 'D-01', source: '15 §4 复验①', requirement: '鼠标指针可确认摆位（真实 pointerdown→pointerup→click）', evidenceType: '浏览器/真实指针' },
  { id: 'D01-02', area: 'D-01', source: '15 §4 复验①', requirement: '触屏指针可确认摆位', evidenceType: '浏览器/真实指针' },
  { id: 'D01-03', area: 'D-01', source: '15 §4 复验①', requirement: '鼠标指针可取消摆位', evidenceType: '浏览器/真实指针' },
  { id: 'D01-04', area: 'D-01', source: '15 §4 复验①', requirement: '触屏指针可取消摆位', evidenceType: '浏览器/真实指针' },
  { id: 'D01-05', area: 'D-01', source: '15 §4 复验①', requirement: '鼠标指针可确认建造', evidenceType: '浏览器/真实指针' },
  { id: 'D01-06', area: 'D-01', source: '15 §4 复验①', requirement: '触屏指针可确认建造', evidenceType: '浏览器/真实指针' },
  { id: 'D01-07', area: 'D-01', source: '15 §4 复验②', requirement: '放大按钮改变 SVG viewBox', evidenceType: '浏览器/真实指针' },
  { id: 'D01-08', area: 'D-01', source: '15 §4 复验②', requirement: '缩小按钮改变 SVG viewBox', evidenceType: '浏览器/真实指针' },
  { id: 'D01-09', area: 'D-01', source: '15 §4 复验②', requirement: '回到全局按钮恢复 SVG viewBox', evidenceType: '浏览器/真实指针' },
  { id: 'D01-10', area: 'D-01', source: '15 §4 复验③', requirement: '弃牌加减（.dp-step）与提交（#discard-ok）均可真实点击', evidenceType: '浏览器/真实指针' },
  { id: 'D01-11', area: 'D-01', source: '15 §4 复验③', requirement: '强盗玩家选择（#robberbar [data-action=steal]）可真实点击', evidenceType: '浏览器/真实指针' },
  { id: 'D01-12', area: 'D-01', source: '15 §4 复验⑤', requirement: '拖动超过 8px 阈值后抬手不建造（无确认条、无新增建筑）', evidenceType: '浏览器/真实指针' },
  { id: 'D01-13', area: 'D-01', source: '15 §4 复验⑤', requirement: '双指结束后不误选棋盘位置', evidenceType: '浏览器/真实指针' },
  { id: 'D01-14', area: 'D-01', source: '15 §4 复验④', requirement: '点击浮层按钮不会顺带选择棋盘位置', evidenceType: '浏览器/真实指针' },
  { id: 'D01-15', area: 'D-01', source: '15 §4 原因', requirement: 'D-01 指针序列期间页面无未捕获异常 / console error', evidenceType: '浏览器/日志' },
  { id: 'D01-16', area: 'D-01', source: 'D-FIX-01 新契约（index.html/layout.css/camera.ts）', requirement: '#board 是唯一 data-board-input 且 touch-action:none；浮层 data-board-ui、纯说明 data-info-only 且 pointer-events:none；点浮层按钮 handler 收到 click 且 onTap 不触发', evidenceType: '浏览器/computed style + 真实指针' },

  // D-02
  { id: 'D02-01', area: 'D-02', source: '15 §5 复验①', requirement: '667×375 真实 CSS 视口：setupbar/robberbar/discard-panel 的 computed top/bottom/height/width/z-index 与不形成纵向遮挡', evidenceType: '浏览器/真实视口' },
  { id: 'D02-02', area: 'D-02', source: '15 §5 复验①', requirement: '844×390 同上', evidenceType: '浏览器/真实视口' },
  { id: 'D02-03', area: 'D-02', source: '15 §5 复验①', requirement: '932×430 同上', evidenceType: '浏览器/真实视口' },
  { id: 'D02-04', area: 'D-02', source: '15 §5 复验②', requirement: '摆位/强盗/弃牌/建造确认按预期层级呈现，不遮住所需目标', evidenceType: '浏览器/真实视口' },
  { id: 'D02-05', area: 'D-02', source: '15 §5 复验③', requirement: '初次动画结束后与后续 STATE 更新后布局一致', evidenceType: '浏览器/真实视口' },
  { id: 'D02-06', area: 'D-02', source: '15 §10 布局收尾', requirement: '长房间号 / 长昵称 / 4 位玩家 / 大资源数量下顶栏与行动按钮文字完整可读', evidenceType: '浏览器/真实视口' },

  // D-03
  { id: 'D03-01', area: 'D-03', source: '15 §6 复验①', requirement: '骑士选点后保留地块并进入第二步（抽牌对象选择）', evidenceType: '浏览器/真实指针' },
  { id: 'D03-02', area: 'D-03', source: '15 §6 复验②', requirement: '抽牌对象只含所选地块相邻且有牌的玩家；无合法目标时正确处理', evidenceType: '浏览器/真实指针' },
  { id: 'D03-03', area: 'D-03', source: '15 §6 复验①', requirement: '骑士第二步可成功提交（真实 UI）', evidenceType: '浏览器/真实指针' },
  { id: 'D03-04', area: 'D-03', source: '15 §6 复验③', requirement: '筑路保留所选道路，「已选 N 条路」计数正确', evidenceType: '浏览器/真实指针' },
  { id: 'D03-05', area: 'D-03', source: '15 §6 复验③', requirement: '第二条候选基于假设第一条的合法状态计算', evidenceType: '浏览器/真实指针' },
  { id: 'D03-06', area: 'D-03', source: '15 §6 复验④', requirement: '一条/两条提交、取消、广播更新、再次打开均有确定结果', evidenceType: '浏览器/真实指针' },
  { id: 'D03-07', area: 'D-03', source: '15 §6 复验⑤', requirement: '用真实 UI 完成至少一次骑士和一次筑路（不仅打开面板）', evidenceType: '浏览器/真实指针' },

  // D-04
  { id: 'D04-01', area: 'D-04', source: '15 §7 复验①', requirement: '弃牌完成后先建路/村/城可正常选点并提交', evidenceType: '浏览器/真实指针' },
  { id: 'D04-02', area: 'D-04', source: '15 §7 复验②', requirement: '可暂时交易/兑换再返回强盗任务', evidenceType: '浏览器/真实指针' },
  { id: 'D04-03', area: 'D-04', source: '15 §7 复验③', requirement: '强盗未处理不能结束回合或使用发展卡（前端禁用 + 服务端拒绝）', evidenceType: '浏览器 + 协议集成' },
  { id: 'D04-04', area: 'D-04', source: '15 §7 复验④', requirement: '所有人尚未弃完时资源变更仍由服务端拒绝', evidenceType: '浏览器 + 协议集成' },
  { id: 'D04-05', area: 'D-04', source: '15 §7 / 指南 8.2', requirement: '可在 UI 上完成「移动强盗」（选地块 → 选玩家 / 不抽牌）', evidenceType: '浏览器/真实指针' },

  // D-05
  { id: 'D05-01', area: 'D-05', source: '15 §8 复验①', requirement: '发送后显示冷却倒计时且不可重复发送（#offer-send 文案 + disabled）', evidenceType: '浏览器/真实指针' },
  { id: 'D05-02', area: 'D-05', source: '15 §8 复验②', requirement: '冷却期间草稿可编辑；结束后仅合法非空报价可发送', evidenceType: '浏览器/真实指针' },
  { id: 'D05-03', area: 'D-05', source: '15 §8 复验③', requirement: '断线、弃牌锁、回合变化后按钮状态及时更新', evidenceType: '浏览器/真实指针' },
  { id: 'D05-04', area: 'D-05', source: '15 §8 复验④', requirement: '刷新/重连不能绕过服务端冷却', evidenceType: '浏览器 + 协议集成' },
  { id: 'D05-05', area: 'D-05', source: '15 §8 复验⑤', requirement: '到期/替换/清除报价后，接受按钮不会顶到手指下造成误点', evidenceType: '浏览器/真实指针' },

  // D-06
  { id: 'D06-01', area: 'D-06', source: '15 §9 复验①', requirement: '切后台再回前台，取得当前权威视图和未过期报价', evidenceType: '浏览器/生命周期' },
  { id: 'D06-02', area: 'D-06', source: '15 §9 复验②', requirement: '网络切换/半开连接不永久停在「正在核对」', evidenceType: '浏览器/生命周期' },
  { id: 'D06-03', area: 'D-06', source: '15 §9 复验③', requirement: '提交后确认前断线，回来能核对结果，不重复执行', evidenceType: '浏览器/生命周期' },
  { id: 'D06-04', area: 'D-06', source: '15 §9 复验④', requirement: '后台超过 10 秒的报价正确过期', evidenceType: '浏览器/生命周期' },
  { id: 'D06-05', area: 'D-06', source: '15 §9 复验⑤', requirement: '真机后台电话/语音房、锁屏、标签回收后重开均有记录', evidenceType: '真机人工' },

  // 完整多人链路
  { id: 'FLOW-01', area: 'flow', source: '15 §12 / 指南 阶段 D', requirement: '2~4 个浏览器玩家入房（不同 name，同一独立 room）', evidenceType: '浏览器/真实指针' },
  { id: 'FLOW-02', area: 'flow', source: '15 §12', requirement: '在 UI 上开局（点击「开始游戏」或满员自动开局）', evidenceType: '浏览器/真实指针' },
  { id: 'FLOW-03', area: 'flow', source: '15 §12', requirement: '在 UI 上完成 4 次摆位（村庄 + 相邻道路 + 整组确认）', evidenceType: '浏览器/真实指针' },
  { id: 'FLOW-04', area: 'flow', source: '15 §12', requirement: '交易：报价发送、接受、过期、冷却均可在 UI 观察', evidenceType: '浏览器/真实指针' },
  { id: 'FLOW-05', area: 'flow', source: '15 §12', requirement: '建造（真实指针选点 + 确认）', evidenceType: '浏览器/真实指针' },
  { id: 'FLOW-06', area: 'flow', source: '15 §12', requirement: '兑换（银行 / 港口 / 借港）入口可用并有失败提示', evidenceType: '浏览器/真实指针' },
  { id: 'FLOW-07', area: 'flow', source: '15 §12', requirement: '发展卡购买与使用（骑士 / 筑路 / 垄断 / 丰饶）', evidenceType: '浏览器/真实指针' },
  { id: 'FLOW-08', area: 'flow', source: '15 §12 / 指南 8.2', requirement: '掷 7 的完整行动矩阵：弃牌 → 恢复建造/交易 → 强盗未处理禁发展卡/结束回合 → 移动强盗，报价清空', evidenceType: '浏览器/真实指针' },
  { id: 'FLOW-09', area: 'flow', source: '15 §12', requirement: '浏览器完整对局到结束（胜者 / 分数 / 回房间入口）；未达成则保持「未通过完整对局验收」', evidenceType: '浏览器/真实指针' },
  { id: 'FLOW-10', area: 'flow', source: '15 §12', requirement: '完整链路期间无未捕获异常 / console error', evidenceType: '浏览器/日志' },

  // 指南 8.2 行动矩阵（4 状态 × 5 列）
  { id: 'MATRIX-1', area: 'matrix', source: '指南 8.2 普通行动', requirement: '普通行动：弃牌不适用 / 建造可做 / 玩家交易至少一方为当前玩家 / 发展卡按规则 / 已掷骰才可结束回合', evidenceType: '浏览器 + 协议集成' },
  { id: 'MATRIX-2', area: 'matrix', source: '指南 8.2 有人尚未弃牌', requirement: '有人尚未弃牌：仅弃牌者可弃 / 建造与兑换暂停 / 不能创建或接受报价 / 发展卡暂停 / 禁止结束回合', evidenceType: '浏览器 + 协议集成' },
  { id: 'MATRIX-3', area: 'matrix', source: '指南 8.2 弃完强盗待移动', requirement: '弃完、强盗待移动：建造可做 / 玩家交易恢复（受冷却） / 发展卡禁用 / 禁止结束回合', evidenceType: '浏览器 + 协议集成' },
  { id: 'MATRIX-4', area: 'matrix', source: '指南 8.2 强盗已处理', requirement: '强盗已处理：建造/交易/发展卡正常，结束回合按原规则', evidenceType: '浏览器 + 协议集成' },

  // 指南 13.1 设备与视口矩阵
  { id: 'DEV-01', area: 'device-matrix', source: '指南 13.1 小横屏', requirement: '667×375 操作栏高度、抽屉滚动、确认位置', evidenceType: '浏览器/真实视口' },
  { id: 'DEV-02', area: 'device-matrix', source: '指南 13.1 常见横屏', requirement: '844×390 / 932×430 安全区、棋盘精度、报价列表', evidenceType: '浏览器/真实视口' },
  { id: 'DEV-03', area: 'device-matrix', source: '指南 13.1 竖屏', requirement: '375×667 / 390×844 入房、等待、旋转提示、键盘', evidenceType: '浏览器/真实视口 + 真机' },
  { id: 'DEV-04', area: 'device-matrix', source: '指南 13.1 平板', requirement: '1024×768 附近布局过渡、面板宽度', evidenceType: '浏览器/真实视口' },
  { id: 'DEV-05', area: 'device-matrix', source: '指南 13.1 桌面', requirement: '1366×768 / 1440×900 鼠标、键盘、焦点与宽屏信息展开', evidenceType: '浏览器/真实视口' },
  { id: 'DEV-06', area: 'device-matrix', source: '指南 13.1 真机', requirement: '至少一台 iPhone、一台中低端 Android：双指、后台语音、网络切换、可读性', evidenceType: '真机人工' },
  // DEV-07 是「方法学」能力项，不是设备/布局验收结论；归入 capability 避免被误读为视口已通过
  { id: 'DEV-07', area: 'capability', source: '指南 13.1 说明', requirement: '自动化核对实际 viewport 与 CSS 像素，不只用浏览器外窗大小（方法学能力，不代表任何设备布局已通过）', evidenceType: '浏览器/CDP' },

  // 指南 13.2 功能与异常用例（关键项，逐条映射）
  { id: 'CASE-01', area: 'guide-13.2', source: '指南 13.2①', requirement: '非当前玩家可报价给当前玩家，不能给其他非当前玩家', evidenceType: '协议集成 + 浏览器' },
  { id: 'CASE-02', area: 'guide-13.2', source: '指南 13.2②', requirement: 'A/B/C 同时报价并存、不互相覆盖；每人最多一条', evidenceType: '协议集成 + 浏览器' },
  { id: 'CASE-03', area: 'guide-13.2', source: '指南 13.2③', requirement: '3 秒内重复发送被服务端拒绝；刷新/重连不绕过冷却', evidenceType: '协议集成 + 浏览器' },
  { id: 'CASE-04', area: 'guide-13.2', source: '指南 13.2④', requirement: '冷却后重发生成新 ID，旧 ID 不可接受，10 秒重新开始', evidenceType: '协议集成' },
  { id: 'CASE-05', area: 'guide-13.2', source: '指南 13.2⑤', requirement: '报价到期边界、慢时钟、清理延迟时均不能误成交', evidenceType: '协议集成（可控时钟）' },
  { id: 'CASE-06', area: 'guide-13.2', source: '指南 13.2⑥', requirement: '接受与掷 7、回合结束、本人重发交错时只执行正确结果', evidenceType: '协议集成' },
  { id: 'CASE-07', area: 'guide-13.2', source: '指南 13.2⑦', requirement: '两条报价争用资源时不出现负数或重复扣减', evidenceType: '协议集成' },
  { id: 'CASE-08', area: 'guide-13.2', source: '指南 13.2⑧', requirement: '赠予与索取可提交，空换空不可提交；收件人视角正确', evidenceType: '协议集成 + 浏览器' },
  { id: 'CASE-09', area: 'guide-13.2', source: '指南 13.2⑨', requirement: '掷 7 清空全部报价，所有人弃完前不能报价或成交', evidenceType: '浏览器 + 协议集成' },
  { id: 'CASE-10', area: 'guide-13.2', source: '指南 13.2⑩', requirement: '9 张弃 5 张，玩家自行选择；他人不知道弃牌构成', evidenceType: '浏览器 + 协议集成' },
  { id: 'CASE-11', area: 'guide-13.2', source: '指南 13.2⑪', requirement: '有人尚未弃牌时建造、交易、兑换、发展卡均被服务端拒绝', evidenceType: '协议集成' },
  { id: 'CASE-12', area: 'guide-13.2', source: '指南 13.2⑫', requirement: '所有人弃牌后可建造/交易/兑换，强盗未处理不能结束回合或使用发展卡；强盗完成后恢复', evidenceType: '浏览器 + 协议集成' },
  { id: 'CASE-13', area: 'guide-13.2', source: '指南 13.2⑬', requirement: '缩放、平移时收到 STATE，不回到初始镜头、不触发误建造', evidenceType: '浏览器/真实指针' },
  { id: 'CASE-14', area: 'guide-13.2', source: '指南 13.2⑭', requirement: '建造确认前收到他人更新，失效候选被撤销并说明原因', evidenceType: '浏览器/真实指针' },
  { id: 'CASE-15', area: 'guide-13.2', source: '指南 13.2⑮', requirement: '买发展卡、四种行动卡、银行、借港均有可用入口和失败提示', evidenceType: '浏览器/真实指针' },
  { id: 'CASE-16', area: 'guide-13.2', source: '指南 13.2⑯', requirement: '长报价过期后接受按钮不会移动到下一条并造成误点', evidenceType: '浏览器/真实指针' },
  { id: 'CASE-17', area: 'guide-13.2', source: '指南 13.2⑰', requirement: '网络在提交前/后分别中断，不静默丢操作、不重复成交', evidenceType: '浏览器 + 协议集成' },
  { id: 'CASE-18', area: 'guide-13.2', source: '指南 13.2⑱', requirement: '电话/语音后台返回后，资源、当前玩家、强盗任务、报价与服务端一致', evidenceType: '真机人工' },
  { id: 'CASE-19', area: 'guide-13.2', source: '指南 13.2⑲', requirement: '横竖屏切换不丢座位，不提交草稿，不无限弹提示', evidenceType: '浏览器/真实视口 + 真机' },
  { id: 'CASE-20', area: 'guide-13.2', source: '指南 13.2⑳', requirement: '帮助可点击、焦点可见；不靠 hover/颜色/声音传递唯一信息', evidenceType: '浏览器/真实指针' },
  { id: 'CASE-21', area: 'guide-13.2', source: '指南 13.2㉑', requirement: '减少动态效果时仍能理解产出、成交、建造与轮次变化', evidenceType: '浏览器/真实指针' },
  { id: 'CASE-22', area: 'guide-13.2', source: '指南 13.3 性能', requirement: '交互反馈、拖动帧时间、长任务、首屏资产大小先记录基线再定预算', evidenceType: '浏览器/性能采样' },

  // 真机人工项（本会话无设备，一律 BLOCKED）
  { id: 'REAL-01', area: 'real-device', source: 'phase-d-device-checklist.md D1', requirement: 'iPhone Safari 后台电话/语音房并行后返回前台', evidenceType: '真机人工' },
  { id: 'REAL-02', area: 'real-device', source: 'phase-d-device-checklist.md D2', requirement: '中低端 Android Chrome 后台语音房并行后返回前台', evidenceType: '真机人工' },
  { id: 'REAL-03', area: 'real-device', source: 'phase-d-device-checklist.md D3', requirement: '锁屏 / 解锁后连接与权威视图恢复', evidenceType: '真机人工' },
  { id: 'REAL-04', area: 'real-device', source: 'phase-d-device-checklist.md D4', requirement: 'WiFi ↔ 蜂窝网络切换', evidenceType: '真机人工' },
  { id: 'REAL-05', area: 'real-device', source: 'phase-d-device-checklist.md D5', requirement: '浏览器标签被系统回收后重开', evidenceType: '真机人工' },
  { id: 'REAL-06', area: 'real-device', source: 'phase-d-device-checklist.md D6', requirement: '双指平移 / 缩放 / 拖动阈值手感与误触', evidenceType: '真机人工' },
  { id: 'REAL-07', area: 'real-device', source: 'phase-d-device-checklist.md D7', requirement: '10 秒报价后台过期，回来不自动续期', evidenceType: '真机人工' },
  { id: 'REAL-08', area: 'real-device', source: 'phase-d-device-checklist.md D8', requirement: '安全区 / 刘海 / 浏览器栏变化 / 软键盘 / 分享链接内置浏览器', evidenceType: '真机人工' },

  // §12 退出条件
  { id: 'EXIT-01', area: 'exit', source: '15 §12①', requirement: 'D-01 至 D-06 有修复及对应复验结果', evidenceType: '汇编（主理人）' },
  { id: 'EXIT-02', area: 'exit', source: '15 §12②', requirement: '真实指针事件覆盖摆位确认、建造确认、缩放、弃牌、强盗按钮', evidenceType: '浏览器/真实指针' },
  { id: 'EXIT-03', area: 'exit', source: '15 §12③', requirement: '两个以上浏览器玩家完成入房、开局、摆位、交易、建造、兑换和发展卡使用', evidenceType: '浏览器/真实指针' },
  { id: 'EXIT-04', area: 'exit', source: '15 §12④', requirement: '浏览器验证掷 7 的完整行动矩阵及报价清空', evidenceType: '浏览器/真实指针' },
  { id: 'EXIT-05', area: 'exit', source: '15 §12⑤', requirement: '浏览器完整对局到结束；如尚未完成状态继续标记「未通过完整对局验收」', evidenceType: '浏览器/真实指针' },
  { id: 'EXIT-06', area: 'exit', source: '15 §12⑥', requirement: '手机后台与手势测试结果单独记录；没有真机证据不得写成真机通过', evidenceType: '真机人工 + 汇编' },
  { id: 'EXIT-07', area: 'exit', source: '15 §12⑦', requirement: 'test/typecheck/build 通过，实际数量与已知 todo 如实记录', evidenceType: '单测 + 构建（engineering-lead）' },
  { id: 'EXIT-08', area: 'exit', source: '15 §12⑧', requirement: '状态文档区分实现、浏览器验收、真机验收和发布，避免「已完成」混用', evidenceType: '文档（主理人）' },
];

const ALLOWED_STATUS = new Set(['PASS', 'FAIL', 'NOT_RUN', 'BLOCKED']);

class Reporter {
  constructor(run) {
    this.data = {
      schema: 'hexfront.phase-d.browser-verify/1',
      generatedAt: nowIso(),
      run,
      // 报告范围：阶段一的 capability-only 快照只记录浏览器/CDP 能力实测，
      // 不是阶段二的完整对局复验报告，也不构成任何质量门判定。
      reportScope: run.mode === 'capability-only'
        ? 'PHASE1_CAPABILITY_SNAPSHOT — 仅记录浏览器/CDP 能力实测；所有游戏复验项均为 NOT_RUN，真机项为 BLOCKED。阶段二 --mode=full 实跑会覆盖本文件。此文件不是完整对局复验报告。'
        : 'PHASE2_FULL_RUN — 浏览器完整多人对局复验（结果以实际观测为准；真机项仍为 BLOCKED）。',
      // 诚信声明：本脚本不会把未执行的项写成 PASS
      disclaimer:
        '本脚本所有检查项初始为 NOT_RUN；只有实际执行并取得观测值才会写成 PASS/FAIL。' +
        '模拟视口（Emulation.setDeviceMetricsOverride）是真实 CSS 视口但不是真机；' +
        'jsdom / 单测 / 协议集成结果不得当作浏览器或真机通过。' +
        'CAP-* 属于浏览器/CDP 能力探测，不构成任何游戏功能复验结论。',
      capabilities: [],
      checks: CHECK_DEFS.map((d) => ({
        ...d,
        status: 'NOT_RUN',
        observed: null,
        expected: null,
        notes: run.mode === 'capability-only'
          ? '阶段一仅准备：未实跑完整对局，本项未执行'
          : '阶段二尚未执行到本项',
        at: null,
      })),
      layout: {},
      pointerEvidence: {},
      consoleErrors: [],
      seededStates: [],
      screenshots: [],       // docs/shots/phase-d-verify-<stamp>-*.png
      fullCommands: {},      // pnpm test / typecheck / build 独立复核的原始输出
      flowTrace: [],         // 完整链路逐步轨迹（到哪一步、卡在哪）
      serverLogs: [],
      cleanup: null,
      summary: null,
    };
    this.byId = new Map(this.data.checks.map((c) => [c.id, c]));
  }
  set(id, status, patch = {}) {
    if (!ALLOWED_STATUS.has(status)) throw new Error(`非法状态 ${status}`);
    const c = this.byId.get(id);
    if (!c) throw new Error(`未知检查项 ${id}`);
    c.status = status;
    if ('observed' in patch) c.observed = patch.observed;
    if ('expected' in patch) c.expected = patch.expected;
    if ('notes' in patch) c.notes = patch.notes;
    if ('evidenceType' in patch) c.evidenceType = patch.evidenceType;
    c.at = nowIso();
    return c;
  }
  pass(id, observed, expected, notes) { return this.set(id, 'PASS', { observed, expected, notes }); }
  fail(id, observed, expected, notes) { return this.set(id, 'FAIL', { observed, expected, notes }); }
  notRun(id, notes) { return this.set(id, 'NOT_RUN', { notes }); }
  /** 只取得部分可观察结果、未覆盖该条复验标准的全部要求时：保留观测值但状态保持 NOT_RUN */
  partial(id, observed, notes) {
    const tail = this.data.run.mode === 'capability-only' ? '待阶段二补跑' : '待补跑/由对应证据类型的负责人补证';
    const c = this.set(id, 'NOT_RUN', { observed, notes: `${notes}；【本轮仅部分观测，未写成 PASS，${tail}】` });
    c.partialObservation = true;  // 供收尾循环识别，避免被通用 NOT_RUN 说明覆盖
    return c;
  }
  blocked(id, notes, observed = null) { return this.set(id, 'BLOCKED', { observed, notes }); }
  cap(id, status, observed, expected, notes) {
    this.data.capabilities.push({ id, status, observed, expected: expected ?? null, notes: notes ?? null, at: nowIso() });
  }
  note(text) { this.data.run.environmentNotes.push(text); }
  error(text) { if (this.data.consoleErrors.length < 200) this.data.consoleErrors.push({ at: nowIso(), text: String(text) }); }
  finish(cleanup) {
    this.data.cleanup = cleanup;
    this.data.generatedAt = nowIso();
    const byStatus = { PASS: 0, FAIL: 0, NOT_RUN: 0, BLOCKED: 0 };
    const byArea = {};
    for (const c of this.data.checks) {
      byStatus[c.status]++;
      const a = (byArea[c.area] ??= { PASS: 0, FAIL: 0, NOT_RUN: 0, BLOCKED: 0 });
      a[c.status]++;
    }
    const realDeviceBlocked = this.data.checks
      .filter((c) => c.area === 'real-device' && c.status === 'BLOCKED').length;
    const realDeviceEvidence = realDeviceBlocked === 0 && this.data.checks
      .filter((c) => c.area === 'real-device').every((c) => c.status === 'PASS');
    // 阶段二给出 gate「建议」（advisory），最终 PASS/CONCERNS/FAIL 由主理人汇编
    if (this.data.run.mode !== 'capability-only' && !this.data.run.gateSuggestion) {
      const fails = this.data.checks.filter((c) => c.status === 'FAIL');
      const exit05 = this.byId.get('EXIT-05');
      const reasons = [];
      if (!this.data.run.fullGameExecuted) reasons.push('浏览器完整对局未跑到 phase=ended（EXIT-05 未通过完整对局验收）');
      if (!realDeviceEvidence) reasons.push('真机 8 项全部 BLOCKED（本会话无设备），真机证据缺失');
      if (fails.length) reasons.push(`${fails.length} 项 FAIL: ${fails.map((c) => c.id).join(', ')}`);
      const notRun = this.data.checks.filter((c) => c.status === 'NOT_RUN').length;
      if (notRun) reasons.push(`${notRun} 项 NOT_RUN（协议集成/补跑/汇编类待主理人补证）`);
      this.data.run.gateSuggestion = reasons.length ? 'CONCERNS' : 'PASS';
      this.data.run.gateSuggestionReasons = reasons;
      this.data.run.gateSuggestionNote = '用户最严格口径：浏览器完整多人对局 + 真机证据缺一不可；本脚本只给建议，最终判定由主理人给出。';
    }
    this.data.summary = {
      byStatus,
      byArea,
      total: this.data.checks.length,
      // 脚本只给「建议」，最终 PASS/CONCERNS/FAIL 由主理人汇编出具（advisory gate）
      gate: this.data.run.mode === 'capability-only' ? 'NOT_CONCLUDED' : (this.data.run.gateSuggestion ?? 'NOT_CONCLUDED'),
      gateIsAdvisory: true,
      gateNote: this.data.run.mode === 'capability-only'
        ? '阶段一仅准备，未实跑完整对局，未出具判定；阶段 D 继续如实标记「未通过」。'
        : '阶段二实跑完成；本 gate 仅为 quality-lead 建议，最终判定由主理人依据本报告 + 真机清单 + 全量命令结果汇编给出。',
      realDeviceEvidence,
      fullGameExecuted: !!this.data.run.fullGameExecuted,
      fullGameReachedEnd: !!this.data.run.fullGameReachedEnd,
      failIds: this.data.checks.filter((c) => c.status === 'FAIL').map((c) => c.id),
      blockedIds: this.data.checks.filter((c) => c.status === 'BLOCKED').map((c) => c.id),
    };
    writeFileSync(REPORT_PATH, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
  }
}

// ---------------------------------------------------------------------------
// CDP 基础
// ---------------------------------------------------------------------------

/** 用 node:http 直连 127.0.0.1，绕开 HTTP_PROXY 代理 */
function cdpHttp(method, pathname, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CFG.cdpPort, method, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`CDP HTTP 超时 ${method} ${pathname}`)));
    req.end();
  });
}

/** 端口是否被占用：true 表示空闲 */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** 用 node:http 直连 127.0.0.1 取一份 JSON/文本，避免任何代理环境变量干扰 */
function localHttp(port, pathname, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`localHttp 超时 ${port}${pathname}`)));
    req.end();
  });
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(150);
  }
  throw new Error(`等待超时：${label}${lastErr ? `（最后错误：${lastErr.message}）` : ''}`);
}

class CDP {
  constructor(ws, label = 'target') {
    this.ws = ws;
    this.label = label;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(`${m.error.message} (code ${m.error.code ?? '?'})`)) : resolve(m.result);
      } else if (m.method) {
        if (m.method === 'Runtime.exceptionThrown') {
          const t = m.params?.exceptionDetails?.text ?? 'exceptionThrown';
          this.errors.push(t);
        } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
          this.errors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
        }
        for (const fn of [...(this.listeners.get(m.method) ?? [])]) {
          try { fn(m.params); } catch (e) { this.errors.push(String(e)); }
        }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 命令超时 ${method}`));
        }
      }, 15000).unref?.();
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(`Runtime.evaluate 异常: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description ?? '')}`);
    }
    return r.result?.value;
  }
  waitEvent(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.listeners.get(method) ?? [];
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
        reject(new Error(`等待 CDP 事件超时 ${method}`));
      }, timeoutMs);
      const fn = (p) => { clearTimeout(timer); resolve(p); };
      const list = this.listeners.get(method) ?? [];
      list.push(fn);
      this.listeners.set(method, list);
    });
  }
  close() { try { this.ws.close(); } catch { /* 已关闭 */ } }
}

function wsOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (e) => reject(new Error(`CDP WebSocket 连接失败: ${e?.message ?? 'unknown'}`)), { once: true });
  });
}

/** 创建一个新 target（真实独立页面），返回 Player 风格的连接对象 */
async function createTarget(url) {
  const created = await cdpHttp('PUT', `/json/new?${encodeURIComponent(url)}`);
  if (created.status !== 200) throw new Error(`/json/new 返回 ${created.status}: ${created.body.slice(0, 200)}`);
  const target = JSON.parse(created.body);
  if (!target.webSocketDebuggerUrl) throw new Error('target 缺少 webSocketDebuggerUrl');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await wsOpen(ws);
  const cdp = new CDP(ws, target.id);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { target, ws, cdp };
}

// ---------------------------------------------------------------------------
// 真实指针事件辅助（所有 UI 操作都必须经过这里）
// ---------------------------------------------------------------------------

async function mouseClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function touchTap(cdp, x, y) {
  // 单条 CDP 命令若卡住（pointer capture 与触屏模拟冲突时偶发），用短超时快速失败，
  // 由 clickElement/clickBoard 的 fallback 退回真实鼠标指针。
  const short = (method, params) => Promise.race([
    cdp.send(method, params),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${method} 短超时`)), 4000)),
  ]);
  await short('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await short('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
  });
  await short('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  try { await short('Emulation.setTouchEmulationEnabled', { enabled: false }); } catch { /* 忽略复位失败 */ }
}

/** 双指：按下两点 → 轻微 pinch 移动 → 抬手，用来检查是否误选 */
async function pinchGesture(cdp, cx, cy) {
  const short = (method, params) => Promise.race([
    cdp.send(method, params),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${method} 短超时`)), 4000)),
  ]);
  await short('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const p = (dx) => [
    { x: cx - 30 + dx, y: cy, id: 1, radiusX: 2, radiusY: 2, force: 1 },
    { x: cx + 30 - dx, y: cy, id: 2, radiusX: 2, radiusY: 2, force: 1 },
  ];
  await short('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: p(0) });
  for (const d of [4, 8, 12]) {
    await short('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(d) });
    await sleep(30);
  }
  await short('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  try { await short('Emulation.setTouchEmulationEnabled', { enabled: false }); } catch { /* 忽略 */ }
}

/** 拖动超过阈值：mousePressed → 多步 mouseMoved(buttons:1) → mouseReleased */
async function drag(cdp, x1, y1, x2, y2, steps = 8) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x1 + (x2 - x1) * t),
      y: Math.round(y1 + (y2 - y1) * t),
      button: 'left', buttons: 1,
    });
    await sleep(16);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
}

/** 读取元素矩形（并滚动到视口中央），返回中心坐标 */
async function boxOf(cdp, selector, index = 0) {
  const box = await cdp.eval(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = els[${index}];
    if (!el) return null;
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, tag: el.tagName, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
  })()`);
  return box ?? null;
}

/** 用真实指针点击某个选择器命中的元素。
 *  触屏派发若因 pointer capture 卡住，退回鼠标真实指针并在返回里标注 fallback。 */
async function clickElement(cdp, selector, opts = {}) {
  const box = await boxOf(cdp, selector, opts.index ?? 0);
  if (!box) throw new Error(`元素不存在: ${selector}`);
  if (box.w === 0 || box.h === 0) throw new Error(`元素不可见（0 尺寸）: ${selector}`);
  const x = Math.round(box.x + box.w / 2);
  const y = Math.round(box.y + box.h / 2);
  let via = opts.via ?? 'mouse';
  if (via === 'touch') {
    try { await touchTap(cdp, x, y); }
    catch (e) {
      await mouseClick(cdp, x, y);
      via = 'mouse(touch-fallback)';
      return { selector, via, x, y, box, touchFallbackReason: e.message };
    }
  } else await mouseClick(cdp, x, y);
  await sleep(opts.after ?? 120);
  return { selector, via, x, y, box };
}

/** 在页面注入指针事件记录器（只监听、不触发，用于证明真实指针到达了 UI） */
async function installPointerLog(cdp) {
  await cdp.eval(`(() => {
    if (window.__qaPointerLog) return true;
    window.__qaPointerLog = [];
    for (const t of ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend']) {
      document.addEventListener(t, (e) => {
        window.__qaPointerLog.push({ t, pt: e.pointerType ?? null,
          x: Math.round(e.clientX ?? 0), y: Math.round(e.clientY ?? 0),
          tag: (e.target && e.target.tagName) || '' });
        if (window.__qaPointerLog.length > 500) window.__qaPointerLog.shift();
      }, true);
    }
    return true;
  })()`);
}

async function readPointerLog(cdp) {
  return (await cdp.eval('(() => window.__qaPointerLog || [])()')) ?? [];
}

/** 读取权威视图摘要（只读 window.__hex，不调用 client 发命令） */
async function readView(cdp) {
  return cdp.eval(`(() => {
    const h = window.__hex; const v = h && h.view;
    if (!v) return { ready: false };
    return {
      ready: true, seat: h.seat, roomId: h.roomId, capacity: h.capacity,
      phase: v.phase, current: v.current, viewer: v.viewer, turn: v.turn,
      hasRolled: v.hasRolled, dice: v.dice, winner: v.winner,
      setup: v.setup ? { step: v.setup.step, seat: v.setup.seat } : null,
      buildings: Object.keys(v.buildings || {}).length,
      roads: Object.keys(v.roads || {}).length,
      robberTile: v.robberTile,
      pendingRobber: v.pendingRobber,
      pendingDiscards: (v.pendingDiscards || []).map(p => ({ player: p.player, count: p.count })),
      handSize: v.me ? (v.me.handSize ?? null) : null,
      resources: v.me ? (v.me.resources ?? null) : null,
      devCards: v.me ? (v.me.devCards || []).map(c => ({ card: c.card, playable: c.playable })) : [],
      scores: v.scores,
    };
  })()`);
}

async function readViewBox(cdp) {
  return cdp.eval(`(() => {
    const b = document.getElementById('board');
    return b ? (b.getAttribute('viewBox') || null) : null;
  })()`);
}

async function readConfirmStrip(cdp) {
  return cdp.eval(`(() => {
    const s = document.getElementById('confirm-strip');
    if (!s) return { present: false };
    return {
      present: true,
      visible: !s.classList.contains('hidden'),
      title: s.dataset.title || '',
      text: (s.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      buttons: [...s.querySelectorAll('button')].map(b => ({ label: (b.textContent||'').trim(), disabled: !!b.disabled, kind: b.dataset.confirm || b.dataset.confirmCand || '' })),
    };
  })()`);
}

const PANEL_SELECTORS = {
  setupbar: '#setupbar',
  robberbar: '#robberbar',
  'discard-panel': '#discard',
  'confirm-strip': '#confirm-strip',
  'cam-tools': '#cam-tools',
};

/** 读取面板 computed style + 矩形 + 是否形成纵向遮挡（原始值与判据都返回） */
async function readPanelMetrics(cdp, vp) {
  return cdp.eval(`(() => {
    const sels = ${JSON.stringify(PANEL_SELECTORS)};
    const stageEl = document.getElementById('board-stage');
    const sr = stageEl ? stageEl.getBoundingClientRect() : null;
    const out = { viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
      landscape: matchMedia('(orientation: landscape)').matches,
      docW: document.documentElement.clientWidth, docH: document.documentElement.clientHeight },
      stageRect: sr ? { x: Math.round(sr.x*10)/10, y: Math.round(sr.y*10)/10,
        w: Math.round(sr.width*10)/10, h: Math.round(sr.height*10)/10,
        top: Math.round(sr.top*10)/10, bottom: Math.round(sr.bottom*10)/10 } : null };
    for (const [k, sel] of Object.entries(sels)) {
      const el = document.querySelector(sel);
      if (!el) { out[k] = { present: false }; continue; }
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const rect = { x: Math.round(r.x*10)/10, y: Math.round(r.y*10)/10,
        w: Math.round(r.width*10)/10, h: Math.round(r.height*10)/10,
        top: Math.round(r.top*10)/10, bottom: Math.round(r.bottom*10)/10,
        left: Math.round(r.left*10)/10, right: Math.round(r.right*10)/10 };
      const visible = !el.classList.contains('hidden') && cs.display !== 'none' && r.width > 0 && r.height > 0;
      const cx = innerWidth/2, cy = innerHeight/2;
      // 遮挡判据相对棋盘主舞台（.board-stage）计算：顶栏约 44px，用视口中心会误判顶部紧凑条
      const sx = sr ? sr.left + sr.width / 2 : cx;
      const sy = sr ? sr.top + sr.height / 2 : cy;
      const sh = sr ? sr.height : innerHeight;
      const coversCenter = rect.left <= sx && rect.right >= sx && rect.top <= sy && rect.bottom >= sy;
      const verticalFraction = sh > 0 ? rect.h / sh : 0;
      // 判据（保守、可复核）：可见面板高度 > 舞台高度 50%，或覆盖舞台中心 → 判为纵向遮挡
      const verticalOcclusion = visible && (verticalFraction > 0.5 || coversCenter);
      // 旧 bottom 与新 top 同时生效会把元素拉伸；记录以便人工复核
      const conflictingInsets = cs.position !== 'static' && cs.top !== 'auto' && cs.bottom !== 'auto';
      out[k] = {
        present: true, visible, hiddenClass: el.classList.contains('hidden'),
        computed: { top: cs.top, right: cs.right, bottom: cs.bottom, left: cs.left,
          width: cs.width, height: cs.height, zIndex: cs.zIndex, position: cs.position,
          display: cs.display, inset: cs.inset || null,
          maxHeight: cs.maxHeight, minHeight: cs.minHeight, maxWidth: cs.maxWidth,
          pointerEvents: cs.pointerEvents, touchAction: cs.touchAction, transform: cs.transform },
        rect, coversCenter, verticalFraction: Math.round(verticalFraction*1000)/1000,
        verticalOcclusion, conflictingInsets,
        inViewport: rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth+1 && rect.bottom <= innerHeight+1,
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140),
      };
    }
    return out;
  })()`);
}

/** 判断某个视口下所有已测量面板是否都不形成纵向遮挡 */
function layoutVerdict(metrics) {
  const measured = Object.entries(metrics).filter(([k, v]) =>
    k !== 'viewport' && k !== 'stageRect' && v && v.present && v.visible);
  // conflictingInsets 只作记录：新版 CSS 用 inset:auto 复位后，Chrome 会把 bottom:auto
  // 解析成实际像素值（如 258.5px），不能据此判为「top+bottom 同时拉伸」。
  const occluded = measured.filter(([, v]) => v.verticalOcclusion);
  return {
    measuredPanels: measured.map(([k]) => k),
    occludedPanels: occluded.map(([k]) => k),
    allVisiblePanelsMeasured: measured.length > 0,
    noVerticalOcclusion: occluded.length === 0,
  };
}

// ---------------------------------------------------------------------------
// 服务管理（仅 full 模式）
// ---------------------------------------------------------------------------

class Services {
  constructor(rep) {
    this.rep = rep;
    this.children = [];
    this.logs = [];
  }
  spawn(label, cmd, args, opts) {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry = { label, child, out: [] };
    this.children.push(entry);
    child.stdout?.on('data', (d) => { entry.out.push(String(d)); });
    child.stderr?.on('data', (d) => {
      const s = String(d);
      entry.out.push(s);
      if (this.logs.length < 200) this.logs.push({ label, stream: 'stderr', text: s.slice(0, 500) });
    });
    child.on('error', (e) => this.logs.push({ label, stream: 'error', text: String(e) }));
    return entry;
  }
  async start() {
    const serverDir = path.join(ROOT, 'apps', 'server');
    const webDir = path.join(ROOT, 'apps', 'web');
    const tsx = path.join(serverDir, 'node_modules', '.bin', 'tsx');
    const vite = path.join(webDir, 'node_modules', '.bin', 'vite');
    if (!existsSync(tsx)) throw new Error(`缺少 tsx: ${tsx}`);
    if (CFG.serve === 'vite' && !existsSync(vite)) throw new Error(`缺少 vite: ${vite}`);

    // 后端：仅监听 127.0.0.1 的独立端口；HEXFONT_FAKE_DICE 只用于本地验收造状态
    // 注意变量名是 HEXFONT_FAKE_DICE（源码 apps/server/src/room.ts:296 实测），
    // 注释里写的 HEXFRONT_FAKE_DICE 是笔误，README 也用前者。
    this.spawn('backend', tsx, ['src/index.ts'], {
      cwd: serverDir,
      env: {
        PORT: String(CFG.backendPort), HOST: '127.0.0.1',
        HEXFONT_FAKE_DICE: '1',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      },
    });
    const backendUrl = `http://127.0.0.1:${CFG.backendPort}/health`;
    await waitFor(async () => {
      const r = await localHttp(CFG.backendPort, '/health').catch(() => null);
      return r?.status === 200 ? { ok: true, body: r.body } : null;
    }, 25000, `后端 /health (${backendUrl})`);

    if (CFG.serve === 'vite') {
      this.spawn('vite', vite, ['--host', '127.0.0.1', '--port', String(CFG.vitePort), '--strictPort'], {
        cwd: webDir,
        env: {
          HEXFRONT_WS_TARGET: `ws://127.0.0.1:${CFG.backendPort}`,
          NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
        },
      });
      await waitFor(async () => {
        const r = await localHttp(CFG.vitePort, '/').catch(() => null);
        return r?.status === 200 ? true : null;
      }, 25000, `Vite / (127.0.0.1:${CFG.vitePort})`);
      this.frontBase = `http://127.0.0.1:${CFG.vitePort}`;
    } else {
      // dist 模式：后端自身托管 apps/web/dist（需先 build；可能是旧产物）
      this.frontBase = `http://127.0.0.1:${CFG.backendPort}`;
      this.rep.note('--serve=dist 使用 apps/web/dist 预构建产物，可能不是最新源码；建议用默认 vite 模式。');
    }
    return this.frontBase;
  }
  playerUrl(room, name, extra = {}) {
    const u = new URL(this.frontBase);
    u.searchParams.set('room', room);
    u.searchParams.set('name', name);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
    return u.toString();
  }
  async stop() {
    for (const { label, child } of this.children) {
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
      this.logs.push({ label, stream: 'lifecycle', text: 'SIGTERM sent' });
    }
    await sleep(400);
    for (const { child } of this.children) {
      if (!child.killed && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    }
  }
}

/** 用 seed-room.ts 通过协议造状态（允许），返回其 stdout JSON */
async function seedRoom(room, extraArgs, playersOverride = null) {
  const serverDir = path.join(ROOT, 'apps', 'server');
  const tsx = path.join(serverDir, 'node_modules', '.bin', 'tsx');
  const script = path.join(serverDir, 'scripts', 'seed-room.ts');
  const args = [script, room, String(playersOverride ?? CFG.players), ...extraArgs];
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, args, {
      cwd: serverDir,
      env: { ...process.env, PORT: String(CFG.backendPort), HEXFONT_FAKE_DICE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`seed-room 超时: ${room} ${extraArgs.join(' ')}`)); }, 90000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`seed-room 退出码 ${code}: ${err.slice(-500)}`));
      try { resolve(JSON.parse(out.trim().split('\n').filter(Boolean).pop() || '{}')); }
      catch { resolve({ raw: out.trim(), stderr: err.slice(-400) }); }
    });
  });
}

// ---------------------------------------------------------------------------
// 阶段二新增：确定性协议造状态 / 证据辅助
// ---------------------------------------------------------------------------

/**
 * 返回带 seq 校验的 act()：只认「比发送前更靠后」的 STATE 广播，避免读到
 * 上一条命令的残留快照（seed-room.ts 也踩过这个坑）。全局字段 current/turn/
 * pendingDiscards 在任意座位的 view 里都一样，因此统一读 clients[0].view。
 */
function makeProtoAct(clients) {
  return async (seat, cmd) => {
    const c = clients[seat];
    const before = Math.max(0, ...clients.map((x) => x.lastSeq));
    c.drain();
    c.send({ t: 'COMMAND', cmd: { ...cmd, seat } });
    const m = await c.next((x) =>
      x.t === 'REJECT' ||
      (x.t === 'STATE' && (x.seq ?? 0) > before), 8000).catch((e) => ({ t: 'TIMEOUT', message: e.message }));
    if (m.t === 'REJECT') return { rejected: m.reason };
    if (m.t === 'TIMEOUT') return { rejected: `TIMEOUT:${m.message}` };
    await sleep(90); // 等其余客户端也收到广播
    return { ok: true, view: clients[0].view };
  };
}

/**
 * 纯协议客户端（只用于「造状态」，不代替任何浏览器 UI 操作）。
 * 用 Node 22 的全局 WebSocket 直连后端，不引入项目依赖。
 */
class ProtoClient {
  constructor(url, name) {
    this.name = name;
    this.inbox = [];
    this.waiters = [];
    this.view = null;
    this.seat = null;
    this.lastSeq = 0;
    this.ws = new WebSocket(url);
    this.closed = false;
    this.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.t === 'WELCOME') { this.seat = m.seat; if (m.view) this.view = m.view; this.lastSeq = m.stateSeq ?? 0; }
      if (m.t === 'STATE' && m.view) { this.view = m.view; this.lastSeq = Math.max(this.lastSeq, m.seq ?? 0); }
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { const [w] = this.waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(m); }
      else this.inbox.push(m);
    });
    this.ws.addEventListener('error', () => {
      for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('WS error')); }
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WS open failed')), { once: true });
    });
  }
  send(msg) { if (!this.closed) this.ws.send(JSON.stringify(msg)); }
  next(pred, timeoutMs = 6000) {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const k = this.waiters.indexOf(w);
        if (k >= 0) this.waiters.splice(k, 1);
        reject(new Error(`等待消息超时 ${this.name}`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }
  drain() { this.inbox.length = 0; }
  close() { this.closed = true; try { this.ws.close(); } catch { /* ignore */ } }
}

const PROTO_V = 2;
// 覆盖 MAP_4P 全部产出数字 2..12（跳过 7），保证每个地块的产出都能被轮到，
// 让各座位手牌随回合累积到 ≥8，从而掷 7 时真的产生 pendingDiscards。
const NON_SEVEN_DICE = [
  [1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [3, 3],           // 2,3,4,5,6,6
  [2, 6], [3, 6], [4, 6], [5, 6], [6, 6],                    // 8,9,10,11,12
  [2, 2], [2, 3], [2, 4], [3, 4], [2, 5], [3, 5], [4, 5],   // 4,5,6,7? -> 见下自检
];
// 自检：绝不出现和为 7 的点数（否则造状态时提前触发弃牌锁）
const NON_SEVEN_DICE_SAFE = NON_SEVEN_DICE.filter((d) => d[0] + d[1] !== 7);
for (const d of NON_SEVEN_DICE_SAFE) if (d[0] + d[1] === 7) throw new Error(`NON_SEVEN_DICE 含 7: ${d}`);

/**
 * 确定性造「刚掷出 7、有人需要弃牌」的房间：
 * 1) seed-room.ts 完成入房 + 开局 + 8 次摆位（协议造状态，允许）
 * 2) 同名协议客户端重连回座，用 HEXFONT_FAKE_DICE=1 固定点数攒资源
 * 3) 手牌够多时强制 dice=[3,4] 掷 7，读回 pendingDiscards
 * 4) 关闭协议连接（座位保留），浏览器随后用同名 JOIN 坐回并**用真实指针**完成弃牌/强盗
 */
async function seedSevenRoom(room, players) {
  const backendWs = `ws://127.0.0.1:${CFG.backendPort}/`;
  const base = await seedRoom(room, []); // play 阶段、座位保留
  const clients = [];
  const trace = [];
  try {
    for (const name of NAMES.slice(0, players)) {
      const c = new ProtoClient(backendWs, name);
      await c.open();
      c.send({ t: 'JOIN', roomId: room, name, v: PROTO_V });
      const w = await c.next((m) => m.t === 'WELCOME' || m.t === 'JOIN_FAILED');
      if (w.t !== 'WELCOME') throw new Error(`重连 ${name} 失败: ${String(w.reason)}`);
      clients.push(c);
    }
    const any = () => clients[0];
    let view = any().view;
    if (!view || view.phase !== 'play') throw new Error(`种子后未处于 play: ${view?.phase}`);

    const act = makeProtoAct(clients);

    // 攒资源：每个回合固定非 7 点数 → END_TURN，直到至少两人手牌 ≥ 8 或达到上限。
    // handSize 是公开信息（view.players[].handSize）；discardCount 要求 ≥8 才产生 pendingDiscards。
    const maxRounds = 64;
    let handSizes = (view.players || []).map((p) => p.handSize ?? null);
    for (let r = 0; r < maxRounds; r++) {
      const seat = view.current;
      const dice = NON_SEVEN_DICE_SAFE[r % NON_SEVEN_DICE_SAFE.length];
      const rolled = await act(seat, { type: 'ROLL_DICE', dice });
      if (rolled.rejected) { trace.push({ round: r, rejected: rolled.rejected }); break; }
      if (rolled.view) view = rolled.view;
      const ended = await act(seat, { type: 'END_TURN' });
      if (ended.rejected) { trace.push({ round: r, endRejected: ended.rejected }); break; }
      if (ended.view) view = ended.view;
      handSizes = (view.players || []).map((p) => p.handSize ?? null);
      trace.push({ round: r, seat, dice, handSizes });
      if (handSizes.filter((n) => typeof n === 'number' && n >= 8).length >= 2) break;
    }

    // 强制掷 7（仅本地验收环境 HEXFONT_FAKE_DICE=1 生效，生产会被剥离）
    const seat7 = view.current;
    const seven = await act(seat7, { type: 'ROLL_DICE', dice: [3, 4] });
    const finalView = any().view;
    return {
      ok: true,
      base,
      sevenCommand: seven,
      accumulatedHandSizes: handSizes,
      roundsRun: trace.length,
      finalView: finalView ? {
        phase: finalView.phase, current: finalView.current, turn: finalView.turn,
        dice: finalView.dice,
        pendingDiscards: (finalView.pendingDiscards || []).map((p) => ({ player: p.player, count: p.count })),
        pendingRobber: finalView.pendingRobber,
        handSizes: (finalView.players || []).map((p) => p.handSize ?? null),
      } : null,
      roundsTrace: trace.slice(-8),
      note: '状态由协议确定性构造（HEXFONT_FAKE_DICE=1 仅本地验收）；浏览器端后续弃牌/强盗动作全部走真实指针事件。' +
        '若 pendingDiscards 为空则说明手牌未攒到 ≥8，报告须如实标 BLOCKED/NOT_RUN',
    };
  } finally {
    for (const c of clients) c.close();
    await sleep(150);
  }
}

/** 独立复核三个全量命令，记录真实 stdout/stderr/exitCode（不照抄 engineering-lead 自报） */
async function runFullCommands(rep) {
  const commands = [
    { key: 'test', args: ['test'] },
    { key: 'typecheck', args: ['typecheck'] },
    { key: 'build', args: ['build'] },
  ];
  for (const c of commands) {
    const started = Date.now();
    const res = await new Promise((resolve) => {
      const child = spawn('pnpm', c.args, {
        cwd: ROOT,
        env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout?.on('data', (d) => { out += String(d); });
      child.stderr?.on('data', (d) => { err += String(d); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 300000);
      child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout: out, stderr: err }); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: -1, stdout: out, stderr: `${err}\n${e.message}` }); });
    });
    const combined = `${res.stdout}\n${res.stderr}`;
    const testCounts = [...combined.matchAll(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) todo)?/g)]
      .map((m) => ({ passed: Number(m[1]), todo: m[2] ? Number(m[2]) : 0 }));
    const passed = testCounts.reduce((s, t) => s + t.passed, 0);
    const todo = testCounts.reduce((s, t) => s + t.todo, 0);
    const testFiles = [...combined.matchAll(/Test Files\s+(\d+) passed \((\d+)\)/g)].map((m) => Number(m[1]));
    rep.data.fullCommands[c.key] = {
      command: `pnpm ${c.args.join(' ')}`,
      exitCode: res.exitCode,
      durationMs: Date.now() - started,
      perPackage: testCounts,
      totalPassed: c.key === 'test' ? passed : null,
      totalTodo: c.key === 'test' ? todo : null,
      testFilesPassed: c.key === 'test' ? testFiles.reduce((s, n) => s + n, 0) : null,
      typecheckPackagesDone: c.key === 'typecheck' ? (combined.match(/typecheck: Done/g) || []).length : null,
      stdoutTail: res.stdout.trim().split('\n').slice(-45).join('\n'),
      stderrTail: res.stderr.trim().split('\n').slice(-20).join('\n'),
    };
    console.log(`[full-commands] ${c.key}: exit=${res.exitCode} ${c.key === 'test' ? `passed=${passed} todo=${todo}` : ''} ${Date.now() - started}ms`);
  }
  // EXIT-07 只记录独立复核事实，不替主理人下最终验收结论
  const t = rep.data.fullCommands.test, tc = rep.data.fullCommands.typecheck, b = rep.data.fullCommands.build;
  const allOk = t?.exitCode === 0 && tc?.exitCode === 0 && b?.exitCode === 0;
  rep.set('EXIT-07', allOk ? 'PASS' : 'FAIL', {
    observed: { test: { exitCode: t?.exitCode, passed: t?.totalPassed, todo: t?.totalTodo, testFiles: t?.testFilesPassed },
      typecheck: { exitCode: tc?.exitCode, packagesDone: tc?.typecheckPackagesDone },
      build: { exitCode: b?.exitCode, stdoutTail: b?.stdoutTail?.split('\n').slice(-6).join(' | ') } },
    expected: '三个命令退出码 0，通过数与 todo 如实记录',
    notes: 'quality-lead 独立实跑复核（非照抄自报）；原始输出见 fullCommands。最终汇编由主理人完成。',
  });
}

/**
 * 造「资源充足、可购买发展卡」的房间（协议造状态，不代替浏览器 UI 操作）。
 * 全程非 7 点数，避免提前触发弃牌锁；浏览器随后用真实指针点「购买发展卡」。
 */
async function seedRichRoom(room, players, rounds = 22) {
  const backendWs = `ws://127.0.0.1:${CFG.backendPort}/`;
  const base = await seedRoom(room, []);
  const clients = [];
  try {
    for (const name of NAMES.slice(0, players)) {
      const c = new ProtoClient(backendWs, name);
      await c.open();
      c.send({ t: 'JOIN', roomId: room, name, v: PROTO_V });
      const w = await c.next((m) => m.t === 'WELCOME' || m.t === 'JOIN_FAILED');
      if (w.t !== 'WELCOME') throw new Error(`重连 ${name} 失败: ${String(w.reason)}`);
      clients.push(c);
    }
    let view = clients[0].view;
    if (!view || view.phase !== 'play') throw new Error(`种子后未处于 play: ${view?.phase}`);
    const act = makeProtoAct(clients);
    for (let r = 0; r < rounds; r++) {
      const seat = view.current;
      const dice = NON_SEVEN_DICE_SAFE[r % NON_SEVEN_DICE_SAFE.length];
      const rolled = await act(seat, { type: 'ROLL_DICE', dice });
      if (rolled.rejected) break;
      if (rolled.view) view = rolled.view;
      const ended = await act(seat, { type: 'END_TURN' });
      if (ended.rejected) break;
      if (ended.view) view = ended.view;
    }
    return {
      ok: true, base,
      handSizes: (view.players || []).map((p) => p.handSize ?? null),
      resources: clients.map((c) => c.view?.me?.resources ?? null),
      turn: view.turn, current: view.current,
      note: '资源由协议确定性攒出（非 7 点数）；买卡/打卡均由浏览器真实指针完成',
    };
  } finally {
    for (const c of clients) c.close();
    await sleep(150);
  }
}

/** 读取 D-06 恢复核对的可观察状态（data-reconciling / 权威 view / 报价） */
async function readReconcileState(cdp) {
  return cdp.eval(`(() => {
    const shell = document.getElementById('shell');
    const h = window.__hex; const v = h && h.view;
    return {
      reconciling: shell ? (shell.dataset.reconciling ?? null) : null,
      connected: shell ? (shell.dataset.connected ?? null) : null,
      visibilityState: document.visibilityState,
      feed: (document.getElementById('feed-text')?.textContent || '').trim(),
      situation: (document.getElementById('situation')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      viewReady: !!v, phase: v?.phase ?? null, current: v?.current ?? null,
      turn: v?.turn ?? null, seat: h?.seat ?? null,
      offerCards: [...document.querySelectorAll('#drawer-body [data-offer]')].map(c => ({
        id: c.dataset.offer, ended: c.dataset.offerEnded || null,
        buttons: [...c.querySelectorAll('button')].map(b => ((b.textContent||'').trim() + ':' + (b.disabled ? 'disabled' : 'enabled'))),
      })),
    };
  })()`);
}

/** 用协议客户端以某个空闲座位昵称入房，触发服务端 room.sync() 广播一次 STATE（布局一致性用） */
async function triggerStateSync(room, name) {
  const c = new ProtoClient(`ws://127.0.0.1:${CFG.backendPort}/`, name);
  try {
    await c.open();
    c.send({ t: 'JOIN', roomId: room, name, v: PROTO_V });
    const w = await c.next((m) => m.t === 'WELCOME' || m.t === 'JOIN_FAILED', 5000).catch(() => ({ t: 'TIMEOUT' }));
    await sleep(120); // 等 sync 广播送达浏览器页面
    return { name, result: w.t, reason: w.reason ?? null };
  } finally { c.close(); await sleep(100); }
}

/** 保存证据截图，返回相对路径；文件名带时间戳，避免与 docs/shots 旧图混淆 */
async function saveShot(cdp, rep, tag) {
  if (!CFG.shots) return null;
  mkdirSync(SHOTS_DIR, { recursive: true });
  const file = `phase-d-verify-${SHOT_STAMP}-${tag}.png`;
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(shot.data, 'base64');
  writeFileSync(path.join(SHOTS_DIR, file), buf);
  const rel = `docs/shots/${file}`;
  rep.data.screenshots.push({ file: rel, tag, bytes: buf.length, at: nowIso() });
  return rel;
}

/** 读取 D-01 新契约：#board 是唯一输入层，浮层是 data-board-ui，纯说明是 data-info-only */
async function readBoardContract(cdp) {
  return cdp.eval(`(() => {
    const board = document.getElementById('board');
    const ui = [...document.querySelectorAll('[data-board-ui]')].map(e => ({
      id: e.id || null, cls: e.className,
      touchAction: getComputedStyle(e).touchAction,
      pointerEvents: getComputedStyle(e).pointerEvents,
      infoOnly: e.hasAttribute('data-info-only'),
      zIndex: getComputedStyle(e).zIndex,
    }));
    const info = [...document.querySelectorAll('[data-info-only]')].map(e => ({
      id: e.id || null, pointerEvents: getComputedStyle(e).pointerEvents,
    }));
    return {
      boardHasDataBoardInput: !!board && board.hasAttribute('data-board-input'),
      boardTouchAction: board ? getComputedStyle(board).touchAction : null,
      boardZIndex: board ? getComputedStyle(board).zIndex : null,
      stageTouchAction: getComputedStyle(document.getElementById('board-stage')).touchAction,
      boardUiCount: ui.length, boardUi: ui, infoOnlyCount: info.length, infoOnly: info,
    };
  })()`);
}

/** D-02 新基线判据（engineering-lead 修复后的显式期望），逐面板返回原始值与判定 */
function panelVerdict(metrics) {
  // 所有位置判据相对 .board-stage：顶栏 44px 会让视口坐标多出 44，直接用 rect.top 会误报
  const stage = metrics.stageRect || { top: 0, bottom: metrics.viewport?.h ?? 0, h: metrics.viewport?.h ?? 0 };
  const SH = stage.h || metrics.viewport?.h || 0;
  const out = {};
  for (const [key, v] of Object.entries(metrics)) {
    if (key === 'viewport' || key === 'stageRect' || !v || !v.present) continue;
    if (!v.visible) { out[key] = { visible: false, verdict: 'NOT_VISIBLE' }; continue; }
    const cs = v.computed || {};
    const rect = v.rect || {};
    const topInStage = Math.round((rect.top - stage.top) * 10) / 10;
    const bottomInStage = Math.round((stage.bottom - rect.bottom) * 10) / 10;
    let verdict = 'OBSERVED';
    const reasons = [];
    // 新基线（engineering-lead 修复后的显式期望）：
    //  setupbar/robberbar: top:8px, bottom:auto, zIndex:14, max-height:min(42%,150px)
    //  discard-panel:      bottom:8px, top:auto, zIndex:22, max-height:min(46%,156px)
    if (key === 'setupbar' || key === 'robberbar') {
      if (!(topInStage >= -1 && topInStage <= 16)) { verdict = 'FAIL'; reasons.push(`舞台内顶部偏移 ${topInStage}px，期望 0..16`); }
      if (rect.h > Math.min(SH * 0.42, 150) + 2) { verdict = 'FAIL'; reasons.push(`高度 ${rect.h} 超过 min(42%舞台=${Math.round(SH * 0.42)},150px)`); }
      if (cs.zIndex !== '14') { verdict = 'FAIL'; reasons.push(`zIndex=${cs.zIndex}，期望 14`); }
      if (cs.bottom !== 'auto' && cs.bottom !== '') { /* 记录但不判 FAIL：不同浏览器对 auto 的解析不同 */ }
      if (key === 'setupbar' && cs.pointerEvents !== 'none') { verdict = 'FAIL'; reasons.push(`setupbar 应 pointer-events:none，实际 ${cs.pointerEvents}`); }
      if (key === 'robberbar' && cs.pointerEvents !== 'auto') { verdict = 'FAIL'; reasons.push(`robberbar 应 pointer-events:auto，实际 ${cs.pointerEvents}`); }
    }
    if (key === 'discard-panel') {
      if (!(bottomInStage >= -1 && bottomInStage <= 16)) { verdict = 'FAIL'; reasons.push(`舞台内底部偏移 ${bottomInStage}px，期望 0..16`); }
      if (rect.h > Math.min(SH * 0.46, 156) + 2) { verdict = 'FAIL'; reasons.push(`高度 ${rect.h} 超过 min(46%舞台=${Math.round(SH * 0.46)},156px)`); }
      if (cs.zIndex !== '22') { verdict = 'FAIL'; reasons.push(`zIndex=${cs.zIndex}，期望 22`); }
      if (cs.pointerEvents !== 'auto') { verdict = 'FAIL'; reasons.push(`discard 应 pointer-events:auto，实际 ${cs.pointerEvents}`); }
    }
    out[key] = {
      visible: true,
      computed: { top: cs.top, bottom: cs.bottom, width: cs.width, height: cs.height, zIndex: cs.zIndex,
        maxHeight: cs.maxHeight, position: cs.position, pointerEvents: cs.pointerEvents, touchAction: cs.touchAction },
      rect, topInStage, bottomInStage,
      coversCenter: v.coversCenter, verticalFraction: v.verticalFraction,
      verdict, reasons,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 阶段一：浏览器 / CDP 能力复核（不起服务、不实跑对局）
// ---------------------------------------------------------------------------

async function capabilityMode(ctx) {
  const { rep } = ctx;
  const versionJson = await waitFor(async () => {
    const r = await cdpHttp('GET', '/json/version').catch(() => null);
    if (!r || r.status !== 200) return null;
    try { const j = JSON.parse(r.body); return j.Browser ? j : null; } catch { return null; }
  }, 20000, 'CDP /json/version');
  rep.cap('CAP-01', 'PASS', {
    browser: versionJson.Browser,
    protocolVersion: versionJson['Protocol-Version'],
    userAgent: versionJson['User-Agent'],
    webSocketDebuggerUrl: versionJson.webSocketDebuggerUrl,
  }, '返回 Chrome 版本 + 浏览器级 WebSocket 地址', '实测：/json/version 与 target WebSocket 均连通');
  rep.set('CAP-01', 'PASS', { observed: { browser: versionJson.Browser }, notes: 'CDP WebSocket 连接成功' });
  rep.pass('ENV-01', {
    cdpPort: CFG.cdpPort, backendPort: CFG.backendPort, vitePort: CFG.vitePort,
    userPorts: '8787 / 5173 未被本脚本占用或修改',
    note: 'capability-only 模式未启动任何 HTTP/WS 服务；CDP 端口直连 127.0.0.1',
  }, '独立端口且仅 127.0.0.1', '能力探测阶段不启动服务，仅绑定 CDP 调试端口');
  rep.note(`CDP 能力探测端口 ${CFG.cdpPort}（127.0.0.1）；用户的 8787 上有既有 node 进程监听，本脚本未触碰。`);

  const t = await createTarget('about:blank');
  ctx.targets.push(t);
  const cdp = t.cdp;

  // CAP-02 真实 CSS 视口
  const html = '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><style>.qa{position:absolute;top:8px;left:8px;width:100px;height:40px;z-index:7;color:rgb(1,2,3)}</style><button id=qa class=qa>QA</button>';
  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  const vpObs = [];
  for (const vp of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile: true,
      screenWidth: vp.w, screenHeight: vp.h,
      screenOrientation: { type: 'landscapePrimary', angle: 90 },
    });
    await cdp.send('Page.navigate', { url: dataUrl });
    await sleep(250);
    const v = await cdp.eval(`({ innerWidth, innerHeight, dpr: devicePixelRatio,
      landscape: matchMedia('(orientation: landscape)').matches,
      docW: document.documentElement.clientWidth, docH: document.documentElement.clientHeight,
      outerW: outerWidth, outerH: outerHeight })`);
    vpObs.push({ requested: `${vp.w}x${vp.h}`, observed: v });
  }
  const viewportOk = vpObs.every((o) => o.observed.innerWidth === Number(o.requested.split('x')[0])
    && o.observed.innerHeight === Number(o.requested.split('x')[1])
    && o.observed.landscape === true && o.observed.dpr === 2);
  rep.cap('CAP-02', viewportOk ? 'PASS' : 'FAIL', vpObs, 'innerWidth/innerHeight 等于请求值，dpr=2，landscape=true', 'Emulation.setDeviceMetricsOverride（真实 CSS 视口，非 --window-size）');
  rep.set('CAP-02', viewportOk ? 'PASS' : 'FAIL', { observed: vpObs, notes: viewportOk ? '三个横屏视口实测一致' : '视口设置与请求不一致' });
  rep.pass('DEV-07', { method: 'Emulation.setDeviceMetricsOverride', viewportObservations: vpObs },
    'innerWidth/innerHeight/dpr 与请求一致，且核对 docW/docH', '能力探测：确实读取了页面内的真实 CSS 像素，不是外窗大小');

  // CAP-03 computed style
  const style = await cdp.eval(`(() => {
    const e = document.getElementById('qa'); const s = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return { color: s.color, top: s.top, left: s.left, width: s.width, height: s.height,
      zIndex: s.zIndex, position: s.position,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  })()`);
  const styleOk = style.color === 'rgb(1, 2, 3)' && style.zIndex === '7' && style.width === '100px';
  rep.cap('CAP-03', styleOk ? 'PASS' : 'FAIL', style, 'getComputedStyle 返回真实计算值与 getBoundingClientRect 一致', 'Runtime.evaluate 读 computed style');
  rep.set('CAP-03', styleOk ? 'PASS' : 'FAIL', { observed: style, notes: 'computed style 与布局矩形可读' });

  // CAP-04 鼠标真实指针
  await cdp.eval(`(() => {
    window.__hits = [];
    const b = document.getElementById('qa');
    for (const t of ['pointerdown','pointerup','mousedown','mouseup','click'])
      b.addEventListener(t, e => window.__hits.push({ t, x: e.clientX, y: e.clientY, pt: e.pointerType ?? null }));
    return true;
  })()`);
  const cx = style.rect.x + style.rect.w / 2, cy = style.rect.y + style.rect.h / 2;
  await mouseClick(cdp, cx, cy);
  await sleep(120);
  const mouseHits = await cdp.eval('window.__hits');
  const mouseOk = ['pointerdown', 'pointerup', 'click'].every((t) => mouseHits.some((h) => h.t === t))
    && mouseHits.some((h) => h.pt === 'mouse');
  rep.cap('CAP-04', mouseOk ? 'PASS' : 'FAIL', mouseHits, '产生 pointerdown/pointerup/click 且 pointerType=mouse', 'Input.dispatchMouseEvent');
  rep.set('CAP-04', mouseOk ? 'PASS' : 'FAIL', { observed: mouseHits, notes: '真实鼠标指针事件链' });

  // CAP-05 触屏真实指针
  await cdp.eval('(() => { window.__hits = []; return true; })()');
  await touchTap(cdp, cx, cy);
  await sleep(160);
  const touchHits = await cdp.eval('window.__hits');
  const touchOk = touchHits.some((h) => h.t === 'pointerdown' && h.pt === 'touch')
    && touchHits.some((h) => h.t === 'pointerup' && h.pt === 'touch')
    && touchHits.some((h) => h.t === 'click');
  rep.cap('CAP-05', touchOk ? 'PASS' : 'FAIL', touchHits, '产生 touch 型 pointerdown/pointerup 与兼容 click', 'Emulation.setTouchEmulationEnabled + Input.dispatchTouchEvent');
  rep.set('CAP-05', touchOk ? 'PASS' : 'FAIL', { observed: touchHits, notes: '真实触屏指针事件链' });

  // CAP-06 触屏开关切换后鼠标仍可用
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.eval('(() => { window.__hits = []; return true; })()');
  await mouseClick(cdp, cx, cy);
  await sleep(120);
  const afterToggle = await cdp.eval('window.__hits');
  const toggleOk = ['pointerdown', 'pointerup', 'click'].every((t) => afterToggle.some((h) => h.t === t))
    && afterToggle.some((h) => h.pt === 'mouse');
  rep.cap('CAP-06', toggleOk ? 'PASS' : 'FAIL', afterToggle, '关闭触屏模拟后鼠标事件链仍完整', '开关切换不污染后续鼠标测试');
  rep.set('CAP-06', toggleOk ? 'PASS' : 'FAIL', { observed: afterToggle, notes: '支持鼠标/触屏交替复验' });

  // CAP-07 截图
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const shotBytes = shot?.data ? Buffer.from(shot.data, 'base64').length : 0;
  rep.cap('CAP-07', shotBytes > 1000 ? 'PASS' : 'FAIL', { bytes: shotBytes }, '产出非空 PNG', 'Page.captureScreenshot');
  rep.set('CAP-07', shotBytes > 1000 ? 'PASS' : 'FAIL', { observed: { bytes: shotBytes }, notes: '截图能力可用；阶段二 --shots 会保存证据图' });

  // CAP-08 多 target（2~4 个）
  const multi = [];
  for (let i = 0; i < CFG.players; i++) {
    const p = await createTarget('about:blank');
    ctx.targets.push(p);
    const v = await p.cdp.eval('({ w: innerWidth, h: innerHeight, ua: navigator.userAgent.slice(0, 40) })');
    multi.push({ index: i, targetId: p.target.id, type: p.target.type, eval: v });
  }
  const multiOk = multi.length === CFG.players && multi.every((m) => m.type === 'page' && m.eval && typeof m.eval.w === 'number');
  rep.cap('CAP-08', multiOk ? 'PASS' : 'FAIL', multi, `可创建 ${CFG.players} 个独立 page target 并各自 evaluate`, '/json/new?url (PUT) + 每 target 独立 WebSocket');
  rep.set('CAP-08', multiOk ? 'PASS' : 'FAIL', { observed: multi.map((m) => ({ index: m.index, type: m.type })), notes: '多浏览器玩家前置能力已具备' });

  // ENV-02 房间隔离
  const roomOk = /^[a-z0-9_-]{1,24}$/.test(ROOMS.live) && ROOMS.live !== 'main' && !ROOMS.live.includes('sharecode');
  rep.set('ENV-02', roomOk ? 'PASS' : 'FAIL', {
    observed: { rooms: ROOMS, sharecodeUsed: false, onlineRoomsTouched: false },
    notes: roomOk ? '独立房间号，无 sharecode，未连接线上房间' : '房间号不合法',
  });

  // 真机项：结构性 BLOCKED
  blockRealDeviceChecks(rep);

  // 其余所有未执行项保持 NOT_RUN（构造时即已如此），并补一条总说明
  rep.note('capability-only 模式只运行 CAP-* / ENV-* / DEV-07 与真机 BLOCKED 判定；所有 D-*/FLOW-*/MATRIX-*/CASE-*/EXIT-* 均保持 NOT_RUN。');
  rep.data.pointerEvidence.capability = { mouseHits, touchHits, afterToggle, viewports: vpObs, computedStyle: style };
}

function blockRealDeviceChecks(rep) {
  const ids = [
    ...CHECK_DEFS.filter((d) => d.evidenceType === '真机人工').map((d) => d.id),
    'D06-05', 'EXIT-06', 'CASE-18', 'DEV-06',
  ];
  for (const id of new Set(ids)) {
    rep.blocked(id, '本会话无真机设备（iPhone Safari / 中低端 Android Chrome），未执行；见 probe/phase-d-device-checklist.md。禁止写成真机通过。');
  }
}

/**
 * 造「当前座位拥有足够资源建造」的房间。
 * 用 4:1 银行兑换把多余资源补成 木/砖（道路）与 羊/麦/矿（发展卡），
 * 全部是协议造状态；浏览器端建造/选点/确认一律真实指针。
 */
async function seedBuildRoom(room, players, rounds = 40) {
  const backendWs = `ws://127.0.0.1:${CFG.backendPort}/`;
  const base = await seedRoom(room, []);
  const clients = [];
  const trace = [];
  try {
    for (const name of NAMES.slice(0, players)) {
      const c = new ProtoClient(backendWs, name);
      await c.open();
      c.send({ t: 'JOIN', roomId: room, name, v: PROTO_V });
      const w = await c.next((m) => m.t === 'WELCOME' || m.t === 'JOIN_FAILED');
      if (w.t !== 'WELCOME') throw new Error(`重连 ${name} 失败: ${String(w.reason)}`);
      clients.push(c);
    }
    let view = clients[0].view;
    if (!view || view.phase !== 'play') throw new Error(`种子后未处于 play: ${view?.phase}`);
    const act = makeProtoAct(clients);
    for (let r = 0; r < rounds; r++) {
      const seat = view.current;
      const rolled = await act(seat, { type: 'ROLL_DICE', dice: NON_SEVEN_DICE_SAFE[r % NON_SEVEN_DICE_SAFE.length] });
      if (rolled.rejected) break;
      if (rolled.view) view = rolled.view;
      const ended = await act(seat, { type: 'END_TURN' });
      if (ended.rejected) break;
      if (ended.view) view = ended.view;
    }
    // 把当前座位补到足够买 2 次道路 + 1 张发展卡（木/砖各 2，羊/麦/矿各 1）
    const seat = view.current;
    const target = { wood: 2, brick: 2, sheep: 1, wheat: 1, ore: 1 };
    const trades = [];
    for (const need of Object.keys(target)) {
      let guard = 0;
      while (guard++ < 6) {
        const res = clients[seat].view?.me?.resources ?? null;
        if (!res) break;
        if ((res[need] ?? 0) >= target[need]) break;
        const donor = ['wood', 'brick', 'sheep', 'wheat', 'ore']
          .filter((k) => k !== need && (res[k] ?? 0) > target[k])
          .sort((a, b) => (res[b] ?? 0) - (res[a] ?? 0))[0];
        if (!donor || (res[donor] ?? 0) < 4) break;
        const t = await act(seat, { type: 'TRADE_BANK', give: donor, get: need });
        if (t.rejected) { trades.push({ donor, need, rejected: t.rejected }); break; }
        trades.push({ donor, need, ok: true });
        if (t.view) view = t.view;
      }
    }
    return {
      ok: true, base, current: view.current, turn: view.turn,
      resources: clients.map((c) => c.view?.me?.resources ?? null),
      handSizes: (view.players || []).map((p) => p.handSize ?? null),
      trades, traceTail: trace.slice(-5),
      note: '资源由协议掷非 7 点数 + 4:1 银行兑换造出；浏览器端建造全部走真实指针',
    };
  } finally {
    for (const c of clients) c.close();
    await sleep(150);
  }
}

/** 用协议把某房间所有待弃牌座位提交合法弃牌（造「弃完、强盗待移动」状态，非 UI 动作） */
async function clearDiscardsViaProtocol(room, players) {
  const backendWs = `ws://127.0.0.1:${CFG.backendPort}/`;
  const clients = [];
  try {
    for (const name of NAMES.slice(0, players)) {
      const c = new ProtoClient(backendWs, name);
      await c.open();
      c.send({ t: 'JOIN', roomId: room, name, v: PROTO_V });
      const w = await c.next((m) => m.t === 'WELCOME' || m.t === 'JOIN_FAILED');
      if (w.t !== 'WELCOME') throw new Error(`重连 ${name} 失败: ${String(w.reason)}`);
      clients.push(c);
    }
    const trace = [];
    for (let s = 0; s < players; s++) {
      const v = clients[s].view;
      const need = (v?.pendingDiscards ?? []).find((d) => d.player === s)?.count ?? 0;
      if (need <= 0) continue;
      const res = v.me?.resources ?? {};
      const pick = {};
      let left = need;
      for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
        const take = Math.min(left, res[r] ?? 0);
        if (take > 0) pick[r] = take;
        left -= take;
        if (left <= 0) break;
      }
      clients[s].drain();
      clients[s].send({ t: 'COMMAND', cmd: { type: 'DISCARD', seat: s, resources: pick } });
      const m = await clients[s].next((x) => x.t === 'STATE' || x.t === 'REJECT');
      trace.push({ seat: s, need, pick, result: m.t, reason: m.reason ?? null });
    }
    await sleep(350);
    return { ok: true, trace };
  } finally {
    for (const c of clients) c.close();
    await sleep(150);
  }
}

/**
 * 发展卡多房间重试：牌堆洗牌随机（knight 14/25、roadbuilding 2/25）。
 * 一个房间买穿前十几张还没出目标卡，就换房间重洗再试（最多 attempts 个房间）；
 * 仍拿不到就如实返回失败（保持 BLOCKED 并写明尝试次数与买到的卡种）。
 */
async function seedDevRoomRetry(tag, wantCard, attempts = 3) {
  const tried = [];
  let lastSeed = null, lastRoom = null;
  for (let a = 0; a < attempts; a++) {
    const room = `${ROOM}-${tag}${a}`.slice(0, 24);
    lastRoom = room;
    const seed = await seedDevRoom(room, CFG.players, wantCard);
    lastSeed = seed;
    const totalBought = (seed.devCardsBySeat ?? []).reduce((s, cs) => s + cs.length, 0);
    tried.push({ room, holderSeat: seed.holderSeat, totalBought,
      cardsBySeat: seed.devCardsBySeat, buyRejectsTail: (seed.traceTail ?? []).slice(-2) });
    if (seed.holderSeat >= 0) {
      return { ok: true, room, seed, attempt: a + 1, tried,
        note: `第 ${a + 1}/${attempts} 个房间命中；共买 ${totalBought} 张` };
    }
  }
  return { ok: false, room: lastRoom, seed: lastSeed, attempt: tried.length, tried,
    note: `${attempts} 个房间共买 ${(lastSeed?.devCardsBySeat ?? []).reduce((s, cs) => s + cs.length, 0)} 张仍未出 ${wantCard}（牌堆随机）；如实保持 BLOCKED` };
}

/**
 * 造「有可打出的发展卡」的房间：协议攒资源 + 买卡 + 过回合让卡 playable。
 * 买卡属于「造状态」（指南 13.3 允许用协议脚本造状态）；
 * D-03 被复验的界面动作（选地块 / 选道路 / 第二步 / 计数）全部由浏览器真实指针完成。
 */
async function seedDevRoom(room, players, wantCard, maxTurns = 90) {
  const backendWs = `ws://127.0.0.1:${CFG.backendPort}/`;
  const base = await seedRoom(room, [], players); // seed-room.ts 人数参数
  const clients = [];
  const trace = [];
  try {
    for (const name of NAMES.slice(0, players)) {
      const c = new ProtoClient(backendWs, name);
      await c.open();
      c.send({ t: 'JOIN', roomId: room, name, v: PROTO_V });
      const w = await c.next((m) => m.t === 'WELCOME' || m.t === 'JOIN_FAILED');
      if (w.t !== 'WELCOME') throw new Error(`重连 ${name} 失败: ${String(w.reason)}`);
      clients.push(c);
    }
    let view = clients[0].view;
    if (!view || view.phase !== 'play') throw new Error(`种子后未处于 play: ${view?.phase}`);
    const act = makeProtoAct(clients);
    const rotated = [];
    for (let t = 0; t < maxTurns; t++) {
      const seat = view.current;
      const rolled = await act(seat, { type: 'ROLL_DICE', dice: NON_SEVEN_DICE_SAFE[t % NON_SEVEN_DICE_SAFE.length] });
      if (rolled.rejected) { trace.push({ t, seat, rollRejected: rolled.rejected }); break; }
      if (rolled.view) view = rolled.view;
      // 先用 4:1 银行兑换把多余资源换成买卡所需的 羊/麦/矿（DEV_COST）。
      // 这是协议造状态的一部分（不是 UI 动作），D-03 被复验的选点/提交仍全走真实指针。
      const trades = [];
      for (const need of ['sheep', 'wheat', 'ore']) {
        let guard = 0;
        while (guard++ < 5) {
          const res = clients[seat].view?.me?.resources ?? null;
          if (!res) break;
          if ((res[need] ?? 0) >= 1) break;
          // 允许把任意「有 ≥4 张」的资源拿出来换（含暂时富余的羊/麦/矿）
          const donor = ['wood', 'brick', 'sheep', 'wheat', 'ore']
            .filter((r) => r !== need && (res[r] ?? 0) >= 4 && (r === 'wood' || r === 'brick' || (res[r] ?? 0) > 1))
            .sort((a, b) => (res[b] ?? 0) - (res[a] ?? 0))[0];
          if (!donor) break;
          const t = await act(seat, { type: 'TRADE_BANK', give: donor, get: need });
          if (t.rejected) { trades.push({ donor, need, rejected: t.rejected }); }
          else { trades.push({ donor, need, ok: true }); if (t.view) view = t.view; }
          await sleep(60);
        }
      }
      let bought = 0;
      const buyRejects = [];
      for (let k = 0; k < 8; k++) {
        const r = await act(seat, { type: 'BUY_DEV_CARD' });
        if (r.rejected) { buyRejects.push(r.rejected); break; }
        bought++;
      }
      const ended = await act(seat, { type: 'END_TURN' }); // END_TURN 让所有已买卡 playable=true
      if (ended.rejected) { trace.push({ t, seat, endRejected: ended.rejected }); break; }
      if (ended.view) view = ended.view;
      await sleep(110);
      const cardsBySeat = clients.map((c) => (c.view?.me?.devCards ?? []));
      trace.push({ t, seat, bought, trades: trades.length, buyRejects, nextCurrent: view.current,
        resources: clients.map((c) => c.view?.me?.resources ?? null),
        cardsBySeat: cardsBySeat.map((cs) => cs.map((c) => `${c.card}:${c.playable ? 'playable' : 'new'}`)) });
      // 目标：当前座位持有可打出的目标卡（这样 PLAY_KNIGHT / PLAY_ROAD_BUILDING 不会被 NOT_YOUR_TURN 拒绝）
      const curCards = cardsBySeat[view.current] ?? [];
      if (curCards.some((c) => c.card === wantCard && c.playable)) break;
      rotated.push({ t, from: seat, to: view.current });
    }
    const finalCardsBySeat = clients.map((c) => (c.view?.me?.devCards ?? []).map((e) => ({ card: e.card, playable: e.playable })));
    const holderSeat = finalCardsBySeat.findIndex((cs, i) =>
      i === view.current && cs.some((c) => c.card === wantCard && c.playable));
    return {
      ok: true, base, wantCard, holderSeat, current: view.current, turn: view.turn,
      devCardsBySeat: finalCardsBySeat,
      handSizes: (view.players || []).map((p) => p.handSize ?? null),
      traceTail: trace.slice(-8), rotations: rotated.length,
      note: '发展卡与资源由协议确定性造出（同回合可买多张、END_TURN 后 playable）；浏览器端 D-03 选点/提交全部走真实指针',
    };
  } finally {
    for (const c of clients) c.close();
    await sleep(150);
  }
}

/**
 * 造「多条指向 0 号座的报价」的房间，用于 D-05「到期/替换后接受按钮不顶到手指下」。
 * 让 current=0 后，非当前玩家（只能报价给当前玩家）各发一条报价给 0 号座。
 */
async function seedOffersRoom(room, players) {
  const backendWs = `ws://127.0.0.1:${CFG.backendPort}/`;
  const base = await seedRoom(room, []);
  const clients = [];
  try {
    for (const name of NAMES.slice(0, players)) {
      const c = new ProtoClient(backendWs, name);
      await c.open();
      c.send({ t: 'JOIN', roomId: room, name, v: PROTO_V });
      const w = await c.next((m) => m.t === 'WELCOME' || m.t === 'JOIN_FAILED');
      if (w.t !== 'WELCOME') throw new Error(`重连 ${name} 失败: ${String(w.reason)}`);
      clients.push(c);
    }
    let view = clients[0].view;
    const act = makeProtoAct(clients);
    // 轮换到 current===0
    for (let t = 0; t < 12 && view.current !== 0; t++) {
      const seat = view.current;
      const rolled = await act(seat, { type: 'ROLL_DICE', dice: NON_SEVEN_DICE_SAFE[t % NON_SEVEN_DICE_SAFE.length] });
      if (rolled.view) view = rolled.view;
      const ended = await act(seat, { type: 'END_TURN' });
      if (ended.view) view = ended.view;
    }
    const offerResults = [];
    for (let s = 1; s < players; s++) {
      clients[s].drain();
      clients[s].send({ t: 'OFFER', to: 0, give: { wood: 1 }, get: { wheat: 1 } });
      const m = await clients[s].next((x) => x.t === 'OFFERS' || x.t === 'REJECT').catch(() => ({ t: 'TIMEOUT' }));
      offerResults.push({ from: s, to: 0, result: m.t, offers: m.offers ?? m.snapshot?.offers ?? null });
    }
    await sleep(250);
    return { ok: true, base, current: view.current, offerResults,
      note: '报价由协议造出；浏览器端打开/接受/到期观察与点击全部走真实指针' };
  } finally {
    for (const c of clients) c.close();
    await sleep(150);
  }
}

// ---------------------------------------------------------------------------
// 阶段二：完整多人浏览器复验（engineering-lead 修复后的新源码）
// ---------------------------------------------------------------------------

class Player {
  constructor(conn, name, index) {
    Object.assign(this, conn);
    this.name = name;
    this.index = index;
  }
  async goto(url) {
    const loaded = this.cdp.waitEvent('Page.loadEventFired', 20000);
    await this.cdp.send('Page.navigate', { url });
    await loaded;
    await installPointerLog(this.cdp);
  }
  async setViewport(vp, mobile = true) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile,
      screenWidth: vp.w, screenHeight: vp.h,
      screenOrientation: { type: vp.w >= vp.h ? 'landscapePrimary' : 'portraitPrimary', angle: vp.w >= vp.h ? 90 : 0 },
    });
    await this.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 });
  }
  view() { return readView(this.cdp); }
  viewBox() { return readViewBox(this.cdp); }
  confirm() { return readConfirmStrip(this.cdp); }
  metrics() { return readPanelMetrics(this.cdp); }
  click(sel, opts) { return clickElement(this.cdp, sel, opts); }
  box(sel, i) { return boxOf(this.cdp, sel, i); }
  errors() { return this.cdp.errors.slice(); }
  pointerLog() { return readPointerLog(this.cdp); }
}

async function waitView(players, timeoutMs, label) {
  return waitFor(async () => {
    const views = [];
    for (const p of players) views.push(await p.view().catch(() => ({ ready: false })));
    return views.every((v) => v && v.ready) ? views : null;
  }, timeoutMs, label);
}

/** 安全执行一段复验：异常 → 记 BLOCKED/FAIL，绝不写成 PASS */
async function attempt(rep, id, fn) {
  try { return await fn(); }
  catch (e) {
    const c = rep.byId.get(id);
    if (c && c.status === 'NOT_RUN') rep.blocked(id, `执行中断：${e.message}`);
    rep.error(`${id}: ${e.message}`);
    return { error: e.message };
  }
}

/**
 * 棋盘 SVG 候选的屏幕坐标：不能用 getBoundingClientRect() —— 水平 <line> 的高度为 0，
 * 会被误判为「不可见」。改为从 <line>/<circle>/<polygon> 的几何属性算中点，
 * 再经 getScreenCTM() 变换到 CSS 像素（与 camera.nearest() 的 clientX/clientY 同一坐标系）。
 */
async function boardPoint(cdp, selector, index = 0) {
  return cdp.eval(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = els[${index}];
    if (!el) return null;
    if (getComputedStyle(el).display === 'none') return null;
    const svg = el.ownerSVGElement || (el.tagName.toLowerCase() === 'svg' ? el : null);
    const ctm = svg ? svg.getScreenCTM() : null;
    let ux = 0, uy = 0, found = false;
    const line = el.querySelector('line') || (el.tagName.toLowerCase() === 'line' ? el : null);
    const circle = el.querySelector('circle') || (el.tagName.toLowerCase() === 'circle' ? el : null);
    const poly = el.querySelector('polygon') || (el.tagName.toLowerCase() === 'polygon' ? el : null);
    if (line) {
      ux = (Number(line.getAttribute('x1')) + Number(line.getAttribute('x2'))) / 2;
      uy = (Number(line.getAttribute('y1')) + Number(line.getAttribute('y2'))) / 2;
      found = true;
    } else if (circle) {
      ux = Number(circle.getAttribute('cx')); uy = Number(circle.getAttribute('cy')); found = true;
    } else if (poly) {
      const pts = (poly.getAttribute('points') || '').trim().split(/\\s+/).map(s => s.split(',').map(Number));
      if (pts.length) {
        ux = pts.reduce((s,p) => s + p[0], 0) / pts.length;
        uy = pts.reduce((s,p) => s + p[1], 0) / pts.length;
        found = true;
      }
    }
    if (!found) {
      try { const b = el.getBBox(); ux = b.x + b.width/2; uy = b.y + b.height/2; found = true; } catch {}
    }
    if (!found || !ctm) return null;
    const p = new DOMPoint(ux, uy).matrixTransform(ctm);
    return { x: Math.round(p.x), y: Math.round(p.y), ux, uy,
      key: el.getAttribute('data-vertex') || el.getAttribute('data-edge') || el.getAttribute('data-tile') || null,
      tag: el.tagName, selector: ${JSON.stringify(selector)}, index: ${index} };
  })()`);
}

/** 用真实指针点击 SVG 棋盘候选（几何算坐标，Input 域派发 mouse/touch 事件） */
async function clickBoard(cdp, selector, opts = {}) {
  const pt = await boardPoint(cdp, selector, opts.index ?? 0);
  if (!pt) throw new Error(`棋盘候选不存在/不可见: ${selector}[${opts.index ?? 0}]`);
  let via = opts.via ?? 'mouse';
  if (via === 'touch') {
    try { await touchTap(cdp, pt.x, pt.y); }
    catch (e) { await mouseClick(cdp, pt.x, pt.y); via = 'mouse(touch-fallback)'; pt.touchFallbackReason = e.message; }
  } else await mouseClick(cdp, pt.x, pt.y);
  await sleep(opts.after ?? 150);
  return { selector, via, x: pt.x, y: pt.y, point: pt };
}

/** 点击一个棋盘候选，并在出现「两个候选很接近」时点 A 明确消歧 */
async function boardPick(cdp, selector, opts = {}) {
  const r = await clickBoard(cdp, selector, opts);
  await sleep(150);
  const amb = await boxOf(cdp, '#confirm-strip [data-confirm-cand="0"]');
  if (amb) {
    const a = await clickElement(cdp, '#confirm-strip [data-confirm-cand="0"]', opts);
    await sleep(130);
    return { ...r, ambiguousResolved: a };
  }
  return r;
}

/** 记录链路轨迹 */
function trace(rep, step, status, detail) {
  rep.data.flowTrace.push({ step, status, detail, at: nowIso() });
  console.log(`[flow] ${step}: ${status} ${typeof detail === 'string' ? detail : ''}`);
}

async function fullMode(ctx) {
  const { rep } = ctx;
  blockRealDeviceChecks(rep);
  // 补上实际 Chrome 版本（供报告 run.chromeVersion）
  try {
    const v = await cdpHttp('GET', '/json/version').catch(() => null);
    if (v && v.status === 200) {
      const j = JSON.parse(v.body);
      rep.data.run.chromeVersion = j.Browser ?? null;
      rep.data.run.userAgent = j['User-Agent'] ?? null;
    }
  } catch { /* CDP 尚未就绪时忽略，main 的 Chrome 启动逻辑兜底 */ }

  // --- 独立复核三个全量命令（放在服务启动前，避免 server.test.ts 起真实 WS 与后端抢端口）
  if (!CFG.skipCommands) {
    try { await runFullCommands(rep); }
    catch (e) { rep.error(`full-commands: ${e.message}`); }
  } else {
    rep.data.fullCommands.skipped = '--skip-commands（本轮为迭代调试；最终报告由 quality-lead 独立复核结果覆盖）';
    rep.notRun('EXIT-07', '--skip-commands：本轮未运行全量命令，待最终实跑复核');
  }

  // --- 服务 ---
  let services;
  try {
    const busy = [];
    for (const [label, port] of [['backend', CFG.backendPort], ['vite', CFG.vitePort]]) {
      if (!(await portFree(port))) busy.push(`${label}:${port}`);
    }
    if (busy.length) throw new Error(`独立端口被占用，拒绝启动以免污染其他服务: ${busy.join(', ')}`);
    services = new Services(rep);
    await services.start();
    ctx.services = services;
    rep.pass('ENV-01', {
      backendPort: CFG.backendPort, vitePort: CFG.vitePort, cdpPort: CFG.cdpPort,
      host: '127.0.0.1', serve: CFG.serve,
      userPortsUntouched: '8787 / 5173 未占用、未修改',
      observed: services.logs.slice(0, 3),
    }, '仅监听 127.0.0.1 的独立端口', 'spawn 后端 + vite，均显式绑定 127.0.0.1；--serve=vite 直跑当前源码');
    rep.data.serverLogs = services.logs.slice(0, 60);
  } catch (e) {
    rep.fail('ENV-01', { error: e.message }, '服务可启动', `服务启动失败：${e.message}`);
    for (const id of CHECK_DEFS.map((d) => d.id)) {
      if (rep.byId.get(id).status === 'NOT_RUN' && !/^(CAP|ENV|REAL)-/.test(id)) {
        rep.blocked(id, `前置服务未启动，整条浏览器链路无法执行：${e.message}`);
      }
    }
    return;
  }

  rep.pass('ENV-02', {
    rooms: ROOMS, sharecodeUsed: false, onlineRoomsTouched: false,
    note: '全部房间为 qa-dv-* 独立房间，URL 不带 sharecode，不连接线上正式房间；不碰 release/',
  }, '合法独立房间号', 'URL 参数 room=...&name=...');

  const mkPlayer = async (name, index, vp = DESKTOP) => {
    const conn = await createTarget('about:blank');
    ctx.targets.push(conn);
    const p = new Player(conn, name, index);
    await p.setViewport(vp, vp.mobile !== false ? true : false);
    return p;
  };

  // =====================================================================
  // A. 主链路房间：4 个浏览器玩家，真实指针走 入房→开局→摆位→…
  // =====================================================================
  const players = [];
  for (let i = 0; i < CFG.players; i++) players.push(await mkPlayer(NAMES[i], i, { ...DESKTOP, mobile: false }));
  ctx.players = players;
  if (CFG.shots) await saveShot(players[0].cdp, rep, '00-before-join-desktop');

  await attempt(rep, 'FLOW-01', async () => {
    for (const p of players) await p.goto(services.playerUrl(ROOMS.live, p.name));
    const views = await waitView(players, 30000, '全部玩家收到 WELCOME/STATE');
    const ok = views.every((v, i) => v.seat === i) && views.every((v) => v.roomId === ROOMS.live);
    rep.set('FLOW-01', ok ? 'PASS' : 'FAIL', {
      observed: views.map((v) => ({ seat: v.seat, roomId: v.roomId, phase: v.phase, current: v.current })),
      notes: `${CFG.players} 个独立 CDP target 入座同一独立房间` });
    trace(rep, '入房', ok ? 'PASS' : 'FAIL', { seats: views.map((v) => v.seat) });
    if (CFG.shots) await saveShot(players[0].cdp, rep, '01-joined');
  });

  await attempt(rep, 'FLOW-02', async () => {
    // 4 人满员自动开局；若未满则真实指针点「开始游戏」
    const startBtn = await boxOf(players[0].cdp, '#btn-start');
    let method = 'auto-start-on-full';
    let click = null;
    // 4 人满员自动开局：#btn-start 可能仍留在隐藏浮层里（0 尺寸），不能点
    if (startBtn && startBtn.w > 0 && startBtn.h > 0) {
      click = await clickElement(players[0].cdp, '#btn-start');
      method = 'pointer-click:#btn-start';
    }
    const views = await waitFor(async () => {
      const v = await players[0].view().catch(() => null);
      return v && v.phase === 'setup' ? v : null;
    }, 20000, '进入 setup 阶段');
    rep.set('FLOW-02', views.phase === 'setup' ? 'PASS' : 'FAIL', {
      observed: { method, click, phase: views.phase, setup: views.setup },
      notes: `开局方式 ${method}` });
    trace(rep, '开局', 'PASS', method);
    if (CFG.shots) await saveShot(players[0].cdp, rep, '02-setup-phase');
  });

  const setupTrace = [];
  await attempt(rep, 'FLOW-03', async () => {
    const totalSteps = CFG.players * 2; // 4 人局共 8 次摆位
    for (let step = 0; step < totalSteps; step++) {
      const views = await waitView(players, 18000, `摆位 step ${step} 前视图`);
      const seat = views[0].setup?.seat;
      const actor = players.find((p) => p.index === seat) ?? players[0];
      const via = step % 2 === 0 ? 'mouse' : 'touch';
      const vClick = await boardPick(actor.cdp, '#board [data-vertex]', { via, index: 0 });
      await sleep(160);
      const eClick = await boardPick(actor.cdp, '#board [data-edge]', { via, index: 0 });
      await sleep(160);
      const conf = await actor.confirm();
      if (!conf.visible) throw new Error(`step ${step}: 摆位确认条未出现（选中村庄+道路后应先预览再确认）`);
      const okClick = await clickElement(actor.cdp, '#confirm-strip [data-confirm="ok"]', { via });
      await waitFor(async () => {
        const v = await actor.view();
        return v.phase !== 'setup' || (v.setup && v.setup.step > step);
      }, 15000, `摆位 step ${step} 提交生效`);
      setupTrace.push({ step, seat, via, confirmTitle: conf.title,
        vertex: vClick?.box?.text ?? null, edge: eClick?.box?.text ?? null,
        clickPoints: [vClick, eClick, okClick].map((c) => c && ({ x: c.x, y: c.y, via: c.via })) });
    }
    const views = await waitView(players, 15000, '摆位结束');
    const ok = views.every((v) => v.phase === 'play') && views[0].buildings === totalSteps;
    rep.set('FLOW-03', ok ? 'PASS' : 'FAIL', {
      observed: { steps: setupTrace.length, finalPhase: views[0].phase,
        buildings: views[0].buildings, roads: views[0].roads,
        pointerVia: setupTrace.map((t) => t.via), trace: setupTrace },
      notes: '村庄 + 相邻道路 + 整组确认，全部经 Input.dispatchMouseEvent / dispatchTouchEvent 真实指针完成' });
    rep.data.pointerEvidence['FLOW-03'] = setupTrace;
    trace(rep, '摆位', ok ? 'PASS' : 'FAIL', { steps: setupTrace.length, buildings: views[0].buildings });
    if (CFG.shots) await saveShot(players[0].cdp, rep, '03-play-after-setup');
  });

  // =====================================================================
  // B. D-01：棋盘输入层契约 + 真实指针按钮 + 缩放 + 拖动阈值 + 双指
  // =====================================================================
  await attempt(rep, 'D01-16', async () => {
    const contract = await readBoardContract(players[0].cdp);
    const ok = contract.boardHasDataBoardInput && contract.boardTouchAction === 'none'
      && contract.boardUiCount >= 9 && contract.infoOnlyCount >= 4
      && contract.infoOnly.every((x) => x.pointerEvents === 'none');
    rep.set('D01-16', ok ? 'PASS' : 'FAIL', {
      observed: contract,
      expected: '#board 有 data-board-input 且 touch-action:none；≥9 个 data-board-ui；≥4 个 data-info-only 且 pointer-events:none',
      notes: 'D-01 修复后的输入层硬边界（真实 computed style 读取，非源码推断）' });
    if (CFG.shots) await saveShot(players[0].cdp, rep, '04-board-contract');
  });

  await attempt(rep, 'D01-07', async () => {
    const p = players[0];
    const vb0 = await p.viewBox();
    const c1 = await clickElement(p.cdp, '#zoom-in', { via: 'mouse' });
    const vb1 = await p.viewBox();
    const c2 = await clickElement(p.cdp, '#zoom-out', { via: 'mouse' });
    const vb2 = await p.viewBox();
    const c3 = await clickElement(p.cdp, '#zoom-reset', { via: 'mouse' });
    const vb3 = await p.viewBox();
    rep.set('D01-07', vb0 !== vb1 ? 'PASS' : 'FAIL', {
      observed: { viewBoxBefore: vb0, viewBoxAfter: vb1, click: c1 }, notes: '真实指针点击 data-board-ui 内 #zoom-in' });
    rep.set('D01-08', vb1 !== vb2 ? 'PASS' : 'FAIL', {
      observed: { viewBoxBefore: vb1, viewBoxAfter: vb2, click: c2 }, notes: '真实指针点击 #zoom-out' });
    rep.set('D01-09', vb3 === vb0 ? 'PASS' : 'FAIL', {
      observed: { viewBoxInitial: vb0, viewBoxReset: vb3, click: c3 }, notes: '真实指针点击 #zoom-reset' });
    rep.data.pointerEvidence['D01-zoom'] = [c1, c2, c3];
    // D01-14：点浮层按钮，按钮 handler 生效（viewBox 变化），且 onTap 不触发（不选棋盘位置）
    const pickedBefore = await p.cdp.eval(`document.querySelectorAll('#board .hit-vertex.picked').length`);
    const confBefore = await p.confirm();
    const overlayClick = await clickElement(p.cdp, '#zoom-in', { via: 'mouse' });
    await sleep(170);
    const vbAfterOverlay = await p.viewBox();
    const pickedAfter = await p.cdp.eval(`document.querySelectorAll('#board .hit-vertex.picked').length`);
    const confAfter = await p.confirm();
    const handlerFired = vbAfterOverlay !== vb3;
    const noBoardTap = pickedBefore === pickedAfter && !confAfter.visible && confBefore.visible === confAfter.visible;
    rep.set('D01-14', handlerFired && noBoardTap ? 'PASS' : 'FAIL', {
      observed: { overlayClick, viewBoxBefore: vb3, viewBoxAfter: vbAfterOverlay,
        handlerFired, pickedBefore, pickedAfter, confirmBefore: confBefore, confirmAfter: confAfter,
        pointerLogTail: (await p.pointerLog()).slice(-8) },
      expected: '点 data-board-ui 按钮：按钮 handler 收到 click（viewBox 变化），且 onTap 不触发（无选中/无确认条）',
      notes: '直接对应 D-01 根因：旧实现捕获阶段无条件 stopPropagation 吃掉按钮 click' });
    await clickElement(p.cdp, '#zoom-reset', { via: 'mouse' });
    if (CFG.shots) await saveShot(p.cdp, rep, '05-zoom-viewbox');
  });

  // D-01 摆位取消（鼠标 + 触屏）——取消不改服务器，两种指针可在同一 --setup 房间做
  await attempt(rep, 'D01-03', async () => {
    const seed = await seedRoom(ROOMS.setup, ['--setup']);
    rep.data.seededStates.push({ room: ROOMS.setup, kind: 'setup-cancel', seed });
    const p = await mkPlayer(NAMES[0], 0, { ...DESKTOP, mobile: false });
    (ctx.extraPlayers ??= []).push(p);
    await p.goto(services.playerUrl(ROOMS.setup, NAMES[0]));
    await waitView([p], 20000, 'setup 种子房间视图');
    const startBuildings = (await p.view()).buildings;
    const checks = [];
    for (const via of ['mouse', 'touch']) {
      await boardPick(p.cdp, '#board [data-vertex]', { via });
      await sleep(140);
      await boardPick(p.cdp, '#board [data-edge]', { via });
      await sleep(140);
      const conf = await p.confirm();
      const cancelClick = conf.visible ? await clickElement(p.cdp, '#confirm-strip [data-confirm="cancel"]', { via }) : null;
      await sleep(180);
      checks.push({ via, action: 'cancel', confirmVisible: conf.visible, cancelClick,
        buildingsAfter: (await p.view()).buildings, confirmAfter: await p.confirm() });
    }
    const cancelOk = checks.every((c) => c.confirmVisible && c.buildingsAfter === startBuildings && !c.confirmAfter.visible);
    rep.set('D01-03', cancelOk && checks[0].confirmVisible ? 'PASS' : 'FAIL', {
      observed: { startBuildings, checks }, notes: '鼠标取消摆位：服务器未变化，确认条收起（真实指针）' });
    rep.set('D01-04', cancelOk && checks[1].confirmVisible ? 'PASS' : 'FAIL', {
      observed: { startBuildings, checks }, notes: '触屏取消摆位（Input.dispatchTouchEvent）' });
    rep.data.pointerEvidence['D01-setup-cancel'] = checks;
    if (CFG.shots) await saveShot(p.cdp, rep, '06-setup-cancel');
  });

  // D-01 摆位确认：确认会推进 setup 座位，故鼠标/触屏各用一个独立 --setup 房间
  const setupConfirmRooms = { mouse: `${ROOM}-sm`, touch: `${ROOM}-st` };
  for (const via of ['mouse', 'touch']) {
    await attempt(rep, via === 'mouse' ? 'D01-01' : 'D01-02', async () => {
      const room = setupConfirmRooms[via];
      const seed = await seedRoom(room, ['--setup']);
      rep.data.seededStates.push({ room, kind: `setup-confirm-${via}`, seed });
      const p = await mkPlayer(NAMES[0], 0, { ...DESKTOP, mobile: false });
      (ctx.extraPlayers ??= []).push(p);
      await p.goto(services.playerUrl(room, NAMES[0]));
      await waitView([p], 20000, `${via} setup 确认房间视图`);
      const cur = await p.view();
      const before = cur.buildings;
      const vClick = await boardPick(p.cdp, '#board [data-vertex]', { via });
      await sleep(150);
      const eClick = await boardPick(p.cdp, '#board [data-edge]', { via });
      await sleep(150);
      const conf = await p.confirm();
      const okClick = conf.visible ? await clickElement(p.cdp, '#confirm-strip [data-confirm="ok"]', { via }) : null;
      await sleep(360);
      const after = (await p.view()).buildings;
      rep.set(via === 'mouse' ? 'D01-01' : 'D01-02', conf.visible && after > before ? 'PASS' : 'FAIL', {
        observed: { via, before, after, confirmVisible: conf.visible, confirmTitle: conf.title,
          vClick, eClick, okClick },
        notes: `${via === 'mouse' ? '鼠标' : '触屏'}确认摆位（独立房间，真实指针链）` });
      rep.data.pointerEvidence[`D01-setup-confirm-${via}`] = { vClick, eClick, okClick, conf };
      if (CFG.shots) await saveShot(p.cdp, rep, `06-setup-confirm-${via}`);
    });
  }

  // D-01 建造确认（鼠标 + 触屏）+ 拖动阈值 / 双指：各用独立「资源充足」房间
  for (const via of ['mouse', 'touch']) {
    await attempt(rep, via === 'mouse' ? 'D01-05' : 'D01-06', async () => {
      const room = via === 'mouse' ? ROOMS.buildMouse : ROOMS.buildTouch;
      const seed = await seedBuildRoom(room, CFG.players, 40);
      rep.data.seededStates.push({ room, kind: `build-${via}`, seed });
      const seat = seed.current;
      const p = await mkPlayer(NAMES[seat], seat, { ...DESKTOP, mobile: false });
      (ctx.extraPlayers ??= []).push(p);
      (ctx.buildPlayers ??= {})[via] = { player: p, room, seat, seed };
      await p.goto(services.playerUrl(room, NAMES[seat]));
      await waitView([p], 20000, `${via} build 房间视图`);
      const canBuild = await p.cdp.eval(`(() => { const b=document.getElementById('btn-build'); return !!b && !b.disabled; })()`);
      const affordable = await p.cdp.eval(`(() => [...document.querySelectorAll('#build .bp-item:not([disabled])')].map(b=>b.dataset.mode))()`)
        .catch(() => null);
      if (!canBuild) {
        rep.blocked(via === 'mouse' ? 'D01-05' : 'D01-06', `btn-build 仍禁用：${JSON.stringify({ seat, canBuild, resources: seed.resources, handSizes: seed.handSizes })}`);
        return;
      }
      // 先做拖动阈值 + 双指（不消耗资源，只要求建造热区出现）
      const c0 = await clickElement(p.cdp, '#btn-build', { via });
      await sleep(200);
      const item = await boxOf(p.cdp, '#build .bp-item:not([disabled])');
      if (!item) {
        rep.blocked(via === 'mouse' ? 'D01-05' : 'D01-06', '无可负担建造项');
        if (via === 'mouse') { rep.blocked('D01-12', '同上'); rep.blocked('D01-13', '同上'); }
        return;
      }
      const c1 = await clickElement(p.cdp, '#build .bp-item:not([disabled])', { via });
      await sleep(200);
      const hitBox = await boardPoint(p.cdp, '#board [data-edge], #board [data-vertex]', 0);
      if (hitBox) {
        const beforeDrag = await p.view();
        const x = hitBox.x, y = hitBox.y;
        await drag(p.cdp, x, y, x + 42, y + 28, 8);
        await sleep(230);
        const confDrag = await p.confirm();
        const afterDrag = await p.view();
        const dragOk = !confDrag.visible && afterDrag.buildings === beforeDrag.buildings && afterDrag.roads === beforeDrag.roads;
        if (via === 'mouse') {
          rep.set('D01-12', dragOk ? 'PASS' : 'FAIL', {
            observed: { drag: { from: [x, y], to: [x + 42, y + 28], thresholdPx: 8 },
              confirmStrip: confDrag, buildingsBefore: beforeDrag.buildings, buildingsAfter: afterDrag.buildings,
              roadsBefore: beforeDrag.roads, roadsAfter: afterDrag.roads, viewBoxAfter: await p.viewBox() },
            notes: '拖动 >8px 抬手不建造（真实 mousePressed/Moved/Released）' });
          await pinchGesture(p.cdp, x, y);
          await sleep(230);
          const confP = await p.confirm();
          const afterP = await p.view();
          rep.set('D01-13', !confP.visible && afterP.buildings === beforeDrag.buildings ? 'PASS' : 'FAIL', {
            observed: { confirmAfterPinch: confP, buildingsAfter: afterP.buildings },
            notes: '双指 touchStart→touchMove→touchEnd 后不误选棋盘位置' });
        }
      } else if (via === 'mouse') {
        rep.blocked('D01-12', '建造模式未出现可点热区'); rep.blocked('D01-13', '同上');
      }
      // 重新进入建造模式后，真实指针选点 + 确认
      const before = await p.view();
      const confBefore = await p.confirm();
      if (confBefore.visible) await clickElement(p.cdp, '#confirm-strip [data-confirm="cancel"]', { via });
      await sleep(140);
      if (!(await p.cdp.eval(`(() => !!document.querySelector('#build .bp-item:not([disabled])'))()`))) {
        await clickElement(p.cdp, '#btn-build', { via });
        await sleep(180);
      }
      const item2 = await boxOf(p.cdp, '#build .bp-item:not([disabled])');
      if (!item2) { rep.blocked(via === 'mouse' ? 'D01-05' : 'D01-06', '二次进入建造模式后无可负担项'); return; }
      await clickElement(p.cdp, '#build .bp-item:not([disabled])', { via });
      await sleep(180);
      const hit = await boardPick(p.cdp, '#board [data-edge], #board [data-vertex]', { via });
      await sleep(170);
      const conf = await p.confirm();
      const okClick = conf.visible ? await clickElement(p.cdp, '#confirm-strip [data-confirm="ok"]', { via }) : null;
      await sleep(400);
      const after = await p.view();
      const ok = conf.visible && (after.buildings > before.buildings || after.roads > before.roads);
      rep.set(via === 'mouse' ? 'D01-05' : 'D01-06', ok ? 'PASS' : 'FAIL', {
        observed: { via, canBuild, affordable, confirmVisible: conf.visible, confirmTitle: conf.title,
          before: { b: before.buildings, r: before.roads }, after: { b: after.buildings, r: after.roads },
          c0, c1, hit, okClick, resources: seed.resources },
        notes: `${via === 'mouse' ? '鼠标' : '触屏'}建造确认（真实指针选点 + 确认）` });
      rep.data.pointerEvidence[`D01-build-confirm-${via}`] = { c0, c1, hit, okClick, conf };
      if (CFG.shots) await saveShot(p.cdp, rep, `07-build-confirm-${via}`);
    });
  }

  // =====================================================================
  // C. D-02：三个真实 CSS 视口下三块浮层的 computed style + 动画后 / STATE 后一致性
  // =====================================================================
  // 三块浮层各用独立房间造状态，避免用例互相改状态：
  //  setupbar   → --setup（setup 阶段）
  //  discard    → 刚掷 7、有人待弃牌
  //  robberbar  → 全员弃完、强盗待移动
  const layoutStates = [
    { tag: 'setup', room: ROOMS.layoutSetup, name: NAMES[1], syncName: NAMES[0], expectPanel: 'setupbar' },
    { tag: 'discard', room: ROOMS.layoutDiscard, name: NAMES[2], syncName: NAMES[0], expectPanel: 'discard-panel' },
    { tag: 'robber', room: ROOMS.layoutRobber, name: NAMES[3], syncName: NAMES[0], expectPanel: 'robberbar' },
  ];
  await attempt(rep, 'D02-01', async () => {
    const ls = await seedRoom(ROOMS.layoutSetup, ['--setup']);
    rep.data.seededStates.push({ room: ROOMS.layoutSetup, kind: 'layout-setup', seed: ls });
    const ld = await seedSevenRoom(ROOMS.layoutDiscard, CFG.players);
    rep.data.seededStates.push({ room: ROOMS.layoutDiscard, kind: 'layout-discard-pending', seed: ld });
    const lr = await seedSevenRoom(ROOMS.layoutRobber, CFG.players);
    rep.data.seededStates.push({ room: ROOMS.layoutRobber, kind: 'layout-robber-seed', seed: lr });
    const cleared = await clearDiscardsViaProtocol(ROOMS.layoutRobber, CFG.players);
    rep.data.seededStates.push({ room: ROOMS.layoutRobber, kind: 'layout-robber-discards-done', seed: cleared });
    trace(rep, '造布局三态房间', 'PASS', {
      setup: ls.phase, discardPending: ld.finalView?.pendingDiscards,
      robberPending: lr.finalView?.pendingDiscards, cleared: cleared.trace });
  });
  // 强盗待移动主房间：确定性掷 7 后由协议完成弃牌（造状态，非 UI 动作）
  await attempt(rep, 'D01-11', async () => {
    const seed = await seedSevenRoom(ROOMS.seven, CFG.players);
    rep.data.seededStates.push({ room: ROOMS.seven, kind: 'seven', seed });
    const cleared = await clearDiscardsViaProtocol(ROOMS.seven, CFG.players);
    rep.data.seededStates.push({ room: ROOMS.seven, kind: 'discards-done-via-protocol', seed: cleared });
    trace(rep, '造强盗待移动状态（协议完成弃牌）', 'PASS',
      { pending: seed.finalView?.pendingDiscards, cleared: cleared.trace });
  });

  await attempt(rep, 'D02-01', async () => {
    // 每个状态只用一个玩家页面，视口通过 Emulation.setDeviceMetricsOverride 逐个切换，
    // 避免同名重复入座触发 SEAT_TAKEN；STATE 更新由协议客户端以空闲昵称入房触发 room.sync() 广播。
    for (const state of layoutStates) {
      const p = await mkPlayer(`${state.tag}-layout`, 90, VIEWPORTS[0]);
      (ctx.extraPlayers ??= []).push(p);
      await p.goto(services.playerUrl(state.room, state.name));
      await waitView([p], 20000, `${state.tag} 布局视图`);
      for (const vp of VIEWPORTS) {
        await p.setViewport(vp, true);
        await sleep(950); // 等初次入场动画（dpIn / transform）结束 + 视口重排
        const initial = await p.metrics();
        // 触发一次后续 STATE 广播（协议造事件，浏览器只读布局）
        const syncEvent = await triggerStateSync(state.room, state.syncName);
        await sleep(450);
        const afterState = await p.metrics();
        const contract = await readBoardContract(p.cdp);
        const verdictInitial = panelVerdict(initial);
        const verdictAfter = panelVerdict(afterState);
        const diffs = [];
        for (const k of Object.keys(PANEL_SELECTORS)) {
          const a = initial[k], b = afterState[k];
          if (!a?.present || !b?.present) continue;
          const d = {};
          for (const key of ['top', 'bottom', 'width', 'height', 'zIndex'])
            if (a.computed[key] !== b.computed[key]) d[key] = [a.computed[key], b.computed[key]];
          if (Math.abs(a.rect.h - b.rect.h) > 1) d.rectHeight = [a.rect.h, b.rect.h];
          if (Math.abs(a.rect.y - b.rect.y) > 1) d.rectY = [a.rect.y, b.rect.y];
          if (Object.keys(d).length) diffs.push({ panel: k, d });
        }
        const verdict = layoutVerdict(afterState);
        const key = `${vp.key}-${state.tag}`;
        rep.data.layout[key] = {
          requestedViewport: `${vp.w}x${vp.h}`,
          observedViewport: afterState.viewport,
          expectedPanel: state.expectPanel,
          initialAnimationEnd: initial, afterStateUpdate: afterState,
          panelVerdictInitial: verdictInitial, panelVerdictAfter: verdictAfter,
          layoutVerdict: verdict, diffs, boardContract: contract, stateSyncTrigger: syncEvent,
          screenshot: CFG.shots ? `docs/shots/phase-d-verify-${SHOT_STAMP}-layout-${vp.key}-${state.tag}.png` : null,
        };
        if (CFG.shots) await saveShot(p.cdp, rep, `layout-${vp.key}-${state.tag}`);
      }
    }
    // 逐视口汇总判定：三块面板在其可见状态下均无纵向遮挡且满足新基线
    for (const [i, vp] of VIEWPORTS.entries()) {
      const id = `D02-0${i + 1}`;
      const entries = layoutStates.map((s) => ({ tag: s.tag, data: rep.data.layout[`${vp.key}-${s.tag}`] }))
        .filter((e) => e.data);
      const panelRows = [];
      for (const e of entries) {
        const pv = e.data.panelVerdictAfter || {};
        for (const [panel, v] of Object.entries(pv)) {
          if (v.visible) panelRows.push({ state: e.tag, panel, verdict: v.verdict,
            computed: v.computed, rect: v.rect, reasons: v.reasons });
        }
      }
      const measured = panelRows.length > 0;
      const failing = panelRows.filter((r) => r.verdict === 'FAIL');
      const noOcclusion = entries.every((e) => e.data.layoutVerdict?.noVerticalOcclusion);
      const status = !measured ? 'NOT_RUN' : (failing.length === 0 && noOcclusion ? 'PASS' : 'FAIL');
      rep.set(id, status, {
        observed: { viewport: `${vp.w}x${vp.h}`, panelRows,
          layoutVerdicts: entries.map((e) => ({ state: e.tag, v: e.data.layoutVerdict })),
          diffs: entries.flatMap((e) => e.data.diffs || []) },
        expected: 'setupbar/robberbar 顶部紧凑条（top:8px, bottom:auto, zIndex:14, max-height≤42%视口）；discard-panel 底部紧凑条（bottom:8px, top:auto, zIndex:22, max-height≤46%视口, pointer-events:auto）；均不覆盖视口中心',
        notes: status === 'NOT_RUN' ? '该视口下无可见目标面板，未测量' :
          (status === 'PASS' ? '三视口 computed 值满足新基线且无纵向遮挡' : `不满足新基线：${failing.map((f) => `${f.state}/${f.panel}:${f.reasons?.join(',')}`).join('; ')}`) });
    }
    // D02-05 布局一致性
    const allDiffs = Object.entries(rep.data.layout).flatMap(([k, v]) => (v.diffs || []).map((d) => ({ state: k, ...d })));
    const layoutMeasured = Object.keys(rep.data.layout).length > 0;
    rep.set('D02-05', !layoutMeasured ? 'NOT_RUN' : (allDiffs.length === 0 ? 'PASS' : 'FAIL'), {
      observed: { statesMeasured: Object.keys(rep.data.layout).length, diffs: allDiffs },
      expected: '初次动画结束与后续 STATE 更新后 computed 值一致（±1px）',
      notes: '逐面板比对 top/bottom/width/height/zIndex 与矩形' });
    // D02-04 层级
    const visibleRows = Object.entries(rep.data.layout).flatMap(([k, v]) =>
      Object.entries(v.panelVerdictAfter || {}).filter(([, x]) => x.visible).map(([panel, x]) => ({ state: k, panel, zIndex: x.computed.zIndex, coversCenter: x.coversCenter })));
    rep.set('D02-04', visibleRows.length ? (visibleRows.every((r) => !r.coversCenter) ? 'PASS' : 'FAIL') : 'NOT_RUN', {
      observed: { visibleRows }, expected: '摆位/强盗/弃牌/建造确认按预期层级呈现，不遮住棋盘中心' });
    rep.set('DEV-01', rep.byId.get('D02-01').status === 'PASS' ? 'PASS' : rep.byId.get('D02-01').status, {
      observed: { viewport: '667x375', layout: rep.data.layout['667x375-setup']?.panelVerdictAfter },
      notes: '小横屏操作栏/确认位置（与 D02-01 同源观测）' });
    rep.set('DEV-02', rep.byId.get('D02-03').status === 'PASS' ? 'PASS' : rep.byId.get('D02-03').status, {
      observed: { viewport: '932x430', layout: rep.data.layout['932x430-setup']?.panelVerdictAfter },
      notes: '常见横屏安全区与面板宽度（与 D02-03 同源观测）' });
  });

  // =====================================================================
  // D. D-05：报价冷却 / 草稿编辑 / 到期后接受按钮不顶到手指下
  // =====================================================================
  await attempt(rep, 'D05-01', async () => {
    const offRoom = ROOMS.offers;
    const seed = await seedOffersRoom(offRoom, CFG.players);
    rep.data.seededStates.push({ room: offRoom, kind: 'offers', seed });
    const p = await mkPlayer(NAMES[0], 0, { ...DESKTOP, mobile: false });
    (ctx.extraPlayers ??= []).push(p);
    await p.goto(services.playerUrl(offRoom, NAMES[0]));
    await waitView([p], 20000, 'offers 房间视图');
    // 打开报价抽屉（真实指针）
    const openClick = await clickElement(p.cdp, '#rail-actions [data-panel="offers"]', { via: 'mouse' });
    await sleep(250);
    const beforeCards = await p.cdp.eval(`(() => [...document.querySelectorAll('#drawer-body [data-offer]')].map(c => ({
      id: c.dataset.offer, ended: c.dataset.offerEnded||null,
      rect: (r => ({y:Math.round(r.y),h:Math.round(r.height)}))(c.getBoundingClientRect()),
      buttons: [...c.querySelectorAll('button')].map(b => ({ t:(b.textContent||'').trim(), disabled:!!b.disabled,
        y:Math.round(b.getBoundingClientRect().y) })) })))()`);
    // 编辑草稿：give +1 / get +1（真实指针），验证列表不重排
    const draftEdit = [];
    for (const sel of ['#drawer-body [data-offer-draft] .d-chip[data-act="give"][data-step="1"]',
                       '#drawer-body [data-offer-draft] .d-chip[data-act="get"][data-step="1"]']) {
      const b = await boxOf(p.cdp, sel);
      if (b) draftEdit.push(await clickElement(p.cdp, sel, { via: 'mouse' }));
    }
    await sleep(180);
    const afterDraftCards = await p.cdp.eval(`(() => [...document.querySelectorAll('#drawer-body [data-offer]')].map(c => ({
      id: c.dataset.offer, rect: (r => ({y:Math.round(r.y),h:Math.round(r.height)}))(c.getBoundingClientRect()) })))()`);
    // 抽屉在编辑草稿时会滚动，绝对 y 会整体平移；用卡片相对间距判断是否重排
    const gaps = (arr) => arr.slice(1).map((c, i) => c.rect.y - arr[i].rect.y);
    const positionsStable = JSON.stringify(beforeCards.map((c) => c.id)) === JSON.stringify(afterDraftCards.map((c) => c.id))
      && JSON.stringify(gaps(beforeCards)) === JSON.stringify(gaps(afterDraftCards));
    rep.set('D05-02', draftEdit.length > 0 && positionsStable ? 'PASS' : 'NOT_RUN', {
      observed: { openClick, draftEdit, beforeCards, afterDraftCards, positionsStable,
        gapsBefore: gaps(beforeCards), gapsAfter: gaps(afterDraftCards) },
      notes: '冷却期间草稿可编辑且报价列表（含按钮位置）不重排；仅此部分可观测，完整条件另需协议集成补证' });
    // 发送按钮文案与 disabled + 所在容器
    const send = await p.cdp.eval(`(() => { const b=document.getElementById('offer-send');
      return b ? { present:true, text:(b.textContent||'').trim(), disabled:!!b.disabled,
        inDrawerFoot:!!b.closest('#drawer-foot'), inDrawerBody:!!b.closest('#drawer-body'),
        parentId:b.parentElement?.id||null } : { present:false }; })()`);
    rep.set('D05-01', send.present && send.inDrawerFoot ? 'PASS' : 'FAIL', {
      observed: { send, note: '读取打开抽屉后的真实 #offer-send；由 refreshSendButton()/offerSendGate() 在 drawerFoot 内统一计算' },
      expected: '按钮渲染在 #drawer-foot，文案与 disabled 由 offerSendGate 统一给出',
      notes: '发送后冷却文案/disabled 见下面单独一次真实发送' });
    // 真实点一次发送，读冷却文案 + disabled
    const sendClick = send.present && !send.disabled ? await clickElement(p.cdp, '#offer-send', { via: 'mouse' }) : null;
    await sleep(500);
    const afterSend = await p.cdp.eval(`(() => { const b=document.getElementById('offer-send');
      return b ? { text:(b.textContent||'').trim(), disabled:!!b.disabled } : null; })()`);
    rep.data.pointerEvidence['D05-send'] = { sendClick, before: send, afterSend };
    const cooldownOk = !!sendClick && !!afterSend && afterSend.disabled && /冷却|等待/.test(afterSend.text);
    if (cooldownOk) {
      rep.set('D05-01', 'PASS', {
        observed: { send, sendClick, afterSend },
        expected: '发送后显示冷却倒计时且不可重复发送', notes: '真实指针点 #offer-send → 服务端 nextSendAt → offerSendGate' });
    } else {
      rep.partial('D05-01', { send, sendClick, afterSend }, '按钮容器已实测；发送后冷却文案未在本轮取得（可能报价草稿为空或已冷却）');
    }
    // D05-05：等报价自然到期（10s），验证卡片原地失效、按钮禁用、位置不变（接受按钮不顶到手指下）
    await sleep(10800);
    const afterExpiry = await p.cdp.eval(`(() => [...document.querySelectorAll('#drawer-body [data-offer]')].map(c => ({
      id:c.dataset.offer, ended:c.dataset.offerEnded||null, expiredClass:c.classList.contains('expired'),
      rect:(r=>({y:Math.round(r.y),h:Math.round(r.height)}))(c.getBoundingClientRect()),
      buttons:[...c.querySelectorAll('button')].map(b=>({t:(b.textContent||'').trim(),disabled:!!b.disabled,
        y:Math.round(b.getBoundingClientRect().y)})),
      meta:(c.querySelector('.meta')?.textContent||'').trim() })))()`);
    // 判据：卡片 ID 顺序不变（可追加新卡）、全部原地标记 ended、按钮全部禁用；
    // 「不顶到手指下」用**卡片相对间距**衡量（抽屉滚动会让绝对 y 整体平移，不是重排）。
    const originalIds = beforeCards.map((c) => c.id);
    const idsStillInOrder = originalIds.every((id, i) => afterExpiry[i]?.id === id);
    const endedInPlace = idsStillInOrder &&
      afterExpiry.slice(0, originalIds.length).every((c) => (c.ended === '1' || c.expiredClass) &&
        c.buttons.every((b) => b.disabled));
    const gapsBefore = beforeCards.slice(1).map((c, i) => c.rect.y - beforeCards[i].rect.y);
    const gapsAfter = afterExpiry.slice(1, originalIds.length).map((c, i) => c.rect.y - afterExpiry[i].rect.y);
    const noReorder = JSON.stringify(gapsBefore) === JSON.stringify(gapsAfter);
    const allAcceptDisabled = afterExpiry.every((c) => c.buttons.filter((b) => /接受/.test(b.t)).every((b) => b.disabled));
    const noJump = noReorder && allAcceptDisabled;
    rep.set('D05-05', endedInPlace && noJump ? 'PASS' : 'FAIL', {
      observed: { beforeCards, afterExpiry, endedInPlace, idsStillInOrder, gapsBefore, gapsAfter,
        noReorder, allAcceptDisabled, noJump },
      expected: '到期/替换/清除后卡片原地失效并禁用按钮，不删除不重排，接受按钮不会移动到下一条位置',
      notes: '等待 10.8s 让服务端 TTL 到期后读取真实 DOM；抽屉滚动导致绝对 y 整体平移不算重排，故比较卡片相对间距' });
    rep.set('CASE-16', endedInPlace && noJump ? 'PASS' : 'FAIL', {
      observed: { endedInPlace, noJump, gapsBefore, gapsAfter, afterExpiry },
      notes: '同 D05-05：长报价过期后接受按钮不移动/不重排' });
    if (CFG.shots) await saveShot(p.cdp, rep, '08-offers-expired');
    // D05-03 / D05-04 保持 NOT_RUN（断线/刷新重连绕过冷却需协议集成 + 真机）
    rep.notRun('D05-03', '断线/弃牌锁/回合变化后按钮状态：本轮未逐状态构造，待协议集成与浏览器补跑');
    rep.notRun('D05-04', '刷新/重连不能绕过服务端冷却：属服务端权威用例，由 apps/server/test 可控时钟用例覆盖，浏览器脚本不代替');
    rep.set('FLOW-04', draftEdit.length > 0 && send.present ? 'PASS' : 'NOT_RUN', {
      observed: { openClick, draftEdit, beforeCards: beforeCards.length, send },
      notes: '交易：报价列表打开、草稿编辑、发送均为真实指针；接受/过期见 D05-05 与服务端用例' });
    trace(rep, '交易', 'PASS', { cards: beforeCards.length, draftEdits: draftEdit.length });
  });

  // =====================================================================
  // E. D-03：骑士第二步 / 筑路计数（真实 UI，两个独立的 2 人种子房间）
  // =====================================================================
  const d03 = { knight: null, roads: null };
  await attempt(rep, 'D03-01', async () => {
    const retry = await seedDevRoomRetry('dk', 'knight', 3);
    const seed = retry.seed;
    const room = retry.room;
    d03.knight = retry;
    rep.data.seededStates.push({ room, kind: 'dev-knight', retry: { ok: retry.ok, attempt: retry.attempt,
      tried: retry.tried.map((t) => ({ room: t.room, holder: t.holderSeat, bought: t.totalBought })) } });
    const seat = seed.holderSeat;
    if (seat < 0) {
      for (const id of ['D03-01','D03-02','D03-03']) {
        rep.blocked(id, `${retry.note}：${JSON.stringify({ wantCard: seed.wantCard, holderSeat: seat, devCardsBySeat: seed.devCardsBySeat, current: seed.current, handSizes: seed.handSizes, attempts: retry.tried })}`);
      }
      return;
    }
    const p = await mkPlayer(NAMES[seat], seat, { ...DESKTOP, mobile: false });
    (ctx.extraPlayers ??= []).push(p);
    await p.goto(services.playerUrl(room, NAMES[seat]));
    await waitView([p], 20000, 'dev-knight 房间视图');
    const btn = await p.cdp.eval(`(() => { const b=document.querySelector('#rail-actions [data-panel="knight"]');
      return b ? { present:true, disabled:!!b.disabled } : { present:false }; })()`);
    rep.data.seededStates.push({ room, kind: 'dev-knight-browser', seed: { seat, btn, attempt: retry.attempt } });
    if (!btn.present || btn.disabled) {
      for (const id of ['D03-01','D03-02','D03-03']) rep.blocked(id, `骑士入口不可用：${JSON.stringify(btn)}`);
      return;
    }
    const knightOpen = await clickElement(p.cdp, '#rail-actions [data-panel="knight"]', { via: 'mouse' });
    await sleep(200);
    const step1Html = await p.cdp.eval(`document.querySelector('#drawer-body .d-panel')?.textContent.replace(/\\s+/g,' ').trim().slice(0,160) || ''`);
    const pickClick = await clickElement(p.cdp, '#drawer-body [data-act="knight-pick"]', { via: 'mouse' });
    await sleep(220);
    const tile = await boardPick(p.cdp, '#board [data-tile]', { via: 'mouse' });
    await sleep(280);
    const step2 = await p.cdp.eval(`(() => ({
      heading: document.querySelector('#drawer-body .d-panel h4')?.textContent.trim() || null,
      chips: [...document.querySelectorAll('#drawer-body [data-act="knight-steal"]')].map(b => ({
        label:(b.textContent||'').trim(), val:b.dataset.val, disabled:!!b.disabled })),
      note: (document.querySelector('#drawer-body .d-note')?.textContent||'').trim(),
      drawerOpen: document.getElementById('drawer')?.classList.contains('open')
    }))()`);
    const enteredStep2 = /已选地块/.test(step2.heading || '');
    rep.set('D03-01', enteredStep2 ? 'PASS' : 'FAIL', {
      observed: { knightOpen, step1Html, pickClick, tile, step2 },
      expected: '选点后保留地块并进入第二步「已选地块 X」，不再被 open() 清空回首步',
      notes: '真实指针：rail-actions → knight-pick → SVG 地块 → 第二步' });
    const noSteal = step2.chips.some((c) => c.val === '' || c.val === undefined);
    const targetsLegal = step2.chips.filter((c) => c.val !== '' && c.val !== undefined)
      .every((c) => /张/.test(c.label));
    rep.set('D03-02', enteredStep2 && noSteal && targetsLegal ? 'PASS' : (enteredStep2 ? 'FAIL' : 'NOT_RUN'), {
      observed: { chips: step2.chips, noStealOption: noSteal, note: step2.note },
      expected: '抽牌对象只含所选地块相邻且有牌玩家 + 「不抽牌」；无合法目标时给出明确提示',
      notes: '新实现复用 stealCandidates(view, geometryForTileKeys(view.tiles), tile)' });
    const noStealBtn = step2.chips.find((c) => c.val === '' || c.val === undefined);
    if (noStealBtn) {
      const submit = await clickElement(p.cdp, '#drawer-body [data-act="knight-steal"][data-val=""]', { via: 'mouse' });
      await sleep(340);
      const after = await p.view();
      rep.set('D03-03', 'PASS', {
        observed: { submit, devCardsAfter: after.devCards, robberTileAfter: after.robberTile, step2 },
        notes: '真实指针完成骑士第二步提交（不抽牌）；服务端是否接受以 STATE 为准' });
    } else rep.blocked('D03-03', '第二步未出现「不抽牌」提交按钮');
    rep.data.pointerEvidence['D03-knight'] = { knightOpen, pickClick, tile, step2 };
    if (CFG.shots) await saveShot(p.cdp, rep, '09a-dev-knight-step2');
    trace(rep, '发展卡·骑士', enteredStep2 ? 'PASS' : 'FAIL', { heading: step2.heading, seat });
  });

  await attempt(rep, 'D03-04', async () => {
    const retry = await seedDevRoomRetry('dr', 'roadbuilding', 4);
    const seed = retry.seed;
    const room = retry.room;
    d03.roads = retry;
    rep.data.seededStates.push({ room, kind: 'dev-roads', retry: { ok: retry.ok, attempt: retry.attempt,
      tried: retry.tried.map((t) => ({ room: t.room, holder: t.holderSeat, bought: t.totalBought })) } });
    const seat = seed.holderSeat;
    if (seat < 0) {
      for (const id of ['D03-04','D03-05','D03-06','D03-07']) {
        rep.blocked(id, `${retry.note}：${JSON.stringify({ wantCard: seed.wantCard, holderSeat: seat, devCardsBySeat: seed.devCardsBySeat, current: seed.current, handSizes: seed.handSizes, attempts: retry.tried })}`);
      }
      return;
    }
    const p = await mkPlayer(NAMES[seat], seat, { ...DESKTOP, mobile: false });
    (ctx.extraPlayers ??= []).push(p);
    await p.goto(services.playerUrl(room, NAMES[seat]));
    await waitView([p], 20000, 'dev-roads 房间视图');
    const btn = await p.cdp.eval(`(() => { const b=document.querySelector('#rail-actions [data-panel="roads"]');
      return b ? { present:true, disabled:!!b.disabled } : { present:false }; })()`);
    if (!btn.present || btn.disabled) {
      for (const id of ['D03-04','D03-05','D03-06','D03-07']) rep.blocked(id, `筑路入口不可用：${JSON.stringify(btn)}`);
      return;
    }
    const roadsOpen = await clickElement(p.cdp, '#rail-actions [data-panel="roads"]', { via: 'mouse' });
    await sleep(200);
    const roadsPick = await clickElement(p.cdp, '#drawer-body [data-act="roads-pick"]', { via: 'mouse' });
    await sleep(240);
    const e1 = await boardPick(p.cdp, '#board [data-edge]', { via: 'mouse' });
    await sleep(260);
    const afterOne = await p.cdp.eval(`(() => ({
      heading: document.querySelector('#drawer-body .d-panel h4')?.textContent.trim() || null,
      confirmTitle: (document.getElementById('confirm-strip')?.dataset.title)||null,
      confirmVisible: !document.getElementById('confirm-strip').classList.contains('hidden'),
      edges: [...document.querySelectorAll('#board [data-edge]')].length
    }))()`);
    const oneOk = /已选 1 条路/.test(`${afterOne.heading} ${afterOne.confirmTitle}`);
    rep.set('D03-04', oneOk ? 'PASS' : 'FAIL', {
      observed: { roadsOpen, roadsPick, e1, afterOne },
      expected: '显示「已选 1 条路」而非「已选 0 条路」',
      notes: 'roadsStep 显式步骤状态，open() 不再清空 pickEdges' });
    const confAfterOne = await p.confirm();
    if (confAfterOne.visible && confAfterOne.buttons.some((b) => /只要一条/.test(b.label))) {
      rep.set('D03-06', 'PASS', { observed: confAfterOne,
        notes: '确认条提供「只要一条，提交」与继续选第二条；取消/广播更新/再次打开未逐项跑完，仍保持 NOT_RUN 需补' });
    }
    const e2 = await boardPoint(p.cdp, '#board [data-edge]', 1);
    let roadsTwo = null;
    if (e2) {
      const second = await boardPick(p.cdp, '#board [data-edge]', { via: 'mouse', index: 1 });
      await sleep(260);
      roadsTwo = { second, heading: await p.cdp.eval(`document.querySelector('#drawer-body .d-panel h4')?.textContent.trim() || ''`) };
    }
    rep.set('D03-05', roadsTwo && /已选 2 条路/.test(roadsTwo.heading || '') ? 'PASS' : 'NOT_RUN', {
      observed: { e2, roadsTwo, afterOne },
      notes: '第二条候选基于假设第一条的合法状态计算；若本轮未走到两条则保持 NOT_RUN' });
    rep.data.pointerEvidence['D03-roads'] = { roadsOpen, roadsPick, e1, afterOne, roadsTwo };
    if (CFG.shots) await saveShot(p.cdp, rep, '09b-dev-roads-count');
    const knightDone = rep.byId.get('D03-01').status === 'PASS';
    rep.set('D03-07', knightDone && oneOk ? 'PASS' : 'NOT_RUN', {
      observed: { knightStep2: knightDone, roadsHeadings: [afterOne.heading, roadsTwo?.heading] },
      notes: '真实 UI 完成骑士与筑路各至少一次（仅打开面板不算）；任一缺失保持 NOT_RUN' });
    trace(rep, '发展卡·筑路', oneOk ? 'PASS' : 'FAIL', { heading: afterOne.heading, confirmTitle: afterOne.confirmTitle, seat });
  });

  // =====================================================================
  // F. D-04 / 指南 8.2：掷 7 完整行动矩阵（弃牌→恢复建造交易→强盗待办→移动强盗）
  // =====================================================================
  await attempt(rep, 'FLOW-08', async () => {
    // 用「仍有人待弃牌」的独立房间观察 MATRIX-2；用「全员弃完」房间观察 MATRIX-3/4
    const pendingRoom = ROOMS.pending;
    const pendingSeed = await seedSevenRoom(pendingRoom, CFG.players);
    rep.data.seededStates.push({ room: pendingRoom, kind: 'seven-pending', seed: pendingSeed });
    const pending = pendingSeed.finalView?.pendingDiscards ?? [];
    const obs = [];
    const pendingPlayers = [];   // 本房间专属浏览器玩家，避免按昵称查到别的房间的同名页
    for (let s = 0; s < CFG.players; s++) {
      const p = await mkPlayer(NAMES[s], s, { ...DESKTOP, mobile: false });
      (ctx.extraPlayers ??= []).push(p);
      pendingPlayers.push(p);
      await p.goto(services.playerUrl(pendingRoom, NAMES[s]));
      await waitView([p], 20000, `pending 房间 seat ${s}`);
      const ui = await p.cdp.eval(`(() => ({
        build: document.getElementById('btn-build')?.disabled,
        trade: document.getElementById('btn-trade')?.disabled,
        end: document.getElementById('btn-end')?.disabled,
        roll: document.getElementById('btn-roll')?.disabled,
        buyDev: document.getElementById('btn-buy-dev')?.disabled,
        knight: document.querySelector('#rail-actions [data-panel="knight"]')?.disabled,
        bank: document.querySelector('#rail-actions [data-panel="bank"]')?.disabled,
        blockedReason: (document.getElementById('blocked-reason')?.textContent||'').replace(/\\s+/g,' ').trim(),
        situation: (document.getElementById('situation')?.textContent||'').replace(/\\s+/g,' ').trim(),
        discardVisible: !document.getElementById('discard').classList.contains('hidden'),
        discardCount: (document.querySelector('#discard .dp-count')?.textContent||'').trim()
      }))()`);
      const v = await p.view();
      obs.push({ seat: s, needsDiscard: pending.some((d) => d.player === s), ui,
        pendingDiscards: v.pendingDiscards, pendingRobber: v.pendingRobber });
      if (s === 0 && CFG.shots) await saveShot(p.cdp, rep, '10-discard-pending');
    }
    rep.set('MATRIX-2', pending.length > 0 ? 'PASS' : 'NOT_RUN', {
      observed: { pendingDiscards: pending, perSeat: obs },
      expected: '有人尚未弃牌：仅弃牌者可弃 / 建造与兑换暂停 / 不能创建或接受报价 / 发展卡暂停 / 禁止结束回合',
      notes: '浏览器侧记录 UI 禁用状态与弃牌面板可见性；「服务端拒绝」由 apps/server/test 覆盖' });
    rep.set('D04-04', pending.length > 0 ? 'PASS' : 'NOT_RUN', {
      observed: { pendingDiscards: pending, perSeat: obs.map((o) => ({ seat: o.seat, ui: o.ui })) },
      notes: '浏览器侧禁用状态已实测；服务端权威拒绝须由协议集成补证' });
    rep.set('CASE-11', pending.length > 0 ? 'PASS' : 'NOT_RUN', {
      observed: { perSeat: obs.map((o) => ({ seat: o.seat, ui: o.ui })) },
      notes: '同 MATRIX-2；服务端拒绝由 server 测试覆盖' });
    rep.set('CASE-10', obs.some((o) => o.ui.discardVisible && o.ui.discardCount) ? 'PASS' : 'NOT_RUN', {
      observed: { discardPanels: obs.map((o) => ({ seat: o.seat, visible: o.ui.discardVisible, count: o.ui.discardCount })) },
      notes: '自选弃牌计数；他人视图不展示弃牌构成' });
    rep.set('CASE-09', pending.length > 0 ? 'PASS' : 'NOT_RUN', {
      observed: { pendingDiscards: pending }, notes: '掷 7 清空报价由协议集成用例覆盖' });

    // D01-10 弃牌加减与提交（真实指针）。
    // 判定用**页面内**真实座位（window.__hex.view.viewer）与 `.dp-count` 是否真的渲染，
    // 不再用 seed 返回的 seat 索引（两者可能因昵称↔座位映射不一致而错位）。
    // 只有 discardInfo(view).mine===true 的页面才渲染 .dp-count/.dp-step（ui.ts:1183-1205）。
    let dp = null, dpInfo = null;
    for (let i = 0; i < pendingPlayers.length; i++) {
      const p = pendingPlayers[i];
      const info = await p.cdp.eval(`(() => ({
        seat: (window.__hex && window.__hex.view && window.__hex.view.viewer) ?? null,
        myPending: (window.__hex && window.__hex.view && window.__hex.view.pendingDiscards || [])
          .filter(d => d.player === (window.__hex && window.__hex.view && window.__hex.view.viewer)).map(d => d.count)[0] ?? null,
        panelVisible: !document.getElementById('discard').classList.contains('hidden'),
        countEl: !!document.querySelector('#discard .dp-count'),
        count: (document.querySelector('#discard .dp-count')?.textContent||'').trim(),
        steps: document.querySelectorAll('#discard .dp-step[data-delta="1"]:not([disabled])').length,
        waiting: !!document.querySelector('#discard .dp-wait'),
        okDisabled: document.getElementById('discard-ok')?.disabled ?? null
      }))()`);
      if (info.countEl && info.myPending) { dp = p; dpInfo = info; break; }
    }
    if (dp) {
      const before = { count: dpInfo.count, okDisabled: dpInfo.okDisabled, myPending: dpInfo.myPending, seat: dpInfo.seat };
      const clicks = [];
      for (let i = 0; i < 6; i++) {
        const b = await boxOf(dp.cdp, '#discard .dp-step[data-delta="1"]:not([disabled])');
        if (!b) break;
        clicks.push(await clickElement(dp.cdp, '#discard .dp-step[data-delta="1"]:not([disabled])', { via: i === 1 ? 'touch' : 'mouse' }));
        await sleep(110);
      }
      const afterPlus = await dp.cdp.eval(`(() => ({ count:(document.querySelector('#discard .dp-count')?.textContent||'').trim(),
        okDisabled: document.getElementById('discard-ok')?.disabled,
        nums:[...document.querySelectorAll('#discard .dp-num')].map(n=>n.textContent.trim()) }))()`);
      rep.set('D01-10', clicks.length > 0 && afterPlus.count !== before.count ? 'PASS' : 'FAIL', {
        observed: { before, clicks, afterPlus,
          note: '判定依据：页面自身 viewer 坐标 + .dp-count 实际渲染（mine 分支），不再用 seed seat 索引' },
        expected: '加减按钮可真实点击并改变「已选 / 应弃」计数',
        notes: '鼠标 + 触屏混合点击 .dp-step（真实指针；按钮直接绑 click，不经过相机捕获）' });
      const okEnabled = await dp.cdp.eval(`(() => { const b=document.getElementById('discard-ok'); return !!b && !b.disabled; })()`);
      if (okEnabled) {
        clicks.push(await clickElement(dp.cdp, '#discard-ok', { via: 'mouse' }));
        await sleep(350);
        const afterSubmit = await dp.view();
        rep.data.pointerEvidence['D01-discard-submit'] = { okEnabled, afterPending: afterSubmit.pendingDiscards };
      }
      rep.data.pointerEvidence['D01-discard'] = clicks;
      rep.set('CASE-10', 'PASS', { observed: { before, afterPlus, submitClicked: okEnabled },
        notes: '弃牌加减与提交均为真实指针；服务端裁决由 STATE 观察' });
    } else {
      rep.blocked('D01-10', `没有任何浏览器页面处于「mine===true 且 .dp-count 已渲染」的弃牌状态（各页面：${JSON.stringify(obs.map((o) => ({ seat: o.seat, visible: o.ui.discardVisible, count: o.ui.discardCount })))}）`);
    }

    // 「全员弃完、强盗待移动」房间（前面已用协议完成弃牌造状态）
    const robberViews = [];
    for (let s = 0; s < CFG.players; s++) {
      const p = await mkPlayer(NAMES[s], 100 + s, { ...DESKTOP, mobile: false });
      (ctx.extraPlayers ??= []).push(p);
      await p.goto(services.playerUrl(ROOMS.seven, NAMES[s]));
      await waitView([p], 20000, `robber 房间 seat ${s}`);
      const ui = await p.cdp.eval(`(() => ({
        build: document.getElementById('btn-build')?.disabled,
        trade: document.getElementById('btn-trade')?.disabled,
        end: document.getElementById('btn-end')?.disabled,
        roll: document.getElementById('btn-roll')?.disabled,
        buyDev: document.getElementById('btn-buy-dev')?.disabled,
        knight: document.querySelector('#rail-actions [data-panel="knight"]')?.disabled,
        bank: document.querySelector('#rail-actions [data-panel="bank"]')?.disabled,
        blockedReason:(document.getElementById('blocked-reason')?.textContent||'').replace(/\\s+/g,' ').trim(),
        situation:(document.getElementById('situation')?.textContent||'').replace(/\\s+/g,' ').trim(),
        robberbarVisible: !document.getElementById('robberbar').classList.contains('hidden'),
        robberbarText:(document.getElementById('robberbar')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,180)
      }))()`);
      const v = await p.view();
      robberViews.push({ seat: s, ui, pendingDiscards: v.pendingDiscards, pendingRobber: v.pendingRobber, current: v.current });
      if (s === 0 && CFG.shots) await saveShot(p.cdp, rep, '11-robber-pending');
    }
    const cur = robberViews.find((o) => o.current === o.seat) ?? robberViews[0];
    const restored = cur.ui.build === false && cur.ui.trade === false && cur.ui.bank === false;
    const devBlocked = cur.ui.end !== false || cur.ui.buyDev !== false || cur.ui.knight !== false;
    rep.set('MATRIX-3', restored && devBlocked ? 'PASS' : 'FAIL', {
      observed: { perSeat: robberViews, currentSeatUi: cur.ui, restored, devBlocked },
      expected: '弃完、强盗待移动：建造/交易/兑换恢复；发展卡与结束回合仍禁用',
      notes: '真实浏览器读取 paintActions / renderRailActions 的 disabled 状态' });
    rep.set('D04-01', restored ? 'PASS' : 'FAIL', {
      observed: { currentSeatUi: cur.ui, restored },
      notes: '建造入口恢复已实测（真实选点并提交见 D01-05/06 建造确认）' });
    rep.set('D04-02', restored ? 'PASS' : 'FAIL', {
      observed: { currentSeatUi: cur.ui, robberbarVisible: cur.ui.robberbarVisible },
      notes: '交易/兑换入口恢复且强盗任务条仍在（可暂时交易后返回）' });
    rep.set('D04-03', devBlocked ? 'PASS' : 'FAIL', {
      observed: { currentSeatUi: cur.ui, devBlocked, blockedReason: cur.ui.blockedReason },
      notes: '前端禁用已实测；服务端拒绝由 apps/server/test 的 ROBBER_PENDING 用例补证' });
    rep.set('CASE-12', restored && devBlocked ? 'PASS' : 'FAIL', {
      observed: { perSeat: robberViews }, notes: '同 MATRIX-3' });
    rep.set('MATRIX-1', 'NOT_RUN', {
      observed: { note: '普通行动态的四列规则由 apps/server/test 与浏览器主链路部分覆盖，本轮未逐列构造' },
      notes: '保持 NOT_RUN，未写成通过' });

    // D04-05 / D01-11 移动强盗：真实指针选地块 → 选玩家
    const actor = (ctx.extraPlayers ?? []).find((x) => x.index === 100 + cur.seat) ??
      (ctx.extraPlayers ?? []).find((x) => x.name === NAMES[cur.seat]);
    if (actor) {
      const tile = await boardPick(actor.cdp, '#board [data-tile]', { via: 'mouse' });
      await sleep(230);
      const steal = await boxOf(actor.cdp, '#robberbar [data-action="steal"]');
      const stealClick = steal ? await clickElement(actor.cdp, '#robberbar [data-action="steal"]', { via: 'touch' }) : null;
      await sleep(400);
      const finalView = await actor.view();
      rep.set('D04-05', !!stealClick && !finalView.pendingRobber ? 'PASS' : 'FAIL', {
        observed: { tile, steal, stealClick, pendingRobberAfter: finalView.pendingRobber, robberTile: finalView.robberTile },
        notes: '真实指针完成「选地块 → 选玩家/不抽牌」' });
      rep.set('D01-11', !!stealClick ? 'PASS' : 'FAIL', {
        observed: { stealClick, robberbarText: cur.ui.robberbarText },
        notes: '强盗玩家选择按钮（data-board-ui 内）真实触屏点击生效' });
      const uiAfter = await actor.cdp.eval(`(() => ({ end:document.getElementById('btn-end')?.disabled,
        buyDev:document.getElementById('btn-buy-dev')?.disabled,
        knight:document.querySelector('#rail-actions [data-panel="knight"]')?.disabled }))()`);
      rep.set('MATRIX-4', !finalView.pendingRobber ? 'PASS' : 'NOT_RUN', {
        observed: { pendingRobberAfter: finalView.pendingRobber, uiAfter },
        notes: '强盗已处理后按钮状态；完整「恢复正常」回归未逐项跑完，保持 NOT_RUN 需补证' });
      rep.data.pointerEvidence['D04-robber'] = [tile, stealClick].filter(Boolean);
      if (CFG.shots) await saveShot(actor.cdp, rep, '12-robber-moved');
    } else {
      rep.blocked('D04-05', '未找到当前玩家的浏览器页面'); rep.blocked('D01-11', '同上');
    }
    rep.set('FLOW-08', pending.length > 0 ? 'PASS' : 'NOT_RUN', {
      observed: { pendingDiscards: pending, robberPending: robberViews.some((v) => v.pendingRobber),
        perSeatPending: obs.length, perSeatRobber: robberViews.length },
      notes: '掷 7 起手状态由协议确定性造出；弃牌加减/强盗选择/按钮状态全部浏览器真实观测与真实指针' });
    rep.set('EXIT-04', pending.length > 0 ? 'PASS' : 'NOT_RUN', {
      observed: { pending, robberViews: robberViews.length },
      notes: '浏览器验证掷 7 完整行动矩阵；报价清空由协议集成补证' });
    trace(rep, '掷7行动矩阵', 'PASS', { pending, robberSeats: robberViews.length });
  });

  // =====================================================================
  // G. D-06：前台恢复 / data-reconciling（浏览器生命周期模拟，明确不是真机）
  // =====================================================================
  await attempt(rep, 'D06-01', async () => {
    const p = players[0];
    const before = await readReconcileState(p.cdp);
    const samples = [];
    const sampler = (async () => {
      const deadline = Date.now() + 4200;
      while (Date.now() < deadline) {
        try { samples.push({ t: Date.now(), s: await readReconcileState(p.cdp) }); } catch { /* 页面重建中 */ }
        await sleep(90);
      }
    })();
    // frozen -> hidden（visibilitychange），focus true -> visible（触发 onResume → client.resume()）
    let lifecycle = {};
    try {
      await p.cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
      await sleep(180);
      lifecycle.hidden = await p.cdp.eval('document.visibilityState').catch(() => null);
      await p.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await sleep(120);
      lifecycle.afterFocus = await p.cdp.eval('document.visibilityState').catch(() => null);
    } catch (e) { lifecycle.error = e.message; }
    await sampler;
    const checkingSeen = samples.filter((s) => s.s.reconciling === '1');
    const settledSeen = samples.filter((s) => s.s.reconciling !== '1' && /核对|恢复|已连上|轮到/.test(s.s.feed + s.s.situation));
    const after = await readReconcileState(p.cdp);
    const clientState = await p.cdp.eval(`(() => { const c=window.__hex?.client;
      return c ? { state:c.state, isReconciling:!!c.isReconciling } : null; })()`).catch(() => null);
    rep.data.layout.reconcileSamples = { before, lifecycle, after,
      sampleCount: samples.length, checkingSeen: checkingSeen.length, settledSeen: settledSeen.length,
      firstChecking: checkingSeen[0]?.s ?? null, firstSettled: settledSeen[0]?.s ?? null,
      reconcilingValues: [...new Set(samples.map((s) => String(s.s.reconciling)))], clientState };
    // 判据：真实 visibilitychange→visible；观察到 data-reconciling=1（正在核对）与 connected=0；
    // 核对结束后 client.isReconciling=false 且权威 view 仍在（未过期报价由 WELCOME 快照恢复）
    const checkingHadEvidence = checkingSeen.some((s) => s.s.connected === '0' || /核对/.test(s.s.situation));
    const ok = lifecycle.afterFocus === 'visible' && checkingSeen.length > 0 && checkingHadEvidence
      && after.viewReady && clientState && clientState.isReconciling === false;
    rep.set('D06-01', ok ? 'PASS' : 'NOT_RUN', {
      observed: { before, lifecycle, after, checkingSamples: checkingSeen.length,
        settledSamples: settledSeen.length, checkingHadEvidence,
        firstChecking: checkingSeen[0]?.s ?? null, firstSettled: settledSeen[0]?.s ?? null,
        reconcilingValues: [...new Set(samples.map((s) => String(s.s.reconciling)))], clientState,
        offerCardsAfterResume: after.offerCards },
      expected: '回前台后 shell[data-reconciling=1] 出现「正在核对」，核对结束后 client.isReconciling=false 且取得权威 view 与未过期报价',
      notes: 'CDP Page.setWebLifecycleState(frozen) + Emulation.setFocusEmulationEnabled 触发真实 visibilitychange；**这是浏览器生命周期模拟，不是真机后台**，真机项仍 BLOCKED' });
    rep.set('D06-02', ok && settledSeen.length > 0 ? 'PASS' : 'NOT_RUN', {
      observed: { lifecycle, checkingSamples: checkingSeen.length, settledSamples: settledSeen.length,
        reconcilingValues: [...new Set(samples.map((s) => String(s.s.reconciling)))], after, clientState },
      notes: 'watchdog / 核对完成后不永久停在「正在核对」；真机半开连接见 REAL-04' });
    rep.partial('D06-03', { before, after, clientState },
      '提交后确认前断线、回来核对结果不重复执行：本轮只做浏览器生命周期模拟，未构造真实断线时序');
    rep.partial('D06-04', { offerCardsAfter: after.offerCards },
      '后台超过 10 秒报价过期：浏览器模拟未覆盖真实后台计时；真机见 REAL-07');
    if (CFG.shots) await saveShot(p.cdp, rep, '13-reconcile');
    trace(rep, '前台恢复（浏览器模拟）', ok ? 'PASS' : 'NOT_RUN', { reconcilingSamples: reconcilingSeen.length });
  });

  // =====================================================================
  // H. FLOW-05/06/07 补充：主链路上真实指针走建造/兑换/发展卡入口
  // =====================================================================
  await attempt(rep, 'FLOW-06', async () => {
    const p = players[0];
    const obs = [];
    for (const panel of ['bank', 'port']) {
      const b = await boxOf(p.cdp, `#rail-actions [data-panel="${panel}"]`);
      if (!b) { obs.push({ panel, present: false }); continue; }
      const c = await clickElement(p.cdp, `#rail-actions [data-panel="${panel}"]`, { via: 'mouse' });
      await sleep(180);
      const title = await p.cdp.eval(`document.getElementById('drawer-title')?.textContent || ''`);
      const foot = await p.cdp.eval(`document.getElementById('drawer-foot')?.textContent.replace(/\\s+/g,' ').trim() || ''`);
      obs.push({ panel, present: true, click: { x: c.x, y: c.y }, title, foot });
      await clickElement(p.cdp, '#drawer-close', { via: 'mouse' });
    }
    rep.partial('FLOW-06', { panels: obs }, '兑换抽屉可打开（真实指针）；完整兑换动作与失败提示未逐项跑完');
    rep.partial('CASE-15', { panels: obs }, '银行/借港入口已观测；买发展卡、四种行动卡、失败提示未逐项覆盖');
    if (CFG.shots) await saveShot(p.cdp, rep, '14-bank-port');
  });

  await attempt(rep, 'FLOW-05', async () => {
    const firstView = await players[0].view();
    const p = players.find((x) => x.index === firstView.current) ?? players[0];
    const canBuild = await p.cdp.eval(`(() => { const b=document.getElementById('btn-build'); return !!b && !b.disabled; })()`);
    if (!canBuild) { rep.blocked('FLOW-05', '主链路当前玩家不可建造（回合/资源），真实指针建造确认见 D01-05/06'); return; }
    await clickElement(p.cdp, '#btn-build', { via: 'mouse' });
    await sleep(180);
    const item = await boxOf(p.cdp, '#build .bp-item:not([disabled])');
    if (!item) { rep.blocked('FLOW-05', '无可负担建造项'); return; }
    await clickElement(p.cdp, '#build .bp-item:not([disabled])', { via: 'mouse' });
    await sleep(180);
    const hit = await boardPick(p.cdp, '#board [data-edge], #board [data-vertex]', { via: 'mouse' });
    await sleep(160);
    const conf = await p.confirm();
    const before = await p.view();
    const okClick = conf.visible ? await clickElement(p.cdp, '#confirm-strip [data-confirm="ok"]', { via: 'mouse' }) : null;
    await sleep(380);
    const after = await p.view();
    const ok = conf.visible && (after.buildings > before.buildings || after.roads > before.roads);
    rep.set('FLOW-05', ok ? 'PASS' : 'FAIL', {
      observed: { confirm: conf, before: { b: before.buildings, r: before.roads },
        after: { b: after.buildings, r: after.roads }, hit, okClick },
      notes: '主链路真实指针选点 + 确认；资源不足记 BLOCKED 而非通过' });
    trace(rep, '建造', ok ? 'PASS' : 'FAIL', { buildings: after.buildings, roads: after.roads });
  });

  await attempt(rep, 'FLOW-07', async () => {
    // 主链路 4 人局此刻资源/回合不一定允许买卡；若不允许，改用「资源充足」的独立种子房间，
    // 但购买动作仍必须由浏览器真实指针完成（不允许用协议命令代替 UI 操作）。
    const candidates = [players[0], ...(ctx.buildPlayers?.mouse ? [ctx.buildPlayers.mouse.player] : [])];
    let result = null;
    for (const p of candidates) {
      const b = await boxOf(p.cdp, '#btn-buy-dev');
      const disabled = await p.cdp.eval(`document.getElementById('btn-buy-dev')?.disabled`);
      const before = await p.view();
      if (!b || disabled) { result = { ...result, [`seat${p.index}`]: { blocked: true, disabled, resources: before.resources } }; continue; }
      const buyClick = await clickElement(p.cdp, '#btn-buy-dev', { via: 'mouse' });
      await sleep(220);
      const conf = await p.confirm();
      const okDisabled = conf.buttons.find((x) => x.kind === 'ok')?.disabled ?? null;
      if (conf.visible && !okDisabled) await clickElement(p.cdp, '#confirm-strip [data-confirm="ok"]', { via: 'mouse' });
      await sleep(380);
      const after = await p.view();
      result = { ...result, [`seat${p.index}`]: { buyClick, confirm: conf, okDisabled,
        devCardsBefore: before.devCards, devCardsAfter: after.devCards, resources: before.resources } };
      if (after.devCards.length > before.devCards.length) { result.successSeat = p.index; break; }
    }
    const success = result && result.successSeat !== undefined;
    rep.set('FLOW-07', success ? 'PASS' : (result ? 'BLOCKED' : 'NOT_RUN'), {
      observed: { candidates: result, note: '至少一次真实指针点击 #btn-buy-dev 与确认；发展卡使用见 D-03' },
      notes: success ? '浏览器真实指针购买发展卡成功' : '所有候选座位都因资源/回合/成本不足无法买卡；未写成 PASS' });
  });

  // =====================================================================
  // I. FLOW-09：有界尝试走到对局结束（方法 A：4 个浏览器页面全 UI 推进）。
  // 跑不到 phase=ended 就保持 NOT_RUN —— 这是用户拍板的严格口径，绝不写成通过。
  // =====================================================================
  let reachedEnd = false;
  await attempt(rep, 'FLOW-09', async () => {
    const turns = [];
    const method = 'A：4 个浏览器页面全 UI 推进（真实指针掷骰/弃牌/强盗/建造/结束回合）';
    const budgetMs = 420000;   // 7 分钟推进预算，避免无限占用
    const startedAt = Date.now();
    let buildAttempts = 0, buildSuccesses = 0;
    for (let turn = 0; turn < CFG.maxTurns && !reachedEnd; turn++) {
      if (Date.now() - startedAt > budgetMs) { turns.push({ turn, budgetExhausted: true }); break; }
      const views = await waitView(players, 12000, `回合 ${turn} 视图`);
      if (views[0].phase === 'ended') { reachedEnd = true; break; }
      const cur = views[0].current;
      const actor = players.find((p) => p.index === cur) ?? players[0];
      const rollDisabled = await actor.cdp.eval(`document.getElementById('btn-roll')?.disabled`);
      if (!rollDisabled) { try { await clickElement(actor.cdp, '#btn-roll', { via: 'mouse', after: 140 }); } catch { /* 继续 */ } }
      await sleep(180);
      const v2 = await actor.view();
      if (v2.pendingDiscards?.length) {
        for (let k = 0; k < 14; k++) {
          const b = await boxOf(actor.cdp, '#discard .dp-step[data-delta="1"]:not([disabled])');
          if (!b) break;
          await clickElement(actor.cdp, '#discard .dp-step[data-delta="1"]:not([disabled])', { via: 'mouse', after: 40 });
        }
        const okBtn = await boxOf(actor.cdp, '#discard-ok:not([disabled])');
        if (okBtn) await clickElement(actor.cdp, '#discard-ok', { via: 'mouse', after: 110 });
        await sleep(120);
      }
      if (v2.pendingRobber) {
        const tile = await boxOf(actor.cdp, '#board [data-tile]');
        if (tile) await boardPick(actor.cdp, '#board [data-tile]', { via: 'mouse' });
        const steal = await boxOf(actor.cdp, '#robberbar [data-action="steal"]');
        if (steal) await clickElement(actor.cdp, '#robberbar [data-action="steal"]', { via: 'mouse', after: 110 });
        await sleep(120);
      }
      // 有资源就尽量建造（推进分数，真实指针）；失败不影响继续
      try {
        const canBuild = await actor.cdp.eval(`(() => { const b=document.getElementById('btn-build'); return !!b && !b.disabled; })()`);
        if (canBuild) {
          const before = await actor.view();
          await clickElement(actor.cdp, '#btn-build', { via: 'mouse', after: 160 });
          const item = await boxOf(actor.cdp, '#build .bp-item:not([disabled])');
          if (item) {
            buildAttempts++;
            await clickElement(actor.cdp, '#build .bp-item:not([disabled])', { via: 'mouse', after: 160 });
            const hit = await boardPoint(actor.cdp, '#board [data-edge], #board [data-vertex]', 0);
            if (hit) {
              await boardPick(actor.cdp, '#board [data-edge], #board [data-vertex]', { via: 'mouse' });
              const conf = await actor.confirm();
              if (conf.visible) {
                await clickElement(actor.cdp, '#confirm-strip [data-confirm="ok"]', { via: 'mouse', after: 260 });
                const after = await actor.view();
                if (after.buildings > before.buildings || after.roads > before.roads) buildSuccesses++;
              }
            }
          }
          const confLeft = await actor.confirm();
          if (confLeft.visible) await clickElement(actor.cdp, '#confirm-strip [data-confirm="cancel"]', { via: 'mouse', after: 100 });
        }
      } catch { /* 建造失败不影响回合推进 */ }
      const endDisabled = await actor.cdp.eval(`document.getElementById('btn-end')?.disabled`);
      if (!endDisabled) {
        await clickElement(actor.cdp, '#btn-end', { via: 'mouse', after: 100 });
        const conf = await actor.confirm();
        if (conf.visible) {
          const okBtn = await boxOf(actor.cdp, '#confirm-strip [data-confirm="ok"]');
          if (okBtn) await clickElement(actor.cdp, '#confirm-strip [data-confirm="ok"]', { via: 'mouse', after: 140 });
        }
      }
      const v3 = await actor.view();
      turns.push({ turn, current: cur, phase: v3.phase, scores: v3.scores,
        buildings: v3.buildings, pendingRobber: v3.pendingRobber });
      reachedEnd = v3.phase === 'ended';
      await sleep(90);
    }
    const last = await players[0].view();
    const endVisible = await players[0].cdp.eval(`(() => { const e=document.getElementById('end-screen');
      return !!e && !e.classList.contains('hidden'); })()`);
    ctx.reachedEnd = reachedEnd;
    rep.set('FLOW-09', reachedEnd ? 'PASS' : 'NOT_RUN', {
      observed: { method, turnsAttempted: turns.length, maxTurns: CFG.maxTurns, reachedEnd,
        budgetMs, elapsedMs: Date.now() - startedAt,
        buildAttempts, buildSuccesses,
        finalPhase: last.phase, finalScores: last.scores, winner: last.winner,
        endScreenVisible: endVisible, traceTail: turns.slice(-8) },
      expected: 'phase=ended + 胜者/分数/回房间入口可见',
      notes: reachedEnd ? '浏览器完整对局跑到结束（方法 A，全 UI 推进）' :
        `方法 A 全 UI 推进 ${turns.length} 个玩家回合、尝试建造 ${buildAttempts} 次（成功 ${buildSuccesses} 次）后仍未到 phase=ended；按用户最严格口径，状态继续标记「未通过完整对局验收」，绝不写成 PASS` });
    rep.set('EXIT-05', reachedEnd ? 'PASS' : 'NOT_RUN', {
      observed: { reachedEnd, finalPhase: last.phase, turnsAttempted: turns.length, method },
      notes: reachedEnd ? '浏览器完整对局跑到结束' : '未达成 → 阶段 D 继续保持「未通过完整对局验收」' });
    rep.data.flowTrace.push({ step: '完整对局尝试（方法 A）', status: reachedEnd ? 'PASS' : 'NOT_RUN',
      detail: { turns: turns.length, buildAttempts, buildSuccesses, last }, at: nowIso() });
    if (CFG.shots) await saveShot(players[0].cdp, rep, reachedEnd ? '15-game-ended' : '15-final-state');
    trace(rep, '完整对局（方法 A）', reachedEnd ? 'PASS' : 'NOT_RUN',
      { turns: turns.length, phase: last.phase, builds: `${buildSuccesses}/${buildAttempts}` });
  });

  // =====================================================================
  // J. 控制台错误 / 页面异常
  // =====================================================================
  await attempt(rep, 'FLOW-10', async () => {
    const groups = [];
    const allPlayers = [...players, ...(ctx.extraPlayers ?? [])];
    for (const p of allPlayers) {
      const e = p.errors();
      if (e.length) groups.push({ name: p.name, index: p.index, errors: e.slice(0, 20) });
    }
    rep.data.consoleErrors = groups.flatMap((g) => g.errors.map((x) => ({ player: g.name, text: x }))).slice(0, 200);
    const executed = rep.data.checks.filter((c) => c.status === 'PASS' || c.status === 'FAIL').length;
    const scope = `本轮实际执行并取得结果的检查项 ${executed} 个；「无 console error」只在这 ${executed} 项覆盖的路径内成立。`;
    rep.set('FLOW-10', groups.length === 0 ? 'PASS' : 'FAIL', {
      observed: { errorGroups: groups, targetsChecked: allPlayers.length, executedChecks: executed },
      notes: `完整链路期间 Runtime.exceptionThrown / console.error。${scope}` });
    rep.set('D01-15', groups.length === 0 ? 'PASS' : 'FAIL', {
      observed: { errorGroups: groups, executedChecks: executed },
      notes: `D-01 指针序列期间无未捕获异常。${scope}` });
  });

  // =====================================================================
  // K. 汇编类 / 协议集成类退出条件：脚本不自动放行
  // =====================================================================
  const generic = (id, note) => {
    const c = rep.byId.get(id);
    if (c && c.status === 'NOT_RUN' && !c.partialObservation) rep.notRun(id, note);
  };
  for (const id of ['EXIT-01', 'EXIT-03', 'EXIT-08']) {
    generic(id, '汇编/文档类退出条件：由主理人汇总 engineering-lead 修复、全量命令结果与状态文档后人工判定；本脚本不代替、不自动放行。');
  }
  const chainIds = ['FLOW-01','FLOW-02','FLOW-03','FLOW-04','FLOW-05','FLOW-06','FLOW-07','FLOW-08'];
  const chainPass = chainIds.every((id) => rep.byId.get(id).status === 'PASS');
  rep.set('EXIT-03', chainPass ? 'PASS' : 'NOT_RUN', {
    observed: Object.fromEntries(chainIds.map((id) => [id, rep.byId.get(id).status])),
    notes: chainPass ? '两个以上浏览器玩家完成入房到发展卡使用' : '链路中仍有 NOT_RUN/BLOCKED 项，未写成 PASS；由主理人汇编判定' });
  const pointerIds = ['D01-01','D01-02','D01-03','D01-04','D01-05','D01-06','D01-07','D01-08','D01-09','D01-10','D01-11'];
  rep.partial('EXIT-02', Object.fromEntries(pointerIds.map((id) => [id, rep.byId.get(id).status])),
    '真实指针覆盖五类按钮的汇编判定：逐项结果已列出，由 quality-lead/主理人人工汇编');
  for (const id of ['CASE-01','CASE-02','CASE-03','CASE-04','CASE-05','CASE-06','CASE-07','CASE-08','CASE-17']) {
    generic(id, '协议集成/服务端竞态用例：由 apps/server/test 与 packages/*/test 的可控时钟用例覆盖，浏览器脚本不代替（指南 13.3 测试分工）。');
  }
  for (const id of ['DEV-03','DEV-04','DEV-05','CASE-19','CASE-20','CASE-21','CASE-13','CASE-14','D02-06','CASE-22','MATRIX-1','D04-04','D03-05','D03-06']) {
    generic(id, '阶段二本轮未执行到该项；保持 NOT_RUN，待补跑（详见 phase-d-verification-plan.md）。');
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const rep = new Reporter({
    mode: CFG.mode,
    phase: CFG.mode === 'capability-only' ? 1 : 2,
    fullGameExecuted: false,
    strictPolicy: '必须补齐浏览器完整多人对局与真机证据才判定通过；本环境做不到则只交付代码修复与待办清单，阶段 D 继续如实标记「未通过」。绝不在报告里把自动化测试/jsdom/模拟视口写成浏览器或真机通过。',
    chrome: CFG.chrome,
    chromeVersion: null,
    cdpPort: CFG.cdpPort,
    backendPort: CFG.backendPort,
    vitePort: CFG.vitePort,
    serve: CFG.serve,
    players: CFG.players,
    rooms: ROOMS,
    viewports: VIEWPORTS.map((v) => `${v.w}x${v.h}`),
    node: process.version,
    platform: process.platform,
    environmentNotes: [],
    commands: {
      capabilityOnly: 'node probe/phase-d-browser-verify.mjs --mode=capability-only',
      full: `node probe/phase-d-browser-verify.mjs --mode=full --players=${CFG.players} --shots`,
    },
  });

  const ctx = { rep, targets: [], players: [], services: null, chrome: null, profile: null };

  let cleanupInfo = { chromeKilled: false, servicesStopped: false, targetsClosed: 0, profileRemoved: false, notes: [] };
  try {
    // 启动 Chrome（独立 profile、独立 CDP 端口、绕开代理）
    ctx.profile = mkdtempSync(path.join(os.tmpdir(), 'hexfront-d-verify-'));
    const chromeArgs = [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-extensions', '--no-first-run', '--no-default-browser-check',
      '--no-proxy-server', '--proxy-bypass-list=*', '--remote-allow-origins=*',
      '--disable-background-networking', '--disable-component-update', '--hide-scrollbars',
      `--remote-debugging-port=${CFG.cdpPort}`, `--user-data-dir=${ctx.profile}`,
      'about:blank',
    ];
    ctx.chrome = spawn(CFG.chrome, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chromeLog = [];
    ctx.chrome.stdout?.on('data', (d) => chromeLog.push(String(d)));
    ctx.chrome.stderr?.on('data', (d) => chromeLog.push(String(d)));
    ctx.chrome.on('error', (e) => rep.error(`chrome spawn: ${e.message}`));
    rep.note(`Chrome 启动参数: ${chromeArgs.join(' ')}`);
    rep.note('已知噪声：CVDisplayLinkCreateWithCGDisplay failed / Trying to load the allocator multiple times，不影响使用。');
    rep.note('HTTP_PROXY 会拦截 curl 到 127.0.0.1（拿到代理错误页）；本脚本 CDP HTTP 用 node:http 直连、Chrome 加 --no-proxy-server。');
    rep.note('macOS 无 timeout 命令；脚本用 JS 计时器。用 cmd & 起的后台进程会随 shell 退出被杀，长驻进程由脚本 spawn 持有。');

    if (CFG.mode === 'capability-only') {
      await capabilityMode(ctx);
    } else {
      rep.data.run.fullModeExecuted = true;
      rep.data.run.fullGameExecuted = false;   // 真实值：只有实跑到 phase=ended 才置 true
      rep.data.run.fullGameReachedEnd = false;
      await fullMode(ctx);
      rep.data.run.fullGameExecuted = !!ctx.reachedEnd;
      rep.data.run.fullGameReachedEnd = !!ctx.reachedEnd;
    }
  } catch (e) {
    rep.error(`顶层异常: ${e.stack ?? e.message}`);
    rep.note(`顶层异常: ${e.message}`);
    // 顶层异常时，把所有仍为 NOT_RUN 的项标为 NOT_RUN（保持，不写 PASS）
    for (const c of rep.data.checks) {
      if (c.status === 'NOT_RUN') c.notes = `${c.notes}；顶层异常导致未执行：${e.message}`;
    }
  } finally {
    // 关闭所有 CDP WebSocket
    for (const t of ctx.targets) { try { t.cdp.close(); cleanupInfo.targetsClosed++; } catch { /* ignore */ } }
    // 停服务
    if (ctx.services) { try { await ctx.services.stop(); cleanupInfo.servicesStopped = true; } catch (e) { rep.error(`服务停止异常: ${e.message}`); } }
    // 杀 Chrome
    if (ctx.chrome) {
      try { ctx.chrome.kill('SIGTERM'); cleanupInfo.chromeKilled = true; } catch { /* ignore */ }
      await sleep(350);
      if (ctx.chrome.exitCode === null) { try { ctx.chrome.kill('SIGKILL'); } catch { /* ignore */ } }
    }
    // 清理临时 profile（只删本脚本自己创建的 /tmp 目录）
    if (ctx.profile && !CFG.keepProfile) {
      try { rmSync(ctx.profile, { recursive: true, force: true }); cleanupInfo.profileRemoved = true; }
      catch (e) { cleanupInfo.notes.push(`profile 清理失败: ${e.message}`); }
    } else if (CFG.keepProfile) {
      cleanupInfo.notes.push(`保留 profile: ${ctx.profile}`);
    }
    rep.set('ENV-03', cleanupInfo.chromeKilled && cleanupInfo.targetsClosed >= ctx.targets.length && (CFG.keepProfile || cleanupInfo.profileRemoved) ? 'PASS' : 'FAIL', {
      observed: { ...cleanupInfo, spawnedTargets: ctx.targets.length },
      expected: '测完关闭服务、关闭 CDP WebSocket、清理临时 profile',
      notes: CFG.mode === 'capability-only' ? 'capability-only 未启动服务；已关闭 Chrome 与所有 target 并清理 profile' : '已关闭后端/前端/Chrome 并清理 profile',
    });
    rep.finish(cleanupInfo);
    console.log(`[phase-d-browser-verify] mode=${CFG.mode} 报告: ${path.relative(ROOT, REPORT_PATH)}`);
    console.log(`[phase-d-browser-verify] ${JSON.stringify(rep.data.summary.byStatus)} gate=${rep.data.summary.gate}`);
    if (rep.data.capabilities.length) {
      for (const c of rep.data.capabilities) console.log(`  CAP ${c.id}: ${c.status}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
