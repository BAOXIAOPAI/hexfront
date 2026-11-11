#!/usr/bin/env node
/**
 * 通用横屏（CSS 自旋转 + 系统方向锁定渐进增强）跨浏览器复验脚本
 * quality-lead / 严守真 · ULS-03 阶段一准备
 *
 * 用途
 * ----
 * 用无头 Chrome + CDP 在**真实浏览器**里复验「任何浏览器打开都呈现横屏」的方案：
 *   - 通过 Page.addScriptToEvaluateOnNewDocument 在页面脚本**之前**剥离 / mock
 *     screen.orientation.lock 与 requestFullscreen，模拟 iOS Safari、厂商浏览器拒绝、
 *     API 缺失、锁定成功、假成功、系统横屏但视口竖屏等能力分支；
 *   - 用 Emulation.setDeviceMetricsOverride 设置真实 CSS 视口（390×844 竖屏、
 *     667×375 / 844×390 / 932×430 横屏、平板 / 桌面）；
 *   - 用 Input.dispatchMouseEvent / Input.dispatchTouchEvent 派发**真实指针**，
 *     验证 CSS 旋转后按钮 / 棋盘热区仍然点得中、拖动不误建造；
 *   - 输出结构化 JSON 到 probe/phase-d-universal-landscape-report.json。
 *
 * 诚信约束（结构性，不是口头承诺）
 * --------------------------------
 * 1. CHECK_DEFS 里每一条在报告构造时初始状态就是 NOT_RUN；只有实际执行并写入
 *    observed 才可能变成 PASS / FAIL。真机项结构性 BLOCKED。
 * 2. Runtime.evaluate 只用于**读**（DOM / computed style / window.__hex.view / 探针计数）
 *    与注入能力模拟；被复验的界面动作一律走 CDP Input 域真实指针，不用 el.click() 代替。
 * 3. CDP 的 iOS Safari / 厂商浏览器模拟只证明**代码分支**，不等于真机。
 *    UA 伪装、mock 的 lock 成功、模拟视口一律不得写成真机通过。
 * 4. 旋转态优先读显式契约 #shell[data-landscape-mode]（off|css|system，2026-11-08 engineering-lead 交付）；
 *    契约缺失时只做几何推断，默认标 partial/NOT_RUN 并注明 INFERRED，不判 PASS
 *    （可用 --allow-inference 显式放宽，报告仍会标记 INFERRED）。
 * 5. capability-only 模式不起任何 HTTP/WS 服务、不连房间、不跑全量命令、不实跑对局。
 *
 * 运行
 * ----
 *   # 阶段一 / 前置自检（默认，秒级）
 *   node probe/phase-d-universal-landscape-check.mjs --mode=capability-only
 *
 *   # 阶段二（实现完成后由主理人唤醒）
 *   node probe/phase-d-universal-landscape-check.mjs --mode=full --shots
 *   node probe/phase-d-universal-landscape-check.mjs --mode=full --scenario=ios-safari
 *   node probe/phase-d-universal-landscape-check.mjs --mode=full --base-url=http://127.0.0.1:8793
 *
 * 可选参数
 *   --chrome=<path> --cdp-port=9415 --backend-port=8793 --vite-port=5183
 *   --base-url=<url> --room=<id> --players=4 --scenario=<id>
 *   --shots --keep-profile --allow-inference --help
 *
 * 环境注意事项（沿用 phase-d-browser-verify.mjs 实测经验）
 *   - HTTP_PROXY 会拦截 127.0.0.1 的 curl；本脚本 CDP HTTP 用 node:http 直连，Chrome 加 --no-proxy-server。
 *   - 长驻进程必须 spawn() 持有句柄并在 finally 里 kill；macOS 无 timeout 命令。
 *   - data: URL 里不能出现裸 #，必须 encodeURIComponent。
 *   - 本脚本只写 probe/**，不写 apps/**、docs/**、release/**，不连线上房间，不执行 git 写操作。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 路径 / 参数
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_DIR = path.join(ROOT, 'probe');
const REPORT_PATH = path.join(PROBE_DIR, 'phase-d-universal-landscape-report.json');
const SHOTS_DIR = path.join(PROBE_DIR, 'phase-d-universal-landscape-shots');
const SHOT_STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, def) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : def;
};
if (flag('help') || argv.includes('-h')) {
  console.log('用法: node probe/phase-d-universal-landscape-check.mjs [--mode=capability-only|full] [选项]\n详见文件头注释。');
  process.exit(0);
}

const CFG = {
  mode: opt('mode', 'capability-only'),
  scenario: opt('scenario', ''),
  chrome: opt('chrome', process.env.HEXFRONT_CHROME || DEFAULT_CHROME),
  cdpPort: Number(opt('cdp-port', '9415')),
  backendPort: Number(opt('backend-port', '8793')),
  vitePort: Number(opt('vite-port', '5183')),
  baseUrl: opt('base-url', ''),
  out: opt('out', ''),
  out: opt('out', ''),
  room: opt('room', ''),
  players: Math.max(2, Math.min(4, Number(opt('players', '4')))),
  shots: flag('shots'),
  keepProfile: flag('keep-profile'),
  allowInference: flag('allow-inference'),
};
if (!['capability-only', 'full'].includes(CFG.mode)) {
  console.error(`未知 --mode=${CFG.mode}（可用 capability-only | full）`);
  process.exit(2);
}
if (!fs.existsSync(CFG.chrome)) {
  console.error(`Chrome 不存在: ${CFG.chrome}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function makeRoom() {
  if (CFG.room) return CFG.room.slice(0, 14);
  return `qa-ul-${Date.now().toString(36)}`.slice(0, 14);
}
const ROOM = makeRoom();
if (!/^[a-z0-9_-]{1,24}$/.test(ROOM) || ROOM === 'main') {
  console.error(`非法房间号 ${ROOM}`);
  process.exit(2);
}

const IOS_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const VP = {
  portrait: { key: '390x844', w: 390, h: 844, orientation: { type: 'portraitPrimary', angle: 0 } },
  portraitSmall: { key: '375x667', w: 375, h: 667, orientation: { type: 'portraitPrimary', angle: 0 } },
  land667: { key: '667x375', w: 667, h: 375, orientation: { type: 'landscapePrimary', angle: 90 } },
  land844: { key: '844x390', w: 844, h: 390, orientation: { type: 'landscapePrimary', angle: 90 } },
  land932: { key: '932x430', w: 932, h: 430, orientation: { type: 'landscapePrimary', angle: 90 } },
  tablet: { key: '1024x768', w: 1024, h: 768, orientation: { type: 'landscapePrimary', angle: 0 } },
  desktop: { key: '1366x768', w: 1366, h: 768, orientation: { type: 'landscapePrimary', angle: 0 } },
  // 华为浏览器历史坑：系统/屏幕报告横屏，但 WebView 仍按竖屏宽度渲染
  huaweiStrip: { key: '390x844@landscape-report', w: 390, h: 844, orientation: { type: 'landscapePrimary', angle: 90 } },
};
const LANDSCAPES = [VP.land667, VP.land844, VP.land932];

// 旧 id：engineering-lead 明确「节点与所有旧 id 保留，供 dom-contract 对账」，即使卡片永久 hidden。
const LEGACY_IDS = [
  'portrait-gate', 'portrait-landscape', 'portrait-hint', 'portrait-dismiss', 'portrait-help',
  'board', 'board-stage', 'zoom-in', 'zoom-out', 'zoom-reset',
  'discard', 'robberbar', 'setupbar', 'confirm-strip', 'toast',
];
// 新契约（2026-11-08 engineering-lead 交付）：自转画布 / 正立 HUD / 出口 / 恢复 / 可选方向入口。
const NEW_CONTRACT_IDS = [
  'shell', 'overlay', 'landscape-hud', 'landscape-hint-main', 'landscape-hint-status',
  'landscape-hint-close', 'landscape-exit', 'landscape-resume', 'btn-orientation',
];
const REQUIRED_IDS = [...LEGACY_IDS, ...NEW_CONTRACT_IDS];

// ---------------------------------------------------------------------------
// 检查项定义（67 条；与 phase-d-universal-landscape-plan.md §3 一一对应）
// ---------------------------------------------------------------------------

const CHECK_DEFS = [];
const def = (id, area, requirement, evidenceType, source) =>
  CHECK_DEFS.push({ id, area, requirement, evidenceType, source });

// CAP 10
def('UL-CAP-01', 'capability', 'CDP 能连上无头 Chrome（/json/version + target WebSocket）', 'CDP·能力模拟', 'ULS-03 §3.1');
def('UL-CAP-02', 'capability', '竖屏真实 CSS 视口 390×844 / 375×667 精确、dpr=2、portrait=true', 'CDP·真实视口', 'ULS-03 §3.1');
def('UL-CAP-03', 'capability', '三档横屏真实 CSS 视口 667×375 / 844×390 / 932×430 精确且 landscape=true', 'CDP·真实视口', 'ULS-03 §3.1');
def('UL-CAP-04', 'capability', '可构造「系统报告横屏但视口仍竖屏」并如实记录原始值（华为竖条坑）', 'CDP·真实视口', 'ULS-03 §3.1 / docs16 §1.1');
def('UL-CAP-05', 'capability', 'addScriptToEvaluateOnNewDocument 可在页面脚本前剥离 lock / requestFullscreen', 'CDP·能力模拟', 'ULS-03 §3.1');
def('UL-CAP-06', 'capability', '可 mock lock resolve + 改写 orientation + 派发 orientationchange 并计数', 'CDP·能力模拟', 'ULS-03 §3.1');
def('UL-CAP-07', 'capability', '可解析 ±90° transform 矩阵，且 computed 布局宽高与 bbox 宽高互换', 'CDP·真实视口', 'ULS-03 §3.1');
def('UL-CAP-08', 'capability', 'elementFromPoint 命中旋转后元素的视觉中心', 'CDP·真实视口', 'ULS-03 §3.1');
def('UL-CAP-09', 'capability', '真实鼠标 / 触屏指针事件到达旋转后元素并记录 pointerType 与 client 坐标', 'CDP·真实指针', 'ULS-03 §3.1');
def('UL-CAP-10', 'capability', '截图非空 + console error / exceptionThrown / unhandledrejection 可采集', 'CDP·日志', 'ULS-03 §3.1');
// ENV 3
def('UL-ENV-01', 'environment', '独立端口仅 127.0.0.1，不碰用户 8787 / 5173 / 8792', '汇编 + 环境', 'ULS-03 §3.2');
def('UL-ENV-02', 'environment', '独立房间号，不带 sharecode，不连线上 / main 房间', '汇编 + 环境', 'ULS-03 §3.2');
def('UL-ENV-03', 'environment', '测完关闭服务 / target / Chrome，清理本脚本自建临时 profile', '汇编 + 环境', 'ULS-03 §3.2');
// A 9
def('UL-A01', 'A-能力分支', 'iOS Safari 模拟（无 lock / 无可靠 fullscreen）→ CSS 自旋转生效', 'CDP·能力模拟 + 真实视口', 'ULS-03 §3.3');
def('UL-A02', 'A-能力分支', 'iOS 模拟不依赖系统 API、无静默失败、无反复提示、无 unhandledrejection', 'CDP·能力模拟 + 日志', 'ULS-03 §3.3');
def('UL-A03', 'A-能力分支', '厂商浏览器 lock 拒绝 → CSS 自旋转，rejection 被 catch', 'CDP·能力模拟 + 日志', 'ULS-03 §3.3');
def('UL-A04', 'A-能力分支', 'screen.orientation / lock 整体缺失 → 不抛异常、落到自旋转', 'CDP·能力模拟', 'ULS-03 §3.3');
def('UL-A05', 'A-能力分支', 'requestFullscreen 被拒但 lock 可用 → 仍呈现横屏、无静默失败', 'CDP·能力模拟', 'ULS-03 §3.3');
def('UL-A06', 'A-能力分支', '系统锁定成功（mock resolve + orientationchange + 视口切横屏）→ 取消 CSS 旋转', 'CDP·能力模拟 + 真实视口', 'ULS-03 §3.3');
def('UL-A07', 'A-能力分支', '锁定成功后回竖屏 → 重新自旋转且不双重旋转', 'CDP·能力模拟 + 真实视口', 'ULS-03 §3.3');
def('UL-A08', 'A-能力分支', 'lock 假成功（resolve 但方向/视口仍竖屏）→ 不误取消自旋转', 'CDP·能力模拟', 'ULS-03 §3.3');
def('UL-A09', 'A-能力分支', '系统报告横屏但 CSS 视口仍竖屏（华为竖条坑）→ 以视口为准自旋转、无竖条黑边', 'CDP·真实视口 + 人工', 'ULS-03 §3.3 / docs16 §1.1');
// B 9
def('UL-B01', 'B-指针命中', '旋转后棋盘候选点选命中目标并出现预览 / 确认条', 'CDP·真实指针', 'ULS-03 §3.4');
def('UL-B02', 'B-指针命中', '旋转后缩放按钮改变 viewBox 且不误选棋盘', 'CDP·真实指针', 'ULS-03 §3.4');
def('UL-B03', 'B-指针命中', '旋转后弃牌加减（--seven 状态）计数变化且提交按钮同步', 'CDP·真实指针', 'ULS-03 §3.4');
def('UL-B04', 'B-指针命中', '旋转后强盗按钮可真实点击', 'CDP·真实指针', 'ULS-03 §3.4');
def('UL-B05', 'B-指针命中', '旋转后水平 + 垂直拖动 >8 CSS px 不建造、不弹确认条', 'CDP·真实指针', 'ULS-03 §3.4');
def('UL-B06', 'B-指针命中', '旋转后双指 pinch 结束不误建造、镜头不回弹', 'CDP·真实指针', 'ULS-03 §3.4');
def('UL-B07', 'B-指针命中', '旋转后关键按钮 elementFromPoint 命中自身、不被遮挡', 'CDP·真实视口 + 真实指针', 'ULS-03 §3.4');
def('UL-B08', 'B-指针命中', '触屏 pointerType=touch 的 tap 在旋转后同样生效', 'CDP·真实指针', 'ULS-03 §3.4');
def('UL-B09', 'B-指针命中', '旋转后关键按钮视觉命中区 ≥44×44 CSS px、无重叠误触', 'CDP·真实视口', 'ULS-03 §3.4');
// C 7
def('UL-C01', 'C-生命周期', '入房阶段（未收到开局 STATE）竖屏不旋转，入房控件可点', 'CDP·真实指针 + 真实视口', 'ULS-03 §3.5');
def('UL-C02', 'C-生命周期', '输入框 focus / visualViewport 变化时不旋转（真机键盘另由 UL-R05 补证）', 'CDP·真实视口', 'ULS-03 §3.5');
def('UL-C03', 'C-生命周期', '收到开局 STATE 或带 view 的 WELCOME（view!==null，UX §1.2）后从 pre-game 切到 css-rotate / system-locked', 'CDP·真实视口', 'ULS-03 §3.5 / docs17 §1.2');
def('UL-C04', 'C-生命周期', '旋转不发游戏命令、不退出房间、不丢待确认选择', 'CDP·真实指针 + 协议集成', 'ULS-03 §3.5 / 指南 4.2');
def('UL-C05', 'C-生命周期', '旋转后收到 STATE 不重置相机（viewBox 不变）', 'CDP·真实视口', 'ULS-03 §3.5 / 指南 5.1');
def('UL-C06', 'C-生命周期', '入房→开局→旋转→锁定/降级→回竖屏 全程无 console error / unhandledrejection', 'CDP·日志', 'ULS-03 §3.5');
def('UL-C07', 'C-生命周期', '旋转后确认条 / 抽屉 / 当前任务不滚出视野', 'CDP·真实视口', 'ULS-03 §3.5 / 指南 4.1');
// D 4
def('UL-D01', 'D-安全区', '旋转后顶栏 / 底部动作 / 确认按钮矩形完全落在视觉视口内', 'CDP·真实视口', 'ULS-03 §3.6');
def('UL-D02', 'D-安全区', 'env(safe-area-inset-*) 旋转后映射到正确的视觉边', 'CDP·真实视口', 'ULS-03 §3.6');
def('UL-D03', 'D-安全区', '无横向滚动 / 竖条 / 黑边 / 裁切', 'CDP·真实视口 + 人工', 'ULS-03 §3.6');
def('UL-D04', 'D-安全区', '真机刘海 / 圆角 / 浏览器栏 / 软键盘下不遮挡', '真机 ADB + 人工', 'ULS-03 §3.6');
// E 7
def('UL-E01', 'E-视口矩阵', '竖屏 390×844 / 375×667 自旋转画布铺满（布局宽≈innerHeight）', 'CDP·真实视口', 'ULS-03 §3.7');
def('UL-E02', 'E-视口矩阵', '667×375 不重复旋转、gate 隐藏、rail 展开、board-stage 可见', 'CDP·真实视口', 'ULS-03 §3.7');
def('UL-E03', 'E-视口矩阵', '844×390 同上', 'CDP·真实视口', 'ULS-03 §3.7');
def('UL-E04', 'E-视口矩阵', '932×430 同上', 'CDP·真实视口', 'ULS-03 §3.7');
def('UL-E05', 'E-视口矩阵', 'portrait→landscape→portrait 动态切换不双重旋转、不漏旋转', 'CDP·真实视口', 'ULS-03 §3.7');
def('UL-E06', 'E-视口矩阵', '1024×768 平板 / 1366×768 桌面不误触发自旋转', 'CDP·真实视口', 'ULS-03 §3.7');
def('UL-E07', 'E-视口矩阵', '每档记录 innerWidth/Height/dpr/orientation/matchMedia 原始值（方法学）', 'CDP·真实视口', 'ULS-03 §3.7');
// F 5
def('UL-F01', 'F-出口', '「仍按竖屏查看」后多次 resize / orientationchange / STATE 不反复弹', 'CDP·真实指针 + 真实视口', 'ULS-03 §3.8');
def('UL-F02', 'F-出口', 'dismiss 后有可恢复入口，真实点击可重新启用旋转或再次提示', 'CDP·真实指针', 'ULS-03 §3.8');
def('UL-F03', 'F-出口', 'dismiss 不丢座位、不提交草稿、横屏视口下仍不显示卡片', 'CDP·真实指针 + 协议集成', 'ULS-03 §3.8');
def('UL-F04', 'F-出口', '拒绝 / 缺失 lock 时不静默失败、不假装成功', 'CDP·能力模拟 + 真实视口', 'ULS-03 §3.8');
def('UL-F05', 'F-出口', '状态提示不靠颜色 / 声音 / hover 单独传递，旋转后文案可读、焦点可见', 'CDP·真实视口 + 人工', 'ULS-03 §3.8');
// G 7
def('UL-G01', 'G-回归', '387 passed + 2 todo / typecheck / build 基线不退化', '单测 + 汇编', 'ULS-03 §3.9');
def('UL-G02', 'G-回归', 'DOM id 对账（16 个既有 id 全部存在，删除需登记为有意变更）', 'CDP·真实视口 + 汇编', 'ULS-03 §3.9');
def('UL-G03', 'G-回归', '8 CSS px 拖动阈值 / 双指 / pointercancel / 失焦不残留手势状态', 'CDP·真实指针', 'ULS-03 §3.9');
def('UL-G04', 'G-回归', 'phase-d-landscape-button-check.mjs 9 PASS / 0 FAIL 不退化', 'CDP·真实指针 + 汇编', 'ULS-03 §3.9');
def('UL-G05', 'G-回归', 'phase-d-verification-plan.md 的 D-* / CASE-* / EXIT-* 不新增 FAIL', '汇编', 'ULS-03 §3.9');
def('UL-G06', 'G-回归', '旋转后 SVG getScreenCTM 与 bbox 一致，client→SVG 无 X/Y 反转', 'CDP·真实视口 + 真实指针', 'ULS-03 §3.9');
def('UL-G07', 'G-回归', '三档横屏布局回归（gate / rail / board-stage）', 'CDP·真实视口', 'ULS-03 §3.9');
// R 6
def('UL-R01', 'R-真机', 'iPhone Safari 真机：无 lock / fullscreen 下自旋转 + 真实手指命中', '真机 ADB + 人工', 'ULS-03 §3.10');
def('UL-R02', 'R-真机', '华为 / 小米 / OPPO 厂商浏览器拒绝 lock → 自旋转，无竖条黑边', '真机 ADB + 人工', 'ULS-03 §3.10');
def('UL-R03', 'R-真机', '微信内置浏览器（iOS WKWebView / Android XWEB·X5）自旋转 + WS 可达', '真机 ADB + 人工', 'ULS-03 §3.10');
def('UL-R04', 'R-真机', 'Android Chrome 支持 lock 的成功路径与取消自旋转', '真机 ADB + 人工', 'ULS-03 §3.10');
def('UL-R05', 'R-真机', '真机物理旋转 + 软键盘 + 电话/语音后台返回', '真机 ADB + 人工', 'ULS-03 §3.10');
def('UL-R06', 'R-真机', '真机 dismiss 出口与恢复 + 刘海 / 圆角 / 浏览器栏', '真机 ADB + 人工', 'ULS-03 §3.10');

// docs/17-universal-landscape-ux.md §7 A-1…A-14（团队 lead 追加；与 UL-* 是「规格条目 → 检查 ID」的映射，不是重复验收）
def('UL-UX01', 'UX-规格', 'A-1 iOS Safari 模拟：无 lock / 无可靠 requestFullscreen 下直接落 S2 自转、不静默失败、无必须点按关卡、无技术黑话', 'CDP·能力模拟 + 真实视口', 'docs17 §7 A-1');
def('UL-UX02', 'UX-规格', 'A-2 厂商浏览器拒绝锁定：自转保持 / 立即生效、画面不闪、不重试、不回退化竖屏、不重复弹提示', 'CDP·能力模拟 + 真实视口', 'docs17 §7 A-2');
def('UL-UX03', 'UX-规格', 'A-3 CSS 自转后棋盘真实点击命中（真机 input tap + uiautomator dump；点 A 不落 B、拖动不误建造、相机不重置、选点不丢）', '真机 ADB + 人工（CDP 仅辅助，不得单独判通过）', 'docs17 §7 A-3');
def('UL-UX04', 'UX-规格', 'A-4 入房软键盘 375×667 / 390×844：输入框正立不裁切、中文可输入、全程无自转无提示（补 docs/16 §4 D8 缺口）', '真机 ADB + 人工（CDP visualViewport 仅辅助）', 'docs17 §7 A-4 / docs16 §4 D8');
def('UL-UX05', 'UX-规格', 'A-5 三档横屏视口回归：503/658/736px 参考、9 PASS 基线、自转画布铺满无黑边 / 中间竖条', 'CDP·真实视口 + 人工', 'docs17 §7 A-5');
def('UL-UX06', 'UX-规格', 'A-6 旋转后安全区：env(safe-area-inset-*) 重映射，刘海 / 挖孔 / 手势条不压顶栏与底部固定按钮', '真机 ADB + 人工（CDP 仅辅助）', 'docs17 §7 A-6');
def('UL-UX07', 'UX-规格', 'A-7 阶段迁移：LOBBY→STATE、带 view 的 WELCOME 恢复路径、结束页→回到房间退出自转', 'CDP·真实视口 + 协议集成', 'docs17 §7 A-7 / §1.2 / E6');
def('UL-UX08', 'UX-规格', 'A-8 状态机 S0–S8 共 9 态逐态覆盖（S1 不停留、S3 超时按 S5、S7/S8 不弹提示）', 'CDP·真实视口 + 单测（状态迁移） + 人工', 'docs17 §3.1 / §7 A-8');
def('UL-UX09', 'UX-规格', 'A-9 出口与恢复：≥44×44 CSS px、键盘可达、S6 信息不空白、恢复不叠加、不改游戏状态', 'CDP·真实指针 + 人工', 'docs17 §7 A-9 / §4.2');
def('UL-UX10', 'UX-规格', 'A-10 不反复弹 / 一次会话记忆：≥3 次 resize、S7↔S8、切后台、接电话，转向提示总计 ≤1 次；刷新视为新会话', 'CDP·真实视口 + 浏览器生命周期 + 真机', 'docs17 §7 A-10 / §4.3');
def('UL-UX11', 'UX-规格', 'A-11 可访问性：aria-live 关键态各一次 / S7-S8 不播、焦点圈不裁、实测 rect ≥44×44、正文 ≥12 CSS px、对比度 ≥4.5:1、两种减少动效开关、不只靠颜色/动画/声音', 'CDP·真实视口 + 真实键盘 + 人工 + 真机', 'docs17 §7 A-11 / §5');
def('UL-UX12', 'UX-规格', 'A-12 降级三分支文案逐字断言（① API 缺失 ② 请求被拒 ③ 无法区分含超时），不得出现旧主提示「请检查系统旋转锁定设置」等', 'CDP·能力模拟 + 单测（文本断言）', 'docs17 §7 A-12 / §6.2');
def('UL-UX13', 'UX-规格', 'A-13 旋转方向习惯与浏览器能力实机复核：iPhone Safari + ≥2 种国产内置浏览器，用户物理转动手机（非 ADB 强制旋转）', '真机 ADB + 人工（明确为未验证假设）', 'docs17 §7 A-13 / 附录 A R1');
def('UL-UX14', 'UX-规格', 'A-14 指南 4.2 依赖剥离：运行时禁用 lock + requestFullscreen 后自转仍完整可用（静态评审 + 运行时验证）', 'CDP·能力模拟 + 真实指针 + 静态评审', 'docs17 §7 A-14 / §8.1');

/** A-3 / A-4 / A-6 / A-13 为「必须真机」项：CDP 截图与模拟一律不得单独判通过。
 *  本会话无 iOS 真机 / 无支持 lock 的 Chrome 真机，结构性 BLOCKED。 */
const UX_REAL_DEVICE_IDS = ['UL-UX03', 'UL-UX04', 'UL-UX06', 'UL-UX13'];

const ALLOWED = new Set(['PASS', 'FAIL', 'NOT_RUN', 'BLOCKED']);

class Reporter {
  constructor(run) {
    this.data = {
      schema: 'hexfront.universal-landscape/1',
      generatedAt: nowIso(),
      run,
      reportScope: run.mode === 'capability-only'
        ? 'PHASE1_CAPABILITY_SNAPSHOT — 仅记录 CDP/浏览器能力自检；所有游戏复验项 NOT_RUN，真机项 BLOCKED。不是验收结论。'
        : 'PHASE2_FULL_RUN — 通用横屏跨浏览器复验（结果以实际观测为准；真机项仍为 BLOCKED）。',
      disclaimer:
        '所有检查项初始 NOT_RUN；只有实际执行并写入 observed 才可能 PASS/FAIL。' +
        'CDP 能力模拟 / UA 伪装 / 模拟视口 / 单测 / jsdom 一律不得写成真机通过。' +
        '模拟视口是真实 CSS 视口但不是真机。CAP-* 仅证明脚本能力，不构成游戏功能结论。',
      checks: CHECK_DEFS.map((d) => ({
        ...d, status: 'NOT_RUN', observed: null, expected: null,
        notes: run.mode === 'capability-only' ? '阶段一仅准备：未实跑完整流程，本项未执行' : '阶段二尚未执行到本项',
        at: null,
      })),
      capabilities: [],
      scenarios: [],          // 每个能力分支场景的注入配置 + 原始观测
      scenarioMocks: [],      // 注入的 mock 原样留痕
      pointerEvidence: {},
      viewports: [],
      consoleErrors: [],
      screenshots: [],
      // docs17 §7 A-1…A-14 的补充观测：CDP 侧原始值集中放这里，
      // 真机必需项（A-3/A-4/A-6/A-13）即使有 CDP 观测也保持 BLOCKED，不写成 PASS。
      uxSupplement: { scenarios: {}, cdp: {}, realDeviceNotes: [] },
      cleanup: null,
      summary: null,
    };
    this.byId = new Map(this.data.checks.map((c) => [c.id, c]));
    // 脚本里大量使用 `(ok ? rep.pass : rep.fail)(...)` 形式，必须绑定 this，
    // 否则方法脱离实例调用时 this 为 undefined。
    for (const m of ['set', 'pass', 'fail', 'blocked', 'notRun', 'partial', 'cap', 'note', 'error']) {
      this[m] = this[m].bind(this);
    }
  }
  set(id, status, patch = {}) {
    if (!ALLOWED.has(status)) throw new Error(`非法状态 ${status}`);
    const c = this.byId.get(id);
    if (!c) throw new Error(`未知检查项 ${id}`);
    c.status = status;
    for (const k of ['observed', 'expected', 'notes', 'evidenceType']) if (k in patch) c[k] = patch[k];
    c.at = nowIso();
    return c;
  }
  pass(id, observed, expected, notes) { return this.set(id, 'PASS', { observed, expected, notes }); }
  fail(id, observed, expected, notes) { return this.set(id, 'FAIL', { observed, expected, notes }); }
  blocked(id, notes, observed = null) { return this.set(id, 'BLOCKED', { observed, notes }); }
  notRun(id, notes) { return this.set(id, 'NOT_RUN', { notes }); }
  partial(id, observed, notes) {
    const c = this.set(id, 'NOT_RUN', { observed, notes: `${notes}；【仅部分观测，未写成 PASS】` });
    c.partialObservation = true;
    return c;
  }
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
      byStatus[c.status] += 1;
      const a = (byArea[c.area] ??= { PASS: 0, FAIL: 0, NOT_RUN: 0, BLOCKED: 0 });
      a[c.status] += 1;
    }
    const realDeviceBlocked = this.data.checks.filter((c) => c.area === 'R-真机' && c.status === 'BLOCKED').length;
    let gate = 'NOT_CONCLUDED';
    const reasons = [];
    if (this.data.run.mode === 'full') {
      const fails = this.data.checks.filter((c) => c.status === 'FAIL');
      const notRun = this.data.checks.filter((c) => c.status === 'NOT_RUN').length;
      if (fails.length) reasons.push(`${fails.length} 项 FAIL: ${fails.map((c) => c.id).join(', ')}`);
      if (notRun) reasons.push(`${notRun} 项 NOT_RUN（含需人工/汇编/其他脚本补证项）`);
      if (realDeviceBlocked) reasons.push(`真机 ${realDeviceBlocked} 项 BLOCKED（本会话无 iOS / Chrome 真机）`);
      gate = reasons.length ? 'CONCERNS' : 'PASS';
    } else {
      reasons.push('capability-only 未实跑完整流程，未出具判定');
    }
    this.data.summary = {
      byStatus, byArea, total: this.data.checks.length,
      gate, gateIsAdvisory: true,
      gateNote: this.data.run.mode === 'capability-only'
        ? '阶段一仅准备，未实跑完整流程，未出具质量门判定。'
        : '本 gate 仅为 quality-lead 建议，最终判定由主理人依据本报告 + 真机清单 + 全量命令结果汇编给出。',
      gateReasons: reasons,
      realDeviceBlocked,
      failIds: this.data.checks.filter((c) => c.status === 'FAIL').map((c) => c.id),
      blockedIds: this.data.checks.filter((c) => c.status === 'BLOCKED').map((c) => c.id),
    };
    fs.writeFileSync(CFG.out || REPORT_PATH, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
  }
}

// ---------------------------------------------------------------------------
// CDP 基础
// ---------------------------------------------------------------------------

function cdpHttp(method, pathname, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CFG.cdpPort, path: pathname, method }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: b, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: b, json: null }); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('CDP HTTP timeout')); });
    req.end();
  });
}
function localHttp(port, pathname, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('local HTTP timeout')); });
    req.end();
  });
}
async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(200);
  }
  throw new Error(`等待超时: ${label}${last ? ` (${last.message})` : ''}`);
}

class CDP {
  constructor(ws, label) {
    this.ws = ws; this.label = label; this.id = 0;
    this.pending = new Map(); this.listeners = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(`${m.error.message} (code ${m.error.code ?? '?'})`)) : resolve(m.result);
      } else if (m.method) {
        if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params?.exceptionDetails?.text ?? 'exceptionThrown');
        else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
          this.errors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
        }
        for (const fn of [...(this.listeners.get(m.method) ?? [])]) { try { fn(m.params); } catch { /* ignore */ } }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 命令超时 ${method}`)); }
      }, 15000).unref?.();
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`Runtime.evaluate 异常: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description ?? '')}`);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}
async function createTarget(url = 'about:blank') {
  const created = await cdpHttp('PUT', `/json/new?${encodeURIComponent(url)}`);
  if (created.status !== 200 || !created.json?.webSocketDebuggerUrl) throw new Error(`/json/new 失败: ${created.status} ${created.body.slice(0, 160)}`);
  const target = created.json;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new CDP(ws, target.id);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { target, ws, cdp };
}
async function setViewport(cdp, vp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile: true,
    screenWidth: vp.w, screenHeight: vp.h, screenOrientation: vp.orientation,
  });
}
async function setUA(cdp, ua) {
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua, platform: 'iPhone', acceptLanguage: 'zh-CN' });
}

// ---------------------------------------------------------------------------
// 能力模拟注入（在页面脚本之前执行）
// ---------------------------------------------------------------------------

function buildMockScript(mock) {
  const cfg = JSON.stringify(mock);
  return `(() => {
  const CFG = ${cfg};
  const P = { locks: [], fullscreens: 0, orientationchanges: 0, resizes: 0, errors: [], injectErrors: [], mock: CFG, injectedAt: Date.now() };
  window.__UL_PROBE__ = P;
  const guard = (label, fn) => { try { fn(); } catch (e) { P.injectErrors.push(label + ': ' + String(e)); } };
  window.__UL_ORIENTATION__ = { type: CFG.initialType || 'portrait-primary', angle: CFG.initialAngle ?? 0 };
  window.addEventListener('unhandledrejection', (e) => P.errors.push('unhandledrejection: ' + String(e.reason)));
  window.addEventListener('error', (e) => P.errors.push('error: ' + String(e.message)));
  window.addEventListener('orientationchange', () => { P.orientationchanges += 1; });
  window.addEventListener('resize', () => { P.resizes += 1; });
  function applyOrientation(type, angle) { window.__UL_ORIENTATION__.type = type; window.__UL_ORIENTATION__.angle = angle; }
  function fireOrientation() { window.dispatchEvent(new Event('orientationchange')); window.dispatchEvent(new Event('resize')); }
  window.__UL_SET_ORIENTATION__ = (type, angle, fire) => { applyOrientation(type, angle); if (fire) fireOrientation(); return true; };

  const fake = {};
  Object.defineProperty(fake, 'type', { configurable: true, get: () => window.__UL_ORIENTATION__.type });
  Object.defineProperty(fake, 'angle', { configurable: true, get: () => window.__UL_ORIENTATION__.angle });
  fake.addEventListener = () => {};
  fake.removeEventListener = () => {};
  fake.unlock = () => { applyOrientation('portrait-primary', 0); fireOrientation(); return Promise.resolve(); };
  if (CFG.lock === 'reject') {
    fake.lock = (o) => { P.locks.push(String(o)); return Promise.reject(new DOMException('Orientation lock denied', 'NotAllowedError')); };
  } else if (CFG.lock === 'resolve') {
    fake.lock = (o) => {
      P.locks.push(String(o));
      if (CFG.applyOrientation) applyOrientation('landscape-primary', 90);
      if (CFG.fireOrientationChange) fireOrientation();
      return Promise.resolve();
    };
  } else if (CFG.lock === 'pending') {
    // E2 / §6.2 ③：Promise 既不 resolve 也不 reject，用于验证 S3 超时按 S5 处理
    fake.lock = (o) => { P.locks.push(String(o)); return new Promise(() => {}); };
  }
  // CFG.lock === 'absent'：完全不提供 lock 属性（iOS Safari / 老 WebView）

  guard('orientation', () => {
    if (CFG.orientationApi === 'absent') {
      Object.defineProperty(screen, 'orientation', { configurable: true, get: () => undefined });
    } else {
      Object.defineProperty(screen, 'orientation', { configurable: true, get: () => fake });
    }
  });

  // 注意：addScriptToEvaluateOnNewDocument 执行时 document.documentElement 可能仍是 null
  // （实测 Chrome 156 会抛 TypeError，导致后续注入静默中断）。因此改在原型上打补丁，
  // 与 DOM 解析时机无关；fullscreenElement 同理放在 Document.prototype 上。
  // A-10：统计「转向提示」由隐藏 → 可见的次数（一次页面会话应 ≤1）。
  // 只读 MutationObserver，不触发任何界面逻辑；候选选择器覆盖不到时如实返回 coverage=false。
  guard('hintObserver', () => {
    window.__UL_HINT__ = { shows: 0, texts: [], coverage: false, transitions: [], armed: false };
    const HINT_SEL = '#landscape-hint-main, [data-orientation-hint], .turn-hint, .portrait-hint, [data-ul-hint]';
    let lastVisible = false;
    let hiddenAt = 0;
    const scan = () => {
      if (!window.__UL_HINT__.armed) return;   // 避免无样式阶段（FOUC）的静态文本被算成一次提示
      const nodes = [...document.querySelectorAll(HINT_SEL)];
      if (nodes.length) window.__UL_HINT__.coverage = true;
      const visible = nodes.some((el) => el.getClientRects().length > 0
        && getComputedStyle(el).visibility !== 'hidden' && (el.textContent || '').trim().length > 0);
      const now = Date.now();
      // 去抖：自转淡出动画期间 display/opacity 会短暂翻转（<300ms），
      // 只有「隐藏 ≥1.2s 后再次出现」才算一次真实的转向提示复现（docs17 §4.3）。
      if (visible && !lastVisible && (hiddenAt === 0 || now - hiddenAt > 1200)) {
        window.__UL_HINT__.shows += 1;
        window.__UL_HINT__.texts.push(nodes.map((e) => (e.textContent || '').trim()).filter(Boolean).join(' | ').slice(0, 400));
        window.__UL_HINT__.transitions.push({ event: 'show', at: now, since: hiddenAt });
      }
      if (!visible) { if (lastVisible) hiddenAt = now; }
      else hiddenAt = 0;
      lastVisible = visible;
    };
    new MutationObserver(scan).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const arm = () => { setTimeout(() => { window.__UL_HINT__.armed = true; scan(); }, 300); };
    if (document.readyState === 'complete') arm();
    else window.addEventListener('load', arm, { once: true });
    document.addEventListener('DOMContentLoaded', scan, { once: true });
  });

  guard('fullscreen', () => {
    if (CFG.fullscreen === 'absent') {
      Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, writable: true, value: undefined });
    } else if (CFG.fullscreen === 'reject') {
      Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, writable: true,
        value: () => { P.fullscreens += 1; return Promise.reject(new DOMException('Fullscreen denied', 'NotAllowedError')); } });
    } else if (CFG.fullscreen === 'resolve') {
      Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, writable: true,
        value: () => { P.fullscreens += 1; return Promise.resolve(); } });
      Object.defineProperty(Document.prototype, 'fullscreenElement', { configurable: true, get: () => document.documentElement });
    }
  });
  return true;
})()`;
}

// ---------------------------------------------------------------------------
// 页面状态读取（只读，不触发界面逻辑）
// ---------------------------------------------------------------------------

function stateExpr() {
  return `(() => {
  const de = document.documentElement;
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
             right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) }; };
  // 实际契约：mode/dir 在 #shell，角度在 #shell 的 --ul-rotation；--ul-vw/--ul-vh 可能写在 documentElement。
  const shell = document.getElementById('shell');
  const shellStyle = shell ? getComputedStyle(shell) : null;
  const px = (name) => {
    const v = (shellStyle ? shellStyle.getPropertyValue(name) : '') || getComputedStyle(de).getPropertyValue(name);
    return (v || '').trim() || null;
  };
  const degOf = (raw) => { const m = /^(-?\\d+(?:\\.\\d+)?)deg$/.exec(raw || ''); return m ? Number(m[1]) : null; };
  const contract = {
    mode: shell?.dataset.landscapeMode ?? null,
    dir: shell?.dataset.landscapeDir ?? null,
    ulRotation: px('--ul-rotation'),
    ulVw: px('--ul-vw'),
    ulVh: px('--ul-vh'),
    rotationDeg: degOf(px('--ul-rotation')),
    // 兼容旧字段名（旧假设为 documentElement.dataset.*），仅用于报告对照，不再作为主判据
    legacyOrientationMode: de.dataset.orientationMode ?? null,
    legacyRotationDeg: de.dataset.rotationDeg ?? null,
  };
  const so = (typeof screen !== 'undefined') ? screen.orientation : undefined;
  const vp = { innerWidth, innerHeight, dpr: devicePixelRatio,
    portrait: matchMedia('(orientation: portrait)').matches,
    landscape: matchMedia('(orientation: landscape)').matches,
    orientationType: so ? so.type : null, orientationAngle: so ? so.angle : null,
    lockType: so ? typeof so.lock : 'absent',
    fullscreenType: typeof de.requestFullscreen,
    fullscreenElement: document.fullscreenElement ? document.fullscreenElement.tagName : null };
  const rotations = [];
  const all = document.body ? document.body.querySelectorAll('*') : [];
  for (const el of all) {
    let st; try { st = getComputedStyle(el); } catch (e) { continue; }
    const t = st.transform;
    if (!t || t === 'none') continue;
    const m = /^matrix\\(([^)]+)\\)$/.exec(t);
    if (!m) continue;
    const p = m[1].split(',').map(Number);
    if (p.length < 6) continue;
    const deg = Math.round(Math.atan2(p[1], p[0]) * 180 / Math.PI);
    if (Math.abs(Math.abs(deg) - 90) > 12) continue;
    const r = el.getBoundingClientRect();
    rotations.push({ tag: el.tagName, id: el.id, cls: String(el.className || '').slice(0, 80), deg,
      layoutW: num(st.width), layoutH: num(st.height), rect: rectOf(el), area: Math.round(r.width * r.height) });
  }
  const vpArea = innerWidth * innerHeight;
  const rotatedCanvas = rotations.filter((c) => c.area >= vpArea * 0.30 && c.layoutW > c.layoutH);
  const cssRotated = rotatedCanvas.length > 0;

  const ids = {};
  for (const id of ${JSON.stringify(REQUIRED_IDS)}) ids[id] = !!document.getElementById(id);
  ids['.rail'] = !!document.querySelector('.rail');

  let probe = null;
  if (window.__UL_PROBE__) {
    const p = window.__UL_PROBE__;
    probe = { locks: p.locks.slice(), fullscreens: p.fullscreens, orientationchanges: p.orientationchanges,
      resizes: p.resizes, errors: p.errors.slice(), injectErrors: (p.injectErrors || []).slice(),
      mock: p.mock, injectedAt: p.injectedAt };
  }
  let view = null;
  try { const h = window.__hex; if (h && h.view) view = { phase: h.view.phase, current: h.view.current ?? null,
    seat: h.seat ?? null, roomId: h.roomId ?? null, pendingRobber: h.view.pendingRobber ?? null,
    pendingDiscards: h.view.pendingDiscards ?? null }; } catch (e) { view = { error: String(e) }; }

  const sDE = getComputedStyle(de);
  const sBody = document.body ? getComputedStyle(document.body) : null;
  const safeArea = {
    dePadding: [sDE.paddingTop, sDE.paddingRight, sDE.paddingBottom, sDE.paddingLeft],
    bodyPadding: sBody ? [sBody.paddingTop, sBody.paddingRight, sBody.paddingBottom, sBody.paddingLeft] : null,
    // 自转后安全区映射（layout.css §417-457）：top←inset-right、right←inset-bottom、bottom←inset-left、left←inset-top
    ulSafeTop: shellStyle ? shellStyle.getPropertyValue('--ul-safe-top').trim() : null,
    ulSafeRight: shellStyle ? shellStyle.getPropertyValue('--ul-safe-right').trim() : null,
    ulSafeBottom: shellStyle ? shellStyle.getPropertyValue('--ul-safe-bottom').trim() : null,
    ulSafeLeft: shellStyle ? shellStyle.getPropertyValue('--ul-safe-left').trim() : null,
    shellPadding: shellStyle ? [shellStyle.paddingTop, shellStyle.paddingRight, shellStyle.paddingBottom, shellStyle.paddingLeft] : null,
  };

  const gate = document.getElementById('portrait-gate');
  const gs = gate ? getComputedStyle(gate) : null;
  const rail = document.querySelector('.rail');
  const rs = rail ? getComputedStyle(rail) : null;
  const board = document.getElementById('board');
  const zoomRects = {};
  for (const id of ['zoom-in','zoom-out','zoom-reset']) zoomRects[id] = rectOf(document.getElementById(id));
  const hudEl = document.getElementById('landscape-hud');
  const visible = (el) => !!el && el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== 'hidden';
  const txt = (id) => (document.getElementById(id)?.textContent || '').trim().slice(0, 300);
  const hud = hudEl ? {
    exists: true, hidden: hudEl.classList.contains('hidden'), settled: hudEl.classList.contains('lh-settled'),
    fading: hudEl.classList.contains('fading'), dir: hudEl.dataset.landscapeDir ?? null,
    display: getComputedStyle(hudEl).display, zIndex: getComputedStyle(hudEl).zIndex,
    rect: rectOf(hudEl), ariaLive: hudEl.getAttribute('aria-live'),
    mainText: txt('landscape-hint-main'), subText: txt('portrait-hint'), statusText: txt('landscape-hint-status'),
    closeVisible: visible(document.getElementById('landscape-hint-close')),
    exitVisible: visible(document.getElementById('landscape-exit')),
    resumeVisible: visible(document.getElementById('landscape-resume')),
  } : null;
  const overlayEl = document.getElementById('overlay');
  const overlay = overlayEl ? {
    hidden: overlayEl.classList.contains('hidden'), display: getComputedStyle(overlayEl).display,
    rect: rectOf(overlayEl),
  } : null;
  const orientationBtn = document.getElementById('btn-orientation');
  const layout = {
    gate: gate ? { display: gs.display, hidden: gate.classList.contains('hidden'),
      dismissed: gate.dataset.dismissed ?? null, rect: rectOf(gate) } : null,
    rail: rail ? { display: rs.display, rect: rectOf(rail) } : null,
    boardStage: rectOf(document.getElementById('board-stage')),
    board: board ? { rect: rectOf(board), viewBox: board.getAttribute('viewBox') } : null,
    confirmStrip: rectOf(document.getElementById('confirm-strip')),
    zoom: zoomRects,
    hud, overlay,
    orientationEntry: orientationBtn ? { visible: visible(orientationBtn), rect: rectOf(orientationBtn),
      aria: orientationBtn.getAttribute('aria-label') || null } : null,
    scroll: { sw: de.scrollWidth, cw: de.clientWidth, sh: de.scrollHeight, ch: de.clientHeight },
  };
  // S0 / S6 都是 mode=off：用 overlay 与 HUD 组合区分（engineering-lead 明确要求）
  const stage = (() => {
    if (!contract.mode) return 'unknown';
    if (contract.mode === 'css') return 'S2';
    if (contract.mode === 'system') return 'S4_S7_system';
    if (overlay && !overlay.hidden) return 'S0_lobby';
    if (hud && !hud.hidden) return 'S6_portrait-exit';
    return 'off_other';
  })();
  let ctm = null;
  try { const m = board && board.getScreenCTM && board.getScreenCTM();
    if (m) ctm = { a: +m.a.toFixed(3), b: +m.b.toFixed(3), c: +m.c.toFixed(3), d: +m.d.toFixed(3), e: +m.e.toFixed(1), f: +m.f.toFixed(1) };
  } catch (e) { ctm = { error: String(e) }; }
  let hint = null;
  if (window.__UL_HINT__) {
    const h = window.__UL_HINT__;
    hint = { shows: h.shows, texts: h.texts.slice(), coverage: h.coverage, transitionCount: h.transitions.length, transitions: h.transitions.slice(-8) };
  }
  return { contract, stage, vp, rotations, rotatedCanvas, cssRotated, ids, probe, view, safeArea, layout, ctm, hint,
    hud, overlay, toast: (document.getElementById('toast')?.textContent || '').trim() };
})()`;
}
async function readState(cdp) { return cdp.eval(stateExpr()); }

/** 旋转态判定：读实际契约 #shell[data-landscape-mode]（off|css|system）；
 *  契约缺失时才几何推断，且默认不判 PASS。 */
function rotationOf(st) {
  const mode = st.contract?.mode;
  if (mode) {
    return { rotated: mode === 'css', source: 'contract', mode,
      dir: st.contract.dir, deg: st.contract.rotationDeg, stage: st.stage, inferred: false };
  }
  return { rotated: !!st.cssRotated, source: 'inferred', mode: null,
    deg: st.rotatedCanvas[0]?.deg ?? null, stage: st.stage ?? null, inferred: true };
}
/** 统一的判定落库：契约缺失时默认 partial/NOT_RUN，除非 --allow-inference */
function verdict(rep, id, st, ok, observed, expected, notes) {
  const rot = rotationOf(st);
  const tail = rot.inferred
    ? `；【契约缺失：#shell[data-landscape-mode] 不可读，几何推断 INFERRED${CFG.allowInference ? '（--allow-inference 已开启）' : '，需人工复核，不判 PASS'}】`
    : '';
  if (rot.inferred && !CFG.allowInference) {
    rep.partial(id, { ...observed, inference: rot, contract: st.contract }, `${notes}${tail}`);
    return;
  }
  (ok ? rep.pass : rep.fail)(id, { ...observed, inference: rot, contract: st.contract }, expected, `${notes}${tail}`);
}

// ---------------------------------------------------------------------------
// 真实指针辅助（所有被复验的界面动作都必须经过这里）
// ---------------------------------------------------------------------------

async function mouseClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
async function touchTap(cdp, x, y) {
  const short = (m, p) => Promise.race([cdp.send(m, p), new Promise((_, r) => setTimeout(() => r(new Error(`${m} 短超时`)), 4000))]);
  await short('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await short('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }] });
  await short('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  try { await short('Emulation.setTouchEmulationEnabled', { enabled: false }); } catch { /* ignore */ }
}
async function drag(cdp, x1, y1, x2, y2, steps = 8) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps,
      button: 'left', buttons: 1,
    });
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
}
async function pinch(cdp, cx, cy) {
  const short = (m, p) => Promise.race([cdp.send(m, p), new Promise((_, r) => setTimeout(() => r(new Error(`${m} 短超时`)), 4000))]);
  await short('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await short('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
    { x: cx - 24, y: cy, id: 1, radiusX: 2, radiusY: 2, force: 1 },
    { x: cx + 24, y: cy, id: 2, radiusX: 2, radiusY: 2, force: 1 },
  ] });
  for (let i = 1; i <= 4; i += 1) {
    await short('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
      { x: cx - 24 - i * 5, y: cy, id: 1, radiusX: 2, radiusY: 2, force: 1 },
      { x: cx + 24 + i * 5, y: cy, id: 2, radiusX: 2, radiusY: 2, force: 1 },
    ] });
  }
  await short('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  try { await short('Emulation.setTouchEmulationEnabled', { enabled: false }); } catch { /* ignore */ }
}
async function elementAt(cdp, x, y) {
  return cdp.eval(`(() => { const el = document.elementFromPoint(${x}, ${y});
    return el ? { tag: el.tagName, id: el.id, cls: String(el.className || '').slice(0, 80),
      closestId: el.closest('[id]')?.id ?? null } : null; })()`);
}
async function rectOf(cdp, selector) {
  return cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2,
      display: s.display, visibility: s.visibility, zIndex: s.zIndex }; })()`);
}
/** 真实指针点击某选择器：先 elementFromPoint 核命中，再派发，返回完整证据 */
async function clickSelector(cdp, selector, opts = {}) {
  const r = await rectOf(cdp, selector);
  if (!r || r.w <= 0 || r.h <= 0) return { ok: false, reason: 'element-not-found-or-zero-rect', rect: r };
  const hit = await elementAt(cdp, r.cx, r.cy);
  if (opts.touch) await touchTap(cdp, r.cx, r.cy);
  else await mouseClick(cdp, r.cx, r.cy);
  await sleep(opts.wait ?? 220);
  return { ok: true, rect: r, hitAtCenter: hit, clickAt: { x: r.cx, y: r.cy }, pointer: opts.touch ? 'touch' : 'mouse' };
}
/**
 * 查找「常驻可选方向入口」并用真实指针点击，用于触发 screen.orientation.lock。
 * UX 规格 §2.5 / §7 A-2：旧「进入横屏」主按钮不得再是必须点按的关卡，
 * 因此不能只认 #portrait-landscape；按文案 / aria-label / id / title 识别，
 * 找不到时如实返回 no-entry（由调用方决定是否用游戏中已有手势搭车）。
 */
async function clickOrientationEntry(cdp) {
  const candidates = await cdp.eval(`(() => {
    const re = /横屏|方向|锁定|landscape|旋转/i;
    const exclude = /仍按竖屏|仍在竖屏|重新铺|知道了|收起|取消|关闭|帮助|回到房间/i;
    return [...document.querySelectorAll('button, [role="button"], a')]
      .map((el) => ({ id: el.id, tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 40), aria: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '', cls: String(el.className || '').slice(0, 60),
        rect: (() => { const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })() }))
      .filter((e) => e.rect.w >= 20 && e.rect.h >= 20 && !exclude.test(e.text + e.aria))
      .filter((e) => re.test([e.id, e.text, e.aria, e.title, e.cls].join(' ')))
      .slice(0, 8);
  })()`);
  if (!candidates.length) return { ok: false, reason: 'no-optional-orientation-entry', candidates };
  const e = candidates[0];
  const hit = await elementAt(cdp, e.rect.cx, e.rect.cy);
  await mouseClick(cdp, e.rect.cx, e.rect.cy);
  await sleep(250);
  return { ok: true, entry: e, hitAtCenter: hit,
    clickAt: { x: e.rect.cx, y: e.rect.cy }, candidates };
}
/** A-12：读取所有可见提示 / 播报文案，检查旧主提示与技术黑话是否残留 */
async function scanCopy(cdp) {
  return cdp.eval(`(() => {
    const FORBIDDEN = ['请检查系统的旋转锁定设置','请检查系统旋转锁定设置','请手动把手机横过来',
      '当前浏览器不支持自动横屏','浏览器没有允许切换方向','screen.orientation','requestFullscreen',
      '方向锁定','WebView','浏览器内核','API'];
    const sels = ['#landscape-hint-main','#portrait-hint','#landscape-hint-status','#toast','.portrait-note',
      '.turn-hint','[data-orientation-hint]','#portrait-status','#portrait-gate','#landscape-hud','[role="status"]'];
    const texts = [];
    for (const s of sels) for (const el of document.querySelectorAll(s)) {
      const t = (el.textContent || '').trim();
      // getClientRects() 会计入祖先 display:none（#portrait-gate 永久 hidden，其子节点 computed display 仍是 block）
      if (t && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden') {
        texts.push({ sel: s, id: el.id || null, text: t.slice(0, 300) });
      }
    }
    const combined = texts.map((t) => t.text).join(' | ');
    return { texts, forbiddenHits: FORBIDDEN.filter((f) => combined.includes(f)), combined: combined.slice(0, 1600) };
  })()`);
}
/** A-11：实测按钮 rect / 字号 / 对比度 / aria-live / 减少动效 / 焦点可见 */
async function readA11y(cdp) {
  return cdp.eval(`(() => {
    const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return null;
      const p = m[1].split(',').map(Number); return { r:p[0], g:p[1], b:p[2], a:p.length>3?p[3]:1 }; };
    const lum = (c) => { const f=(v)=>{ v/=255; return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4); };
      return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); };
    const bgOf = (el) => { let e=el; while(e){ const c=parse(getComputedStyle(e).backgroundColor);
      if (c && c.a>0.5) return c; e=e.parentElement; } return { r:255,g:255,b:255,a:1 }; };
    const contrast = (el) => { const fg=parse(getComputedStyle(el).color), bg=bgOf(el); if(!fg) return null;
      const l1=lum(fg),l2=lum(bg),hi=Math.max(l1,l2),lo=Math.min(l1,l2);
      return +((hi+0.05)/(lo+0.05)).toFixed(2); };
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const buttons = [...document.querySelectorAll('button, [role="button"], a')].filter((b) => {
      const r=b.getBoundingClientRect();
      return r.width>0 && r.height>0 && visible(b);
    }).map((b) => { const r=b.getBoundingClientRect(); return { id:b.id, txt:(b.textContent||'').trim().slice(0,24),
      w:+r.width.toFixed(1), h:+r.height.toFixed(1) }; });
    const textEls = [...document.querySelectorAll('body *')].filter((e) => e.children.length===0
      && (e.textContent||'').trim().length>2 && visible(e)).slice(0,40)
      .map((e) => ({ tag:e.tagName, id:e.id, fontPx:parseFloat(getComputedStyle(e).fontSize),
        contrast:contrast(e), text:(e.textContent||'').trim().slice(0,30) }));
    const ariaLive = [...document.querySelectorAll('[aria-live]')].map((e) => ({ id:e.id,
      mode:e.getAttribute('aria-live'), text:(e.textContent||'').trim().slice(0,120) }));
    const focus = (() => { const a=document.activeElement; if(!a||a===document.body) return null;
      const s=getComputedStyle(a); return { id:a.id, tag:a.tagName, outlineWidth:s.outlineWidth, outlineStyle:s.outlineStyle }; })();
    const nums = (arr) => arr.filter((v) => Number.isFinite(v));
    return { buttons: buttons.slice(0,40), buttonCount: buttons.length,
      under44: buttons.filter((b) => b.w<44 || b.h<44),
      minW: buttons.length ? Math.min(...nums(buttons.map((b)=>b.w))) : null,
      minH: buttons.length ? Math.min(...nums(buttons.map((b)=>b.h))) : null,
      textSamples: textEls,
      minFontPx: textEls.length ? Math.min(...nums(textEls.map((t)=>t.fontPx))) : null,
      minContrast: textEls.length ? Math.min(...nums(textEls.map((t)=>t.contrast))) : null,
      ariaLive, reduceMotionAttr: document.documentElement.dataset.reduceMotion ?? null,
      reduceMotionMedia: matchMedia('(prefers-reduced-motion: reduce)').matches, focus };
  })()`);
}
async function pressTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await sleep(120);
}
/** A-9：找「重新铺成横屏」恢复入口并真实指针点击（UX §4.3） */
async function clickRestoreEntry(cdp) {
  const candidates = await cdp.eval(`(() => {
    const re = /重新铺成横屏|重新铺|铺成横屏|恢复横屏/;
    return [...document.querySelectorAll('button, [role="button"], a')].map((el) => ({ id: el.id, tag: el.tagName,
      text: (el.textContent||'').trim().slice(0,40), aria: el.getAttribute('aria-label')||'',
      rect: (() => { const r=el.getBoundingClientRect();
        return { x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2 }; })() }))
      .filter((e) => e.rect.w>=20 && e.rect.h>=20 && re.test(e.id+' '+e.text+' '+e.aria)).slice(0,6);
  })()`);
  if (!candidates.length) return { ok: false, reason: 'no-restore-entry', candidates };
  const e = candidates[0];
  const hit = await elementAt(cdp, e.rect.cx, e.rect.cy);
  await mouseClick(cdp, e.rect.cx, e.rect.cy);
  await sleep(350);
  return { ok: true, entry: e, hitAtCenter: hit, clickAt: { x: e.rect.cx, y: e.rect.cy }, candidates };
}
async function viewBox(cdp) { return cdp.eval(`document.getElementById('board')?.getAttribute('viewBox') ?? null`); }
async function confirmVisible(cdp) {
  return cdp.eval(`(() => { const el = document.getElementById('confirm-strip');
    if (!el) return null; return { hidden: el.classList.contains('hidden'), display: getComputedStyle(el).display,
      text: (el.textContent || '').trim().slice(0, 120) }; })()`);
}
async function saveShot(cdp, rep, tag) {
  if (!CFG.shots) return null;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(SHOTS_DIR, `${SHOT_STAMP}-${tag}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  const rel = path.relative(ROOT, file);
  rep.data.screenshots.push({ tag, file: rel, at: nowIso() });
  return rel;
}

// ---------------------------------------------------------------------------
// 能力自检 fixture（data: URL，不依赖游戏服务）
// ---------------------------------------------------------------------------

const FIXTURE_HTML = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
 html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#123}
 #wrap{position:absolute;left:0;top:0;width:100vh;height:100vw;transform-origin:0 0;
       transform:rotate(90deg) translateY(-100%);background:#234}
 #qa{position:absolute;left:20px;top:20px;width:120px;height:60px;font-size:14px}
</style>
<div id="wrap"><button id="qa">QA-ROTATED</button></div>`;
const FIXTURE_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(FIXTURE_HTML);

async function capabilityMode(ctx) {
  const { rep } = ctx;
  const version = await waitFor(async () => {
    const r = await cdpHttp('GET', '/json/version').catch(() => null);
    return r?.status === 200 && r.json?.Browser ? r.json : null;
  }, 20000, 'CDP /json/version');
  rep.data.run.chromeVersion = version.Browser;
  rep.cap('UL-CAP-01', 'PASS', { browser: version.Browser, protocol: version['Protocol-Version'] }, 'CDP 连通', '/json/version + target WebSocket');
  rep.pass('UL-CAP-01', { browser: version.Browser, protocol: version['Protocol-Version'] }, 'CDP 连通并返回版本', '实测');

  const t = await createTarget('about:blank');
  ctx.targets.push(t);
  const cdp = t.cdp;

  // UL-CAP-02/03/04：真实 CSS 视口 + 矛盾方向
  const vpObs = [];
  for (const vp of [VP.portrait, VP.portraitSmall, ...LANDSCAPES, VP.huaweiStrip]) {
    await setViewport(cdp, vp);
    await cdp.send('Page.navigate', { url: FIXTURE_URL });
    await sleep(180);
    const o = await cdp.eval(`({ innerWidth, innerHeight, dpr: devicePixelRatio,
      portrait: matchMedia('(orientation: portrait)').matches,
      landscape: matchMedia('(orientation: landscape)').matches,
      orientationType: screen.orientation?.type ?? null, orientationAngle: screen.orientation?.angle ?? null,
      docW: document.documentElement.clientWidth, docH: document.documentElement.clientHeight })`);
    vpObs.push({ requested: vp.key, w: vp.w, h: vp.h, requestedOrientation: vp.orientation, observed: o });
    rep.data.viewports.push({ key: vp.key, requested: vp, observed: o, stage: 'capability' });
  }
  const exact = (v, w, h) => v.innerWidth === w && v.innerHeight === h && v.dpr === 2;
  const portraitOk = vpObs.slice(0, 2).every((r) => exact(r.observed, r.w, r.h) && r.observed.portrait === true);
  const landscapeOk = vpObs.slice(2, 5).every((r) => exact(r.observed, r.w, r.h) && r.observed.landscape === true);
  rep.cap('UL-CAP-02', portraitOk ? 'PASS' : 'FAIL', vpObs.slice(0, 2), 'innerWidth/Height 精确、dpr=2、portrait=true', 'setDeviceMetricsOverride');
  rep.cap('UL-CAP-03', landscapeOk ? 'PASS' : 'FAIL', vpObs.slice(2, 5), '三档横屏精确且 landscape=true', 'setDeviceMetricsOverride');
  const huawei = vpObs[5];
  rep.cap('UL-CAP-04', exact(huawei.observed, huawei.w, huawei.h) ? 'PASS' : 'FAIL', huawei,
    '可下发矛盾方向并如实记录 screen.orientation 与 matchMedia 原始值', 'CDP 接受该组合；原始值不做推断');
  (portraitOk ? rep.pass : rep.fail)('UL-CAP-02', vpObs.slice(0, 2), '竖屏视口精确且 portrait=true', 'CDP 真实 CSS 视口能力自检');
  (landscapeOk ? rep.pass : rep.fail)('UL-CAP-03', vpObs.slice(2, 5), '三档横屏视口精确且 landscape=true', 'CDP 真实 CSS 视口能力自检');
  (exact(huawei.observed, huawei.w, huawei.h) ? rep.pass : rep.fail)('UL-CAP-04', huawei,
    '矛盾方向组合可构造，原始值如实记录', 'CDP 真实 CSS 视口能力自检；不代表华为浏览器真机');

  // UL-CAP-05/06：注入剥离 / mock
  await setViewport(cdp, VP.portrait);
  const mockAbsent = { lock: 'absent', fullscreen: 'absent', orientationApi: 'present', initialType: 'portrait-primary', initialAngle: 0 };
  const absentId = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: buildMockScript(mockAbsent) });
  rep.data.scenarioMocks.push({ scope: 'capability-absent', mock: mockAbsent });
  await cdp.send('Page.navigate', { url: FIXTURE_URL });
  await sleep(200);
  const absent = await cdp.eval(`({ lockType: typeof screen.orientation?.lock,
    fullscreenType: typeof document.documentElement.requestFullscreen,
    probe: !!window.__UL_PROBE__, injectErrors: window.__UL_PROBE__?.injectErrors ?? [],
    orientationType: screen.orientation?.type ?? null })`);
  const absentOk = absent.lockType === 'undefined' && absent.fullscreenType === 'undefined'
    && absent.probe && absent.injectErrors.length === 0;
  rep.cap('UL-CAP-05', absentOk ? 'PASS' : 'FAIL', absent,
    '页面脚本前 lock / requestFullscreen 均为 undefined、探针存在、注入无异常', 'addScriptToEvaluateOnNewDocument');
  (absentOk ? rep.pass : rep.fail)('UL-CAP-05', absent, '剥离 API 生效', '能力自检');
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: absentId.identifier }).catch(() => {});

  const mockResolve = { lock: 'resolve', fullscreen: 'resolve', orientationApi: 'present',
    applyOrientation: true, fireOrientationChange: true, initialType: 'portrait-primary', initialAngle: 0 };
  const resolveId = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: buildMockScript(mockResolve) });
  rep.data.scenarioMocks.push({ scope: 'capability-resolve', mock: mockResolve });
  await cdp.send('Page.navigate', { url: FIXTURE_URL });
  await sleep(200);
  const resolved = await cdp.eval(`(async () => {
    const before = { type: screen.orientation.type, angle: screen.orientation.angle };
    const r = await screen.orientation.lock('landscape');
    const after = { type: screen.orientation.type, angle: screen.orientation.angle };
    return { before, after, lockReturn: String(r), probe: window.__UL_PROBE__ };
  })()`);
  const resolveOk = resolved.after.type === 'landscape-primary' && resolved.after.angle === 90
    && resolved.probe?.locks?.includes('landscape') && resolved.probe?.orientationchanges > 0;
  rep.cap('UL-CAP-06', resolveOk ? 'PASS' : 'FAIL', resolved, 'lock resolve + orientation 改写 + orientationchange 派发 + 探针计数', '能力自检');
  (resolveOk ? rep.pass : rep.fail)('UL-CAP-06', resolved, '锁定成功可模拟', '能力自检；不代表真机锁定成功');
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: resolveId.identifier }).catch(() => {});

  // UL-CAP-07：computed transform 矩阵 + 布局/bbox 宽高互换
  await cdp.send('Page.navigate', { url: FIXTURE_URL });
  await sleep(200);
  const geom = await cdp.eval(`(() => { const el = document.getElementById('wrap');
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const m = /^matrix\\(([^)]+)\\)$/.exec(s.transform); const p = m ? m[1].split(',').map(Number) : null;
    const deg = p ? Math.round(Math.atan2(p[1], p[0]) * 180 / Math.PI) : null;
    return { transform: s.transform, deg, layoutW: parseFloat(s.width), layoutH: parseFloat(s.height),
      bboxW: +r.width.toFixed(1), bboxH: +r.height.toFixed(1), innerWidth, innerHeight }; })()`);
  const geomOk = Math.abs(Math.abs(geom.deg ?? 0) - 90) <= 5
    && geom.layoutW > geom.layoutH && Math.abs(geom.bboxW - geom.bboxH) > 0
    && Math.abs(geom.layoutW - geom.innerHeight) <= 2 && Math.abs(geom.layoutH - geom.innerWidth) <= 2;
  rep.cap('UL-CAP-07', geomOk ? 'PASS' : 'FAIL', geom, '≈±90° 矩阵；computed 布局宽高与 bbox 宽高互换', 'fixture');
  (geomOk ? rep.pass : rep.fail)('UL-CAP-07', geom, '旋转几何可测', '能力自检；注意 bbox 是竖屏形，不能只看 bbox 宽高');
  rep.note('旋转几何口径：布局盒 844×390（横屏）+ rotate(90deg) → bbox 390×844（竖屏形，盖满视口）。判据同时记录 computed width/height 与 bbox。');

  // UL-CAP-08/09：elementFromPoint + 真实指针到达旋转后元素
  const qaRect = await cdp.eval(`(() => { const r = document.getElementById('qa').getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
  const hit = await elementAt(cdp, qaRect.cx, qaRect.cy);
  const hitOk = hit?.id === 'qa' || hit?.closestId === 'qa';
  rep.cap('UL-CAP-08', hitOk ? 'PASS' : 'FAIL', { rect: qaRect, hit }, 'elementFromPoint 命中被旋转元素', 'fixture');
  (hitOk ? rep.pass : rep.fail)('UL-CAP-08', { rect: qaRect, hit }, '视觉中心命中 #qa', '能力自检');

  await cdp.eval(`(() => { window.__hits = []; const b = document.getElementById('qa');
    for (const t of ['pointerdown','pointerup','click']) b.addEventListener(t, (e) =>
      window.__hits.push({ t, pt: e.pointerType ?? null, x: e.clientX, y: e.clientY })); return true; })()`);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await mouseClick(cdp, qaRect.cx, qaRect.cy);
  await sleep(150);
  const mouseHits = await cdp.eval('window.__hits');
  await cdp.eval('(() => { window.__hits = []; return true; })()');
  await touchTap(cdp, qaRect.cx, qaRect.cy);
  await sleep(200);
  const touchHits = await cdp.eval('window.__hits');
  const chain = (hs, pt) => ['pointerdown', 'pointerup', 'click'].every((t) => hs.some((h) => h.t === t))
    && hs.some((h) => h.pt === pt);
  const pointerOk = chain(mouseHits, 'mouse') && chain(touchHits, 'touch');
  rep.cap('UL-CAP-09', pointerOk ? 'PASS' : 'FAIL', { mouseHits, touchHits }, 'mouse/touch 均产生完整 pointer 链并记录 client 坐标', 'Input 域');
  (pointerOk ? rep.pass : rep.fail)('UL-CAP-09', { mouseHits, touchHits }, '旋转后真实指针可达', '能力自检');
  rep.data.pointerEvidence.capability = { qaRect, hit, mouseHits, touchHits };

  // UL-CAP-10：截图 + 错误采集
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const shotBytes = shot?.data ? Buffer.from(shot.data, 'base64').length : 0;
  const errCapable = Array.isArray(cdp.errors);
  rep.cap('UL-CAP-10', shotBytes > 1000 && errCapable ? 'PASS' : 'FAIL',
    { shotBytes, listeners: ['Runtime.exceptionThrown', 'Runtime.consoleAPICalled(error)'], unhandledrejectionProbe: true },
    '截图非空 + 错误监听可用', 'Page.captureScreenshot + Runtime');
  (shotBytes > 1000 && errCapable ? rep.pass : rep.fail)('UL-CAP-10', { shotBytes }, '证据采集能力可用', '能力自检');

  // 在真实浏览器里预跑 UX 辅助表达式，避免阶段二才暴露语法/运行时错误（不构成任何游戏验收结论）
  const helperSanity = {
    scanCopy: await scanCopy(cdp).then((v) => ({ ok: !v.error, forbiddenHits: v.forbiddenHits, textCount: v.texts?.length ?? 0 }))
      .catch((e) => ({ ok: false, error: String(e) })),
    readA11y: await readA11y(cdp).then((v) => ({ ok: !v.error, buttonCount: v.buttonCount, minW: v.minW, minH: v.minH }))
      .catch((e) => ({ ok: false, error: String(e) })),
    clickOrientationEntry: 'full 模式执行（fixture 无方向入口）',
    clickRestoreEntry: 'full 模式执行（fixture 无恢复入口）',
  };
  rep.data.uxSupplement.cdp.capabilitySanity = helperSanity;
  rep.cap('UX-HELPERS',
    helperSanity.scanCopy.ok && helperSanity.readA11y.ok ? 'PASS' : 'FAIL', helperSanity,
    'UX 辅助表达式在真实浏览器中可求值（仅脚本能力，不是游戏结论）',
    'capability-only 预跑 scanCopy / readA11y');
  rep.note('UX 辅助表达式已在 capability-only 阶段预跑，避免阶段二因表达式错误中断；结果见 uxSupplement.cdp.capabilitySanity。');

  // 环境隔离
  rep.pass('UL-ENV-01', { cdpPort: CFG.cdpPort, backendPort: CFG.backendPort, vitePort: CFG.vitePort,
    servicesStarted: false, userPortsUntouched: '8787 / 5173 / 8791 / 8792 / 9411 / 9413' },
  'capability-only 不起服务；端口与既有服务全部错开', '能力自检阶段仅绑定 CDP 调试端口');
  rep.pass('UL-ENV-02', { room: ROOM, sharecodeUsed: false, onlineRoomsTouched: false },
    '独立房间号且非 main、无 sharecode', '能力自检不连房间');
  rep.note('capability-only 未启动任何 HTTP/WS 服务、未运行 pnpm test/typecheck/build、未连任何房间。');

  // 真机项结构性 BLOCKED
  blockRealDevice(rep);
  rep.note('capability-only 只运行 UL-CAP-01..10 / UL-ENV-01..02；A/B/C/D/E/F/G 组与 UL-UX01..14 全部保持 NOT_RUN，R 组与 A-3/A-4/A-6/A-13 真机必需项全部 BLOCKED。');
  rep.note('UL-UX01..14 对应 docs/17-universal-landscape-ux.md §7 A-1…A-14；A-8 状态机以 §3.1 的 S0–S8 共 9 态为准。');
}

function blockRealDevice(rep) {
  for (const c of CHECK_DEFS.filter((d) => d.area === 'R-真机')) {
    rep.blocked(c.id,
      '本会话无 iOS Safari 真机、无支持 lock 的 Android Chrome 真机；ADB 仅可见 1 台休眠的华为 ADY_AL00（Android 12，无 Chrome），'
      + '且阶段一不实跑完整流程。见 probe/phase-d-universal-landscape-plan.md §5。禁止写成真机通过。');
  }
  for (const id of UX_REAL_DEVICE_IDS) {
    rep.blocked(id,
      'docs17 §7 明确本条**必须真机**（A-3 真机 input tap + uiautomator dump；A-4 中文软键盘；A-6 刘海/挖孔/手势条；'
      + 'A-13 用户物理转动手机，不能用 ADB 强制旋转替代）。指南 §13.1：模拟视口 / CDP 截图 / 单测不得单独判通过。'
      + '本会话无 iOS 真机、Android 设备休眠且阶段一不实跑 → BLOCKED。CDP 辅助观测只记录在 uxSupplement.cdp，不写成 PASS。');
  }
}

// ---------------------------------------------------------------------------
// 独立服务（仅 full 模式；或 --base-url 使用已起好的独立服务）
// ---------------------------------------------------------------------------

class Services {
  constructor(rep) { this.rep = rep; this.children = []; this.frontBase = null; }
  spawn(label, cmd, args, opts) {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { label, child, out: [] };
    this.children.push(entry);
    child.stdout?.on('data', (d) => entry.out.push(String(d)));
    child.stderr?.on('data', (d) => entry.out.push(String(d)));
    child.on('error', (e) => this.rep.error(`${label} spawn: ${e.message}`));
    return entry;
  }
  async start() {
    if (CFG.baseUrl) {
      this.frontBase = CFG.baseUrl.replace(/\/$/, '');
      this.rep.note(`--base-url 使用外部独立服务 ${this.frontBase}；本脚本不启动任何进程。`);
      return this.frontBase;
    }
    const serverDir = path.join(ROOT, 'apps', 'server');
    const webDir = path.join(ROOT, 'apps', 'web');
    const tsx = path.join(serverDir, 'node_modules', '.bin', 'tsx');
    const vite = path.join(webDir, 'node_modules', '.bin', 'vite');
    if (!fs.existsSync(tsx) || !fs.existsSync(vite)) throw new Error(`缺少 tsx / vite: ${tsx} / ${vite}`);
    const backendEnv = { PORT: String(CFG.backendPort), HOST: '127.0.0.1', HEXFONT_FAKE_DICE: '1',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    const backendHealthy = async () =>
      (await localHttp(CFG.backendPort, '/health').catch(() => null))?.status === 200 ? true : null;
    const tsxEntry = this.spawn('backend-tsx', tsx, ['src/index.ts'], { cwd: serverDir, env: backendEnv });
    try {
      await waitFor(backendHealthy, 12000, `后端 /health (tsx, 127.0.0.1:${CFG.backendPort})`);
      this.rep.note('后端使用 tsx src/index.ts（当前源码）。');
    } catch (e) {
      // 2026-11-08 实测：tsx 冷启动偶发挂起（无输出、不监听），回退到已构建 dist/server.cjs。
      // 本次修复仅改 apps/web/src + web 测试，server 未变，dist 与该源码等价；报告会写明实际用了哪种。
      this.rep.note(`tsx 后端 12s 内未就绪（${e.message}），回退 node dist/server.cjs；本次改动仅前端，server 未变。`);
      try { tsxEntry.child.kill('SIGKILL'); } catch { /* ignore */ }
      this.spawn('backend-dist', process.execPath, ['dist/server.cjs'], { cwd: serverDir, env: backendEnv });
      await waitFor(backendHealthy, 20000, `后端 /health (dist, 127.0.0.1:${CFG.backendPort})`);
    }
    this.spawn('vite', vite, ['--host', '127.0.0.1', '--port', String(CFG.vitePort), '--strictPort'], {
      cwd: webDir,
      env: { HEXFRONT_WS_TARGET: `ws://127.0.0.1:${CFG.backendPort}`,
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    });
    await waitFor(async () => (await localHttp(CFG.vitePort, '/').catch(() => null))?.status === 200 ? true : null,
      25000, `Vite / (127.0.0.1:${CFG.vitePort})`);
    this.frontBase = `http://127.0.0.1:${CFG.vitePort}`;
    this.rep.note(`独立服务已启动：backend 127.0.0.1:${CFG.backendPort} / vite 127.0.0.1:${CFG.vitePort}（--serve=vite 跑当前源码）。`);
    return this.frontBase;
  }
  url(room, name, extra = {}) {
    const u = new URL(this.frontBase);
    if (name) u.searchParams.set('name', name);
    u.searchParams.set('room', room);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
    return u.toString();
  }
  async stop() {
    for (const { child } of this.children) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
    await sleep(400);
    for (const { child } of this.children) if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
}

/** 协议补位：只发 JOIN / START，不碰服务端内存；用于让房间开局并触发 STATE */
class Filler {
  constructor(port, room, name) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.inbox = [];
    this.waiters = [];
    this.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m);
      else this.inbox.push(m);
    });
    this.room = room; this.name = name;
  }
  async open() {
    await new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); });
    this.send({ t: 'JOIN', roomId: this.room, name: this.name, v: 2 });
    return this.next((m) => m.t === 'WELCOME' || m.t === 'JOIN_FAILED', 6000);
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  next(pred, ms = 6000) {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject };
      this.waiters.push(w);
      setTimeout(() => {
        const k = this.waiters.indexOf(w);
        if (k >= 0) { this.waiters.splice(k, 1); reject(new Error('filler 等待超时')); }
      }, ms).unref?.();
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}
async function fillAfterJoin(rep, room, count = 3) {
  const port = CFG.baseUrl ? Number(new URL(CFG.baseUrl).port) : CFG.backendPort;
  const fillers = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const f = new Filler(port, room, `UL-补位${String.fromCharCode(65 + i)}`);
      const w = await f.open();
      if (w.t !== 'WELCOME') throw new Error(`补位入座失败 ${f.name}: ${JSON.stringify(w).slice(0, 200)}`);
      fillers.push(f);
    }
    // 浏览器玩家已在座，补满 capacity=4 后服务端自动开局；不再显式发 START
    return fillers;
  } catch (e) {
    for (const f of fillers) f.close();
    rep.error(`fillAfterJoin(${room}): ${e.message}`);
    return null;
  }
}
async function waitGameState(cdp, ms = 12000) {
  return waitFor(async () => {
    const v = await cdp.eval(`(() => { try { const h = window.__hex; return h?.view?.phase ?? null; } catch { return null; } })()`);
    return v && v !== 'lobby' ? v : null;
  }, ms, '开局 STATE');
}

// ---------------------------------------------------------------------------
// full 模式：能力分支场景
// ---------------------------------------------------------------------------

const SCENARIOS = [
  { id: 'ios-safari', suffix: 'ios', vp: VP.portrait, ua: IOS_SAFARI_UA,
    mock: { lock: 'absent', fullscreen: 'absent', orientationApi: 'present', initialType: 'portrait-primary', initialAngle: 0 },
    expect: 'css-rotate', checks: ['UL-A01', 'UL-A02'] },
  { id: 'vendor-lock-reject', suffix: 'rej', vp: VP.portrait, ua: null,
    mock: { lock: 'reject', fullscreen: 'reject', orientationApi: 'present', initialType: 'portrait-primary', initialAngle: 0 },
    expect: 'css-rotate', checks: ['UL-A03'], clickLandscape: true },
  { id: 'vendor-api-absent', suffix: 'api', vp: VP.portrait, ua: null,
    mock: { lock: 'absent', fullscreen: 'absent', orientationApi: 'absent', initialType: 'portrait-primary', initialAngle: 0 },
    expect: 'css-rotate', checks: ['UL-A04'], clickLandscape: true },
  { id: 'fullscreen-reject', suffix: 'fsr', vp: VP.portrait, ua: null,
    mock: { lock: 'resolve', fullscreen: 'reject', orientationApi: 'present', applyOrientation: false, fireOrientationChange: false,
      initialType: 'portrait-primary', initialAngle: 0 },
    expect: 'landscape', checks: ['UL-A05'], clickLandscape: true },
  { id: 'system-lock-success', suffix: 'lck', vp: VP.portrait, ua: null,
    mock: { lock: 'resolve', fullscreen: 'resolve', orientationApi: 'present', applyOrientation: true, fireOrientationChange: true,
      initialType: 'portrait-primary', initialAngle: 0 },
    expect: 'no-rotate', checks: ['UL-A06', 'UL-A07'], clickLandscape: true },
  { id: 'lock-fake-success', suffix: 'fak', vp: VP.portrait, ua: null,
    mock: { lock: 'resolve', fullscreen: 'resolve', orientationApi: 'present', applyOrientation: false, fireOrientationChange: false,
      initialType: 'portrait-primary', initialAngle: 0 },
    expect: 'css-rotate', checks: ['UL-A08'], clickLandscape: true },
  { id: 'vendor-landscape-portrait-viewport', suffix: 'hw', vp: VP.huaweiStrip, ua: null,
    mock: { lock: 'reject', fullscreen: 'absent', orientationApi: 'present', initialType: 'landscape-primary', initialAngle: 90 },
    expect: 'css-rotate', checks: ['UL-A09'], clickLandscape: false },
  // A-12 ③ / E2：lock Promise 长时 pending（无法区分 / 超时），应回落到 S5 自转而不是停在「尝试中」
  { id: 'degrade-undistinguishable', suffix: 'unk', vp: VP.portrait, ua: null,
    mock: { lock: 'pending', fullscreen: 'absent', orientationApi: 'present', initialType: 'portrait-primary', initialAngle: 0 },
    expect: 'css-rotate', checks: [], clickLandscape: true },
];

async function runScenario(ctx, sc) {
  const { rep, services } = ctx;
  const room = `${ROOM}-${sc.suffix}`;
  const entry = { id: sc.id, room, viewport: sc.vp.key, uaSpoofed: !!sc.ua, mock: sc.mock,
    startedAt: nowIso(), observed: {}, errors: [], screenshot: null };
  rep.data.scenarios.push(entry);
  let t = null; let fillers = null;
  try {
    t = await createTarget('about:blank');
    ctx.targets.push(t);
    const cdp = t.cdp;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: buildMockScript(sc.mock) });
    rep.data.scenarioMocks.push({ scenario: sc.id, room, mock: sc.mock });
    if (sc.ua) await setUA(cdp, sc.ua);
    await setViewport(cdp, sc.vp);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });

    await cdp.send('Page.navigate', { url: services.url(room, 'UL-P1') });
    await sleep(1600);   // 等浏览器页面完成 JOIN 并坐稳 0 号位
    fillers = await fillAfterJoin(rep, room, 3);
    entry.fillers = fillers ? fillers.length : 0;
    entry.phase = await waitGameState(cdp).catch((e) => { entry.errors.push(e.message); return null; });

    const before = await readState(cdp);
    entry.observed.before = before;

    // 触发 lock 路径：优先点「常驻可选方向入口」，找不到时用一次游戏中已有手势搭车
    // （UX 规格 §2.5）；旧 #portrait-landscape 主按钮已被明确禁止作为必须点按的关卡。
    if (sc.clickLandscape) {
      const trigger = await clickOrientationEntry(cdp);
      if (!trigger.ok) {
        const piggyback = await clickSelector(cdp, '#zoom-in');
        entry.observed.landscapeClick = { ok: piggyback.ok, reason: 'gesture-piggyback-via-zoom-in',
          entrySearch: trigger, piggyback };
      } else {
        entry.observed.landscapeClick = trigger;
      }
      // E2 / A-12 ③：lock Promise 长时 pending，实现有 1200ms 上限，需等超时走 S5
      if (sc.id === 'degrade-undistinguishable') await sleep(1700);
    }

    // 锁定成功场景：视口真正切到横屏，模拟浏览器完成系统旋转
    if (sc.id === 'system-lock-success') {
      await setViewport(cdp, VP.land844);
      await sleep(400);
    }
    const after = await readState(cdp);
    entry.observed.after = after;
    entry.observed.rotationBefore = rotationOf(before);
    entry.observed.rotationAfter = rotationOf(after);
    entry.observed.copy = await scanCopy(cdp).catch((e) => ({ error: String(e) }));
    entry.screenshot = await saveShot(cdp, rep, `scenario-${sc.id}`);
    entry.errors.push(...(cdp.errors || []));

    // A-1…A-14 的原始观测集中留痕（不直接判 PASS，由 runUxChecks 统一裁定）
    rep.data.uxSupplement.scenarios[sc.id] = {
      room, viewport: sc.vp.key, uaSpoofed: !!sc.ua, mock: sc.mock, phase: entry.phase,
      rotationBefore: entry.observed.rotationBefore, rotationAfter: entry.observed.rotationAfter,
      probe: after.probe, gate: after.layout.gate, vp: after.vp, contract: after.contract,
      rotatedCanvas: after.rotatedCanvas, copy: entry.observed.copy, hint: after.hint,
      toast: after.toast, landscapeClick: entry.observed.landscapeClick ?? null,
      consoleErrors: cdp.errors, screenshot: entry.screenshot,
    };

    evaluateScenario(rep, sc, entry, before, after);
  } catch (e) {
    entry.errors.push(String(e.stack ?? e.message));
    for (const id of sc.checks) rep.blocked(id, `场景 ${sc.id} 执行异常/前置缺失：${e.message}；未取得可判定观测`, entry.observed);
  } finally {
    if (fillers) for (const f of fillers) f.close();
    if (t) { try { await t.cdp.send('Page.close').catch(() => {}); } catch { /* ignore */ } t.cdp.close(); }
  }
}

function evaluateScenario(rep, sc, entry, before, after) {
  const rot = rotationOf(after);
  const probe = after.probe ?? {};
  const baseObs = { viewport: after.vp, contract: after.contract, rotation: rot,
    rotatedCanvas: after.rotatedCanvas, probe, gate: after.layout.gate,
    landscapeClick: entry.observed.landscapeClick ?? null, phase: entry.phase,
    errors: entry.errors, consoleErrors: after.probe?.errors ?? [] };
  const rotated = rot.rotated;
  const noUnhandled = (probe.errors ?? []).length === 0;
  const lockCalled = (probe.locks ?? []).length > 0;

  switch (sc.id) {
    case 'ios-safari': {
      verdict(rep, 'UL-A01', after, rotated, baseObs,
        'data-landscape-mode=css 且 --ul-rotation=90deg，布局宽≈innerHeight、布局高≈innerWidth，bbox 覆盖视口，rail/board 可见',
        'iOS Safari 能力模拟：剥离 lock / requestFullscreen + iOS UA（UA 伪装不是真机）');
      const ok = (probe.locks ?? []).length === 0 && Number(probe.fullscreens ?? 0) === 0
        && noUnhandled && rotated && after.layout.rail?.display !== 'none';
      verdict(rep, 'UL-A02', after, ok, { ...baseObs, probe },
        '不调用系统 API、无 unhandledrejection、自旋转实际生效、 rail 可见、无「必须手动旋转」唯一出口',
        '不依赖系统 API 的降级路径');
      break;
    }
    case 'vendor-lock-reject': {
      const rejected = lockCalled || entry.observed.landscapeClick?.ok === false;
      if (!lockCalled) {
        rep.blocked('UL-A03', '实现未在该场景请求 screen.orientation.lock，拒绝分支未被触发（可能为设计选择，需 UX 规格确认）；未写成 FAIL', baseObs);
      } else {
        verdict(rep, 'UL-A03', after, rotated && noUnhandled, baseObs,
          'lock 拒绝后落到自旋转，rejection 被 catch（无 unhandledrejection），有可见结果不假装成功', '厂商浏览器拒绝 lock 模拟');
      }
      void rejected;
      break;
    }
    case 'vendor-api-absent': {
      verdict(rep, 'UL-A04', after, rotated && noUnhandled && after.vp.lockType === 'absent', baseObs,
        'screen.orientation 缺失时不抛异常、落到自旋转', 'API 整体缺失模拟');
      break;
    }
    case 'fullscreen-reject': {
      const landscape = rotated || after.vp.landscape === true || after.layout.gate?.hidden === true;
      verdict(rep, 'UL-A05', after, landscape && noUnhandled, baseObs,
        '全屏被拒不阻断后续分支，最终呈现横屏（自旋转或锁定成功）且无静默失败', 'requestFullscreen 拒绝 + lock 可用');
      break;
    }
    case 'system-lock-success': {
      if (!lockCalled) {
        rep.blocked('UL-A06', '实现未请求 screen.orientation.lock，系统锁定成功分支未被触发（可能为设计选择）；未写成 FAIL', baseObs);
      } else {
        const ok = !rotated && after.vp.landscape === true && after.contract.mode === 'system';
        verdict(rep, 'UL-A06', after, ok, baseObs,
          'lock resolve + orientationchange + 视口切横屏后 mode 推为 system、取消 CSS 旋转，无双重旋转', 'CDP 能力模拟 + 真实视口切换');
      }
      break;
    }
    case 'lock-fake-success': {
      verdict(rep, 'UL-A08', after, rotated && after.vp.portrait === true, baseObs,
        'lock 假成功（方向/视口仍竖屏）时不误取消自旋转', '防「声称已横屏、实际仍竖屏」');
      break;
    }
    case 'vendor-landscape-portrait-viewport': {
      verdict(rep, 'UL-A09', after, rotated && after.vp.portrait === true, baseObs,
        '以 CSS 视口实测为准自旋转；旋转后画布铺满可视区、无竖条 / 黑边（截图需人工复核）',
        '系统报告横屏但视口仍竖屏（docs/16 §1.1 华为浏览器坑）');
      break;
    }
    default: break;
  }
}

async function runSystemUnlock(ctx) {
  // UL-A07：锁定成功后把视口转回竖屏并派发 orientationchange，观测是否重新自旋转且不双重旋转
  const { rep, services } = ctx;
  const id = 'UL-A07';
  if (rep.byId.get(id).status !== 'NOT_RUN') return;
  let t = null; let fillers = null;
  try {
    t = await createTarget('about:blank');
    ctx.targets.push(t);
    const cdp = t.cdp;
    const mock = { lock: 'resolve', fullscreen: 'resolve', orientationApi: 'present', applyOrientation: true,
      fireOrientationChange: true, initialType: 'portrait-primary', initialAngle: 0 };
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: buildMockScript(mock) });
    rep.data.scenarioMocks.push({ scenario: 'system-unlock', mock });
    await setViewport(cdp, VP.portrait);
    const room = `${ROOM}-ulk`;
    await cdp.send('Page.navigate', { url: services.url(room, 'UL-P1') });
    await sleep(1600);
    fillers = await fillAfterJoin(rep, room, 3);
    await waitGameState(cdp).catch(() => null);
    let click = await clickOrientationEntry(cdp);
    if (!click.ok) click = { ...click, piggyback: await clickSelector(cdp, '#zoom-in') };
    await setViewport(cdp, VP.land844);
    await sleep(350);
    const locked = await readState(cdp);
    // 回竖屏：环境级事件（非 el.click），模拟系统解锁/用户物理转回
    await cdp.eval(`window.__UL_SET_ORIENTATION__ && window.__UL_SET_ORIENTATION__('portrait-primary', 0, true)`);
    await setViewport(cdp, VP.portrait);
    await sleep(450);
    const back = await readState(cdp);
    const rot = rotationOf(back);
    const deg = Number(back.contract.rotationDeg ?? rot.deg ?? 0);
    const noDouble = Math.abs(Math.abs(deg) - 90) <= 5 || Math.abs(deg) <= 5;
    const obs = { mock, click, locked: { contract: locked.contract, vp: locked.vp, rotation: rotationOf(locked) },
      back: { contract: back.contract, vp: back.vp, rotation: rot, rotatedCanvas: back.rotatedCanvas }, deg, noDouble };
    if (!(locked.probe?.locks ?? []).length) {
      rep.blocked(id, '该场景未触发 lock（实现可能从不请求系统锁定），无法判定解锁后重新自旋转；未写成 FAIL', obs);
    } else if (rot.inferred && !CFG.allowInference) {
      rep.partial(id, obs, '契约缺失，几何推断 INFERRED，需人工复核；未写成 PASS');
    } else {
      (rot.rotated && noDouble ? rep.pass : rep.fail)(id, obs,
        '回竖屏后重新自旋转，且旋转角恰为 ±90° 一次（不叠加 180°）',
        '环境级 orientationchange + 真实视口切换（非 el.click）');
    }
  } catch (e) {
    rep.blocked(id, `UL-A07 场景执行异常/前置缺失：${e.message}；未取得可判定观测`);
  } finally {
    if (fillers) for (const f of fillers) f.close();
    if (t) { try { await t.cdp.send('Page.close').catch(() => {}); } catch { /* ignore */ } t.cdp.close(); }
  }
}

// ---------------------------------------------------------------------------
// full 模式：共享检查（B / C / D / E / F / G）
// ---------------------------------------------------------------------------

async function attempt(rep, id, fn, fallbackNote) {
  try { await fn(); }
  catch (e) { rep.blocked(id, `${fallbackNote}：${e.message}；未写成 FAIL`); }
}

async function runSharedChecks(ctx) {
  const { rep, services } = ctx;

  // --- C01 / C02：入房阶段（不带 name，不触发 JOIN）
  let pre = null;
  try {
    pre = await createTarget('about:blank');
    ctx.targets.push(pre);
    await setViewport(pre.cdp, VP.portrait);
    await pre.cdp.send('Page.navigate', { url: services.url(`${ROOM}-pre`, null) });
    await sleep(900);
    const st = await readState(pre.cdp);
    const rot = rotationOf(st);
    // A-7 / A-8：S0 入房态原始观测
    rep.data.uxSupplement.cdp.S0 = { contract: st.contract, vp: st.vp, rotation: rot,
      view: st.view, gate: st.layout.gate, hint: st.hint, toast: st.toast,
      copy: await scanCopy(pre.cdp).catch((e) => ({ error: String(e) })) };
    const joinVisible = await pre.cdp.eval(`(() => { const o = document.querySelector('.overlay.open, #join, .join');
      return o ? { found: true, display: getComputedStyle(o).display, rect: (() => { const r=o.getBoundingClientRect(); return {w:r.width,h:r.height}; })() } : { found: false }; })()`);
    const obs = { contract: st.contract, vp: st.vp, rotation: rot, view: st.view, joinVisible, rotatedCanvas: st.rotatedCanvas };
    const ok = !rot.rotated && (st.view === null || st.view.phase === 'lobby');
    verdict(rep, 'UL-C01', st, ok, obs, '未收到开局 STATE 时不旋转，入房控件可见', '竖屏 390×844，无 name 参数');
    const inputs = await pre.cdp.eval(`(() => { const a=[...document.querySelectorAll('input')];
      return a.map((e)=>({id:e.id,rect:(()=>{const r=e.getBoundingClientRect();return {w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2};})()})); })()`);
    if (inputs.length) {
      const { cx, cy } = inputs[0].rect;
      await mouseClick(pre.cdp, cx, cy);
      await sleep(250);
      const focused = await readState(pre.cdp);
      const fr = rotationOf(focused);
      verdict(rep, 'UL-C02', focused, !fr.rotated, { input: inputs[0], contract: focused.contract,
        rotation: fr, activeElement: await pre.cdp.eval('document.activeElement?.id ?? null') },
      '输入框 focus 时不启用旋转', '浏览器级 focus 模拟；真机软键盘须由 UL-R05 补证，本项不替代真机');
    } else {
      rep.blocked('UL-C02', '入房浮层未找到 input 元素，无法执行 focus 观测；真机键盘仍须 UL-R05', { inputs });
    }
  } catch (e) {
    rep.blocked('UL-C01', `入房阶段场景异常：${e.message}`);
    rep.blocked('UL-C02', `入房阶段场景异常：${e.message}`);
  }

  // --- 主 target：iOS Safari 能力模拟 + 开局 STATE
  let t = null; let fillers = null;
  try {
    t = await createTarget('about:blank');
    ctx.targets.push(t);
    const cdp = t.cdp;
    const mock = { lock: 'absent', fullscreen: 'absent', orientationApi: 'present', initialType: 'portrait-primary', initialAngle: 0 };
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: buildMockScript(mock) });
    rep.data.scenarioMocks.push({ scenario: 'shared-main', mock });
    await setViewport(cdp, VP.portrait);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    const room = `${ROOM}-main`;
    await cdp.send('Page.navigate', { url: services.url(room, 'UL-P1') });
    await sleep(1600);
    fillers = await fillAfterJoin(rep, room, 3);
    const phase = await waitGameState(cdp).catch(() => null);
    const st = await readState(cdp);
    const rot = rotationOf(st);
    rep.data.scenarios.push({ id: 'shared-main', room, mock, phase, startedAt: nowIso(),
      observed: { state: st, rotation: rot } });
    await saveShot(cdp, rep, 'shared-main-portrait');
    // A-7 / A-8 / A-11 / A-12：S2 主态原始观测 + 可访问性实测 + 文案扫描
    rep.data.uxSupplement.cdp.S2 = { contract: st.contract, vp: st.vp, rotation: rot, view: st.view,
      gate: st.layout.gate, rail: st.layout.rail, ctm: st.ctm, hint: st.hint, toast: st.toast,
      copy: await scanCopy(cdp).catch((e) => ({ error: String(e) })) };
    rep.data.uxSupplement.cdp.a11y = await readA11y(cdp).catch((e) => ({ error: String(e) }));
    await pressTab(cdp).catch((e) => rep.error(`pressTab: ${e.message}`));
    rep.data.uxSupplement.cdp.focusAfterTab = await readA11y(cdp).then((a) => a.focus).catch(() => null);
    rep.data.uxSupplement.cdp.hintBeforeBurst = st.hint;

    // --- C03 / G02 / G06
    // UX 规格 §1.2：阶段信号以 view !== null / 入房浮层隐藏为准，
    // 不能只等 STATE —— 重连恢复的 WELCOME 也会直接带 msg.view。
    const stageSignal = !!st.view && !!st.view.phase && st.view.phase !== 'lobby';
    verdict(rep, 'UL-C03', st, stageSignal && (rot.rotated || st.contract.mode === 'system'),
      { phase, view: st.view, stageSignal, contract: st.contract, rotation: rot },
      '收到开局 STATE 或带 view 的 WELCOME（view!==null）后从 pre-game 切到 css-rotate / system-locked',
      '竖屏 390×844 开局后观测；阶段信号按 UX §1.2 以 view!==null 为准');
    const missingIds = [...REQUIRED_IDS, '.rail'].filter((id) => !st.ids[id]);
    (missingIds.length === 0 ? rep.pass : rep.fail)('UL-G02', { ids: st.ids, missingIds },
      '16 个既有 DOM id 全部存在（缺失需登记为有意变更并同步既有脚本 / 测试）',
      `DOM id 对账；缺失 ${missingIds.length} 个`);
    (st.ctm && !st.ctm.error ? rep.pass : rep.fail)('UL-G06', { ctm: st.ctm, board: st.layout.board },
      '#board 可读取 getScreenCTM 且无异常（供阶段二核对 client→SVG 无 X/Y 反转）',
      '本项只证 CTM 可读；坐标反转的最终判据需在 B01 真实点选中核对命中 ID');

    // --- B07 / B09 / D01 / D02 / D03 / C07（只读几何）
    const hitResults = {};
    for (const id of ['zoom-in', 'zoom-out', 'zoom-reset']) {
      const r = st.layout.zoom[id];
      if (!r || r.w <= 0) { hitResults[id] = null; continue; }
      hitResults[id] = { rect: r, hit: await elementAt(cdp, r.x + r.w / 2, r.y + r.h / 2) };
    }
    const hitsOk = Object.values(hitResults).every((v) => v && (v.hit?.id?.startsWith('zoom-') || v.hit?.closestId?.startsWith('zoom-')));
    (hitsOk ? rep.pass : rep.fail)('UL-B07', hitResults,
      '关键按钮 rect 中心 elementFromPoint 命中自身（不被 overlay / gate / toast 遮挡）',
      '旋转后视觉坐标命中测试');
    const sizesOk = Object.values(hitResults).every((v) => v && v.rect.w >= 40 && v.rect.h >= 40);
    (sizesOk ? rep.pass : rep.fail)('UL-B09', hitResults,
      '旋转后关键按钮视觉命中区 ≥44×44 CSS px（记录实测值，允许 ±4px 量测误差）',
      '指南 5.2 触控目标设计目标');
    const inView = (r) => r && r.x >= -1 && r.y >= -1 && r.right <= st.vp.innerWidth + 1 && r.bottom <= st.vp.innerHeight + 1;
    const keyRects = { gate: st.layout.gate?.rect, rail: st.layout.rail?.rect,
      boardStage: st.layout.boardStage, confirmStrip: st.layout.confirmStrip, ...Object.fromEntries(Object.entries(hitResults).map(([k, v]) => [k, v?.rect])) };
    const d1ok = Object.values(keyRects).filter(Boolean).every(inView);
    (d1ok ? rep.pass : rep.fail)('UL-D01', { keyRects, viewport: st.vp },
      '关键 UI 矩形完全落在视觉视口内', '旋转后安全区几何检查');
    const safeKeys = ['ulSafeTop', 'ulSafeRight', 'ulSafeBottom', 'ulSafeLeft'];
    const safeOk = safeKeys.every((k) => st.safeArea[k] !== null && st.safeArea[k] !== '')
      && st.safeArea.shellPadding?.length === 4;
    if (st.contract.mode !== 'css') {
      rep.partial('UL-D02', { ...st.safeArea, safeKeys, contract: st.contract },
        '非 css 模式（off/system）下 --ul-safe-* 未定义，属预期；安全区映射需在 css 自转态观测，未写成 FAIL');
    } else {
      (safeOk ? rep.pass : rep.fail)('UL-D02', { ...st.safeArea, safeKeys, contract: st.contract },
        '旋转后 --ul-safe-top/right/bottom/left 均可读（实现按 90° 映射 right→top、bottom→right、left→bottom、top→left）',
        'CDP 无头 Chrome 无真实刘海，只验证映射变量存在与 shell padding 应用；真机遮挡由 UL-D04 / UL-R06 补证');
    }
    (st.layout.scroll.sw <= st.layout.scroll.cw ? rep.pass : rep.fail)('UL-D03',
      { scroll: st.layout.scroll, vp: st.vp, rotatedCanvas: st.rotatedCanvas },
      'scrollWidth ≤ clientWidth（无横向滚动）；截图目视无竖条 / 黑边需人工复核',
      'CDP 几何 + 人工；不代表真机');
    (inView(st.layout.confirmStrip) || st.layout.confirmStrip === null ? rep.pass : rep.fail)('UL-C07',
      { confirmStrip: st.layout.confirmStrip, rail: st.layout.rail?.rect, vp: st.vp },
      '确认条 / 行动区矩形在视口内，当前任务未滚出视野', '旋转后重新计算可视区域');

    // --- B02：缩放按钮真实指针 + 不误选棋盘
    const vb0 = await viewBox(cdp);
    const clickIn = await clickSelector(cdp, '#zoom-in');
    const vb1 = await viewBox(cdp);
    const clickOut = await clickSelector(cdp, '#zoom-out');
    const vb2 = await viewBox(cdp);
    const clickReset = await clickSelector(cdp, '#zoom-reset');
    const vb3 = await viewBox(cdp);
    const confirmAfterZoom = await confirmVisible(cdp);
    const b2ok = clickIn.ok && clickOut.ok && clickReset.ok && !!vb0 && vb1 !== vb0 && vb2 !== vb1
      && (confirmAfterZoom?.hidden === true || confirmAfterZoom?.display === 'none');
    (b2ok ? rep.pass : rep.fail)('UL-B02',
      { vb0, vb1, vb2, vb3, resetRestored: vb3 === vb0, clickIn, clickOut, clickReset, confirmAfterZoom },
      'zoom-in / out 均改变 viewBox、三个按钮真实可点、不弹确认条 / 不选棋盘；reset 是否回到初值单独记录（不据此改判）',
      'CDP 真实指针');

    // --- B08：触屏 tap 同样生效
    const vbBeforeTouch = await viewBox(cdp);
    const touchClick = await clickSelector(cdp, '#zoom-in', { touch: true });
    const vbAfterTouch = await viewBox(cdp);
    (touchClick.ok && vbAfterTouch !== vbBeforeTouch ? rep.pass : rep.fail)('UL-B08',
      { touchClick, vbBeforeTouch, vbAfterTouch }, '触屏 tap 在旋转后改变 viewBox（与鼠标同样生效）', 'CDP 真实触屏指针');

    // --- B01：棋盘候选点选（setup 阶段才有热区）
    const candidates = await cdp.eval(`(() => { const a=[...document.querySelectorAll('#board [data-vertex]')];
      return a.slice(0,12).map((e)=>{ const r=e.getBoundingClientRect();
        return { key:e.getAttribute('data-vertex'), cx:r.x+r.width/2, cy:r.y+r.height/2, w:r.width,h:r.height }; }); })()`);
    if (!candidates.length) {
      rep.blocked('UL-B01', '当前页面无 #board [data-vertex] 候选（状态未造出或选择器已变更），真实指针点选未执行；未写成 FAIL', { phase });
    } else {
      const c = candidates.find((x) => x.w > 0 && x.h > 0) ?? candidates[0];
      const hit = await elementAt(cdp, c.cx, c.cy);
      await mouseClick(cdp, c.cx, c.cy);
      await sleep(350);
      const conf = await confirmVisible(cdp);
      const picked = await cdp.eval(`(() => { const e=document.querySelector('#board .picked, #board [data-vertex].picked');
        return e ? { key:e.getAttribute('data-vertex') ?? e.getAttribute('data-tile') ?? null, cls:String(e.className||'') } : null; })()`);
      const b1ok = !!hit && (conf?.hidden === false || !!picked);
      (b1ok ? rep.pass : rep.fail)('UL-B01',
        { candidate: c, hitAtCenter: hit, confirmStrip: conf, picked, ctm: st.ctm },
        '真实指针点候选中心后 elementFromPoint 命中棋盘元素，且出现预览 / 确认条 / picked',
        'CSS 自旋转后的视觉坐标命中（本方案最高风险）');
    }

    // --- B05 / B06 / G03：拖动 / 双指不误建造
    const stage = st.layout.boardStage;
    if (stage && stage.w > 40 && stage.h > 40) {
      const cx = stage.x + stage.w / 2, cy = stage.y + stage.h / 2;
      const beforeDrag = await confirmVisible(cdp);
      await drag(cdp, cx, cy, cx + 30, cy, 8);          // 视觉水平
      await sleep(200);
      const afterH = await confirmVisible(cdp);
      await drag(cdp, cx, cy, cx, cy + 30, 8);          // 视觉垂直
      await sleep(200);
      const afterV = await confirmVisible(cdp);
      const noConfirm = (x) => x?.hidden === true || x?.display === 'none';
      const b5ok = noConfirm(afterH) && noConfirm(afterV);
      (b5ok ? rep.pass : rep.fail)('UL-B05',
        { beforeDrag, afterHorizontal: afterH, afterVertical: afterV, stage, thresholdCssPx: 8 },
        '两个方向 >8 CSS px 拖动后均无确认条 / 新增建筑', 'CDP 真实指针拖动');
      const vbBeforePinch = await viewBox(cdp);
      await pinch(cdp, cx, cy);
      await sleep(300);
      const afterPinch = await confirmVisible(cdp);
      const vbAfterPinch = await viewBox(cdp);
      (noConfirm(afterPinch) ? rep.pass : rep.fail)('UL-B06',
        { confirmAfterPinch: afterPinch, vbBeforePinch, vbAfterPinch },
        '双指 pinch 抬手后无确认条 / 误建造，镜头不回弹', 'CDP 真实触屏双指');
      rep.partial('UL-G03', { thresholdCssPx: 8, horizontal: afterH, vertical: afterV, pinch: afterPinch,
        pointercancelTested: false, blurTested: false },
      '已观测 8px 阈值与双指；pointercancel / 多指加入 / 失焦清理未在本轮覆盖，需阶段二补跑');
    } else {
      for (const id of ['UL-B05', 'UL-B06', 'UL-G03']) rep.blocked(id, '#board-stage 矩形不可用，拖动 / 双指未执行；未写成 FAIL', { stage });
    }

    // --- B03 / B04：需要 --seven / robber 种子态，本脚本不造该状态，如实标 BLOCKED
    rep.blocked('UL-B03', '弃牌加减需要掷 7 / 待弃牌种子态；本脚本不调用 seed-room --seven，阶段二用独立房间补跑。未写成 FAIL', { phase, view: st.view });
    rep.blocked('UL-B04', '强盗按钮需要 pendingRobber 种子态；本脚本不造该状态，阶段二用独立房间补跑。未写成 FAIL', { phase, view: st.view });

    // --- C04 / C05：旋转无副作用 / STATE 不重置相机
    const vbBeforeSwitch = await viewBox(cdp);
    await setViewport(cdp, VP.land844);
    await sleep(350);
    const land = await readState(cdp);
    await setViewport(cdp, VP.portrait);
    await sleep(350);
    const back = await readState(cdp);
    const vbAfterSwitch = await viewBox(cdp);
    const seatSame = st.view?.seat === back.view?.seat && st.view?.roomId === back.view?.roomId;
    rep.partial('UL-C04', { seatBefore: st.view?.seat, seatAfter: back.view?.seat,
      roomBefore: st.view?.roomId, roomAfter: back.view?.roomId, seatSame,
      serverCommandCount: null },
    '客户端侧座位 / 房间未变已观测；「不发游戏命令」需服务端命令计数（协议集成）补证，本脚本未采集，不判 PASS');
    rep.partial('UL-C05', { vbBeforeSwitch, vbAfterSwitch, same: vbBeforeSwitch === vbAfterSwitch,
      stateBroadcastTriggered: false },
    '视口切换前后 viewBox 已观测；「收到 STATE 广播不重置相机」需可控 STATE 广播补跑，未写成 PASS');
    void land;

    // --- E 组：视口矩阵
    const e2 = [], e5 = [], e6 = [], e7 = [];
    for (const [id, vp] of [['UL-E02', VP.land667], ['UL-E03', VP.land844], ['UL-E04', VP.land932]]) {
      await setViewport(cdp, vp);
      await sleep(300);
      const s = await readState(cdp);
      const r = rotationOf(s);
      const ok = !r.rotated && s.layout.gate?.display === 'none'
        && s.layout.rail?.display !== 'none' && (s.layout.boardStage?.w ?? 0) > 0;
      const obs = { viewport: s.vp, contract: s.contract, rotation: r, gate: s.layout.gate,
        rail: s.layout.rail, boardStage: s.layout.boardStage };
      e7.push({ key: vp.key, requested: vp, observed: s.vp });
      rep.data.viewports.push({ key: vp.key, requested: vp, observed: s.vp, stage: 'full-E' });
      (ok ? rep.pass : rep.fail)(id, obs,
        '不重复旋转（mode !== css）、gate display:none、rail 展开、board-stage 宽度 >0', 'CDP 真实视口');
    }
    for (const vp of [VP.portrait, VP.portraitSmall]) {
      await setViewport(cdp, vp);
      await sleep(300);
      const s = await readState(cdp);
      const canvas = s.rotatedCanvas[0];
      const ok = !!canvas && Math.abs(canvas.layoutW - s.vp.innerHeight) <= 4
        && Math.abs(canvas.layoutH - s.vp.innerWidth) <= 4 && s.layout.rail?.display !== 'none';
      e2.push({ key: vp.key, canvas, rotation: rotationOf(s), ok });
      rep.data.viewports.push({ key: vp.key, requested: vp, observed: s.vp, stage: 'full-E01' });
    }
    (e2.every((x) => x.ok) ? rep.pass : rep.fail)('UL-E01', e2,
      '竖屏两档布局宽≈innerHeight、布局高≈innerWidth（误差 ≤4px），rail 可见', 'CDP 真实视口');
    // E05 动态切换序列
    for (const vp of [VP.portrait, VP.land844, VP.portrait]) {
      await setViewport(cdp, vp);
      await sleep(260);
      const s = await readState(cdp);
      e5.push({ key: vp.key, contract: s.contract, rotation: rotationOf(s), deg: s.contract.rotationDeg ?? s.rotatedCanvas[0]?.deg ?? 0 });
    }
    const degreesOk = e5.every((x) => {
      const d = Number(x.deg);
      return Number.isFinite(d) && (Math.abs(d) <= 5 || Math.abs(Math.abs(d) - 90) <= 5);
    });
    (degreesOk ? rep.pass : rep.fail)('UL-E05', e5,
      'portrait→landscape→portrait 每次旋转角为 0 或 ±90°，无 180° 叠加', 'CDP 真实视口动态切换');
    for (const vp of [VP.tablet, VP.desktop]) {
      await setViewport(cdp, vp);
      await sleep(260);
      const s = await readState(cdp);
      e6.push({ key: vp.key, rotation: rotationOf(s), contract: s.contract, vp: s.vp });
    }
    (e6.every((x) => !x.rotation.rotated) ? rep.pass : rep.fail)('UL-E06', e6,
      '平板 / 桌面视口不误触发 CSS 自旋转', 'CDP 真实视口');
    rep.pass('UL-E07', e7, '每档 innerWidth/Height/dpr/orientation/matchMedia 原始值已记录',
      '方法学能力，不代表任何设备布局已通过');
    await setViewport(cdp, VP.portrait);
    await sleep(250);

    // --- G07：三档横屏布局回归（对齐既有 9 PASS 基线）
    const g7 = [];
    for (const vp of LANDSCAPES) {
      await setViewport(cdp, vp);
      await sleep(260);
      const s = await readState(cdp);
      g7.push({ key: vp.key, gate: s.layout.gate, rail: s.layout.rail, boardStage: s.layout.boardStage,
        rotation: rotationOf(s) });
    }
    (g7.every((x) => x.gate?.display === 'none' && x.rail?.display !== 'none' && (x.boardStage?.w ?? 0) > 0)
      ? rep.pass : rep.fail)('UL-G07', g7,
      '三档横屏 gate 隐藏 / rail 展开 / board-stage 宽度 >0（历史 503/658/736 px 仅作参考值）', 'CDP 真实视口');
    // A-5 / A-8：三档横屏与动态切换的原始观测留痕
    rep.data.uxSupplement.cdp.landscapeViewportRows = g7;
    rep.data.uxSupplement.cdp.portraitCanvasRows = e2;
    rep.data.uxSupplement.cdp.S7S8Transitions = e5;
    rep.data.uxSupplement.cdp.tabletDesktop = e6;
    rep.data.uxSupplement.cdp.tabletDesktopNotRotated = e6.every((x) => !x.rotation.rotated);
    await setViewport(cdp, VP.portrait);
    await sleep(250);

    // --- F 组：出口不反复弹 / 可恢复 / 无副作用 / 不静默失败 / 可及性
    // 实际契约：主出口是正立层 #landscape-exit（仅 css 模式可见）；旧 #portrait-dismiss 保留但永久 hidden。
    const exitRect = await rectOf(cdp, '#landscape-exit');
    const dismissSel = exitRect && exitRect.w > 0 ? '#landscape-exit' : '#portrait-dismiss';
    const dismissBtn = await rectOf(cdp, dismissSel);
    if (!dismissBtn || dismissBtn.w <= 0) {
      for (const id of ['UL-F01', 'UL-F02', 'UL-F03', 'UL-F04', 'UL-F05']) {
        rep.blocked(id, '未找到可见的「仍按竖屏查看」出口（#landscape-exit / #portrait-dismiss 均不可点）；未写成 FAIL', { dismissBtn, exitRect });
      }
    } else {
      const click = await clickSelector(cdp, dismissSel);
      const afterDismiss = await readState(cdp);
      // 反复触发环境事件，不调用 el.click()
      for (const vp of [VP.land844, VP.portrait, VP.land667, VP.portrait]) { await setViewport(cdp, vp); await sleep(140); }
      await cdp.eval(`window.__UL_SET_ORIENTATION__ && window.__UL_SET_ORIENTATION__('portrait-primary', 0, true)`);
      await sleep(300);
      const afterBurst = await readState(cdp);
      const f1ok = afterBurst.contract.mode === 'off'
        && afterBurst.layout.gate?.dismissed === '1'
        && afterBurst.hud?.hidden === false && afterBurst.hud?.settled === true;
      (f1ok ? rep.pass : rep.fail)('UL-F01', { click, dismissSel,
        afterDismiss: { mode: afterDismiss.contract.mode, gate: afterDismiss.layout.gate, hud: afterDismiss.hud },
        afterBurst: { mode: afterBurst.contract.mode, gate: afterBurst.layout.gate, hud: afterBurst.hud },
        events: '4×resize + 1×orientationchange' },
      'dismiss 后 mode 保持 off、forced=off（gate[data-dismissed=1]）、HUD 常驻状态条可见；多次 resize / orientationchange 不复活提示',
      'CDP 真实指针 + 真实视口事件');
      // A-10：burst 之后读转向提示出现次数（一次会话应 ≤1）
      const hintAfterBurst = afterBurst.hint;
      rep.data.uxSupplement.cdp.hintAfterBurst = hintAfterBurst;
      rep.data.uxSupplement.cdp.hintBurst = { events: '4×resize + 1×orientationchange',
        shows: hintAfterBurst?.shows ?? null, coverage: hintAfterBurst?.coverage ?? null };
      // A-9 / UL-F02：找「重新铺成横屏」恢复入口并真实指针点击
      const restoreClick = await clickRestoreEntry(cdp);
      const afterRestore = await readState(cdp);
      if (!restoreClick.ok) {
        rep.blocked('UL-F02', 'dismiss 后未找到「重新铺成横屏」恢复入口（需 UX 规格确认目标控件），未写成 FAIL', { restoreClick });
      } else {
        const f2ok = rotationOf(afterRestore).rotated || afterRestore.contract.mode === 'system';
        (f2ok ? rep.pass : rep.fail)('UL-F02', { restoreClick, before: afterBurst.contract,
          after: afterRestore.contract, rotation: rotationOf(afterRestore), hint: afterRestore.hint },
        '真实点击「重新铺成横屏」后重新进入 S2 自转 / S4 锁定，且不叠加提示', 'CDP 真实指针');
      }
      rep.data.uxSupplement.cdp.S6 = { contract: afterBurst.contract, vp: afterBurst.vp,
        rotation: rotationOf(afterBurst), gate: afterBurst.layout.gate, view: afterBurst.view,
        hud: afterBurst.hud, hint: hintAfterBurst,
        copy: await scanCopy(cdp).catch((e) => ({ error: String(e) })) };
      rep.data.uxSupplement.cdp.restore = { click: restoreClick, afterContract: afterRestore.contract,
        rotation: rotationOf(afterRestore), hint: afterRestore.hint, view: afterRestore.view, hud: afterRestore.hud };
      rep.data.uxSupplement.cdp.a11yAfterDismiss = await readA11y(cdp).catch((e) => ({ error: String(e) }));
      const seatOk = st.view?.seat === afterBurst.view?.seat && st.view?.roomId === afterBurst.view?.roomId;
      const f3ok = seatOk && afterBurst.contract.mode === 'off' && afterBurst.hud?.hidden === false;
      (f3ok ? rep.pass : rep.fail)('UL-F03', { seatOk, viewBefore: st.view, viewAfter: afterBurst.view,
        mode: afterBurst.contract.mode, hud: afterBurst.hud, vp: afterBurst.vp },
      'dismiss 后座位 / 房间不变、mode=off，且 S6 正立状态条保留（连接 / 回合 / 待办不空白）', 'CDP 真实指针 + 只读视图');
      const visibleCopy = `${afterBurst.hud?.mainText ?? ''}${afterBurst.hud?.subText ?? ''}${afterBurst.hud?.statusText ?? ''}`.trim();
      const f4ok = visibleCopy.length > 0 || afterBurst.contract.mode === 'css';
      (f4ok ? rep.pass : rep.fail)('UL-F04', { copy: visibleCopy, hud: afterBurst.hud,
        contract: afterBurst.contract, probe: afterBurst.probe, toast: afterBurst.toast },
      '拒绝 / 缺失 lock 时有可见结果或自旋转生效，不静默失败、不假装成功', 'iOS 能力模拟 + 只读观测');
      rep.partial('UL-F05', { copy: visibleCopy, hud: afterBurst.hud },
        '已记录正立层文案与可见状态；「不靠颜色 / 声音 / hover 单独传递」与旋转后可读性需人工目视复核，未写成 PASS');
    }

    // --- C06：全链路错误采集
    const pageErrors = [...(cdp.errors || []), ...(st.probe?.errors ?? [])];
    (pageErrors.length === 0 ? rep.pass : rep.fail)('UL-C06', { pageErrors,
      events: ['Runtime.exceptionThrown', 'Runtime.consoleAPICalled(error)', 'unhandledrejection'] },
    '全链路无 console error / 未捕获异常 / unhandledrejection', 'CDP 日志 + 注入探针');
    rep.data.consoleErrors.push(...pageErrors.map((text) => ({ at: nowIso(), target: 'shared-main', text: String(text) })));
  } catch (e) {
    rep.error(`runSharedChecks 顶层异常: ${e.stack ?? e.message}`);
    for (const c of rep.data.checks) if (c.status === 'NOT_RUN' && !c.partialObservation) c.notes += `；共享检查未执行到：${e.message}`;
  } finally {
    if (fillers) for (const f of fillers) f.close();
    if (t) { try { await t.cdp.send('Page.close').catch(() => {}); } catch { /* ignore */ } t.cdp.close(); }
    if (pre) { try { await pre.cdp.send('Page.close').catch(() => {}); } catch { /* ignore */ } pre.cdp.close(); }
  }

  // 需其他脚本 / 人工 / 汇编补证的项，如实保持 NOT_RUN 或 BLOCKED
  rep.set('UL-G01', 'NOT_RUN', { observed: { reportedBy: 'engineering-lead', reported: '429 passed + 2 todo（engine 139+2 / protocol 20 / server 62 / web 208, 17 files）；四包 typecheck 通过；pnpm build 成功', independentlyVerifiedByQualityLead: false },
    notes: 'engineering-lead 自报 429 passed + 2 todo（旧基线 387+2 已随新增 42 条前端测试更新，属有意变更）。'
      + '本脚本不把他人自报写成实测通过；如需 quality-lead 独立复核，需单独执行 pnpm test/typecheck/build 并记录原始输出。' });
  rep.set('UL-G04', 'BLOCKED', { observed: { baseline: 'probe/phase-d-landscape-button-check.mjs', status: 'SUPERSEDED' },
    notes: 'SUPERSEDED（有意变更，非回归）：该脚本验证旧「进入横屏」主按钮必经关卡，该主路径已按 docs/17 §2.4/§4.1 废弃；'
      + '#portrait-gate 永久 hidden、#portrait-landscape 保留为可选「尝试系统横屏」。不得用其 9 PASS 证明无回归；'
      + '回归改由 apps/web/test phase-d-fix-landscape(34) + uls-landscape-hit(17) 与全仓 429 passed + 2 todo 承担。' });
  rep.notRun('UL-G05', '本脚本不重跑 phase-d-browser-verify.mjs；由主理人汇编既有报告，核对 D-* / CASE-* / EXIT-* 未新增 FAIL');
  rep.blocked('UL-D04', '真机刘海 / 圆角 / 浏览器栏 / 软键盘：本会话无 iOS 真机、Android 设备休眠且阶段一不实跑；见计划 §5');
}

/**
 * docs17 §7 A-1…A-14 统一裁定。
 * 所有输入都来自实际观测（uxSupplement.scenarios / .cdp）；没有观测就 BLOCKED / partial，
 * 绝不从「有检查项」「源码看起来实现了」推断 PASS。真机必需项由 blockRealDevice 结构性 BLOCKED。
 */
function runUxChecks(rep) {
  const S = rep.data.uxSupplement;
  const sc = S.scenarios;
  const c = S.cdp;
  const hasShared = !!c.S2;
  const status = (id) => rep.byId.get(id)?.status;
  const copyHits = (s) => (s?.copy?.forbiddenHits ?? []);
  const errorsOf = (s) => [...(s?.probe?.errors ?? []), ...(s?.consoleErrors ?? [])];
  const isModal = (s) => {
    const g = s?.gate;
    return !!g && g.display !== 'none' && g.rect
      && g.rect.w >= (s.vp?.innerWidth ?? 0) * 0.8 && g.rect.h >= (s.vp?.innerHeight ?? 0) * 0.5;
  };

  S.realDeviceNotes.push(
    'A-3 / A-4 / A-6 / A-13 的 CDP 辅助观测分别见：UL-B01/B02/B05/B06/B07/G06 的 pointerEvidence、'
    + 'UL-C01/C02 的入房 focus 观测、UL-D01/D02/D03 的安全区几何、UL-A01 的方向分支。'
    + '这些观测**不构成**真机通过；docs17 §7 与指南 §13.1 明确必须真机。');

  // --- A-1 iOS Safari 模拟
  {
    const s = sc['ios-safari'];
    if (!s) {
      rep.blocked('UL-UX01', '未取得 ios-safari 场景观测（可能被 --scenario 过滤或服务前置失败）；未写成 FAIL');
    } else {
      const obs = { rotation: s.rotationAfter, probe: s.probe, gate: s.gate, copy: s.copy,
        hint: s.hint, toast: s.toast, errors: errorsOf(s), modalGate: isModal(s) };
      const ok = !!s.rotationAfter?.rotated && errorsOf(s).length === 0
        && copyHits(s).length === 0 && !isModal(s)
        && (s.probe?.locks ?? []).length === 0 && Number(s.probe?.fullscreens ?? 0) === 0;
      (ok ? rep.pass : rep.fail)('UL-UX01', obs,
        '无 lock / 无 requestFullscreen 下直接落 S2 自转；无 unhandledrejection / console error；无全屏模态关卡；主提示无旧文案与技术黑话',
        'CDP 能力模拟；文案「逐字一致」与真机 iPhone 另由单测 / A-13 补证');
    }
  }

  // --- A-2 厂商拒绝锁定
  {
    const s = sc['vendor-lock-reject'];
    if (!s) rep.blocked('UL-UX02', '未取得 vendor-lock-reject 场景观测；未写成 FAIL');
    else {
      const obs = { rotation: s.rotationAfter, probe: s.probe, locks: s.probe?.locks,
        hint: s.hint, copy: s.copy, errors: errorsOf(s), modalGate: isModal(s) };
      const ok = !!s.rotationAfter?.rotated && errorsOf(s).length === 0
        && (s.probe?.locks ?? []).length <= 1 && (s.hint?.shows ?? 0) <= 1
        && copyHits(s).length === 0 && !isModal(s);
      (ok ? rep.pass : rep.fail)('UL-UX02', obs,
        'lock 被拒后自转保持 / 立即生效；无异常、不重试（≤1 次 lock）、转向提示 ≤1 次、不弹失败卡片',
        'CDP 能力模拟；「画面不闪」需真机目视（A-13）补证');
    }
  }

  // --- A-3 / A-4 / A-6 / A-13 保持 BLOCKED（blockRealDevice 结构性设置），此处只补充备注
  for (const id of UX_REAL_DEVICE_IDS) {
    const c0 = rep.byId.get(id);
    c0.notes += '；【CDP 辅助观测见 uxSupplement，不计入通过】';
  }

  // --- A-5 三档横屏回归
  if (!hasShared) rep.blocked('UL-UX05', '未运行共享视口检查（--scenario 单场景模式）；未写成 FAIL');
  else {
    const rows = c.landscapeViewportRows ?? [];
    const canvas = c.portraitCanvasRows ?? [];
    const rowsOk = rows.length === 3 && rows.every((r) => r.gate?.display === 'none'
      && r.rail?.display !== 'none' && (r.boardStage?.w ?? 0) > 0 && !r.rotation?.rotated);
    const canvasOk = canvas.length === 2 && canvas.every((r) => r.ok);
    const obs = { landscapeRows: rows, portraitCanvasRows: canvas,
      referenceStageWidths: [503, 658, 736], referenceNote: '历史值仅作参考，不作硬性判据',
      horizontalScroll: c.S2?.vp ? null : null, relatedChecks: ['UL-E02', 'UL-E03', 'UL-E04', 'UL-E01', 'UL-G07'],
      relatedStatus: ['UL-E02', 'UL-E03', 'UL-E04', 'UL-E01', 'UL-G07'].map((id) => ({ id, status: status(id) })) };
    (rowsOk && canvasOk ? rep.pass : rep.fail)('UL-UX05', obs,
      '三档横屏 gate 隐藏 / rail 展开 / stage 宽度 >0 / 不重复旋转；竖屏两档自转画布铺满；无黑边 / 中间竖条需截图人工复核',
      'CDP 真实视口 + 人工；503/658/736 为 docs16 §1.2 参考值');
  }

  // --- A-7 阶段迁移
  if (!hasShared) rep.blocked('UL-UX07', '未运行共享阶段迁移检查；未写成 FAIL');
  else {
    const s0 = c.S0, s2 = c.S2;
    const s0ok = !s0?.rotation?.rotated && (s0?.view === null || !s0?.view?.phase);
    const s2ok = !!s2?.rotation?.rotated && !!s2?.view?.phase;
    rep.partial('UL-UX07', { S0: s0, S2: s2, s0ok, s2ok,
      covered: ['LOBBY→STATE（S0→S2）'],
      missing: ['带 view 的 WELCOME 恢复路径（需重连快照场景）', '对局结束页→「回到房间」退出自转（需完整对局）'],
      related: [{ id: 'UL-C03', status: status('UL-C03') }] },
    'S0→S2 已实测；WELCOME 带 view 恢复与「回到房间」链路需阶段二造重连 / 结束态补跑，未写成 PASS');
  }

  // --- A-8 状态机 S0–S8 共 9 态
  {
    const observed = {
      S0: !!c.S0, S1: false, S2: !!c.S2, S3: false,   // S1/S3 为瞬时态，CDP 不采样，交单测
      S4: !!sc['system-lock-success'] && !sc['system-lock-success'].rotationAfter?.rotated,
      S5: !!sc['vendor-lock-reject'] && !!sc['vendor-lock-reject'].rotationAfter?.rotated,
      S6: !!c.S6, S7: (c.S7S8Transitions ?? []).some((x) => x.key === '844x390' && !x.rotation?.rotated),
      S8: (c.S7S8Transitions ?? []).some((x) => x.key === '390x844' && !!x.rotation?.rotated),
    };
    const count = Object.values(observed).filter(Boolean).length;
    rep.partial('UL-UX08', { stateTable: 'docs17 §3.1（S0–S8 共 9 态，非 S0–S9）',
      observed, observedCount: count, scenarios: Object.keys(sc), S7S8Transitions: c.S7S8Transitions,
      missing: ['S1 瞬时/兜底态（同帧迁移，CDP 无法稳定采样）',
        'S3 超时按 S5（需可控时钟 / pending Promise 上限断言）',
        'forced / hintShown 记忆位的逐态核对需单测状态迁移表'],
      note: 'S7/S8 不播提示、S1 不得停留、S3 不得阻断操作，须由单测 + 人工检查表补证' },
    `${count}/9 态取得运行时观测；S1 瞬时态与 S3 超时分支需单测补证，未写成 PASS`);
  }

  // --- A-9 出口与恢复
  if (!hasShared || !c.restore) rep.blocked('UL-UX09', '未运行共享出口 / 恢复检查；未写成 FAIL');
  else {
    const a11y = c.a11y ?? {};
    const restoreOk = c.restore.click?.ok === true && (c.restore.rotation?.rotated || c.restore.afterContract?.mode === 'system');
    const sizeOk = (a11y.under44 ?? []).length === 0 && (a11y.minW ?? 0) >= 44 && (a11y.minH ?? 0) >= 44;
    const s6HasInfo = (c.S6?.copy?.combined ?? '').length > 0 || !!c.S6?.view?.phase;
    const noStack = (c.restore.hint?.shows ?? 0) <= 1;
    const ok = restoreOk && sizeOk && s6HasInfo && noStack;
    (ok ? rep.pass : rep.fail)('UL-UX09', { restore: c.restore, a11y: { minW: a11y.minW, minH: a11y.minH, under44: a11y.under44 },
      S6: { copy: c.S6?.copy, view: c.S6?.view, gate: c.S6?.gate }, focusAfterTab: c.focusAfterTab,
      keyboardReachable: '仅派发一次真实 Tab 键，完整键盘可达顺序需人工检查表' },
    '「重新铺成横屏」真实可点并回到 S2；关键按钮实测 ≥44×44；S6 保留连接/回合/待办信息；恢复不叠加提示',
    'CDP 真实指针 + 真实键盘；屏幕阅读器与完整键盘顺序需人工补证');
  }

  // --- A-10 不反复弹出 / 会话记忆
  {
    const burst = c.hintBurst;
    const obs = { burst, hintBeforeBurst: c.hintBeforeBurst, hintAfterBurst: c.hintAfterBurst,
      coverage: burst?.coverage ?? null,
      covered: ['≥3 次 resize / orientationchange（本脚本 4×resize + 1×orientationchange）'],
      missing: ['S7↔S8 多次来回（部分覆盖，见 S7S8Transitions）', '切后台再回来（浏览器生命周期）',
        '临时接电话回来（真机）', '刷新后视为新会话可再出现 1 次（需 reload 场景）'],
      importantCaveat: 'docs17 §2.3：系统方向锁死时前端拿不到用户是否已物理横过来，提示只能「一次 + 淡出 + 可关 + 会话记忆」；**不得把「提示应自动消失」写成通过条件**' };
    if (!burst || burst.coverage !== true) {
      rep.partial('UL-UX10', obs, '提示计数器未覆盖到候选选择器或共享检查未运行；需确认实现的选择器后补跑，未写成 PASS');
    } else if ((burst.shows ?? 0) > 1) {
      rep.fail('UL-UX10', obs, '一次页面会话内转向提示最多出现 1 次', '真实 resize / orientationchange 事件下的 MutationObserver 计数');
    } else {
      rep.partial('UL-UX10', obs, `CDP 部分实测提示出现 ${burst.shows ?? 0} 次（≤1）；切后台 / 接电话 / 刷新重置需真机与生命周期场景补跑，未写成 PASS`);
    }
  }

  // --- A-11 可访问性
  if (!hasShared || !c.a11y) rep.blocked('UL-UX11', '未运行共享可访问性量测；未写成 FAIL');
  else {
    const a = c.a11y;
    const measured = { tap44: (a.minW ?? 0) >= 44 && (a.minH ?? 0) >= 44,
      font12: (a.minFontPx ?? 0) >= 12, contrast45: (a.minContrast ?? 0) >= 4.5,
      ariaLivePresent: (a.ariaLive ?? []).length > 0,
      focusVisible: !!c.focusAfterTab && c.focusAfterTab.outlineStyle !== 'none',
      reduceMotionAttr: a.reduceMotionAttr, reduceMotionMedia: a.reduceMotionMedia };
    rep.partial('UL-UX11', { measured, a11y: { minW: a.minW, minH: a.minH, minFontPx: a.minFontPx,
      minContrast: a.minContrast, under44: a.under44, ariaLive: a.ariaLive, focus: c.focusAfterTab,
      textSamples: (a.textSamples ?? []).slice(0, 12) },
      missing: ['aria-live 关键态各播一次 / S7-S8 不播（需事件计数）',
        '两种减少动效开关的实际切换效果', '屏幕阅读器播报与旋转后中文文字真机渲染'],
      note: '对比度为 CDP 页面内 computed color 采样估算，非真机屏幕实测' },
    '已实测按钮 rect / 字号 / 对比度 / aria-live / 焦点 / 减少动效标记；播报次数、开关效果与真机文字渲染需人工 + 真机补证，未写成 PASS');
  }

  // --- A-12 降级三分支文案
  {
    const branches = [
      { key: '① API 缺失', id: 'vendor-api-absent' },
      { key: '② 请求被拒', id: 'vendor-lock-reject' },
      { key: '③ 无法区分 / Promise 超时', id: 'degrade-undistinguishable' },
    ].map((b) => { const s = sc[b.id];
      return { key: b.key, scenario: b.id, present: !!s,
        copy: s?.copy ?? null, rotation: s?.rotationAfter ?? null, hint: s?.hint ?? null }; });
    const allPresent = branches.every((b) => b.present);
    const allHaveText = branches.every((b) => (b.copy?.combined ?? '').length > 0);
    const forbidden = branches.flatMap((b) => (b.copy?.forbiddenHits ?? []).map((f) => `${b.key}: ${f}`));
    const obs = { branches, forbidden, spec: 'docs17 §6.2 三条建议文案（待用户拍板 C3）',
      checked: '旧主提示 / 技术黑话禁用 + 三分支均有可见文案',
      notChecked: '逐字一致断言（需 C3 定稿后由单测实现）' };
    if (!allPresent) rep.blocked('UL-UX12', '三分支场景未全部执行（可能被 --scenario 过滤）；未写成 FAIL', obs);
    else if (forbidden.length) rep.fail('UL-UX12', obs,
      '不得出现「请检查系统旋转锁定设置」「请手动把手机横过来」等旧主提示与技术黑话', '三分支真实文案扫描');
    else if (!allHaveText) rep.fail('UL-UX12', obs, '三分支均须有可见降级文案（不静默失败）', '三分支真实文案扫描');
    else rep.partial('UL-UX12', obs,
      '三分支均有可见文案且未出现禁用旧提示；逐字一致断言待 C3 文案定稿后由单测补证，未写成 PASS');
  }

  // --- A-14 指南 4.2 依赖剥离（运行时）
  {
    const s = sc['ios-safari'];
    const pointer = ['UL-B01', 'UL-B02', 'UL-B05', 'UL-B06'].map((id) => ({ id, status: status(id) }));
    const runtimeOk = !!s?.rotationAfter?.rotated && (s.probe?.locks ?? []).length === 0
      && Number(s.probe?.fullscreens ?? 0) === 0 && errorsOf(s).length === 0;
    const obs = { runtimeApiStripped: s?.mock ?? null, rotation: s?.rotationAfter ?? null,
      probe: s?.probe ?? null, pointerChecks: pointer,
      staticReview: '指南 4.2 原文未修改（docs17 §8.3）；静态评审由主理人汇编',
      missing: '完整「入房→摆位→一次建造/交易」链路需阶段二补跑' };
    if (!s) rep.blocked('UL-UX14', '未取得 ios-safari（API 剥离）场景观测；未写成 FAIL');
    else if (runtimeOk && pointer.some((p) => p.status === 'PASS')) {
      rep.pass('UL-UX14', obs,
        '运行时禁用 lock + requestFullscreen 后自转仍生效、无异常，且真实指针可完成棋盘 / 缩放操作',
        'CDP 能力模拟 + 真实指针；静态评审与完整链路另行补证');
    } else {
      rep.partial('UL-UX14', obs,
        '运行时 API 剥离已注入；自转与真实指针操作未全部取得可判定观测，需阶段二补跑，未写成 PASS');
    }
  }
  rep.note('UL-UX01..14 已按 docs17 §7 逐条裁定：真机必需项 A-3/A-4/A-6/A-13 保持 BLOCKED；CDP 辅助观测只记入 uxSupplement。');
}

async function fullMode(ctx) {
  const { rep } = ctx;
  rep.data.run.fullModeExecuted = true;
  ctx.services = new Services(rep);
  await ctx.services.start();
  const selected = CFG.scenario ? SCENARIOS.filter((s) => s.id === CFG.scenario) : SCENARIOS;
  if (CFG.scenario && !selected.length) throw new Error(`未知 --scenario=${CFG.scenario}；可用: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  for (const sc of selected) await runScenario(ctx, sc);
  if (!CFG.scenario || CFG.scenario === 'system-lock-success') await runSystemUnlock(ctx);
  if (!CFG.scenario) await runSharedChecks(ctx);
  runUxChecks(rep);   // docs17 §7 A-1…A-14 统一裁定（初始 NOT_RUN，只按实际观测落状态）
  rep.note(`full 模式已执行场景: ${selected.map((s) => s.id).join(', ')}；真机项仍为 BLOCKED。`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const rep = new Reporter({
    mode: CFG.mode,
    phase: CFG.mode === 'capability-only' ? 1 : 2,
    fullModeExecuted: false,
    strictPolicy: '用户最严格口径：浏览器真实指针复验 + 真机证据缺一不可；CDP 能力模拟 / 模拟视口 / 单测 / jsdom 不得冒充真机通过。',
    chrome: CFG.chrome, chromeVersion: null,
    cdpPort: CFG.cdpPort, backendPort: CFG.backendPort, vitePort: CFG.vitePort,
    baseUrl: CFG.baseUrl || null, room: ROOM, players: CFG.players,
    allowInference: CFG.allowInference,
    // 2026-11-08 实现交付后登记：旧「进入横屏」主按钮基线已 superseded，不得当作回归通过
    supersededBaselines: [
      {
        baseline: 'probe/phase-d-landscape-button-check.mjs 9 PASS / 0 FAIL',
        status: 'SUPERSEDED',
        reason: '该脚本验证的是旧「进入横屏」主按钮必经关卡；docs/17 §2.4/§4.1 已废弃该主路径，'
          + '#portrait-gate 永久 hidden、#portrait-landscape 仅保留为「尝试系统横屏（可选）」。'
          + '不得用其 PASS 证明无回归；回归基线改以 apps/web/test（phase-d-fix-landscape 34 条 + uls-landscape-hit 17 条）与全仓 429 passed + 2 todo 为准。',
      },
    ],
    node: process.version, platform: process.platform,
    environmentNotes: [],
    commands: {
      capabilityOnly: 'node probe/phase-d-universal-landscape-check.mjs --mode=capability-only',
      full: 'node probe/phase-d-universal-landscape-check.mjs --mode=full --shots',
    },
  });
  const ctx = { rep, targets: [], services: null, chrome: null, profile: null };
  const cleanup = { chromeKilled: false, servicesStopped: false, targetsClosed: 0, profileRemoved: false, notes: [] };

  try {
    ctx.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hexfront-ul-verify-'));
    const chromeArgs = [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-extensions', '--no-first-run', '--no-default-browser-check',
      '--no-proxy-server', '--proxy-bypass-list=*', '--remote-allow-origins=*',
      '--disable-background-networking', '--disable-component-update', '--hide-scrollbars',
      `--remote-debugging-port=${CFG.cdpPort}`, `--user-data-dir=${ctx.profile}`, 'about:blank',
    ];
    ctx.chrome = spawn(CFG.chrome, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    ctx.chrome.stdout?.on('data', () => {});
    ctx.chrome.stderr?.on('data', () => {});
    ctx.chrome.on('error', (e) => rep.error(`chrome spawn: ${e.message}`));
    rep.note('Chrome 启动参数含 --no-proxy-server；CDP HTTP 用 node:http 直连 127.0.0.1，绕开 HTTP_PROXY。');
    rep.note('已知噪声：CVDisplayLinkCreateWithCGDisplay failed / Trying to load the allocator multiple times，不影响使用。');
    if (CFG.mode === 'capability-only') await capabilityMode(ctx);
    else await fullMode(ctx);
  } catch (e) {
    rep.error(`顶层异常: ${e.stack ?? e.message}`);
    rep.note(`顶层异常: ${e.message}`);
    for (const c of rep.data.checks) {
      if (c.status === 'NOT_RUN') c.notes += `；顶层异常导致未执行：${e.message}`;
    }
  } finally {
    for (const t of ctx.targets) { try { t.cdp.close(); cleanup.targetsClosed += 1; } catch { /* ignore */ } }
    if (ctx.services) { try { await ctx.services.stop(); cleanup.servicesStopped = true; } catch (e) { rep.error(`服务停止异常: ${e.message}`); } }
    if (ctx.chrome) {
      try { ctx.chrome.kill('SIGTERM'); cleanup.chromeKilled = true; } catch { /* ignore */ }
      await sleep(350);
      if (ctx.chrome.exitCode === null) { try { ctx.chrome.kill('SIGKILL'); } catch { /* ignore */ } }
    }
    if (ctx.profile && !CFG.keepProfile) {
      try { fs.rmSync(ctx.profile, { recursive: true, force: true }); cleanup.profileRemoved = true; }
      catch (e) { cleanup.notes.push(`profile 清理失败: ${e.message}`); }
    } else if (CFG.keepProfile) cleanup.notes.push(`保留 profile: ${ctx.profile}`);

    (cleanup.chromeKilled && cleanup.targetsClosed >= ctx.targets.length && (CFG.keepProfile || cleanup.profileRemoved)
      ? rep.pass : rep.fail)('UL-ENV-03', { ...cleanup, spawnedTargets: ctx.targets.length },
      '测完关闭服务 / target / Chrome，清理本脚本自建临时 profile',
      CFG.mode === 'capability-only' ? 'capability-only 未启动服务' : 'full 模式服务已在 finally 停止');

    blockRealDevice(rep);
    rep.finish(cleanup);
    console.log(`[universal-landscape] mode=${CFG.mode} 报告: ${path.relative(ROOT, CFG.out || REPORT_PATH)}`);
    console.log(`[universal-landscape] ${JSON.stringify(rep.data.summary.byStatus)} gate=${rep.data.summary.gate}`);
    for (const c of rep.data.capabilities) console.log(`  CAP ${c.id}: ${c.status}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
