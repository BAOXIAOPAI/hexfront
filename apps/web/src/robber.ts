/**
 * 掷 7 结算的「可用性提示」纯函数（与 placement.ts / build.ts 同构）。
 * 只做提示，合法性一律由服务端 MOVE_ROBBER 裁决。
 */

import { tileVertexKeys, type Geometry, type PlayerView } from '@hexfront/engine';

/** R-44：强盗可移到任意其他地块（含沙漠、含自己建筑旁），就是不能留原地 */
export function robberTiles(view: PlayerView, geo: Geometry): string[] {
  return geo.tileKeys.filter((key) => key !== view.robberTile);
}

export interface StealCandidate {
  seat: number;
  name: string;
  handSize: number;
}

/** R-45/46：目标地块相邻、有建筑、手里有牌、且不是自己的玩家 */
export function stealCandidates(view: PlayerView, geo: Geometry, tile: string): StealCandidate[] {
  const seats = new Set<number>();
  for (const vk of tileVertexKeys(geo, tile)) {
    const b = view.buildings[vk];
    if (!b || b.owner === view.viewer) continue;
    const p = view.players[b.owner];
    if (p && p.handSize > 0) seats.add(b.owner);
  }
  return [...seats]
    .sort((a, b) => a - b)
    .map((seat) => ({ seat, name: view.players[seat]!.name, handSize: view.players[seat]!.handSize }));
}
