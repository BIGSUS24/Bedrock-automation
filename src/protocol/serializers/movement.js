'use strict';

/**
 * movement.js — Bedrock MovePlayer packet (varies by version) serializer
 *
 * Layout (1.21.x base):
 *   entity_runtime_id : varuint64
 *   position          : Vec3 (float32 x3)  — note: y is eye height (add ~1.62)
 *   pitch             : float32
 *   yaw               : float32
 *   head_yaw          : float32
 *   mode              : byte (MoveMode)
 *   on_ground         : bool (byte)
 *   riding_runtime_id : varuint64
 *   [if mode == TELEPORT]
 *     teleport_cause  : int32
 *     teleport_item   : int32
 *   tick              : varuint64
 */

const { readVarint, writeVarint } = require('../../transport/packet_router');

const MoveMode = {
  NORMAL:   0,
  RESET:    1,
  TELEPORT: 2,
  ROTATION: 3,
};

class MovementSerializer {
  /**
   * @param {object} opts
   * @param {bigint|number} opts.entityRuntimeId
   * @param {{ x: number, y: number, z: number }} opts.position
   * @param {number} opts.pitch
   * @param {number} opts.yaw
   * @param {number} [opts.headYaw]
   * @param {number} [opts.mode=MoveMode.NORMAL]
   * @param {boolean} [opts.onGround=true]
   * @param {bigint|number} [opts.ridingRuntimeId=0]
   * @param {bigint|number} [opts.tick=0]
   * @returns {Buffer}
   */
  static serialize({
    entityRuntimeId = 1n,
    position        = { x: 0, y: 0, z: 0 },
    pitch           = 0,
    yaw             = 0,
    headYaw,
    mode            = MoveMode.NORMAL,
    onGround        = true,
    ridingRuntimeId = 0n,
    tick            = 0n,
  }) {
    const parts = [];

    parts.push(writeVarintU64(BigInt(entityRuntimeId)));
    parts.push(writeFloat32(position.x));
    parts.push(writeFloat32(position.y));
    parts.push(writeFloat32(position.z));
    parts.push(writeFloat32(pitch));
    parts.push(writeFloat32(yaw));
    parts.push(writeFloat32(headYaw ?? yaw));
    parts.push(Buffer.from([mode & 0xFF]));
    parts.push(Buffer.from([onGround ? 1 : 0]));
    parts.push(writeVarintU64(BigInt(ridingRuntimeId)));

    if (mode === MoveMode.TELEPORT) {
      const extra = Buffer.alloc(8);
      extra.writeInt32LE(0, 0); // teleport cause
      extra.writeInt32LE(0, 4); // teleport item
      parts.push(extra);
    }

    parts.push(writeVarintU64(BigInt(tick)));

    return Buffer.concat(parts);
  }

  /**
   * @param {Buffer} buf
   * @returns {object}
   */
  static deserialize(buf) {
    let off = 0;

    const eidR = readVarintU64(buf, off); const entityRuntimeId = eidR.value; off += eidR.bytesRead;

    const x = buf.readFloatLE(off); off += 4;
    const y = buf.readFloatLE(off); off += 4;
    const z = buf.readFloatLE(off); off += 4;

    const pitch   = buf.readFloatLE(off); off += 4;
    const yaw     = buf.readFloatLE(off); off += 4;
    const headYaw = buf.readFloatLE(off); off += 4;

    const mode      = buf.readUInt8(off++);
    const onGround  = buf.readUInt8(off++) !== 0;

    const ridR = readVarintU64(buf, off); const ridingRuntimeId = ridR.value; off += ridR.bytesRead;

    let teleportCause = null, teleportItem = null;
    if (mode === MoveMode.TELEPORT && off + 8 <= buf.length) {
      teleportCause = buf.readInt32LE(off); off += 4;
      teleportItem  = buf.readInt32LE(off); off += 4;
    }

    let tick = 0n;
    if (off < buf.length) {
      const tickR = readVarintU64(buf, off); tick = tickR.value;
    }

    return {
      entityRuntimeId, position: { x, y, z },
      pitch, yaw, headYaw, mode, onGround,
      ridingRuntimeId, teleportCause, teleportItem, tick,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeFloat32(val) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(val, 0);
  return b;
}

function writeVarintU64(bigVal) {
  const bytes = [];
  let v = bigVal;
  while (v > 0x7Fn) {
    bytes.push(Number(v & 0x7Fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function readVarintU64(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let bytesRead = 0;

  while (offset + bytesRead < buf.length) {
    const byte = BigInt(buf[offset + bytesRead]);
    bytesRead++;
    value |= (byte & 0x7Fn) << shift;
    shift += 7n;
    if ((byte & 0x80n) === 0n) break;
    if (shift >= 70n) break;
  }

  return { value, bytesRead };
}

module.exports = { MovementSerializer, MoveMode };
