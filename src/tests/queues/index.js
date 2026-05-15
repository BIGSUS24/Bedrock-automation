'use strict';

/**
 * tests/queues/index.js — OutgoingQueue Tests
 */

const assert = require('assert');
const { OutgoingQueue } = require('../../protocol/outgoing_queue');

const tests = {
  'Queue: starts paused': () => {
    const q = new OutgoingQueue({ silent: true });
    assert.strictEqual(q.isPaused(), true);
  },

  'Queue: enqueue adds items': () => {
    const q = new OutgoingQueue({ silent: true });
    q.enqueue({ type: 'chat', content: 'hello' });
    assert.strictEqual(q.size(), 1);
    assert(!q.isEmpty());
  },

  'Queue: bounded — drops oldest when full': () => {
    const q = new OutgoingQueue({ maxSize: 3, silent: true });
    q.enqueue({ id: 'a' });
    q.enqueue({ id: 'b' });
    q.enqueue({ id: 'c' });
    q.enqueue({ id: 'd' }); // should drop 'a'
    assert.strictEqual(q.size(), 3);
    const items = q.getItems();
    assert(!items.find((i) => i.id === 'a'), 'Oldest item should be dropped');
    assert(items.find((i) => i.id === 'd'), 'Newest item should be present');
  },

  'Queue: flush clears items and returns them': () => {
    const q = new OutgoingQueue({ silent: true });
    q.enqueue({ type: 'chat' });
    q.enqueue({ type: 'command' });
    const dropped = q.flush();
    assert.strictEqual(dropped.length, 2);
    assert.strictEqual(q.size(), 0);
  },

  'Queue: clear pauses and flushes': () => {
    const q = new OutgoingQueue({ silent: true });
    q.resume();
    q.enqueue({ type: 'chat' });
    q.clear();
    assert.strictEqual(q.size(), 0);
    assert.strictEqual(q.isPaused(), true);
  },

  'Queue: resume → sends items via sendFunction': async () => {
    const sent = [];
    const q = new OutgoingQueue({ sendInterval: 0, silent: true });
    q.setSendFunction(async (item) => { sent.push(item.content); });

    q.enqueue({ content: 'msg1' });
    q.enqueue({ content: 'msg2' });
    q.resume();

    // Wait for drain
    await sleep(100);
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[0], 'msg1');
    assert.strictEqual(sent[1], 'msg2');
  },

  'Queue: pause stops drain mid-flight': async () => {
    const sent = [];
    const q = new OutgoingQueue({ sendInterval: 10, silent: true });
    q.setSendFunction(async (item) => {
      await sleep(20);
      sent.push(item.content);
    });

    q.enqueue({ content: 'a' });
    q.enqueue({ content: 'b' });
    q.enqueue({ content: 'c' });
    q.resume();
    await sleep(25);
    q.pause();
    await sleep(80);

    // Only 1 or 2 should have been sent
    assert(sent.length <= 2, `Expected ≤2 sent but got ${sent.length}`);
  },

  'Queue: send error triggers pause and sendError event': async () => {
    const errors = [];
    const q = new OutgoingQueue({ sendInterval: 0, silent: true });
    q.setSendFunction(async () => { throw new Error('network error'); });
    q.on('sendError', (e) => errors.push(e));

    q.enqueue({ type: 'test' });
    q.resume();
    await sleep(100);

    assert.strictEqual(errors.length, 1);
    assert(errors[0].error.message.includes('network error'));
    assert.strictEqual(q.isPaused(), true);
  },

  'Queue: cancel removes specific item by ID': () => {
    const q = new OutgoingQueue({ silent: true });
    q.enqueue({ type: 'a' });
    const items = q.getItems();
    const id = items[0]._id;
    assert(q.cancel(id));
    assert.strictEqual(q.size(), 0);
  },

  'Queue: getPendingItems returns stale items': async () => {
    const q = new OutgoingQueue({ silent: true });
    q.enqueue({ type: 'old' });
    await sleep(50);
    const pending = q.getPendingItems(10); // items older than 10ms
    assert.strictEqual(pending.length, 1);
  },

  'Queue: no sendFunction — holds items without error': async () => {
    const q = new OutgoingQueue({ sendInterval: 0, silent: true });
    q.enqueue({ type: 'test' });
    q.resume();
    await sleep(50);
    assert.strictEqual(q.size(), 1); // held
  },
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  let passed = 0, failed = 0;
  console.log('\n[Queue Tests]\n');
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
