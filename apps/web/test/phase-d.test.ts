/**
 * 阶段 D 前端单测（指南 13.3）：候选消歧、坐标转换、权限呈现、草稿失效、给/要视角转换。
 * 测的都是实际运行代码里的纯函数，不是复制品。
 */

import { describe, expect, it } from 'vitest';
import type { PlayerView, ResourceCount } from '@hexfront/engine';
import {
  AMBIGUITY_PX, DRAG_THRESHOLD_PX, MAX_HIT_PX, MAX_ZOOM, MIN_ZOOM,
  candidateStillValid, makeProjection, panForZoomAround, resolveHits,
  type BoardCandidate, type CameraBox, type Hit,
} from '../src/camera.js';
import { offerPerspective, offerTargets } from '../src/panels.js';

const BOX: CameraBox = { x: 0, y: 0, width: 1000, height: 800 };
const W = 800;
const H = 600;

function cand(key: string, x = 0, y = 0): BoardCandidate {
  return { key, kind: 'vertex', x, y, label: key };
}
function hit(key: string, dist: number): Hit {
  return { candidate: cand(key), dist };
}

function stubView(over: Partial<PlayerView> = {}): PlayerView {
  const me = {
    index: 0, name: '我', color: 'red' as const, handSize: 0, devCardCount: 0,
    playedKnights: 0, score: 0,
    resources: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 } as ResourceCount,
    devCards: [],
  };
  return {
    viewer: 0, phase: 'play', current: 0, turn: 1, hasRolled: false,
    dice: null, winner: null,
    tiles: [], ports: [], buildings: {}, roads: {}, robberTile: '',
    players: [0, 1, 2, 3].map((i) => ({
      index: i, name: `P${i}`, color: 'red' as const, handSize: 0,
      devCardCount: 0, playedKnights: 0, score: 0,
    })),
    me, scores: [0, 0, 0, 0],
    longestRoad: null, largestArmy: null, devDeckCount: 25, setup: null,
    pendingDiscards: [], pendingRobber: false,
    ...over,
  } as PlayerView;
}

describe('相机坐标转换（指南 5.1 / 13.3）', () => {
  it('zoom=1 / pan=0 时 viewBox 与 scene 原始包围盒同心，且地图完整可见', () => {
    const proj = makeProjection(BOX, W, H, 1, 0, 0);
    const vb = proj.viewBox();
    expect(vb.x + vb.w / 2).toBeCloseTo(BOX.x + BOX.width / 2, 6);
    expect(vb.y + vb.h / 2).toBeCloseTo(BOX.y + BOX.height / 2, 6);
    expect(vb.w * proj.scale).toBeCloseTo(W, 6);
    expect(vb.h * proj.scale).toBeCloseTo(H, 6);
    expect(vb.w).toBeGreaterThanOrEqual(BOX.width);
    expect(vb.h).toBeGreaterThanOrEqual(BOX.height);
  });

  it('worldToScreen 与 screenToWorld 互为逆运算（含缩放与平移）', () => {
    for (const [zoom, panX, panY] of [[1, 0, 0], [2.4, 37, -18], [1.3, -120, 66]] as const) {
      const proj = makeProjection(BOX, W, H, zoom, panX, panY);
      for (const p of [{ x: 0, y: 0 }, { x: 500, y: 400 }, { x: 123.5, y: 777 }]) {
        const back = proj.screenToWorld(proj.worldToScreen(p));
        expect(back.x).toBeCloseTo(p.x, 6);
        expect(back.y).toBeCloseTo(p.y, 6);
      }
    }
  });

  it('默认相机把地图中心放在视口中心；pan 直接偏移屏幕像素', () => {
    const center = { x: BOX.x + BOX.width / 2, y: BOX.y + BOX.height / 2 };
    const a = makeProjection(BOX, W, H, 1, 0, 0).worldToScreen(center);
    expect(a).toEqual({ x: W / 2, y: H / 2 });
    const b = makeProjection(BOX, W, H, 1, 25, -10).worldToScreen(center);
    expect(b).toEqual({ x: W / 2 + 25, y: H / 2 - 10 });
  });

  it('缩放围绕手势中心：该点对应的世界坐标在缩放前后落回同一屏幕位置', () => {
    const zoom = 1;
    const before = makeProjection(BOX, W, H, zoom, 0, 0);
    const screen = { x: 220, y: 145 };
    const world = before.screenToWorld(screen);
    const nextZoom = 2;
    const pan = panForZoomAround(world, screen, BOX, W, H, nextZoom);
    const after = makeProjection(BOX, W, H, nextZoom, pan.panX, pan.panY);
    const s = after.worldToScreen(world);
    expect(s.x).toBeCloseTo(screen.x, 6);
    expect(s.y).toBeCloseTo(screen.y, 6);
    expect(after.scale).toBeCloseTo(before.scale * nextZoom, 6);
  });

  it('缩放范围有上下限，阈值以 CSS px 定义', () => {
    expect(MIN_ZOOM).toBe(1);
    expect(MAX_ZOOM).toBeGreaterThan(1);
    expect(DRAG_THRESHOLD_PX).toBe(8);
  });
});

describe('最近候选与歧义消歧（指南 5.2 / 13.3）', () => {
  it('空列表或超出最大命中距离都视为无命中', () => {
    expect(resolveHits([]).kind).toBe('none');
    expect(resolveHits([hit('a', MAX_HIT_PX + 0.1)]).kind).toBe('none');
  });

  it('只有一个近候选时直接选中，不替用户挑别的', () => {
    const r = resolveHits([hit('v1', 3), hit('v2', MAX_HIT_PX + 5)]);
    expect(r.kind).toBe('single');
    if (r.kind === 'single') expect(r.first.key).toBe('v1');
  });

  it('两名候选都很近且差距小于阈值 → 交给用户明确选', () => {
    const r = resolveHits([hit('v1', 10), hit('v2', 10 + AMBIGUITY_PX - 1)]);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.first.key).toBe('v1');
      expect(r.second.key).toBe('v2');
    }
  });

  it('差距达到阈值就取最近的那个，不弹候选', () => {
    const r = resolveHits([hit('v1', 4), hit('v2', 4 + AMBIGUITY_PX)]);
    expect(r.kind).toBe('single');
    if (r.kind === 'single') expect(r.first.key).toBe('v1');
  });

  it('收到权威更新后失效的本地选点会被判定为无效', () => {
    const list = [cand('v1'), cand('v2')];
    expect(candidateStillValid(list, 'v2')).toBe(true);
    expect(candidateStillValid(list, 'v9')).toBe(false);
    expect(candidateStillValid(list, null)).toBe(false);
  });
});

describe('报价视角与权限呈现（指南 7.1 / 7.4 / 13.3）', () => {
  const offer = {
    from: 1, to: 0, give: { wood: 2 }, get: { wheat: 1 },
  };

  it('收件人视角：发起人的 give 是「我收到」，get 是「我付出」', () => {
    const p = offerPerspective(offer, 0);
    expect(p.mine).toBe(true);
    expect(p.own).toBe(false);
    expect(p.iGet).toEqual({ wood: 2 });
    expect(p.iGive).toEqual({ wheat: 1 });
  });

  it('发起人视角保持原样，旁观者不会看到行动按钮', () => {
    const own = offerPerspective(offer, 1);
    expect(own.own).toBe(true);
    expect(own.iGive).toEqual({ wood: 2 });
    expect(own.iGet).toEqual({ wheat: 1 });
    const other = offerPerspective(offer, 2);
    expect(other.mine).toBe(false);
    expect(other.own).toBe(false);
  });

  it('当前玩家可向任意其他玩家报价', () => {
    expect(offerTargets(stubView({ viewer: 0, current: 0 }))).toEqual([1, 2, 3]);
  });

  it('非当前玩家只能向当前玩家报价，不能给另一个非当前玩家', () => {
    expect(offerTargets(stubView({ viewer: 1, current: 0 }))).toEqual([0]);
    expect(offerTargets(stubView({ viewer: 2, current: 0 }))).toEqual([0]);
  });
});
