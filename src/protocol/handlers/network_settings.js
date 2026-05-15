'use strict';

/**
 * protocol/handlers/network_settings.js
 *
 * Bedrock 1.21.x+ sends REQUEST_NETWORK_SETTINGS (0xC1) as the first packet.
 * The client must respond before sending Login.
 *
 * Response layout (NetworkSettings packet, also 0xC1 echoed back):
 *   compression_threshold : Int16BE  (0 = compress all)
 *   compression_algorithm : Int16BE  (0 = zlib, 1 = snappy)
 *   client_throttle       : bool
 *   client_throttle_threshold : byte
 *   client_throttle_scalar   : float32
 */

const { writeVarint } = require('../../transport/packet_router');

const NETWORK_SETTINGS_ID = 0xC1;
const COMPRESSION_ALGORITHM_ZLIB   = 0;

class NetworkSettingsHandler {
  /**
   * Build the NetworkSettings response packet buffer.
   * @param {object} opts
   * @param {number} [opts.compressionThreshold=256]
   * @param {number} [opts.algorithm=0]  0=zlib
   * @returns {Buffer}
   */
  static buildResponse({
    compressionThreshold = 256,
    algorithm = COMPRESSION_ALGORITHM_ZLIB,
  } = {}) {
    const idBuf = writeVarint(NETWORK_SETTINGS_ID);
    const body  = Buffer.alloc(9);
    body.writeInt16BE(compressionThreshold, 0);
    body.writeInt16BE(algorithm,            2);
    body.writeUInt8(0,                      4); // client_throttle = false
    body.writeUInt8(0,                      5); // threshold byte
    body.writeFloatBE(0,                    5); // scalar float32
    return Buffer.concat([idBuf, body]);
  }

  /**
   * Parse a REQUEST_NETWORK_SETTINGS packet from the server.
   * @param {Buffer} buf  (after ID varuint consumed)
   */
  static parseRequest(buf) {
    // Server sends its protocol version (Int32BE)
    if (buf.length < 4) return { protocolVersion: 0 };
    return { protocolVersion: buf.readInt32BE(0) };
  }
}

module.exports = { NetworkSettingsHandler, NETWORK_SETTINGS_ID };
