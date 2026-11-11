/** 与 packages/engine/src/board.ts 相同的 (u,row) 几何，仅用于设计原型。 */
(function () {
  const SQRT3 = Math.sqrt(3);
  const HEX_SIZE = 56;
  const PRECISION = 100;

  function cornersOf(cx, cy, size = HEX_SIZE) {
    const out = [];
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 180) * (60 * i - 30);
      out.push({ x: cx + size * Math.cos(ang), y: cy + size * Math.sin(ang) });
    }
    return out;
  }

  function keyOf(x, y) {
    return `${Math.round(x * PRECISION)},${Math.round(y * PRECISION)}`;
  }

  function build(rows = [3, 4, 5, 4, 3]) {
    const center = (rows.length - 1) / 2;
    const tiles = {};
    const tileKeys = [];
    rows.forEach((count, row) => {
      const u0 = 1 - count;
      for (let i = 0; i < count; i++) {
        const u = u0 + i * 2;
        const key = `${u},${row}`;
        tiles[key] = { key, u, row, x: (HEX_SIZE * SQRT3 * u) / 2, y: HEX_SIZE * 1.5 * (row - center) };
        tileKeys.push(key);
      }
    });

    const vertices = {};
    const vertexKeys = [];
    const edges = {};
    const edgeKeys = [];
    const ensureVertex = (x, y) => {
      const k = keyOf(x, y);
      if (!vertices[k]) {
        vertices[k] = { key: k, x: Math.round(x * PRECISION) / PRECISION, y: Math.round(y * PRECISION) / PRECISION, tiles: [], edges: [], neighbors: [] };
        vertexKeys.push(k);
      }
      return k;
    };

    for (const tk of tileKeys) {
      const t = tiles[tk];
      const pts = cornersOf(t.x, t.y);
      const vks = pts.map((p) => ensureVertex(p.x, p.y));
      for (const vk of vks) {
        if (!vertices[vk].tiles.includes(tk)) vertices[vk].tiles.push(tk);
      }
      for (let i = 0; i < 6; i++) {
        const a = vks[i];
        const b = vks[(i + 1) % 6];
        const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (!edges[ek]) {
          edges[ek] = { key: ek, a, b, tiles: [] };
          edgeKeys.push(ek);
        }
        if (!edges[ek].tiles.includes(tk)) edges[ek].tiles.push(tk);
        if (!vertices[a].edges.includes(ek)) vertices[a].edges.push(ek);
        if (!vertices[b].edges.includes(ek)) vertices[b].edges.push(ek);
        if (!vertices[a].neighbors.includes(b)) vertices[a].neighbors.push(b);
        if (!vertices[b].neighbors.includes(a)) vertices[b].neighbors.push(a);
      }
    }
    return { tiles, tileKeys, vertices, vertexKeys, edges, edgeKeys };
  }

  function nearestVertex(geo, x, y) {
    let best = null;
    let bestD = Infinity;
    for (const k of geo.vertexKeys) {
      const v = geo.vertices[k];
      const d = (v.x - x) ** 2 + (v.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  function shortestVertexPath(geo, startKey, endKey) {
    if (startKey === endKey) return [startKey];
    const prev = new Map([[startKey, null]]);
    const queue = [startKey];
    while (queue.length) {
      const cur = queue.shift();
      for (const next of geo.vertices[cur].neighbors) {
        if (prev.has(next)) continue;
        prev.set(next, cur);
        if (next === endKey) {
          const path = [];
          let step = endKey;
          while (step) {
            path.unshift(step);
            step = prev.get(step);
          }
          return path;
        }
        queue.push(next);
      }
    }
    return null;
  }

  function boundaryEdges(geo) {
    return geo.edgeKeys.filter((k) => geo.edges[k].tiles.length === 1);
  }

  function ports(geo, plan) {
    const candidates = boundaryEdges(geo).map((k) => {
      const e = geo.edges[k];
      const a = geo.vertices[e.a];
      const b = geo.vertices[e.b];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      return { key: k, a, b, mx, my, angle: (Math.atan2(my, mx) * 180) / Math.PI };
    });
    const used = new Set();
    return plan.map((p) => {
      let best = null;
      let bestD = Infinity;
      for (const c of candidates) {
        if (used.has(c.key)) continue;
        const d = Math.abs(((c.angle - p.angle + 540) % 360) - 180);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      used.add(best.key);
      const len = Math.hypot(best.mx, best.my) || 1;
      const nx = best.mx / len;
      const ny = best.my / len;
      return { ...p, ...best, nx, ny, lx: best.mx + nx * 38, ly: best.my + ny * 38 };
    });
  }

  window.HexGeo = { HEX_SIZE, build, cornersOf, nearestVertex, shortestVertexPath, ports, keyOf };
})();
