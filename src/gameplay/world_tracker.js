'use strict';

const EventEmitter = require('events');
const registryLoader = require('prismarine-registry');
const chunkLoader = require('prismarine-chunk');
const { Vec3 } = require('vec3');
const { BlockMatcher } = require('./block_matcher');

function keyOf(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function chunkKey(x, z) {
  return `${x},${z}`;
}

function mod16(value) {
  return ((value % 16) + 16) % 16;
}

function distanceSq(a, b) {
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  const dz = Number(a.z) - Number(b.z);
  return dx * dx + dy * dy + dz * dz;
}

function horizontalDistanceSq(a, b) {
  const dx = Number(a.x) - Number(b.x);
  const dz = Number(a.z) - Number(b.z);
  return dx * dx + dz * dz;
}

function withinColumnRadius(pos, center, radius, yRadius) {
  if (Math.abs(Number(pos.y) - Number(center.y)) > yRadius) return false;
  return horizontalDistanceSq(pos, center) <= radius * radius;
}

class WorldTracker extends EventEmitter {
  constructor(config, protocol, state) {
    super();
    this.config = config || {};
    this.protocol = protocol;
    this.state = state;
    this.version = protocol?.getActiveVersion?.() || config?.server?.version || '1.26.20';
    this.matcher = new BlockMatcher(this.version);
    this.blockUpdates = new Map();
    this.chunks = new Map();
    this.loadedChunkKeys = new Set(); // Track which chunk columns are loaded
    this.failedChunkKeys = new Set(); // Track which chunk columns failed to decode
    this.items = new Map();
    this.gameStart = null;
    this._listeners = [];
    this._chunkClass = null;
    this._chunkLoadWarning = null;
    this._debugLog = (config?.logging?.level === 'debug');
    this._initChunkLoader();
  }

  attach() {
    if (!this.protocol || this._listeners.length) return;
    this._on('gameStart', (packet) => {
      this.gameStart = packet;
      this.blockUpdates.clear();
      this.chunks.clear();
      this.loadedChunkKeys.clear();
      this.failedChunkKeys.clear();
      this.items.clear();
      this.emit('gameStart', packet);
    });
    this._on('levelChunk', (packet) => this._handleLevelChunk(packet));
    this._on('updateBlock', (packet) => this._handleUpdateBlock(packet));
    this._on('blockEvent', (packet) => this.emit('blockEvent', packet));
    this._on('addItemEntity', (packet) => this._handleAddItem(packet));
    this._on('takeItemEntity', (packet) => this._handleTakeItem(packet));
  }

  detach() {
    for (const [event, handler] of this._listeners) {
      this.protocol.removeListener(event, handler);
    }
    this._listeners = [];
  }

  getChunkLoadWarning() {
    return this._chunkLoadWarning;
  }

  /**
   * Check if a chunk column has been received from the server (regardless of decode success).
   */
  isChunkReceived(pos) {
    const cx = Math.floor(Math.floor(Number(pos.x)) / 16);
    const cz = Math.floor(Math.floor(Number(pos.z)) / 16);
    const key = chunkKey(cx, cz);
    return this.loadedChunkKeys.has(key) || this.failedChunkKeys.has(key);
  }

  /**
   * Check if a chunk column was successfully loaded (decoded).
   */
  isChunkLoaded(pos) {
    const cx = Math.floor(Math.floor(Number(pos.x)) / 16);
    const cz = Math.floor(Math.floor(Number(pos.z)) / 16);
    return this.chunks.has(chunkKey(cx, cz));
  }

  getBlock(pos) {
    const blockPos = this._blockPos(pos);
    // update_block overlay takes priority — this data is always fresh
    const overlay = this.blockUpdates.get(keyOf(blockPos));
    if (overlay) return { ...overlay, position: blockPos };

    const cx = Math.floor(blockPos.x / 16);
    const cz = Math.floor(blockPos.z / 16);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk) return null;

    try {
      const block = chunk.getBlock(new Vec3(mod16(blockPos.x), blockPos.y, mod16(blockPos.z)), true);
      if (!block) return null;
      const runtimeId = Number(block.stateId ?? block.state ?? block.type ?? 0);
      const dataBlock = this.matcher.getByStateId(runtimeId);
      return {
        block: dataBlock || block,
        runtimeId,
        position: blockPos,
        source: 'chunk',
      };
    } catch {
      return null;
    }
  }

  findBlocks({ origin, radius = 24, yRadius = 16, limit = 64, match }) {
    const found = [];
    const seen = new Set();
    const center = this._blockPos(origin || this.state?.player?.position || { x: 0, y: 0, z: 0 });
    const matcher = typeof match === 'function' ? match : () => true;

    // First scan update_block overlay — these are the most reliable data points
    for (const entry of this.blockUpdates.values()) {
      if (!matcher(entry.block, entry)) continue;
      if (!withinColumnRadius(entry.position, center, radius, yRadius)) continue;
      const key = keyOf(entry.position);
      seen.add(key);
      found.push({ ...entry, distanceSq: distanceSq(entry.position, center) });
    }

    // Then scan loaded chunks
    const minY = Math.floor(center.y - yRadius);
    const yOffsets = [];
    for (let dy = 0; dy <= yRadius; dy++) {
      yOffsets.push(dy);
      if (dy !== 0) yOffsets.push(-dy);
    }

    const horizontalOffsets = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const horizontalSq = dx * dx + dz * dz;
        if (horizontalSq <= radius * radius) horizontalOffsets.push({ dx, dz, horizontalSq });
      }
    }
    horizontalOffsets.sort((a, b) => a.horizontalSq - b.horizontalSq);

    let farthestKept = Infinity;
    for (const offset of horizontalOffsets) {
      if (found.length >= limit && offset.horizontalSq > farthestKept) break;

      const x = center.x + offset.dx;
      const z = center.z + offset.dz;
      const cx = Math.floor(x / 16);
      const cz = Math.floor(z / 16);
      if (!this.chunks.has(chunkKey(cx, cz))) continue;

      for (const dy of yOffsets) {
        const y = center.y + dy;
        if (y < minY) continue;
        const pos = { x, y, z };
        const key = keyOf(pos);
        if (seen.has(key)) continue;
        const entry = this.getBlock(pos);
        if (!entry || !matcher(entry.block, entry)) continue;
        if (!withinColumnRadius(pos, center, radius, yRadius)) continue;
        seen.add(key);
        found.push({ ...entry, distanceSq: distanceSq(pos, center) });
        found.sort((a, b) => a.distanceSq - b.distanceSq);
        if (found.length > limit) found.length = limit;
        farthestKept = found.length >= limit ? found[found.length - 1].distanceSq : Infinity;
      }
    }

    found.sort((a, b) => a.distanceSq - b.distanceSq);
    return found.slice(0, limit);
  }

  findTrapdoors(origin, radius, options = {}) {
    const allowedBlocks = options.allowedBlocks || this.config.gameplay?.pull?.allowedBlocks || [];
    const deniedBlocks = options.deniedBlocks || this.config.gameplay?.pull?.deniedBlocks || [];

    return this.findBlocks({
      origin,
      radius,
      yRadius: this.config.gameplay?.pull?.yRadius || 8,
      match: (block) => this.matcher.isTrapdoor(block) && this._blockNameAllowed(block, allowedBlocks, deniedBlocks),
    });
  }

  findMineTargets(query, origin, radius) {
    return this.findBlocks({
      origin,
      radius,
      yRadius: this.config.gameplay?.mining?.yRadius || 24,
      match: (block) => this.matcher.matches(block, query),
    });
  }

  getPullWaypoints() {
    const pull = this.config.gameplay?.pull || {};
    const global = this.config.gameplay?.waypoints?.pull || [];
    return [...(pull.waypoints || []), ...(pull.trapdoors || []), ...global]
      .map((wp) => this._normaliseWaypoint(wp))
      .filter(Boolean);
  }

  findNearestItem(origin, radius = 6) {
    const center = this._blockPos(origin || this.state?.player?.position || { x: 0, y: 0, z: 0 });
    let best = null;
    for (const packet of this.items.values()) {
      const position = this._itemPosition(packet);
      if (!position) continue;
      const dist = distanceSq(position, center);
      if (dist > radius * radius) continue;
      if (!best || dist < best.distanceSq) best = { packet, position, distanceSq: dist };
    }
    return best;
  }

  /**
   * Check if a position is passable (air or transparent block).
   * For positions in unloaded/unknown chunks near the player, default to SOLID (conservative).
   * For distant unloaded chunks, default to passable (optimistic, allows long-range path estimates).
   */
  isPassable(pos) {
    const entry = this.getBlock(pos);
    if (!entry) {
      // If the chunk was received but we have no data for this block, treat as passable
      // (could be air in a decoded chunk with no matching entry).
      // If the chunk was never received, be conservative for nearby blocks.
      const playerPos = this.state?.player?.position;
      if (playerPos) {
        const dist = horizontalDistanceSq(pos, playerPos);
        // Within 8 blocks: unknown = solid (conservative, prevents walking into walls)
        if (dist < 64) return false;
      }
      return true;
    }
    return this.matcher.isAir(entry.block) || entry.block.transparent === true || entry.block.boundingBox === 'empty';
  }

  hasFloor(pos) {
    const below = this.getBlock({ x: pos.x, y: pos.y - 1, z: pos.z });
    if (!below) {
      // Same conservative approach for unknown blocks
      const playerPos = this.state?.player?.position;
      if (playerPos) {
        const dist = horizontalDistanceSq(pos, playerPos);
        if (dist < 64) return true; // Assume floor exists for nearby unknown (conservative)
      }
      return true;
    }
    return this.matcher.isSolid(below.block);
  }

  /**
   * Get stats about the world tracker state (for debugging)
   */
  getStats() {
    return {
      loadedChunks: this.chunks.size,
      receivedChunks: this.loadedChunkKeys.size,
      failedChunks: this.failedChunkKeys.size,
      blockUpdates: this.blockUpdates.size,
      trackedItems: this.items.size,
      chunkWarning: this._chunkLoadWarning,
    };
  }

  _on(event, handler) {
    this.protocol.on(event, handler);
    this._listeners.push([event, handler]);
  }

  _initChunkLoader() {
    if (String(this.version).startsWith('1.26.')) {
      try {
        const registry = registryLoader(`bedrock_${String(this.version).replace(/^bedrock_/, '')}`);
        this._ensureRuntimeBlockMap(registry);
        const bedrock118Chunk = require('prismarine-chunk/src/bedrock/1.18/chunk');
        this._chunkClass = bedrock118Chunk(registry);
        this._chunkLoadWarning = 'Chunk parser compatibility mode: using 1.18+ Bedrock format with 1.26 registry';
        return;
      } catch (e) {
        this._chunkLoadWarning = e.message;
      }
    }

    const candidates = [this.version];
    if (!candidates.includes('1.21.100')) candidates.push('1.21.100');

    for (const version of candidates) {
      try {
        const registry = registryLoader(`bedrock_${String(version).replace(/^bedrock_/, '')}`);
        this._ensureRuntimeBlockMap(registry);
        this._chunkClass = chunkLoader(registry);
        if (version !== this.version) {
          this._chunkLoadWarning = `Chunk parser fallback active: using ${version} format for ${this.version}`;
        }
        return;
      } catch (e) {
        this._chunkLoadWarning = e.message;
      }
    }
  }

  _ensureRuntimeBlockMap(registry) {
    if (registry.blocksByRuntimeId) return;
    const runtimeMap = {};
    for (const [stateId, state] of Object.entries(registry.blockStates || {})) {
      const id = Number(stateId);
      const block = registry.blocksByStateId?.[id] || {};
      runtimeMap[id] = {
        ...block,
        ...state,
        stateId: id,
        id: block.id,
        displayName: block.displayName,
        hardness: block.hardness,
        resistance: block.resistance,
        boundingBox: block.boundingBox,
        transparent: block.transparent,
      };
    }
    registry.blocksByRuntimeId = new Proxy(runtimeMap, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        const id = Number(prop);
        if (!Number.isInteger(id)) return undefined;
        const placeholder = {
          id: -1,
          stateId: id,
          name: `unknown_runtime_${id}`,
          displayName: `Unknown Runtime ${id}`,
          states: {},
          hardness: 1,
          resistance: 1,
          boundingBox: 'block',
          transparent: false,
          diggable: false,
          count: 0,
        };
        target[prop] = placeholder;
        registry.blocksByStateId[id] = placeholder;
        registry.blockStates[id] = { name: placeholder.name, states: {}, version: 0 };
        return placeholder;
      },
    });
  }

  async _handleLevelChunk(packet) {
    const ck = chunkKey(packet.x, packet.z);

    if (!this._chunkClass || packet.cache_enabled) {
      this.loadedChunkKeys.add(ck);
      this.failedChunkKeys.add(ck);
      return;
    }
    if (!packet.payload || Number(packet.sub_chunk_count) < 0) {
      this.loadedChunkKeys.add(ck);
      this.failedChunkKeys.add(ck);
      return;
    }

    try {
      const chunk = new this._chunkClass({ x: packet.x, z: packet.z });
      await chunk.networkDecodeNoCache(Buffer.from(packet.payload), Number(packet.sub_chunk_count));
      this._remapSignedSubChunkSections(chunk);
      this.chunks.set(ck, chunk);
      this.loadedChunkKeys.add(ck);
      this.failedChunkKeys.delete(ck); // Successfully decoded
      this.emit('chunkLoaded', { x: packet.x, z: packet.z });
    } catch (e) {
      this.loadedChunkKeys.add(ck);
      this.failedChunkKeys.add(ck);
      this.emit('worldWarning', `Chunk decode failed at ${packet.x},${packet.z}: ${e.message}`);
    }
  }

  _remapSignedSubChunkSections(chunk) {
    if (!chunk || !Array.isArray(chunk.sections)) return;

    const remapped = [];
    let changed = false;
    for (let index = 0; index < chunk.sections.length; index++) {
      const section = chunk.sections[index];
      if (!section) continue;

      const sectionY = this._signedByte(section.y);
      const expectedIndex = chunk.co + sectionY;
      if (Number.isInteger(sectionY) && expectedIndex >= 0) {
        section.y = sectionY;
        remapped[expectedIndex] = section;
        changed = changed || expectedIndex !== index;
      } else {
        remapped[index] = section;
      }
    }

    if (changed) chunk.sections = remapped;
  }

  _signedByte(value) {
    const number = Number(value);
    if (!Number.isInteger(number)) return number;
    return number > 127 ? number - 256 : number;
  }

  _handleUpdateBlock(packet) {
    const position = this._blockPos(packet.position);
    const runtimeId = Number(packet.block_runtime_id ?? packet.runtime_id ?? 0);
    const block = this.matcher.getByStateId(runtimeId) || { name: `runtime_${runtimeId}`, displayName: `Runtime ${runtimeId}` };
    const entry = {
      block,
      runtimeId,
      position,
      source: 'update_block',
      updatedAt: Date.now(),
    };
    this.blockUpdates.set(keyOf(position), entry);
    this.emit('blockUpdate', entry);
  }

  _handleAddItem(packet) {
    const id = String(packet.runtime_entity_id ?? packet.entity_id_self ?? Date.now());
    this.items.set(id, packet);
    this.emit('itemAdded', packet);
  }

  _handleTakeItem(packet) {
    const id = String(packet.runtime_entity_id);
    this.items.delete(id);
    this.emit('itemTaken', packet);
  }

  _blockPos(pos) {
    return {
      x: Math.floor(Number(pos?.x) || 0),
      y: Math.floor(Number(pos?.y) || 0),
      z: Math.floor(Number(pos?.z) || 0),
    };
  }

  _itemPosition(packet) {
    const pos = packet?.position || packet?.coordinates || packet?.pos;
    if (!pos) return null;
    return {
      x: Number(pos.x),
      y: Number(pos.y),
      z: Number(pos.z),
    };
  }

  _normaliseWaypoint(wp) {
    if (!wp) return null;
    if (Array.isArray(wp)) {
      const face = Number(wp[3]);
      return {
        position: this._blockPos({ x: wp[0], y: wp[1], z: wp[2] }),
        ...(Number.isFinite(face) ? { face } : {}),
      };
    }
    if (wp.position) {
      const face = Number(wp.face);
      return {
        ...wp,
        position: this._blockPos(wp.position),
        ...(Number.isFinite(face) ? { face } : {}),
      };
    }
    if (wp.x !== undefined && wp.y !== undefined && wp.z !== undefined) {
      const face = Number(wp.face);
      return {
        ...wp,
        position: this._blockPos(wp),
        ...(Number.isFinite(face) ? { face } : {}),
      };
    }
    return null;
  }

  _blockNameAllowed(block, allowedBlocks, deniedBlocks) {
    if (!block) return false;
    if (deniedBlocks?.length && this.matcher.nameMatches(block, deniedBlocks)) return false;
    if (!allowedBlocks?.length) return true;
    return this.matcher.nameMatches(block, allowedBlocks);
  }
}

module.exports = {
  WorldTracker,
  keyOf,
  distanceSq,
  horizontalDistanceSq,
};
