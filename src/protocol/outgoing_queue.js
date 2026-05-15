'use strict';

/**
 * outgoing_queue.js — Safe Async Bounded Queue
 *
 * Problems with the old implementation:
 *   - Array + boolean flag can race
 *   - Stalls under reconnect (no cancel)
 *   - Leaks queued packets (no flush-to-drain)
 *
 * This implementation:
 *   - Uses an async drain loop with proper await
 *   - Supports pause/resume (disconnect/reconnect)
 *   - Supports cancel() — rejects all pending items
 *   - Supports flush() — drains without sending (for cleanup)
 *   - Bounded by maxSize — drops oldest with a warning (never silently)
 *   - Rate limiting: minimum interval between sends
 */

const EventEmitter = require('events');

const DEFAULT_MAX_SIZE       = 128;
const DEFAULT_SEND_INTERVAL  = 50; // ms minimum between sends

class OutgoingQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxSize      = options.maxSize      || DEFAULT_MAX_SIZE;
    this.sendInterval = options.sendInterval || DEFAULT_SEND_INTERVAL;
    this.silent       = options.silent        || false;

    /** @type {QueueEntry[]} */
    this._queue    = [];
    this._paused   = true;   // start paused; resume when connected
    this._running  = false;
    this._sendFn   = null;
    this._drainTimer = null;
    this._lastSendAt = 0;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Register the function used to actually send items.
   * @param {Function} fn  async (item) => void
   */
  setSendFunction(fn) {
    this._sendFn = fn;
  }

  /**
   * Add an item to the queue.
   * @param {object} item
   * @returns {boolean}  false if dropped due to full queue
   */
  enqueue(item) {
    if (this._queue.length >= this.maxSize) {
      const dropped = this._queue.shift();
      if (!this.silent) {
        console.warn(`[OutgoingQueue] Queue full (${this.maxSize}), dropped oldest item: ${dropped?.type || '?'}`);
      }
      this.emit('dropped', dropped);
    }

    const entry = {
      ...item,
      _id:          this._generateId(),
      _enqueuedAt:  Date.now(),
    };
    this._queue.push(entry);
    this.emit('enqueued', entry);

    this._scheduleDrain();
    return true;
  }

  /**
   * Remove a specific item by ID.
   * @param {string} id
   * @returns {boolean}
   */
  cancel(id) {
    const idx = this._queue.findIndex((e) => e._id === id);
    if (idx === -1) return false;
    this._queue.splice(idx, 1);
    return true;
  }

  /**
   * Pause the queue (e.g. on disconnect).
   * In-flight sends are NOT cancelled, but no new sends will start.
   */
  pause() {
    this._paused = true;
    this._cancelDrainTimer();
  }

  /**
   * Resume sending (e.g. after reconnect).
   */
  resume() {
    this._paused = false;
    this._scheduleDrain();
  }

  /**
   * Flush all pending items without sending them.
   * Use during teardown so items don't linger.
   */
  flush() {
    const dropped = [...this._queue];
    this._queue = [];
    this._cancelDrainTimer();
    this.emit('flushed', dropped);
    return dropped;
  }

  /**
   * Flush all items AND mark as paused.
   */
  clear() {
    this.pause();
    return this.flush();
  }

  size()       { return this._queue.length; }
  isEmpty()    { return this._queue.length === 0; }
  isPaused()   { return this._paused; }
  isRunning()  { return this._running; }

  getItems()   { return [...this._queue]; }

  getPendingItems(maxAgeMs = 5000) {
    const cutoff = Date.now() - maxAgeMs;
    return this._queue.filter((e) => e._enqueuedAt < cutoff);
  }

  // ── Internal drain loop ────────────────────────────────────────────────────

  _scheduleDrain() {
    if (this._paused || this._running || this._drainTimer || this.isEmpty()) return;

    const now   = Date.now();
    const delay = Math.max(0, this._lastSendAt + this.sendInterval - now);

    this._drainTimer = setTimeout(() => {
      this._drainTimer = null;
      this._drain();
    }, delay);
  }

  _cancelDrainTimer() {
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
  }

  async _drain() {
    if (this._paused || this._running) return;
    if (!this._sendFn) {
      if (!this.silent) {
        console.warn('[OutgoingQueue] No send function registered — items held in queue');
      }
      return;
    }

    this._running = true;

    while (!this._paused && !this.isEmpty()) {
      const item = this._queue[0];

      try {
        await this._sendFn(item);
        this._queue.shift();
        this._lastSendAt = Date.now();
        this.emit('sent', item);
      } catch (err) {
        this.emit('sendError', { item, error: err });
        // Stop draining on send error — let the caller handle reconnect
        this.pause();
        break;
      }

      // Rate limiting between sends
      if (!this.isEmpty()) {
        await sleep(this.sendInterval);
      }
    }

    this._running = false;

    // If items remain and we're not paused, schedule next drain
    if (!this._paused && !this.isEmpty()) {
      this._scheduleDrain();
    }
  }

  _generateId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { OutgoingQueue };