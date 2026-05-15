'use strict';

/**
 * latest.js — Alias for the newest tested stable profile.
 *
 * DO NOT hardcode version assumptions in other modules.
 * Always resolve through VersionNegotiator instead of importing this directly.
 */

const { V1_21_80_Profile, PROTOCOL_VERSION, GAME_VERSION, PACKET_IDS, CAPABILITIES } = require('./v1_21_80');

class LatestProfile extends V1_21_80_Profile {
  constructor() {
    super();
    this._isLatestAlias = true;
  }
}

module.exports = {
  LatestProfile,
  LATEST_PROTOCOL_VERSION: PROTOCOL_VERSION,
  LATEST_GAME_VERSION:     GAME_VERSION,
  PACKET_IDS,
  CAPABILITIES,
};