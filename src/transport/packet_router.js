'use strict';

/**
 * PacketRouter — Game Packet Dispatcher
 *
 * Bedrock encapsulates game packets inside RakNet frames.
 * After reassembly + zlib decompression, each game packet starts with:
 *   - Packet ID: varuint
 *   - Subclient source/target (2 bits each, packed in 1 byte, post-1.2)
 *   - Payload
 *
 * This router:
 *   1. Accepts raw decrypted/decompressed payloads from the session
 *   2. Reads the packet ID
 *   3. Dispatches to registered handlers or emits a generic 'packet' event
 *
 * Compression: Bedrock compresses game payloads with zlib (deflate-raw, level 7).
 * Multiple game packets may be batched in one RakNet frame, separated by their
 * varuint-length prefixes in the MCPE "batch" wrapper.
 */

const EventEmitter = require('events');
const zlib         = require('zlib');

class PacketRouter extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<number, Function[]>} packetId → handlers */
    this.handlers = new Map();
  }

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Register a handler for a specific packet ID.
   * Multiple handlers may be registered for the same ID.
   *
   * @param {number}   packetId
   * @param {Function} handler  Called with (payload: Buffer)
   */
  on(eventOrId, handler) {
    if (typeof eventOrId === 'number') {
      if (!this.handlers.has(eventOrId)) {
        this.handlers.set(eventOrId, []);
      }
      this.handlers.get(eventOrId).push(handler);
      return this;
    }
    return super.on(eventOrId, handler);
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  /**
   * Route a raw frame payload from the session.
   * The payload may be a Batch packet (0xFE) containing zlib-compressed data,
   * or a raw game packet.
   *
   * @param {Buffer} payload
   */
  route(payload) {
    if (!payload || payload.length < 1) return;

    const packetId = payload.readUInt8(0);

    // Batch packet — decompress and dispatch each sub-packet
    if (packetId === 0xFE) {
      this._dispatchBatch(payload.slice(1));
      return;
    }

    this._dispatchPacket(payload);
  }

  _dispatchBatch(compressed) {
    let decompressed;
    try {
      decompressed = zlib.inflateRawSync(compressed);
    } catch (e) {
      // May be uncompressed (some server implementations)
      decompressed = compressed;
    }

    let offset = 0;
    while (offset < decompressed.length) {
      const lenResult = readVarint(decompressed, offset);
      if (!lenResult) break;
      offset += lenResult.bytesRead;

      const packetPayload = decompressed.slice(offset, offset + lenResult.value);
      offset += lenResult.value;

      if (packetPayload.length > 0) {
        this._dispatchPacket(packetPayload);
      }
    }
  }

  _dispatchPacket(payload) {
    let offset = 0;
    const idResult = readVarint(payload, offset);
    if (!idResult) return;
    const packetId  = idResult.value & 0x3FF; // mask subclient bits
    offset += idResult.bytesRead;

    const data = payload.slice(offset);

    // Call specific handlers
    const specific = this.handlers.get(packetId);
    if (specific) {
      for (const h of specific) {
        try { h(data); } catch (e) {
          console.warn(`[Router] Handler error for packet 0x${packetId.toString(16)}: ${e.message}`);
        }
      }
    }

    // Emit generic event
    this.emit('packet', { id: packetId, data });
  }

  // ── Outgoing — Build batch packet ────────────────────────────────────────

  /**
   * Wrap one or more game packets into a Bedrock Batch packet (0xFE + zlib).
   *
   * @param {Buffer[]} packets  Array of serialized game packets (without length prefix)
   * @returns {Buffer}
   */
  buildBatch(packets) {
    // Concatenate each packet with varuint length prefix
    const parts = [];
    for (const pkt of packets) {
      const lenBuf = writeVarint(pkt.length);
      parts.push(lenBuf, pkt);
    }
    const combined    = Buffer.concat(parts);
    const compressed  = zlib.deflateRawSync(combined, { level: 7 });
    return Buffer.concat([Buffer.from([0xFE]), compressed]);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  clear() {
    this.handlers.clear();
    this.removeAllListeners();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Varint helpers (unsigned, little-endian, 7-bit groups)
// ─────────────────────────────────────────────────────────────────────────────

function readVarint(buf, offset = 0) {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset + bytesRead < buf.length) {
    const byte = buf[offset + bytesRead];
    bytesRead++;
    value |= (byte & 0x7F) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
    if (shift >= 35) return null; // overflow
  }

  return { value, bytesRead };
}

function writeVarint(value) {
  const bytes = [];
  while (value > 0x7F) {
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7F);
  return Buffer.from(bytes);
}

module.exports = { PacketRouter, readVarint, writeVarint };