'use strict';

/**
 * state/reducers/position.js
 * Processes MOVE_PLAYER / SET_PLAYER_POSITION packets → updates position/rotation in state.
 *
 * MOVE_PLAYER payload parsed by MovementSerializer.
 * Only position + rotation are extracted; the reducer does NOT send any packets.
 */

const { MovementSerializer } = require('../../protocol/serializers/movement');

class PositionReducer {
  constructor(stateManager) {
    this.state = stateManager;
  }

  /**
   * Reduce a MovePlayer payload.
   * @param {Buffer} buf
   */
  reduceMovePlayer(buf) {
    try {
      const data = MovementSerializer.deserialize(buf);
      const { x, y, z } = data.position;
      this.state.setPosition(x, y, z);
      this.state.setRotation(data.yaw, data.pitch);
      this.state.player.onGround = data.onGround;
      this.state.emit('positionUpdate', { x, y, z, yaw: data.yaw, pitch: data.pitch, onGround: data.onGround });
    } catch (e) {
      // Malformed packet — do not update state
    }
  }

  /**
   * Reduce a simpler position-only packet (e.g. teleport with x/y/z floats).
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  reducePosition(x, y, z) {
    this.state.setPosition(x, y, z);
    this.state.emit('positionUpdate', { x, y, z });
  }

  getPosition() { return { ...this.state.player.position }; }
  getRotation() { return { ...this.state.player.rotation }; }
  isOnGround()  { return this.state.player.onGround === true; }
}

module.exports = { PositionReducer };
