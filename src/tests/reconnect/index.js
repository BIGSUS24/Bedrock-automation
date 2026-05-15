'use strict';

/**
 * tests/reconnect/index.js — Reconnect State Machine Tests
 */

const assert = require('assert');
const { BackoffCalculator } = require('../../reconnect/backoff');
const { ReconnectStateMachine, ReconnectState } = require('../../reconnect/state_machine');
const { StateManager } = require('../../state');

const tests = {
  // ── BackoffCalculator ─────────────────────────────────────────────────────

  'Backoff: retry 0 gives base delay + jitter': () => {
    const b = new BackoffCalculator({ baseDelay: 1000, maxDelay: 60000, multiplier: 2, jitterRange: 500, minDelay: 1000, maxAttemptsPerMin: 10 });
    const d = b.calculate(0);
    assert(d >= 1000 && d <= 1500, `Expected 1000-1500 but got ${d}`);
  },

  'Backoff: retry 1 doubles base': () => {
    const b = new BackoffCalculator({ baseDelay: 1000, maxDelay: 60000, multiplier: 2, jitterRange: 0, minDelay: 1000, maxAttemptsPerMin: 10 });
    const d = b.calculate(1);
    assert(d >= 2000 && d <= 2001, `Expected ~2000 but got ${d}`);
  },

  'Backoff: caps at maxDelay': () => {
    const b = new BackoffCalculator({ baseDelay: 1000, maxDelay: 5000, multiplier: 2, jitterRange: 0, minDelay: 1000, maxAttemptsPerMin: 10 });
    const d = b.calculate(10); // 1000 * 2^10 = 1M, capped at 5000
    assert(d <= 5000, `Expected ≤5000 but got ${d}`);
  },

  'Backoff: enforces minDelay': () => {
    const b = new BackoffCalculator({ baseDelay: 100, maxDelay: 60000, multiplier: 1, jitterRange: 0, minDelay: 1000, maxAttemptsPerMin: 10 });
    const d = b.calculate(0);
    assert(d >= 1000, `Expected ≥1000 but got ${d}`);
  },

  'Backoff: rate limit detected after N attempts': () => {
    const b = new BackoffCalculator({ baseDelay: 1000, maxDelay: 60000, multiplier: 2, jitterRange: 0, minDelay: 1000, maxAttemptsPerMin: 3 });
    b.recordAttempt();
    b.recordAttempt();
    b.recordAttempt();
    assert(b.isRateLimited(), 'Should be rate limited after 3 attempts');
  },

  'Backoff: not rate limited before threshold': () => {
    const b = new BackoffCalculator({ baseDelay: 1000, maxDelay: 60000, multiplier: 2, jitterRange: 0, minDelay: 1000, maxAttemptsPerMin: 5 });
    b.recordAttempt();
    b.recordAttempt();
    assert(!b.isRateLimited(), 'Should not be rate limited with 2/5 attempts');
  },

  'Backoff: reset clears history': () => {
    const b = new BackoffCalculator({ baseDelay: 1000, maxDelay: 60000, multiplier: 2, jitterRange: 0, minDelay: 1000, maxAttemptsPerMin: 3 });
    b.recordAttempt(); b.recordAttempt(); b.recordAttempt();
    b.reset();
    assert(!b.isRateLimited(), 'Should not be rate limited after reset');
  },

  // ── ReconnectState ────────────────────────────────────────────────────────

  'ReconnectState: enum values are strings': () => {
    assert.strictEqual(typeof ReconnectState.IDLE,        'string');
    assert.strictEqual(typeof ReconnectState.WAITING,     'string');
    assert.strictEqual(typeof ReconnectState.RECONNECTING,'string');
    assert.strictEqual(typeof ReconnectState.CONNECTED,   'string');
    assert.strictEqual(typeof ReconnectState.FAILED,      'string');
  },

  // ── StateMachine ─────────────────────────────────────────────────────────

  'StateMachine: starts in IDLE': () => {
    const sm = makeStateMachine({ enabled: false });
    assert.strictEqual(sm.getCurrentState(), ReconnectState.IDLE);
  },

  'StateMachine: disabled → trigger emits "disabled"': async () => {
    const sm = makeStateMachine({ enabled: false });
    let disabled = false;
    sm.on('disabled', () => { disabled = true; });
    await sm.trigger('test');
    assert(disabled);
  },

  'StateMachine: stop resets retry count': () => {
    const sm = makeStateMachine({ enabled: true });
    sm._retryCount = 5;
    sm.stop();
    assert.strictEqual(sm._retryCount, 0);
  },

  'StateMachine: getBackoffDelay returns numeric value': () => {
    const sm = makeStateMachine({ enabled: true });
    const d = sm.getBackoffDelay();
    assert(typeof d === 'number' && d > 0);
  },

  'StateMachine: maxRetries exceeded → emits maxRetriesReached': async () => {
    const sm = makeStateMachine({ enabled: true, maxRetries: 0 });
    let reached = false;
    sm.on('maxRetriesReached', () => { reached = true; });
    sm._retryCount = 0; // already at max
    await sm.trigger('test');
    assert(reached);
    assert.strictEqual(sm.getCurrentState(), ReconnectState.FAILED);
  },
};

function makeStateMachine(reconnectConfig = {}) {
  const state    = new StateManager();
  const protocol = { connect: async () => {}, cleanup: () => {}, removeAllListeners: () => {} };
  const config   = { reconnect: { baseDelay: 100, maxDelay: 1000, multiplier: 2, jitterRange: 0, maxRetries: 3, ...reconnectConfig } };
  return new ReconnectStateMachine(config, state, protocol, {});
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  let passed = 0, failed = 0;
  console.log('\n[Reconnect Tests]\n');
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✕ ${name}`);
      console.log(`    ${e.message}`);
      failed++;
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

if (require.main === module) run().then((ok) => process.exit(ok ? 0 : 1));
module.exports = { tests, run };
