import { describe, expect, it } from 'vitest';
import { wsUrlFor } from '../src/net.js';

describe('WS 连接地址', () => {
  it('开发期与发布期走同一个路径 /ws（两边配置不同，路径必须一致）', () => {
    expect(wsUrlFor({ origin: 'http://localhost:5173' })).toBe('ws://localhost:5173/ws');
    expect(wsUrlFor({ origin: 'https://game.example.com' })).toBe('wss://game.example.com/ws');
  });

  it('sharecode 必须原样带上（平台反向代理靠它鉴权）', () => {
    expect(wsUrlFor({ origin: 'https://game.example.com', sharecode: 'OE7OJUOCS2' })).toBe(
      'wss://game.example.com/ws?sharecode=OE7OJUOCS2',
    );
  });

  it('https 页面自动用 wss，避免浏览器拦混合内容', () => {
    expect(wsUrlFor({ origin: 'https://a.b.c:8443' }).startsWith('wss://')).toBe(true);
    expect(wsUrlFor({ origin: 'http://a.b.c:8443' }).startsWith('ws://')).toBe(true);
  });

  it('保留端口，局域网 IP 直连时才不会连错机器', () => {
    expect(wsUrlFor({ origin: 'http://192.168.0.100:4173' })).toBe('ws://192.168.0.100:4173/ws');
  });

  it('空 sharecode 不产生空参数', () => {
    expect(wsUrlFor({ origin: 'https://x.y', sharecode: '  ' })).toBe('wss://x.y/ws');
  });
});
