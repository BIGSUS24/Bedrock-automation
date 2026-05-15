'use strict';

/**
 * cleanup.js — Ordered Session Teardown
 *
 * MANDATORY teardown order before any reconnect:
 *   1. Stop automation (no more actions fired)
 *   2. Pause outgoing queue (no new sends)
 *   3. Flush outgoing queue (discard pending items)
 *   4. Close/cleanup protocol session
 *   5. Remove all protocol event listeners
 *   6. Wait a tick (let pending async ops settle)
 *
 * Only CleanupManager performs teardown.
 * No other module should call cleanup directly.
 */

class CleanupManager {
  /**
   * @param {object} refs
   * @param {object} refs.automation   AutomationManager instance
   * @param {object} refs.queue        OutgoingQueue instance
   * @param {object} refs.protocol     BedrockProtocolClient instance
   */
  constructor(refs) {
    this.automation = refs.automation;
    this.queue      = refs.queue;
    this.protocol   = refs.protocol;
  }

  /**
   * Perform the full ordered teardown.
   * Returns a promise that resolves when teardown is complete.
   *
   * @param {string} [reason='reconnect']
   */
  async perform(reason = 'reconnect') {
    const steps = [
      ['Stop automation',           () => this._stopAutomation()],
      ['Pause outgoing queue',      () => this._pauseQueue()],
      ['Flush outgoing queue',      () => this._flushQueue()],
      ['Close protocol session',    () => this._closeProtocol(reason)],
      ['Settle async ops',          () => this._settle()],
    ];

    for (const [name, fn] of steps) {
      try {
        await fn();
      } catch (e) {
        console.warn(`[Cleanup] Step "${name}" failed: ${e.message}`);
        // Continue — teardown must complete all steps
      }
    }
  }

  _stopAutomation() {
    if (this.automation && typeof this.automation.stop === 'function') {
      this.automation.stop();
    }
  }

  _pauseQueue() {
    if (this.queue && typeof this.queue.pause === 'function') {
      this.queue.pause();
    }
  }

  _flushQueue() {
    if (this.queue && typeof this.queue.flush === 'function') {
      this.queue.flush();
    }
  }

  _closeProtocol(reason) {
    if (this.protocol && typeof this.protocol.cleanup === 'function') {
      this.protocol.cleanup();
    }
    if (this.protocol?.session && typeof this.protocol.session.disconnect === 'function') {
      this.protocol.session.disconnect(reason);
    }
  }

  _settle() {
    return new Promise((r) => setImmediate(r));
  }
}

module.exports = { CleanupManager };
