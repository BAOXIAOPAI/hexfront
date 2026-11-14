/**
 * 文档 23：邀请链接与随机房间号。
 *
 * 架构说明（重要）：**不依赖 WorkBuddy 云管理，也不需要服务端改动**。
 * 房间只是服务端内存里的 Map<roomId, Room>，房间号就是 URL 上的 ?room=，
 * 由 normalizeRoomId 校验 ^[a-z0-9_-]{1,24}$。所以：
 *   - 随机房间号 = 前端生成一小串合法字符
 *   - 复制链接 = 拼 ?room=xxx（并原样透传平台鉴权参数 sharecode）
 *   - 朋友点开链接 = main.ts 读 ?room= 预填表单，只需填昵称即可加入
 *
 * 唯一与平台相关的是 sharecode：发布环境反向代理靠它鉴权 WS 连接，
 * 复制链接时必须带上，否则朋友打开页面连不上服务端。本地开发没有该参数，
 * 链接里自然不带，行为一致。
 */

/** 服务端 normalizeRoomId 的规则；生成时必须自己先遵守，避免被回退成 main */
export const ROOM_ID_RE = /^[a-z0-9_-]{1,24}$/;

export function isValidRoomId(raw: string): boolean {
  return ROOM_ID_RE.test(raw.trim().toLowerCase());
}

export function normalizeRoomId(raw: string | null): string {
  const id = (raw ?? '').trim().toLowerCase();
  return ROOM_ID_RE.test(id) ? id : 'main';
}

// 词表刻意选短、好念、无歧义的英文单词（房间号常需要口头念给朋友）
const ADJECTIVES = [
  'quiet', 'sunny', 'amber', 'brisk', 'calm', 'clever', 'cozy', 'dawn',
  'eager', 'fair', 'gentle', 'golden', 'happy', 'lucky', 'merry', 'noble',
  'olive', 'plain', 'rapid', 'sage', 'shy', 'soft', 'tidy', 'warm',
];
const NOUNS = [
  'harbor', 'meadow', 'river', 'forest', 'island', 'valley', 'cabin', 'orchard',
  'lagoon', 'prairie', 'cove', 'grove', 'ridge', 'brook', 'dune', 'maple',
  'cedar', 'willow', 'pebble', 'lantern', 'compass', 'anchor', 'kite', 'shell',
];
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 去掉易混淆的 l/1/o/0

export interface RngLike {
  (): number;
}

/** 用 crypto.getRandomValues 生成随机字节；测试可注入伪随机函数 */
function defaultRng(byteCount: number): Uint8Array {
  const out = new Uint8Array(byteCount);
  const c = (globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < byteCount; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function pick<T>(arr: readonly T[], random: RngLike = Math.random): T {
  return arr[Math.floor(random() * arr.length)]!;
}

/**
 * 生成一个随机房间号：形容词-名词-4 位随机字符，例如 `quiet-harbor-7k2m`。
 * 长度恒定 ≤ 24，符合服务端规则，且比纯哈希好念、好核对。
 */
export function randomRoomId(random: RngLike = Math.random): string {
  const bytes = defaultRng(4);
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    // 用系统随机字节，避免 Math.random 可预测；注入的 random 只用于词表选择
    suffix += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  const id = `${pick(ADJECTIVES, random)}-${pick(NOUNS, random)}-${suffix}`.toLowerCase();
  if (!isValidRoomId(id)) throw new Error(`生成的房间号非法: ${id}`);
  return id;
}

/** 当前页面的 sharecode（平台鉴权参数），没有则为空 */
export function currentSharecode(search = location.search): string {
  return new URLSearchParams(search).get('sharecode')?.trim() ?? '';
}

/**
 * 构造邀请链接：只带 room（和平台鉴权 sharecode），不带 name。
 * 这样朋友点开后只需填自己的昵称，不会误用房主身份。
 */
export function inviteUrl(roomId: string, opts: {
  origin?: string;
  pathname?: string;
  sharecode?: string;
} = {}): string {
  const origin = opts.origin ?? location.origin;
  const pathname = opts.pathname ?? location.pathname;
  const url = new URL(pathname, origin);
  const clean = normalizeRoomId(roomId);
  url.searchParams.set('room', clean);
  const code = opts.sharecode === undefined ? currentSharecode() : opts.sharecode.trim();
  if (code) url.searchParams.set('sharecode', code);
  return url.toString();
}

/**
 * 复制文本到剪贴板。优先 navigator.clipboard（需安全上下文），
 * 失败回退到 execCommand('copy')，再失败返回 false 让调用方提示手动复制。
 */
export async function copyText(text: string): Promise<boolean> {
  const nav = globalThis as unknown as {
    navigator?: { clipboard?: { writeText?: (s: string) => Promise<void> } };
  };
  try {
    if (nav.navigator?.clipboard?.writeText) {
      await nav.navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 继续回退 */ }
  try {
    const g = globalThis as unknown as {
      document?: {
        createElement?: (tag: string) => {
          value: string; setAttribute?: (k: string, v: string) => void;
          style?: Record<string, string>; select?: () => void;
          parentNode?: { removeChild?: (n: unknown) => void }; remove?: () => void;
        };
        body?: { appendChild?: (n: unknown) => void };
        execCommand?: (cmd: string) => boolean;
      };
    };
    const doc = g.document;
    if (!doc?.createElement || !doc.body?.appendChild) return false;
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute?.('readonly', '');
    if (ta.style) { ta.style.position = 'fixed'; ta.style.opacity = '0'; }
    doc.body.appendChild(ta);
    ta.select?.();
    const ok = doc.execCommand?.('copy') ?? false;
    if (ta.remove) ta.remove();
    else ta.parentNode?.removeChild?.(ta);
    return ok;
  } catch {
    return false;
  }
}
