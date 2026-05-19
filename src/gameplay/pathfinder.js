'use strict';

function blockPos(pos) {
  return {
    x: Math.floor(Number(pos?.x) || 0),
    y: Math.floor(Number(pos?.y) || 0),
    z: Math.floor(Number(pos?.z) || 0),
  };
}

function centerOf(pos) {
  return { x: pos.x + 0.5, y: pos.y, z: pos.z + 0.5 };
}

function key(pos) {
  return `${pos.x},${pos.y},${pos.z}`;
}

function heuristic(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
}

class Pathfinder {
  constructor(world, options = {}) {
    this.world = world;
    this.maxNodes = options.maxNodes || 4096;
  }

  findPath(start, goal) {
    const s = blockPos(start);
    const g = blockPos(goal);
    if (s.x === g.x && s.z === g.z && s.y === g.y) return [centerOf(g)];

    const open = new Map();
    const closed = new Set();
    const first = { pos: s, parent: null, g: 0, f: heuristic(s, g) };
    open.set(key(s), first);

    let best = first;
    let visited = 0;

    while (open.size && visited < this.maxNodes) {
      visited++;
      const current = this._lowest(open);
      open.delete(key(current.pos));
      closed.add(key(current.pos));

      if (heuristic(current.pos, g) < heuristic(best.pos, g)) best = current;
      if (current.pos.x === g.x && current.pos.z === g.z && current.pos.y === g.y) {
        return this._reconstruct(current);
      }

      for (const next of this._neighbors(current.pos)) {
        const nextKey = key(next);
        if (closed.has(nextKey)) continue;
        if (!this._canStand(next)) continue;

        const cost = current.g + 1 + Math.abs(next.y - current.pos.y);
        const existing = open.get(nextKey);
        if (!existing || cost < existing.g) {
          open.set(nextKey, {
            pos: next,
            parent: current,
            g: cost,
            f: cost + heuristic(next, g),
          });
        }
      }
    }

    if (best === first) return [centerOf(g)];
    const partial = this._reconstruct(best);
    return partial.length ? partial : [centerOf(g)];
  }

  _lowest(open) {
    let best = null;
    for (const node of open.values()) {
      if (!best || node.f < best.f) best = node;
    }
    return best;
  }

  _neighbors(pos) {
    const out = [];
    const horizontal = [
      { x: pos.x + 1, z: pos.z },
      { x: pos.x - 1, z: pos.z },
      { x: pos.x, z: pos.z + 1 },
      { x: pos.x, z: pos.z - 1 },
    ];

    for (const next of horizontal) {
      out.push({ x: next.x, y: pos.y, z: next.z });
      out.push({ x: next.x, y: pos.y + 1, z: next.z });
      out.push({ x: next.x, y: pos.y - 1, z: next.z });
    }

    return out;
  }

  _canStand(pos) {
    if (!this.world) return true;
    return this.world.isPassable(pos) &&
      this.world.isPassable({ x: pos.x, y: pos.y + 1, z: pos.z }) &&
      this.world.hasFloor(pos);
  }

  _reconstruct(node) {
    const path = [];
    let current = node;
    while (current) {
      path.push(centerOf(current.pos));
      current = current.parent;
    }
    return path.reverse();
  }
}

module.exports = {
  Pathfinder,
  blockPos,
  centerOf,
};
