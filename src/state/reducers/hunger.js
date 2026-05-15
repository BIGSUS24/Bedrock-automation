'use strict';

/**
 * state/reducers/hunger.js
 * Alias for the hunger portion of SET_HEALTH — delegates to HealthReducer.
 * Exists as a separate module so automation can import only what it needs.
 */

class HungerReducer {
  constructor(stateManager) {
    this.state = stateManager;
  }

  /** Called after HealthReducer runs (or standalone if hunger data available). */
  reduce({ hunger, saturation } = {}) {
    if (hunger !== undefined) {
      this.state.player.hunger = Math.max(0, Math.min(20, hunger));
    }
    if (saturation !== undefined) {
      this.state.player.saturation = Math.max(0, saturation);
    }
    this.state.emit('hungerUpdate', {
      hunger:     this.state.player.hunger,
      saturation: this.state.player.saturation,
    });
  }

  getHunger()     { return this.state.player.hunger; }
  getSaturation() { return this.state.player.saturation || 5; }
  isHungry(threshold = 17) { return this.getHunger() <= threshold; }
}

module.exports = { HungerReducer };
