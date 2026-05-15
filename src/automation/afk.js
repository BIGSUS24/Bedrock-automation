'use strict';

/**
 * automation/afk.js — Anti-AFK system
 *
 * Sends periodic jump + random head movement to prevent AFK kicks.
 */

class AfkManager {
  constructor(protocol, state) {
    this.protocol = protocol;
    this.state = state;
    this.active = false;
    this.jumpInterval = 30;  // seconds
    this.jumpCount = 0;
    this._jumpTimer = null;
    this._lookTimer = null;
  }

  start() {
    if (this.active) return;
    this.active = true;

    // Jump periodically
    this._jumpTimer = setInterval(() => {
      this._sendJump();
    }, this.jumpInterval * 1000);

    // Random look every 10-20 seconds
    this._scheduleLook();
  }

  stop() {
    this.active = false;
    if (this._jumpTimer) { clearInterval(this._jumpTimer); this._jumpTimer = null; }
    if (this._lookTimer) { clearTimeout(this._lookTimer); this._lookTimer = null; }
  }

  setJumpInterval(seconds) {
    this.jumpInterval = Math.max(5, Math.min(300, seconds));
    if (this.active) {
      // Restart with new interval
      this.stop();
      this.start();
    }
  }

  getStatus() {
    return {
      active: this.active,
      jumpInterval: this.jumpInterval,
      jumpCount: this.jumpCount,
    };
  }

  _sendJump() {
    if (!this.protocol.isConnected() || !this.protocol._client) return;

    try {
      const entityId = this.state.player?.entityRuntimeId;
      if (!entityId) return;

      // Send player action: JUMP (action_id = 8 in MCPE)
      this.protocol._client.queue('player_action', {
        runtime_entity_id: entityId,
        action:            'jump',
        position:          { x: 0, y: 0, z: 0 },
        result_position:   { x: 0, y: 0, z: 0 },
        face:              0,
      });

      this.jumpCount++;
    } catch {}
  }

  _sendRandomLook() {
    if (!this.protocol.isConnected() || !this.protocol._client) return;

    try {
      const pos = this.state.player?.position;
      if (!pos) return;

      // Random yaw change (-30 to +30 degrees)
      const currentYaw = this.state.player?.rotation?.yaw ?? 0;
      const yaw = currentYaw + (Math.random() - 0.5) * 60;
      const pitch = (Math.random() - 0.5) * 20;

      if (this.state.player) {
        this.state.player.rotation = { pitch, yaw };
      }

      if (typeof this.protocol._sendPlayerAuthInput === 'function') {
        this.protocol._sendPlayerAuthInput();
      }
    } catch {}
  }

  _scheduleLook() {
    if (!this.active) return;
    const delay = 10000 + Math.random() * 10000; // 10-20 seconds
    this._lookTimer = setTimeout(() => {
      this._sendRandomLook();
      this._scheduleLook();
    }, delay);
  }
}

module.exports = { AfkManager };
