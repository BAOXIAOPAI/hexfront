/**
 * 测试工具：假 socket + 开局摆位驱动。
 *
 * FakeSocket 让房间逻辑可以脱离真实网络单测，
 * 也顺便当成「消息记录器」断言谁收到了什么。
 */

import type { GameState } from '@hexfront/engine';
import type { Room, SocketLike } from '../src/room.js';
import type { ServerMessage } from '../src/protocol.js';

type StateMsg = Extract<ServerMessage, { t: 'STATE' }>;
type RejectMsg = Extract<ServerMessage, { t: 'REJECT' }>;

export class FakeSocket implements SocketLike {
  readonly label: string;
  sent: ServerMessage[] = [];

  constructor(label = 'sock') {
    this.label = label;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  clear(): void {
    this.sent = [];
  }

  get states(): StateMsg[] {
    return this.sent.filter((m): m is StateMsg => m.t === 'STATE');
  }

  get rejects(): RejectMsg[] {
    return this.sent.filter((m): m is RejectMsg => m.t === 'REJECT');
  }

  get lastState(): StateMsg | undefined {
    return this.states[this.states.length - 1];
  }
}

/**
 * 找一个合法的开局摆放点：顶点无建筑、邻居无建筑，且至少有一条空边。
 * 直接遍历几何，不猜坐标。
 */
export function findSetupSpot(room: Room, state: GameState): { vertex: string; edge: string } | null {
  const { geo } = room.board;
  for (const vk of geo.vertexKeys) {
    const v = geo.vertices[vk]!;
    if (state.buildings[vk]) continue;
    if (v.neighbors.some((nb) => state.buildings[nb])) continue;
    const edge = v.edges.find((ek) => state.roads[ek] === undefined);
    if (edge) return { vertex: vk, edge };
  }
  return null;
}

/** 走完 8 次摆位（2 人局 4 次），把房间推进到 play 阶段 */
export function driveSetup(room: Room): void {
  let guard = 0;
  while (room.game && room.game.phase === 'setup') {
    if (guard++ > 20) throw new Error('摆位未能在合理次数内结束');
    const seat = room.game.setup!.seat;
    const spot = findSetupSpot(room, room.game);
    if (!spot) throw new Error('找不到合法摆位点');
    const out = room.command(seat, { type: 'PLACE_SETTLEMENT', seat, ...spot });
    if (!out.ok) throw new Error(`摆位被拒绝: ${out.reason}`);
  }
  if (!room.game || room.game.phase !== 'play') throw new Error('摆位结束后未进入 play');
}
