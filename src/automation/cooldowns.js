'use strict';

/**
 * automation/cooldowns.js — Per-Action Cooldown Tracking
 */

class CooldownTracker {
  constructor() {
    /** @type {Map<string, number>} action name → last fired timestamp */
    this._lastFired = new Map();
  }

  /**
   * Returns true if the action is ready to fire (cooldown expired).
   * @param {string} name
   * @param {number} cooldownMs
   */
  isReady(name, cooldownMs) {
    const last = this._lastFired.get(name);
    if (last === undefined) return true;
    return Date.now() - last >= cooldownMs;
  }

  /** Record that the action fired right now. */
  record(name) {
    this._lastFired.set(name, Date.now());
  }

  /** Remaining cooldown in ms (0 if ready). */
  remaining(name, cooldownMs) {
    const last = this._lastFired.get(name);
    if (!last) return 0;
    return Math.max(0, cooldownMs - (Date.now() - last));
  }

  /** Reset a specific action's cooldown. */
  reset(name) {
    this._lastFired.delete(name);
  }

  resetAll() {
    this._lastFired.clear();
  }
}

module.exports = { CooldownTracker };
