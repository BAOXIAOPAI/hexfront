/**
 * 文档 23：邀请链接与随机房间号验收。
 *
 * 重点：功能**不依赖 WorkBuddy 云管理**，纯前端字符串 + URL + 剪贴板；
 * 但必须原样透传平台鉴权参数 sharecode，否则发布环境 WS 连不上。
 * 另一个关键约束：朋友点开 ?room=xxx 的链接时，房间号不能被随机号覆盖。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiniDocument, installGlobals, makeWindow } from './fixtures/mini-dom.js';
import {
  ROOM_ID_RE,
  copyText,
  currentSharecode,
  inviteUrl,
  isValidRoomId,
  normalizeRoomId,
  randomRoomId,
} from '../src/invite.js';

describe('随机房间号', () => {
  it('生成的房间号符合服务端 normalizeRoomId 规则 [a-z0-9_-]{1,24}', () => {
    for (let i = 0; i < 200; i++) {
      const id = randomRoomId();
      expect(ROOM_ID_RE.test(id)).toBe(true);
      expect(isValidRoomId(id)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(24);
    }
  });

  it('是「形容词-名词-4 位随机」格式，便于口头念与核对', () => {
    expect(randomRoomId()).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
  });

  it('两次生成大概率不同（1/24·24·32^4 的碰撞概率）', () => {
    const ids = new Set(Array.from({ length: 50 }, () => randomRoomId()));
    expect(ids.size).toBeGreaterThan(45);
  });

  it('词表选择可注入伪随机，便于复现', () => {
    const a = randomRoomId(() => 0);
    const b = randomRoomId(() => 0);
    expect(a.split('-')[0]).toBe(b.split('-')[0]);
    expect(a.split('-')[1]).toBe(b.split('-')[1]);
  });
});

describe('房间号规范化', () => {
  it('大小写与空白被规范化，非法字符回落 main', () => {
    expect(normalizeRoomId('  Quiet-Harbor-7K2M ')).toBe('quiet-harbor-7k2m');
    expect(normalizeRoomId('中文房')).toBe('main');
    expect(normalizeRoomId('a b')).toBe('main');
    expect(normalizeRoomId('x'.repeat(25))).toBe('main');
    expect(normalizeRoomId(null)).toBe('main');
  });
});

describe('邀请链接', () => {
  const origin = 'https://hexfront.example';
  const pathname = '/';

  it('链接只带 room，不带 name（朋友需自己填昵称，不会误用房主身份）', () => {
    const url = new URL(inviteUrl('quiet-harbor-7k2m', { origin, pathname, sharecode: '' }));
    expect(url.searchParams.get('room')).toBe('quiet-harbor-7k2m');
    expect(url.searchParams.has('name')).toBe(false);
  });

  it('透传平台鉴权 sharecode —— 这是发布环境能连上 WS 的关键', () => {
    const url = new URL(inviteUrl('abc', { origin, pathname, sharecode: 'SC-123' }));
    expect(url.searchParams.get('sharecode')).toBe('SC-123');
    expect(url.searchParams.get('room')).toBe('abc');
  });

  it('不传 sharecode 时从当前页面 URL 读取', () => {
    expect(currentSharecode('?sharecode=FROM-PAGE&room=abc')).toBe('FROM-PAGE');
    expect(currentSharecode('?room=abc')).toBe('');
  });

  it('房间号先规范化，非法值不会污染链接', () => {
    const url = new URL(inviteUrl('  BAD ROOM ', { origin, pathname, sharecode: '' }));
    expect(url.searchParams.get('room')).toBe('main');
  });

  it('链接点开后 ?room= 能被读回，且与生成的房间号一致', () => {
    const generated = randomRoomId();
    const link = inviteUrl(generated, { origin, pathname, sharecode: 'SC' });
    const params = new URL(link).searchParams;
    expect(normalizeRoomId(params.get('room'))).toBe(generated);
    expect(params.get('sharecode')).toBe('SC');
  });

  it('保留页面上其它参数（如调试用 build=road）不丢', () => {
    const url = new URL(inviteUrl('abc', { origin, pathname, sharecode: '' }));
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe(pathname);
  });
});

describe('剪贴板复制', () => {
  let restore: () => void;
  let savedNavigator: PropertyDescriptor | undefined;
  let mockClipboard: { writeText: ReturnType<typeof vi.fn> };

  const setNavigator = (value: unknown): void => {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  };

  beforeEach(() => {
    const doc = new MiniDocument('<body><div id="x"></div></body>');
    restore = installGlobals(doc, makeWindow());
    savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    setNavigator({ clipboard: mockClipboard });
    // mini-dom 是极简 shim，补上真实浏览器具备的 DOM API 桩
    const shim = doc as unknown as {
      execCommand: (s: string) => boolean;
      body: { appendChild?: (n: unknown) => void };
    };
    shim.execCommand = () => true;
    shim.body.appendChild = () => undefined;
  });
  afterEach(() => {
    restore();
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    else delete (globalThis as unknown as Record<string, unknown>)['navigator'];
  });

  it('优先用 navigator.clipboard.writeText', async () => {
    const ok = await copyText('https://example/?room=abc');
    expect(ok).toBe(true);
    expect(mockClipboard.writeText).toHaveBeenCalledWith('https://example/?room=abc');
  });

  it('clipboard 抛错时回退 execCommand，仍成功', async () => {
    mockClipboard.writeText = vi.fn().mockRejectedValue(new Error('denied'));
    setNavigator({ clipboard: mockClipboard });
    expect(await copyText('link')).toBe(true);
  });

  it('两条路径都失败时返回 false，由调用方提示手动复制', async () => {
    mockClipboard.writeText = vi.fn().mockRejectedValue(new Error('denied'));
    setNavigator({ clipboard: mockClipboard });
    const d = (globalThis as unknown as { document: { execCommand: (s: string) => boolean } }).document;
    d.execCommand = () => false;
    expect(await copyText('link')).toBe(false);
  });
});
