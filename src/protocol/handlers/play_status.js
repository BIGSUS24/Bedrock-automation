'use strict';

/**
 * protocol/handlers/play_status.js
 *
 * PLAY_STATUS (0x02) — server signals login success or failure.
 *
 * Status codes:
 *   LOGIN_SUCCESS        = 0  → client is logged in
 *   FAILED_CLIENT        = 1  → outdated client
 *   FAILED_SERVER        = 2  → outdated server
 *   PLAYER_SPAWN         = 3  → player is spawning (post-StartGame)
 *   FAILED_INVALID_TENANT= 4  → education edition mismatch
 *   FAILED_VANILLA_EDU   = 5  → vanilla connecting to edu
 *   FAILED_EDU_VANILLA   = 6  → edu connecting to vanilla
 *   FAILED_SERVER_FULL   = 7  → server full
 */

const PlayStatusCode = {
  LOGIN_SUCCESS:           0,
  FAILED_CLIENT:          1,
  FAILED_SERVER:          2,
  PLAYER_SPAWN:            3,
  FAILED_INVALID_TENANT:  4,
  FAILED_VANILLA_EDU:     5,
  FAILED_EDU_VANILLA:     6,
  FAILED_SERVER_FULL:     7,
};

const PLAY_STATUS_ERRORS = {
  [PlayStatusCode.FAILED_CLIENT]:         'Outdated client — update your game version',
  [PlayStatusCode.FAILED_SERVER]:         'Outdated server — server needs to update',
  [PlayStatusCode.FAILED_INVALID_TENANT]: 'Education Edition mismatch',
  [PlayStatusCode.FAILED_VANILLA_EDU]:    'Cannot join Education Edition server with Vanilla client',
  [PlayStatusCode.FAILED_EDU_VANILLA]:    'Cannot join Vanilla server with Education Edition client',
  [PlayStatusCode.FAILED_SERVER_FULL]:    'Server is full',
};

class PlayStatusHandler {
  /**
   * Parse a PLAY_STATUS payload.
   * @param {Buffer} buf  (after packet ID consumed)
   * @returns {{ code: number, isError: boolean, message: string|null }}
   */
  static parse(buf) {
    if (buf.length < 4) return { code: -1, isError: true, message: 'Truncated PLAY_STATUS' };
    const code    = buf.readInt32BE(0);
    const isError = code !== PlayStatusCode.LOGIN_SUCCESS && code !== PlayStatusCode.PLAYER_SPAWN;
    const message = PLAY_STATUS_ERRORS[code] || null;
    return { code, isError, message };
  }

  static isSuccess(code) { return code === PlayStatusCode.LOGIN_SUCCESS; }
  static isSpawn(code)   { return code === PlayStatusCode.PLAYER_SPAWN; }
  static isError(code)   { return !(this.isSuccess(code) || this.isSpawn(code)); }
}

module.exports = { PlayStatusHandler, PlayStatusCode, PLAY_STATUS_ERRORS };
