'use strict';

/**
 * state_machine.js — Reconnect State Machine
 *
 * States:
 *   IDLE          → not reconnecting; connected or stopped
 *   WAITING       → backoff timer running before next attempt
 *   TEARING_DOWN  → running ordered cleanup sequence
 *   RECONNECTING  → protocol.connect() in progress
 *   CONNECTED     → successfully reconnected
 *   FAILED        → max retries exceeded
 *
 * Only ONE reconnect cycle may be active at a time.
 * Only ReconnectManager drives state transitions.
 * All other modules MUST emit events rather than calling reconnect directly.
 */

const EventEmitter       = require('events');
const { BackoffCalculator } = require('./backoff');
const { CleanupManager } = require('./cleanup');

const ReconnectState = {
  IDLE:         'idle',
  WAITING:      'waiting',
  TEARING_DOWN: 'tearing_down',
  RECONNECTING: 'reconnecting',
  CONNECTED:    'connected',
  FAILED:       'failed',
};

class ReconnectStateMachine extends EventEmitter {
  /**
   * @param {object} config       Full bot config
   * @param {object} stateManager StateManager instance
   * @param {object} protocol     BedrockProtocolClient instance
   * @param {object} [refs]       { automation, queue } for CleanupManager
   */
  constructor(config, stateManager, protocol, refs = {}) {
    super();
    this.config      = config.reconnect || {};
    this.state       = stateManager;
    this.protocol    = protocol;
    this.backoff     = new BackoffCalculator({
      baseDelay:    this.config.baseDelay    || 1000,
      maxDelay:     this.config.maxDelay     || 60_000,
      multiplier:   this.config.multiplier   || 2,
      jitterRange:  this.config.jitterRange  || 500,
    });
    this.cleanup     = new CleanupManager({
      automation: refs.automation,
      queue:      refs.queue,
      protocol,
    });

    this._currentState = ReconnectState.IDLE;
    this._retryCount   = 0;
    this._waitTimer    = null;
    this._maxRetries   = this.config.maxRetries ?? 10;
    this._enabled      = this.config.enabled    !== false;
    this._lastDisconnectAt = 0;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getCurrentState() { return this._currentState; }
  getRetryCount()   { return this._retryCount; }
  isActive()        { return this._currentState !== ReconnectState.IDLE &&
                             this._currentState !== ReconnectState.CONNECTED &&
                             this._currentState !== ReconnectState.FAILED; }

  /**
   * Trigger a reconnect cycle. Safe to call multiple times — idempotent.
   * @param {string} [reason]
   */
  async trigger(reason = 'disconnected') {
    if (!this._enabled) {
      this.emit('disabled');
      return;
    }

    // Debounce: ignore if a cycle is already running
    if (this._currentState !== ReconnectState.IDLE &&
        this._currentState !== ReconnectState.CONNECTED) {
      return;
    }

    // Debounce rapid triggers (< 500ms)
    const now = Date.now();
    if (now - this._lastDisconnectAt < 500) return;
    this._lastDisconnectAt = now;

    if (this._retryCount >= this._maxRetries) {
      this._transition(ReconnectState.FAILED);
      this.emit('maxRetriesReached', { retryCount: this._retryCount, max: this._maxRetries });
      return;
    }

    if (this.backoff.isRateLimited()) {
      console.warn('[Reconnect] Rate limit hit — pausing reconnect for 60s');
      this._transition(ReconnectState.WAITING);
      await sleep(60_000);
    }

    await this._runCycle(reason);
  }

  /** Permanently stop reconnecting (e.g. user-initiated disconnect). */
  stop() {
    this._cancelWait();
    this._transition(ReconnectState.IDLE);
    this._retryCount = 0;
    this.backoff.reset();
  }

  /** Reset retry counter (call after successful reconnect). */
  reset() {
    this._retryCount = 0;
    this.backoff.reset();
    this._transition(ReconnectState.CONNECTED);
  }

  getBackoffDelay() {
    return this.backoff.calculate(this._retryCount);
  }

  // ── Internal cycle ─────────────────────────────────────────────────────────

  async _runCycle(reason) {
    // ── Step 1: WAITING (backoff) ──
    const delay = this.backoff.calculate(this._retryCount);
    const rateLimitHit = this.backoff.recordAttempt();

    this._transition(ReconnectState.WAITING);
    this.emit('reconnectScheduled', {
      delay,
      retryCount:   this._retryCount + 1,
      maxRetries:   this._maxRetries,
      rateLimitHit,
    });

    await this._wait(delay);
    if (this._currentState !== ReconnectState.WAITING) return; // cancelled

    // ── Step 2: TEARING DOWN ──
    this._transition(ReconnectState.TEARING_DOWN);
    this.emit('tearingDown');
    await this.cleanup.perform(reason);

    // ── Step 3: RECONNECTING ──
    this._transition(ReconnectState.RECONNECTING);
    this.emit('reconnecting', { retryCount: this._retryCount + 1 });

    try {
      await this.protocol.connect();
      this._retryCount = 0;
      this.backoff.reset();
      this._transition(ReconnectState.CONNECTED);
      this.emit('reconnectSuccess', { retryCount: this._retryCount });
    } catch (err) {
      this._retryCount++;
      this._transition(ReconnectState.IDLE);
      this.state.setDisconnectReason(err.message);

      this.emit('reconnectFailed', {
        error:      err.message,
        retryCount: this._retryCount,
        maxRetries: this._maxRetries,
      });

      // Schedule next attempt if retries remain
      if (this._retryCount < this._maxRetries) {
        setImmediate(() => this._runCycle('retry'));
      } else {
        this._transition(ReconnectState.FAILED);
        this.emit('maxRetriesReached', { retryCount: this._retryCount, max: this._maxRetries });
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _transition(newState) {
    const old = this._currentState;
    this._currentState = newState;
    this.emit('stateChange', { from: old, to: newState });
    this.state.setStatus(newState === ReconnectState.CONNECTED ? 'connected' : newState);
  }

  _wait(ms) {
    return new Promise((resolve) => {
      this._waitTimer = setTimeout(() => {
        this._waitTimer = null;
        resolve();
      }, ms);
    });
  }

  _cancelWait() {
    if (this._waitTimer) {
      clearTimeout(this._waitTimer);
      this._waitTimer = null;
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { ReconnectStateMachine, ReconnectState };
