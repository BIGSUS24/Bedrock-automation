'use strict';

/**
 * state/reducers/health.js
 * Processes SET_HEALTH packets → updates health + hunger in state.
 *
 * SET_HEALTH (0x2A) payload:
 *   health : float32LE
 *   hunger : varuint
 *   saturation : float32LE
 */

const { readVarint } = require('../../transport/packet_router');

class HealthReducer {
  /**
   * @param {import('../index').StateManager} stateManager
   */
  constructor(stateManager) {
    this.state = stateManager;
  }

  /**
   * Process a SET_HEALTH payload buffer.
   * @param {Buffer} buf
   */
  reduce(buf) {
    if (buf.length < 4) return;

    let off = 0;
    const health = buf.readFloatLE(off); off += 4;

    let hunger = 20;
    if (off < buf.length) {
      const r = readVarint(buf, off);
      hunger = r.value;
      off += r.bytesRead;
    }

    let saturation = 5;
    if (off + 4 <= buf.length) {
      saturation = buf.readFloatLE(off);
    }

    // Clamp values
    const clampedHealth = Math.max(0, Math.min(20, health));
    const clampedHunger = Math.max(0, Math.min(20, hunger));

    this.state.setHealth(clampedHealth, clampedHunger);
    this.state.player.saturation = saturation;
    this.state.emit('healthUpdate', { health: clampedHealth, hunger: clampedHunger, saturation });
  }
}

module.exports = { HealthReducer };
