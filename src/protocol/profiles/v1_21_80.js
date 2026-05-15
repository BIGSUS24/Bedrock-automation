'use strict';

/**
 * v1_21_80.js — Bedrock 1.21.80 (Protocol 649)
 * Inherits 1.21.50 packet IDs with overrides for packets that changed.
 */

const { V1_21_50_Profile, PACKET_IDS: BASE_IDS, CAPABILITIES: BASE_CAPS } = require('./v1_21_50');

const PROTOCOL_VERSION = 649;
const GAME_VERSION     = '1.21.80';

// Only define IDs that CHANGED from 1.21.50
const ID_OVERRIDES = {
  // 1.21.80 remapped several packets; these are the known changes:
  CAMERA_INSTRUCTION:        0xB4,
  CONTAINER_REGISTRY_CLEANUP: 0xB5,
  MOVEMENT_EFFECT:           0xB6,
  SET_MOVEMENT_AUTHORITY:    0xB7,
};

const PACKET_IDS = { ...BASE_IDS, ...ID_OVERRIDES };

const PACKET_NAMES = {};
for (const [name, id] of Object.entries(PACKET_IDS)) {
  PACKET_NAMES[id] = name;
}

const CAPABILITIES = {
  ...BASE_CAPS,
  maxProtocolVersion: 649,
  minProtocolVersion: 622,
  movementAuthority:  true,  // server-authoritative movement added
};

class V1_21_80_Profile extends V1_21_50_Profile {
  constructor() {
    super();
    this.protocolVersion = PROTOCOL_VERSION;
    this.gameVersion     = GAME_VERSION;
    this.family          = '1.21';
    this.packetIds       = PACKET_IDS;
    this.packetNames     = PACKET_NAMES;
    this.capabilities    = CAPABILITIES;
  }

  getLoginPacket(username, bedrockToken) {
    return {
      isCustom: false,
      id:       PACKET_IDS.LOGIN,
      data:     { username, bedrockToken, protocolVersion: PROTOCOL_VERSION, gameVersion: GAME_VERSION },
    };
  }
}

module.exports = { V1_21_80_Profile, PROTOCOL_VERSION, GAME_VERSION, PACKET_IDS, CAPABILITIES };
