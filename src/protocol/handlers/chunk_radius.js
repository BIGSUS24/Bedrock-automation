'use strict';

/**
 * protocol/handlers/chunk_radius.js
 *
 * After START_GAME, the client must send REQUEST_CHUNK_RADIUS (0x45).
 * Server replies with CHUNK_RADIUS_UPDATE (0x46).
 *
 * Request layout: requested_radius (varuint)
 * Response layout: chunk_radius    (varuint)
 */

const { writeVarint, readVarint } = require('../../transport/packet_router');

const REQUEST_CHUNK_RADIUS_ID = 0x45;
const CHUNK_RADIUS_UPDATE_ID  = 0x46;

const DEFAULT_CHUNK_RADIUS = 8;
const MAX_CHUNK_RADIUS     = 16;

class ChunkRadiusHandler {
  /**
   * Build a REQUEST_CHUNK_RADIUS packet.
   * @param {number} [radius=8]
   * @returns {Buffer}
   */
  static buildRequest(radius = DEFAULT_CHUNK_RADIUS) {
    const clamped = Math.max(4, Math.min(radius, MAX_CHUNK_RADIUS));
    const idBuf   = writeVarint(REQUEST_CHUNK_RADIUS_ID);
    const radBuf  = writeVarint(clamped);
    return Buffer.concat([idBuf, radBuf]);
  }

  /**
   * Parse a CHUNK_RADIUS_UPDATE response.
   * @param {Buffer} buf  (after packet ID consumed)
   * @returns {{ chunkRadius: number }}
   */
  static parseUpdate(buf) {
    const r = readVarint(buf, 0);
    return { chunkRadius: r.value };
  }
}

module.exports = { ChunkRadiusHandler, REQUEST_CHUNK_RADIUS_ID, CHUNK_RADIUS_UPDATE_ID, DEFAULT_CHUNK_RADIUS };
