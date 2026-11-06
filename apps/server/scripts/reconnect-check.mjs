/**
 * 断线重连验收（不开浏览器）。
 *
 * 做三件事：
 * 1. 用某个名字入座，记录座位号 / 回合 / 手牌
 * 2. 直接断开连接
 * 3. 用同名重连，确认回到同一个座位、同一局、状态一致
 *
 * 用法（房间需已开局）：
 *   PORT=8899 node scripts/reconnect-check.mjs <房间号> <名字>
 */

import WebSocket from 'ws';

const roomId = (process.argv[2] ?? 'recon').toLowerCase();
const name = process.argv[3] ?? '甲';
const port = Number(process.env.PORT ?? 8899);
const url = `ws://127.0.0.1:${port}/`;

function join(displayName) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('入座超时'));
    }, 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'JOIN', roomId, name: displayName }));
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.t === 'WELCOME') {
        clearTimeout(timer);
        resolve({ ws, welcome: msg });
      } else if (msg.t === 'JOIN_FAILED') {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`入座失败：${msg.reason}`));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot(welcome) {
  const view = welcome.view;
  if (!view) return { seat: welcome.seat, view: null };
  const me = view.players[view.viewer];
  return {
    seat: welcome.seat,
    turn: view.turn,
    phase: view.phase,
    handSize: me ? me.handSize : null,
    tiles: view.tiles.length,
    buildings: Object.keys(view.buildings).length,
    roads: Object.keys(view.roads).length,
    offer: welcome.offer,
  };
}

async function main() {
  const first = await join(name);
  const before = snapshot(first.welcome);

  // 模拟关掉标签页：直接断开，不发任何告别消息
  first.ws.close();
  await wait(300);

  const second = await join(name);
  const after = snapshot(second.welcome);
  second.ws.close();

  const same =
    before.seat === after.seat &&
    before.turn === after.turn &&
    before.phase === after.phase &&
    before.handSize === after.handSize &&
    before.buildings === after.buildings &&
    before.roads === after.roads;

  console.log(
    JSON.stringify(
      {
        ok: same,
        roomId,
        name,
        before,
        after,
        checks: {
          seatKept: before.seat === after.seat,
          sameTurn: before.turn === after.turn,
          sameHand: before.handSize === after.handSize,
          sameBuildings: before.buildings === after.buildings,
        },
      },
      null,
      2,
    ),
  );

  process.exit(same ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err.message ?? err) }, null, 2));
  process.exit(1);
});
