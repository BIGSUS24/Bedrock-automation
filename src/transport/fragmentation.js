'use strict';

/**
 * FragmentationSystem — Real RakNet Split-Packet Handling
 *
 * RakNet splits large payloads (> MTU payload size) across multiple frames.
 * Each split frame carries:
 *   splitCount  : UInt32BE  — total number of fragments
 *   splitId     : UInt16BE  — unique ID for this split set (wraps at 65535)
 *   splitIndex  : UInt32BE  — zero-based index of this fragment
 *
 * The reliability layer signals split frames via a 'splitFrame' event.
 * FragmentationSystem accumulates fragments and emits 'reassembled' when complete.
 *
 * For sending: fragment() breaks a payload into frames sized to (mtu - overhead).
 */

const EventEmitter = require('events');

const DEFAULT_MAX_FRAGMENT_SIZE = 1464 - 28; // UDP payload - RakNet framing overhead
const STALE_AGE_MS = 30_000;
const CLEANUP_INTERVAL_MS = 10_000;

class FragmentationSystem extends EventEmitter {
  constructor(maxFragmentSize = DEFAULT_MAX_FRAGMENT_SIZE) {
    super();
    /** @type {Map<number, AssemblyRecord>} splitId → record */
    this.inProgress   = new Map();
    this.nextSplitId  = 0;
    this.maxSize      = maxFragmentSize;
    this._cleanupTimer = null;
  }

  // ── Outgoing fragmentation ───────────────────────────────────────────────

  /**
   * Break `data` into fragments. Returns an array of fragment descriptors
   * that the caller passes to ReliabilitySystem.encodeFrame() with isSplit=true.
   *
   * @param {Buffer} data
   * @returns {{ splitCount: number, splitId: number, splitIndex: number, chunk: Buffer }[]}
   */
  fragment(data) {
    const splitId     = this.nextSplitId;
    this.nextSplitId  = (this.nextSplitId + 1) & 0xFFFF;
    const totalChunks = Math.ceil(data.length / this.maxSize);

    const fragments = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * this.maxSize;
      const chunk = data.slice(start, start + this.maxSize);
      fragments.push({
        splitCount: totalChunks,
        splitId,
        splitIndex: i,
        chunk,
      });
    }
    return fragments;
  }

  /**
   * Returns true if `data` must be split to fit in a single frame.
   */
  needsFragmentation(data) {
    return data.length > this.maxSize;
  }

  // ── Incoming reassembly ──────────────────────────────────────────────────

  /**
   * Feed a split frame received from the reliability layer.
   * Returns the fully reassembled Buffer when all fragments have arrived,
   * or null if more fragments are still expected.
   *
   * Also emits 'reassembled' with the buffer when complete.
   *
   * @param {{ splitCount: number, splitId: number, splitIndex: number, data: Buffer }} frame
   * @returns {Buffer | null}
   */
  handleSplitFrame(frame) {
    const { splitCount, splitId, splitIndex, data } = frame;

    if (!this.inProgress.has(splitId)) {
      this.inProgress.set(splitId, {
        totalFragments: splitCount,
        received:       new Array(splitCount).fill(null),
        receivedCount:  0,
        timestamp:      Date.now(),
      });
    }

    const record = this.inProgress.get(splitId);

    if (splitIndex >= record.totalFragments) {
      console.warn(`[Frag] Invalid splitIndex ${splitIndex} for splitId ${splitId} (total=${record.totalFragments})`);
      return null;
    }

    if (record.received[splitIndex] !== null) {
      return null; // duplicate
    }

    record.received[splitIndex] = data;
    record.receivedCount++;

    if (record.receivedCount === record.totalFragments) {
      const reassembled = Buffer.concat(record.received);
      this.inProgress.delete(splitId);
      this.emit('reassembled', reassembled);
      return reassembled;
    }

    return null;
  }

  // ── Stale cleanup ────────────────────────────────────────────────────────

  startCleanup() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => this.cleanStale(), CLEANUP_INTERVAL_MS);
  }

  stopCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  cleanStale() {
    const now = Date.now();
    for (const [id, record] of this.inProgress) {
      if (now - record.timestamp > STALE_AGE_MS) {
        console.warn(`[Frag] Dropping stale split set id=${id} (${record.receivedCount}/${record.totalFragments} received)`);
        this.inProgress.delete(id);
      }
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  cleanup() {
    this.stopCleanup();
    this.inProgress.clear();
    this.nextSplitId = 0;
  }

  getStats() {
    return {
      inProgressSets:   this.inProgress.size,
      maxFragmentSize:  this.maxSize,
    };
  }
}

module.exports = { FragmentationSystem, DEFAULT_MAX_FRAGMENT_SIZE };