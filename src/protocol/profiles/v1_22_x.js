const { VersionProfile } = require('./base');

const PACKET_MAPPINGS_1_22 = {
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
  0x50: 'FULL_CRYPTO',
  0x53: 'NETWORK_SETTINGS',
};

const LOGIN_PACKET_V1_22 = {
  protocolVersion: 678,
  encode: (packet, buffer, offset) => {
    const { PacketSerializer } = require('../serializer');
    offset += PacketSerializer.writeVarint(buffer, packet.protocolVersion || 678, offset);
    offset += PacketSerializer.writeString(buffer, packet.gameVersion || '1.22.0', offset);
    offset += PacketSerializer.writeString(buffer, packet.username || '', offset);
    offset += PacketSerializer.writeString(buffer, packet.token || '', offset);
    return offset;
  },
};

const TEXT_PACKET_V1_22 = {
  encode: (packet, buffer, offset) => {
    const { PacketSerializer } = require('../serializer');
    offset += PacketSerializer.writeVarint(buffer, packet.type || 0, offset);
    offset += PacketSerializer.writeString(buffer, packet.source || '', offset);
    offset += PacketSerializer.writeString(buffer, packet.message || '', offset);
    offset += PacketSerializer.writeVarint(buffer, packet.isTranslation || 0, offset);
    if (packet.parameters) {
      offset += PacketSerializer.writeVarint(buffer, packet.parameters.length, offset);
      for (const param of packet.parameters) {
        offset += PacketSerializer.writeString(buffer, param, offset);
      }
    }
    return offset;
  },
};

const MOVE_PLAYER_V1_22 = {
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
    offset += PacketSerializer.writeVarint(packet.unknown || 0, offset);
    return offset;
  },
};

class V1_22_x_Profile extends VersionProfile {
  constructor(versionString = '1.22.50') {
    super(versionString);
    this.packetEncoders = this.buildEncoders();
    this.protocolVersion = this.getProtocolVersionForMinor();
  }

  getProtocolVersionForMinor() {
    const versionMap = {
      '1.22': 656,
      '1.23': 660,
      '1.24': 665,
      '1.25': 670,
      '1.26': 678,
    };
    return versionMap[this.family] || 678;
  }

  buildEncoders() {
    return {
      [require('../serializer').PacketIds.LOGIN]: LOGIN_PACKET_V1_22,
      [require('../serializer').PacketIds.TEXT]: TEXT_PACKET_V1_22,
      [require('../serializer').PacketIds.MOVE_PLAYER]: MOVE_PLAYER_V1_22,
    };
  }

  getPacketName(id) {
    return PACKET_MAPPINGS_1_22[id] || `UNKNOWN_0x${id.toString(16)}`;
  }

  getProtocolVersion() {
    return this.protocolVersion;
  }

  getLoginPacket(username, token, gameVersion) {
    return {
      id: require('../serializer').PacketIds.LOGIN,
      data: {
        protocolVersion: this.protocolVersion,
        gameVersion: gameVersion || this.versionString,
        username: username,
        token: token,
      },
    };
  }

  supportsFeature(feature) {
    const features = {
      'chat-preview': true,
      'inventory-version': true,
      'player-skin': true,
      'actor-properties': true,
      'network-settings': this.isAtLeast(1, 22),
    };
    return features[feature] ?? false;
  }
}

module.exports = { V1_22_x_Profile, PACKET_MAPPINGS_1_22 };