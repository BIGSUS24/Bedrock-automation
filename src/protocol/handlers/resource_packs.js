'use strict';

/**
 * protocol/handlers/resource_packs.js
 *
 * Bedrock server sends RESOURCE_PACKS_INFO (0x06) after LOGIN is accepted.
 * Client must respond with RESOURCE_PACK_CLIENT_RESPONSE (0x08).
 *
 * Then server sends RESOURCE_PACK_STACK (0x07).
 * Client must respond AGAIN with RESOURCE_PACK_CLIENT_RESPONSE.
 *
 * ResourcePackClientResponse statuses:
 *   REFUSED           = 1
 *   SEND_PACKS        = 2  (request specific packs)
 *   HAVE_ALL_PACKS    = 3  (skip downloads — fastest path)
 *   COMPLETED         = 4  (all packs ready, proceed to game)
 *
 * Strategy: always respond HAVE_ALL_PACKS → COMPLETED
 * This tells the server we have all required packs and don't need downloads.
 * Most servers accept this. Servers with forced packs may disconnect.
 */

const { writeVarint } = require('../../transport/packet_router');

const RESOURCE_PACKS_INFO_ID     = 0x06;
const RESOURCE_PACK_STACK_ID     = 0x07;
const RESOURCE_PACK_RESPONSE_ID  = 0x08;

const ResourcePackStatus = {
  REFUSED:        1,
  SEND_PACKS:     2,
  HAVE_ALL_PACKS: 3,
  COMPLETED:      4,
};

class ResourcePackHandler {
  /**
   * Build a RESOURCE_PACK_CLIENT_RESPONSE packet.
   * @param {number} status  ResourcePackStatus value
   * @param {string[]} [packIds=[]]  Pack IDs to download (only for SEND_PACKS)
   * @returns {Buffer}
   */
  static buildResponse(status, packIds = []) {
    const idBuf  = writeVarint(RESOURCE_PACK_RESPONSE_ID);
    const parts  = [idBuf, Buffer.from([status & 0xFF])];

    // Pack ID list: UInt16LE count + strings
    const countBuf = Buffer.alloc(2);
    countBuf.writeUInt16LE(packIds.length, 0);
    parts.push(countBuf);

    for (const id of packIds) {
      const strBuf = Buffer.from(id, 'utf8');
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16LE(strBuf.length, 0);
      parts.push(lenBuf, strBuf);
    }

    return Buffer.concat(parts);
  }

  /**
   * Build the initial "I have all packs" response.
   * @returns {Buffer}
   */
  static buildHaveAllPacks() {
    return this.buildResponse(ResourcePackStatus.HAVE_ALL_PACKS);
  }

  /**
   * Build the final "completed" response.
   * @returns {Buffer}
   */
  static buildCompleted() {
    return this.buildResponse(ResourcePackStatus.COMPLETED);
  }

  /**
   * Parse RESOURCE_PACKS_INFO to extract pack IDs (for logging).
   * @param {Buffer} buf  (after packet ID consumed)
   * @returns {{ mustAccept: boolean, packIds: string[] }}
   */
  static parsePacksInfo(buf) {
    if (buf.length < 3) return { mustAccept: false, packIds: [] };

    let off = 0;
    const mustAccept = buf.readUInt8(off++) !== 0;
    const hasScripts = buf.readUInt8(off++) !== 0;
    const hasAddon   = buf.readUInt8(off++) !== 0;

    const packIds = [];
    if (off + 2 <= buf.length) {
      const count = buf.readUInt16LE(off); off += 2;
      for (let i = 0; i < count && off < buf.length; i++) {
        // Each entry: id(string) + version(string) + size(uint64) + hash(string) + isPremium(bool) + type(byte)
        const r = readString16(buf, off); off += r.bytesRead;
        packIds.push(r.value);
        // Skip remainder of entry (version, size, hash, flags) — variable length
        // We just collect IDs; we won't try to download them
        const vr = readString16(buf, off); off += vr.bytesRead;
        off += 8; // uint64 size
        const hr = readString16(buf, off); off += hr.bytesRead;
        off += 2; // isPremium + type
      }
    }

    return { mustAccept, hasScripts, packIds };
  }
}

function readString16(buf, offset) {
  if (offset + 2 > buf.length) return { value: '', bytesRead: 2 };
  const len   = buf.readUInt16LE(offset);
  const value = buf.slice(offset + 2, offset + 2 + len).toString('utf8');
  return { value, bytesRead: 2 + len };
}

module.exports = {
  ResourcePackHandler,
  ResourcePackStatus,
  RESOURCE_PACKS_INFO_ID,
  RESOURCE_PACK_STACK_ID,
  RESOURCE_PACK_RESPONSE_ID,
};
