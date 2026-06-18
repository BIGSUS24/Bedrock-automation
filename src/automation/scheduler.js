'use strict';

/**
 * automation/scheduler.js — Tick-based Action Scheduler
 *
 * The scheduler evaluates conditions every tick and queues actions.
 * Actions write packets through the protocol queue ONLY — never directly.
 *
 * Action flow:
 *   1. Tick fires (configurable interval)
 *   2. Scheduler evaluates each registered action's condition
 *   3. If condition passes AND cooldown expired → action.execute() called
 *   4. Action builds packet → protocol.sendPacket() or queue.enqueue()
 */

const EventEmitter = require('events');
const { CooldownTracker } = require('./cooldowns');

const DEFAULT_TICK_MS = 50; // 20 ticks/sec

class Scheduler extends EventEmitter {
  /**
   * @param {import('../state/index').StateManager} stateManager
   * @param {object} protocolClient   BedrockProtocolClient
   * @param {number} [tickMs]
   */
  constructor(stateManager, protocolClient, tickMs = DEFAULT_TICK_MS) {
    super();
    this.state    = stateManager;
    this.protocol = protocolClient;
    this.tickMs   = tickMs;

    /** @type {Map<string, RegisteredAction>} */
    this.actions  = new Map();
    this.cooldowns = new CooldownTracker();

    this._tickTimer = null;
    this._running   = false;
    this._tickCount = 0n;
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Register an action with the scheduler.
   *
   * @param {string}   name         Unique action name
   * @param {Function} condition    (state) => boolean  — should this action fire?
   * @param {Function} execute      async (state, protocol, tickCount) => void
   * @param {number}   cooldownMs   Minimum ms between executions
   */
  register(name, condition, execute, cooldownMs = 1000) {
    this.actions.set(name, { name, condition, execute, cooldownMs });
  }

  unregister(name) {
    this.actions.delete(name);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running   = true;
    this._tickCount = 0n;
    this._tick();
    this.emit('started');
  }

  stop() {
    this._running = false;
    if (this._tickTimer) {
      clearTimeout(this._tickTimer);
      this._tickTimer = null;
    }
    this.emit('stopped');
  }

  isRunning() { return this._running; }

  // ── Tick ──────────────────────────────────────────────────────────────────

  _tick() {
    if (!this._running) return;

    this._evaluate().finally(() => {
      if (this._running) {
        this._tickTimer = setTimeout(() => this._tick(), this.tickMs);
      }
    });
  }

  async _evaluate() {
    this._tickCount++;

    for (const [name, action] of this.actions) {
      try {
        // Check condition
        if (!action.condition(this.state)) continue;

        // Check cooldown
        if (!this.cooldowns.isReady(name, action.cooldownMs)) continue;

        // Execute action. Record the cooldown AFTER it completes so long-running
        // actions (e.g. a sell cycle) wait the full interval from completion, and
        // a thrown action still gets its cooldown (no hot-loop retry).
        try {
          await action.execute(this.state, this.protocol, this._tickCount);
          this.emit('actionFired', { name, tick: this._tickCount });
        } finally {
          this.cooldowns.record(name);
        }
      } catch (e) {
        this.emit('actionError', { name, error: e.message });
      }
    }
  }

  getRegisteredActions() {
    return [...this.actions.keys()];
  }
}

/** @typedef {{ name: string, condition: Function, execute: Function, cooldownMs: number }} RegisteredAction */

module.exports = { Scheduler, DEFAULT_TICK_MS };
