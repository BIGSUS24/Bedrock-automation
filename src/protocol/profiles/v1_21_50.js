'use strict';

/**
 * v1_21_50.js — Bedrock 1.21.50 (Protocol 622)
 *
 * Exact packet IDs sourced from open-source Bedrock protocol research:
 *   - bedrock-protocol, CloudburstMC/Protocol, wiki.vg/Bedrock
 */

const PROTOCOL_VERSION = 622;
const GAME_VERSION     = '1.21.50';

const PACKET_IDS = {
  LOGIN:                         0x01,
  PLAY_STATUS:                   0x02,
  SERVER_TO_CLIENT_HANDSHAKE:    0x03,
  CLIENT_TO_SERVER_HANDSHAKE:    0x04,
  DISCONNECT:                    0x05,
  RESOURCE_PACKS_INFO:           0x06,
  RESOURCE_PACK_STACK:           0x07,
  RESOURCE_PACK_CLIENT_RESPONSE: 0x08,
  TEXT:                          0x09,
  SET_TIME:                      0x0A,
  START_GAME:                    0x0B,
  ADD_PLAYER:                    0x0C,
  ADD_ENTITY:                    0x0D,
  REMOVE_ENTITY:                 0x0E,
  ADD_ITEM_ENTITY:               0x0F,
  TAKE_ITEM_ENTITY:              0x11,
  MOVE_ENTITY:                   0x12,
  MOVE_PLAYER:                   0x13,
  PLAYER_ACTION:                 0x24,
  SET_HEALTH:                    0x2A,
  ANIMATE:                       0x2C,
  RESPAWN:                       0x2D,
  CONTAINER_OPEN:                0x2E,
  CONTAINER_CLOSE:               0x2F,
  PLAYER_HOTBAR:                 0x30,
  INVENTORY_CONTENT:             0x31,
  INVENTORY_SLOT:                0x32,
  REQUEST_CHUNK_RADIUS:          0x45,
  CHUNK_RADIUS_UPDATE:           0x46,
  AVAILABLE_COMMANDS:            0x4C,
  COMMAND_REQUEST:               0x4D,
  COMMAND_OUTPUT:                0x4F,
  TRANSFER:                      0x55,
  PLAY_SOUND:                    0x56,
  SET_TITLE:                     0x58,
  PLAYER_SKIN:                   0x5D,
  MODAL_FORM_REQUEST:            0x64,
  MODAL_FORM_RESPONSE:           0x65,
  SET_SCORE:                     0x6C,
  NETWORK_STACK_LATENCY:         0x73,
  LEVEL_SOUND_EVENT:             0x7B,
  CLIENT_CACHE_STATUS:           0x81,
  REQUEST_NETWORK_SETTINGS:      0xC1,
  UPDATE_ABILITIES:              0xAC,
  UPDATE_ADVENTURE_SETTINGS:     0xAD,
  DEATH_INFO:                    0xAE,
  REQUEST_ABILITY:               0xA9,
  TOAST_REQUEST:                 0xAB,
  CORRECT_PLAYER_MOVE_PREDICTION: 0x92,
  PLAYER_FOG:                    0x91,
  CAMERA_SHAKE:                  0x90,
  SUB_CHUNK:                     0x9F,
  SUB_CHUNK_REQUEST:             0xA0,
  PACKET_VIOLATION_WARNING:      0x8D,
};

// Reverse map: id → name
const PACKET_NAMES = {};
for (const [name, id] of Object.entries(PACKET_IDS)) {
  PACKET_NAMES[id] = name;
}

const CAPABILITIES = {
  encryptionHandshake:      true,
  compressionEnabled:       true,
  resourcePacksEnabled:     true,
  chunkRadius:              true,
  clientCacheStatus:        true,
  subChunk:                 true,
  requestNetworkSettings:   true,
  networkStackLatency:      true,
  emotes:                   true,
  scriptApi:                false,
  maxProtocolVersion:       622,
  minProtocolVersion:       594,
};

class V1_21_50_Profile {
  constructor() {
    this.protocolVersion = PROTOCOL_VERSION;
    this.gameVersion     = GAME_VERSION;
    this.family          = '1.21';
    this.packetIds       = PACKET_IDS;
    this.packetNames     = PACKET_NAMES;
    this.capabilities    = CAPABILITIES;
  }

  getPacketId(name) {
    const id = this.packetIds[name];
    if (id === undefined) {
      throw new Error(`Packet "${name}" is not defined in profile ${this.gameVersion}`);
    }
    return id;
  }

  getPacketName(id) {
    return this.packetNames[id] || `UNKNOWN_0x${id.toString(16).toUpperCase()}`;
  }

  supports(capability) {
    return this.capabilities[capability] === true;
  }

  getLoginPacket(username, bedrockToken) {
    return {
      isCustom: false,
      id:       PACKET_IDS.LOGIN,
      data:     { username, bedrockToken, protocolVersion: PROTOCOL_VERSION, gameVersion: GAME_VERSION },
    };
  }

  isAtLeast(major, minor) {
    const [maj, min] = GAME_VERSION.split('.').map(Number);
    return maj > major || (maj === major && min >= minor);
  }
}

module.exports = { V1_21_50_Profile, PROTOCOL_VERSION, GAME_VERSION, PACKET_IDS, CAPABILITIES };