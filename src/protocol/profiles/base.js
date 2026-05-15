const { PacketIds, PacketSerializer } = require('../serializer');

class VersionProfile {
  constructor(versionString) {
    this.versionString = versionString;
    this.parts = this.parseVersion(versionString);
    this.family = `${this.parts.major}.${this.parts.minor}`;
    this.packetRegistry = this.buildPacketRegistry();
  }

  parseVersion(versionString) {
    const match = versionString.match(/^(\d+)\.(\d+)\.?(\d*)/);
    if (!match) {
      return { major: 0, minor: 0, patch: 0 };
    }
    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: match[3] ? parseInt(match[3], 10) : 0,
    };
  }

  buildPacketRegistry() {
    return {
      [PacketIds.LOGIN]: this.handleLogin.bind(this),
      [PacketIds.LOGIN_STATUS]: this.handleLoginStatus.bind(this),
      [PacketIds.START_GAME]: this.handleStartGame.bind(this),
      [PacketIds.PLAYER_SET_POSITION]: this.handlePlayerPosition.bind(this),
      [PacketIds.PLAYER_SET_HEALTH]: this.handlePlayerHealth.bind(this),
      [PacketIds.TEXT]: this.handleText.bind(this),
      [PacketIds.CONTAINER_SET_CONTENT]: this.handleInventory.bind(this),
      [PacketIds.MOVE_PLAYER]: this.handleMovePlayer.bind(this),
    };
  }

  handleLogin(packet) {
    return packet;
  }

  handleLoginStatus(packet) {
    return packet;
  }

  handleStartGame(packet) {
    return packet;
  }

  handlePlayerPosition(packet) {
    return packet;
  }

  handlePlayerHealth(packet) {
    return packet;
  }

  handleText(packet) {
    return packet;
  }

  handleInventory(packet) {
    return packet;
  }

  handleMovePlayer(packet) {
    return packet;
  }

  getLoginPacket(username, token, gameVersion) {
    return {
      id: PacketIds.LOGIN,
      data: {
        protocolVersion: this.getProtocolVersion(),
        gameVersion: gameVersion || this.versionString,
        username: username,
        token: token,
      },
    };
  }

  getProtocolVersion() {
    return this.getVersionSpecificField('protocolVersion', 622);
  }

  getVersionSpecificField(field, defaultValue) {
    const versionMap = {
      '1.20': { protocolVersion: 622 },
      '1.21': { protocolVersion: 648 },
      '1.22': { protocolVersion: 656 },
      '1.23': { protocolVersion: 660 },
      '1.24': { protocolVersion: 665 },
      '1.25': { protocolVersion: 670 },
      '1.26': { protocolVersion: 678 },
    };

    return versionMap[this.family]?.[field] ?? defaultValue;
  }

  supportsFeature(feature) {
    const features = {
      'chat-preview': this.isAtLeast(1, 21),
      'inventory-version': this.isAtLeast(1, 21),
      'player-skin': this.isAtLeast(1, 20),
      'actor-properties': this.isAtLeast(1, 21),
    };

    return features[feature] ?? false;
  }

  isAtLeast(major, minor = 0) {
    if (this.parts.major > major) return true;
    if (this.parts.major === major && this.parts.minor >= minor) return true;
    return false;
  }

  isCompatible(profile) {
    return this.family === profile.family;
  }

  getSerializer() {
    return PacketSerializer;
  }

  serialize(packet) {
    return PacketSerializer.writePacket(packet);
  }

  deserialize(buffer) {
    return PacketSerializer.readPacket(buffer);
  }
}

module.exports = { VersionProfile };