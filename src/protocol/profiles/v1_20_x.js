const { VersionProfile } = require('./base');

const PACKET_MAPPINGS_1_20 = {
  0x01: 'LOGIN',
  0x02: 'LOGIN_STATUS',
  0x03: 'READY',
  0x0b: 'START_GAME',
  0x0a: 'TEXT',
  0x0d: 'SET_TIME',
  0x0f: 'PLAYER_SET_HEALTH',
  0x11: 'MOVE_PLAYER',
  0x13: 'PLAYER_SET_POSITION',
  0x14: 'CONTAINER_SET_CONTENT',
  0x15: 'CONTAINER_SET_SLOT',
  0x1b: 'PLAYER_ACTION',
  0x2d: 'MOB_EQUIPMENT',
  0x2e: 'MOB_ARMOR_EQUIPMENT',
  0x31: 'INVENTORY_ACTION',
  0x32: 'ADVENTURE_SETTINGS',
  0x38: 'LEVEL_CHUNK',
  0x39: 'CAMERA',
  0x3d: 'RESPAWN',
  0x3f: 'PLAYER_INPUT',
};

const LOGIN_PACKET_V1_20 = {
  protocolVersion: 622,
  encode: (packet, buffer, offset) => {
    const { PacketSerializer } = require('../serializer');
    offset += PacketSerializer.writeVarint(buffer, packet.protocolVersion || 622, offset);
    offset += PacketSerializer.writeString(buffer, packet.gameVersion || '1.20.60', offset);
    offset += PacketSerializer.writeString(buffer, packet.username || '', offset);
    offset += PacketSerializer.writeString(buffer, packet.token || '', offset);
    return offset;
  },
};

const TEXT_PACKET_V1_20 = {
  encode: (packet, buffer, offset) => {
    const { PacketSerializer } = require('../serializer');
    offset += PacketSerializer.writeVarint(buffer, packet.type || 0, offset);
    offset += PacketSerializer.writeString(buffer, packet.source || '', offset);
    offset += PacketSerializer.writeString(buffer, packet.message || '', offset);
    offset += PacketSerializer.writeVarint(buffer, packet.isTranslation || 0, offset);
    return offset;
  },
};

const MOVE_PLAYER_V1_20 = {
  encode: (packet, buffer, offset) => {
    const { PacketSerializer } = require('../serializer');
    if (packet.position) {
      offset += PacketSerializer.writeFloat64(buffer, packet.position.x || 0, offset);
      offset += PacketSerializer.writeFloat64(buffer, packet.position.y || 0, offset);
      offset += PacketSerializer.writeFloat64(buffer, packet.position.z || 0, offset);
    }
    if (packet.rotation) {
      offset += PacketSerializer.writeFloat32(buffer, packet.rotation.pitch || 0, offset);
      offset += PacketSerializer.writeFloat32(buffer, packet.rotation.yaw || 0, offset);
      offset += PacketSerializer.writeFloat32(buffer, packet.rotation.headYaw || 0, offset);
    }
    offset += PacketSerializer.writeVarint(buffer, packet.mode || 0, offset);
    return offset;
  },
};

class V1_20_x_Profile extends VersionProfile {
  constructor(versionString = '1.20.60') {
    super(versionString);
    this.packetEncoders = this.buildEncoders();
    this.protocolVersion = 622;
  }

  buildEncoders() {
    return {
      [require('../serializer').PacketIds.LOGIN]: LOGIN_PACKET_V1_20,
      [require('../serializer').PacketIds.TEXT]: TEXT_PACKET_V1_20,
      [require('../serializer').PacketIds.MOVE_PLAYER]: MOVE_PLAYER_V1_20,
    };
  }

  getPacketName(id) {
    return PACKET_MAPPINGS_1_20[id] || `UNKNOWN_0x${id.toString(16)}`;
  }

  getProtocolVersion() {
    return 622;
  }

  getLoginPacket(username, token, gameVersion) {
    return {
      id: require('../serializer').PacketIds.LOGIN,
      data: {
        protocolVersion: 622,
        gameVersion: gameVersion || this.versionString,
        username: username,
        token: token,
      },
    };
  }

  supportsFeature(feature) {
    const features = {
      'chat-preview': false,
      'inventory-version': false,
      'player-skin': true,
      'actor-properties': false,
    };
    return features[feature] ?? false;
  }
}

module.exports = { V1_20_x_Profile, PACKET_MAPPINGS_1_20 };