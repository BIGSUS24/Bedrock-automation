'use strict';

/**
 * automation/legacy_manager.js
 * Original interval-based AutomationManager — kept for backwards compatibility.
 * New code should use the Scheduler from automation/scheduler.js.
 */

const EventEmitter = require('events');

class AutomationManager extends EventEmitter {
  constructor(config, stateManager, actionCallback) {
    super();
    this.config         = config;
    this.state          = stateManager;
    this.actionCallback = actionCallback;
    this.intervals      = {};
    this.enabled        = config?.automation?.enabled ?? false;
    this.active         = false;
  }

  start() {
    if (!this.enabled) return;
    this.active = true;
    this.state.setAutomationActive(true);
    this._setupActions();
    this.emit('started');
  }

  stop() {
    this.active = false;
    this.state?.setAutomationActive(false);
    this._clearIntervals();
    this.emit('stopped');
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled && !this.active)  this.start();
    else if (!enabled && this.active) this.stop();
  }

  _setupActions() {
    const actions = this.config?.automation?.actions || {};

    if (actions.jump?.enabled) {
      this.intervals.jump = setInterval(() => {
        if (this.active) this._perform('jump');
      }, actions.jump.interval || 5000);
    }

    if (actions.move?.enabled) {
      this.intervals.move = setInterval(() => {
        if (this.active) this._perform('move', { distance: actions.move.distance });
      }, actions.move.interval || 1000);
    }

    if (actions.autoEat?.enabled) {
      this.intervals.autoEat = setInterval(() => {
        if (this.active) this._checkAutoEat(actions.autoEat.hungerThreshold ?? 17);
      }, 2000);
    }

    if (actions.periodicChat?.enabled && actions.periodicChat.messages?.length > 0) {
      let idx = 0;
      const msgs = actions.periodicChat.messages;
      this.intervals.periodicChat = setInterval(() => {
        if (this.active) {
          this._perform('chat', { message: msgs[idx % msgs.length] });
          idx++;
        }
      }, actions.periodicChat.interval || 60000);
    }
  }

  _clearIntervals() {
    for (const key of Object.keys(this.intervals)) {
      if (this.intervals[key]) {
        clearInterval(this.intervals[key]);
        this.intervals[key] = null;
      }
    }
  }

  async _perform(type, data = {}) {
    try {
      if (this.actionCallback) await this.actionCallback(type, data);
      this.state.automation.lastActionTime = Date.now();
      this.state.recordAction();
      this.emit('action', { type, data });
    } catch (err) {
      this.emit('actionError', { type, error: err.message });
    }
  }

  // Keep original public name for callers
  async performAction(type, data = {}) { return this._perform(type, data); }

  _checkAutoEat(threshold) {
    if ((this.state.player.hunger ?? 20) <= threshold) {
      this._perform('autoEat');
    }
  }

  onPlayerStateChange(playerState) { this.state.setPlayerInfo(playerState); }

  isActive()  { return this.active; }

  getStatus() {
    return {
      enabled: this.enabled,
      active:  this.active,
      runningActions: Object.keys(this.intervals).filter((k) => this.intervals[k] !== null),
    };
  }
}

module.exports = { AutomationManager };
