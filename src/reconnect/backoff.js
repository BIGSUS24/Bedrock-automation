'use strict';

/**
 * backoff.js — Exponential Backoff with Jitter and Rate-Limit Guard
 */

const DEFAULT_CONFIG = {
  baseDelay:        1000,
  maxDelay:         60_000,
  multiplier:       2.0,
  jitterRange:      500,
  minDelay:         1000,
  maxAttemptsPerMin: 10,
};

class BackoffCalculator {
  constructor(config = {}) {
    this.config    = { ...DEFAULT_CONFIG, ...config };
    this.history   = []; // timestamps of recent attempts
  }

  /**
   * Calculate the next delay for `retryCount` (0-indexed).
   * @param {number} retryCount
   * @returns {number}  delay in ms
   */
  calculate(retryCount) {
    const { baseDelay, maxDelay, multiplier, jitterRange, minDelay } = this.config;

    let delay = baseDelay * Math.pow(multiplier, retryCount);
    delay     = Math.min(delay, maxDelay);
    delay    += Math.random() * jitterRange;
    delay     = Math.max(delay, minDelay);

    return Math.floor(delay);
  }

  /**
   * Record an attempt timestamp and check rate limit.
   * @returns {boolean}  true if rate limit exceeded
   */
  recordAttempt() {
    const now     = Date.now();
    const oneMin  = now - 60_000;
    this.history  = this.history.filter((t) => t > oneMin);
    this.history.push(now);
    return this.history.length > this.config.maxAttemptsPerMin;
  }

  isRateLimited() {
    const oneMin = Date.now() - 60_000;
    const recent = this.history.filter((t) => t > oneMin);
    return recent.length >= this.config.maxAttemptsPerMin;
  }

  reset() {
    this.history = [];
  }
}

module.exports = { BackoffCalculator, DEFAULT_CONFIG };
