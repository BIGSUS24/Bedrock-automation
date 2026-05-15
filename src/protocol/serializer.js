const PacketIds = {
  LOGIN: 0x01,
  LOGIN_STATUS: 0x02,
  READY: 0x03,
  CHUNK_CACHE_NOTIFY: 0x04,
  LEVEL_CHUNK: 0x38,
  START_GAME: 0x0b,
  SET_TIME: 0x0d,
  PLAYER_SET_POSITION: 0x13,
  PLAYER_SET_HEALTH: 0x0f,
  TEXT: 0x0a,
  MOVE_PLAYER: 0x11,
  ADVENTURE_SETTINGS: 0x32,
  INVENTORY_ACTION: 0x31,
  CONTAINER_SET_CONTENT: 0x14,
  CONTAINER_SET_SLOT: 0x15,
  PLAYER_ACTION: 0x1b,
  MOB_EQUIPMENT: 0x2d,
  MOB_ARMOR_EQUIPMENT: 0x2e,
  INTERACT: 0x1a,
  BLOCK_ENTITY_DATA: 0x24,
  SET_ENTITY_DATA: 0x27,
  SET_ENTITY_MOTION: 0x28,
  EXPLODE: 0x1c,
  CAMERA: 0x39,
  RESPAWN: 0x3d,
  PLAYER_INPUT: 0x3f,
  FULL_CRYPTO: 0x50,
  PING: 0x00,
  PONG: 0x03,
};

class PacketSerializer {
  static writeVarint(buffer, value, offset = 0) {
    let bytesWritten = 0;
    value = BigInt(value);

    while (value > 0x7fn) {
      buffer[offset + bytesWritten] = Number((value & 0xffn) | 0x80n);
      value >>= 7n;
      bytesWritten++;
    }

    buffer[offset + bytesWritten] = Number(value);
    bytesWritten++;

    return bytesWritten;
  }

  static readVarint(buffer, offset = 0) {
    let result = 0n;
    let bytesRead = 0;
    let shift = 0n;

    while (true) {
      if (offset + bytesRead >= buffer.length) {
        throw new Error('Varint read beyond buffer');
      }

      const byte = buffer[offset + bytesRead];
      bytesRead++;

      result |= BigInt(byte & 0x7f) << shift;

      if ((byte & 0x80) === 0) {
        break;
      }

      shift += 7n;
    }

    return { value: result, bytesRead };
  }

  static writeString(buffer, str, offset = 0) {
    const bytes = Buffer.from(str, 'utf8');
    const lenBytes = this.writeVarint(buffer, bytes.length, offset);
    bytes.copy(buffer, offset + lenBytes);
    return lenBytes + bytes.length;
  }

  static readString(buffer, offset = 0) {
    const { value: length, bytesRead: lenBytes } = this.readVarint(buffer, offset);
    const lengthNum = Number(length);

    if (offset + lenBytes + lengthNum > buffer.length) {
      throw new Error('String read beyond buffer');
    }

    const str = buffer.slice(offset + lenBytes, offset + lenBytes + lengthNum).toString('utf8');
    return { value: str, bytesRead: lenBytes + lengthNum };
  }

  static writePacket(packet) {
    const estimatedSize = 4096;
    const buffer = Buffer.alloc(estimatedSize);
    let offset = 0;

    offset += this.writeVarint(buffer, packet.id, offset);

    if (packet.data) {
      const dataSize = this.writePacketData(packet.id, packet.data, buffer, offset);
      offset += dataSize;
    }

    return buffer.slice(0, offset);
  }

  static writePacketData(packetId, data, buffer, offset) {
    let written = 0;

    switch (packetId) {
      case PacketIds.LOGIN:
        written += this.writeVarint(buffer, data.protocolVersion || 0, offset + written);
        written += this.writeString(buffer, data.gameVersion || '', offset + written);
        written += this.writeString(buffer, data.username || '', offset + written);
        written += this.writeString(buffer, data.token || '', offset + written);
        break;

      case PacketIds.TEXT:
        written += this.writeVarint(buffer, data.type || 0, offset + written);
        written += this.writeString(buffer, data.source || '', offset + written);
        written += this.writeString(buffer, data.message || '', offset + written);
        written += this.writeVarint(buffer, data.isTranslation || 0, offset + written);
        break;

      case PacketIds.PLAYER_SET_POSITION:
        written += this.writeFloat64(buffer, data.x || 0, offset + written);
        written += this.writeFloat64(buffer, data.y || 0, offset + written);
        written += this.writeFloat64(buffer, data.z || 0, offset + written);
        written += this.writeVarint(buffer, data.pitch || 0, offset + written);
        written += this.writeVarint(buffer, data.yaw || 0, offset + written);
        break;

      case PacketIds.PLAYER_ACTION:
        written += this.writeVarint(buffer, data.action || 0, offset + written);
        written += this.writeVarint(buffer, data.position?.x || 0, offset + written);
        written += this.writeVarint(buffer, data.position?.y || 0, offset + written);
        written += this.writeVarint(buffer, data.position?.z || 0, offset + written);
        written += this.writeVarint(buffer, data.face || 0, offset + written);
        break;

      case PacketIds.INVENTORY_ACTION:
        written += this.writeVarint(buffer, data.transactionId || 0, offset + written);
        written += this.writeVarint(buffer, data.actionType || 0, offset + written);
        if (data.slot) {
          written += this.writeVarint(buffer, data.slot.slot || 0, offset + written);
          written += this.writeVarint(buffer, data.slot.count || 0, offset + written);
          written += this.writeVarint(buffer, data.slot.networkId || 0, offset + written);
        }
        break;

      case PacketIds.MOVE_PLAYER:
        written += this.writeFloat64(buffer, data.position?.x || 0, offset + written);
        written += this.writeFloat64(buffer, data.position?.y || 0, offset + written);
        written += this.writeFloat64(buffer, data.position?.z || 0, offset + written);
        written += this.writeFloat32(buffer, data.rotation?.pitch || 0, offset + written);
        written += this.writeFloat32(buffer, data.rotation?.yaw || 0, offset + written);
        written += this.writeFloat32(buffer, data.rotation?.yaw || 0, offset + written);
        written += this.writeVarint(buffer, data.mode || 0, offset + written);
        break;

      default:
        if (data.raw) {
          data.raw.copy(buffer, offset);
          written += data.raw.length;
        }
    }

    return written;
  }

  static readPacket(buffer, offset = 0) {
    const { value: packetId, bytesRead: idBytes } = this.readVarint(buffer, offset);

    let data = {};
    let dataBytes = 0;

    try {
      const result = this.readPacketData(Number(packetId), buffer, offset + idBytes);
      data = result.data;
      dataBytes = result.bytesRead;
    } catch (e) {
      console.warn(`Failed to parse packet ${packetId}:`, e.message);
    }

    return {
      id: Number(packetId),
      data,
      totalBytes: idBytes + dataBytes,
    };
  }

  static readPacketData(packetId, buffer, offset) {
    let data = {};
    let bytesRead = 0;

    switch (packetId) {
      case PacketIds.LOGIN_STATUS:
        const { value: chain, bytesRead: chainBytes } = this.readVarint(buffer, offset);
        bytesRead += chainBytes;
        data.chain = chain.toString();
        break;

      case PacketIds.TEXT:
        const msgType = this.readVarint(buffer, offset);
        bytesRead += msgType.bytesRead;
        data.type = Number(msgType.value);

        const source = this.readString(buffer, offset + bytesRead);
        bytesRead += source.bytesRead;
        data.source = source.value;

        const message = this.readString(buffer, offset + bytesRead);
        bytesRead += message.bytesRead;
        data.message = message.value;
        break;

      case PacketIds.START_GAME:
        data.entityId = this.readVarint(buffer, offset);
        bytesRead += data.entityId.bytesRead;

        const gameVersion = this.readString(buffer, offset + bytesRead);
        bytesRead += gameVersion.bytesRead;
        data.gameVersion = gameVersion.value;
        break;

      case PacketIds.PLAYER_SET_POSITION:
        data.x = this.readFloat64(buffer, offset);
        bytesRead += 8;

        data.y = this.readFloat64(buffer, offset + 8);
        bytesRead += 8;

        data.z = this.readFloat64(buffer, offset + 16);
        bytesRead += 8;
        break;

      case PacketIds.PLAYER_SET_HEALTH:
        const health = this.readFloat32(buffer, offset);
        bytesRead += 4;
        data.health = health;
        break;

      case PacketIds.CONTAINER_SET_CONTENT:
        const windowId = this.readVarint(buffer, offset);
        bytesRead += windowId.bytesRead;
        data.windowId = Number(windowId.value);
        break;

      case PacketIds.MOVE_PLAYER:
        data.position = {
          x: this.readFloat64(buffer, offset),
          y: this.readFloat64(buffer, offset + 8),
          z: this.readFloat64(buffer, offset + 16),
        };
        bytesRead += 24;

        data.rotation = {
          pitch: this.readFloat32(buffer, offset + 24),
          yaw: this.readFloat32(buffer, offset + 28),
          headYaw: this.readFloat32(buffer, offset + 32),
        };
        bytesRead += 12;
        break;

      default:
        data.raw = buffer.slice(offset);
        bytesRead = data.raw.length;
    }

    return { data, bytesRead };
  }

  static writeFloat32(buffer, value, offset) {
    buffer.writeFloatLE(value, offset);
    return 4;
  }

  static writeFloat64(buffer, value, offset) {
    buffer.writeDoubleLE(value, offset);
    return 8;
  }

  static readFloat32(buffer, offset) {
    return buffer.readFloatLE(offset);
  }

  static readFloat64(buffer, offset) {
    return buffer.readDoubleLE(offset);
  }
}

module.exports = { PacketSerializer, PacketIds };