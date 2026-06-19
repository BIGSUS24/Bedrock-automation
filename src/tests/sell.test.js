'use strict';

/**
 * Focused self-check for auto_sell's churn + dead-GUI recovery paths.
 * Run: node src/tests/sell.test.js
 * Mocks the protocol/state — no live server needed.
 */

const assert = require('assert');
const EventEmitter = require('events');
const { createAutoSell } = require('../automation/actions/auto_sell');

// A GUI slot holding the green "$" sell button (matched by NBT display name).
function buttonItem() {
  return {
    network_id: -647,
    count: 1,
    raw: { stack_id: 999 },
    extra: { nbt: { nbt: { value: { display: { value: { Name: { value: '§a$ Click to Sell' } } } } } } },
  };
}
function invItem(stackId) {
  return { network_id: -320, count: 64, raw: { stack_id: stackId } };
}

// Minimal protocol mock. `acceptStackId` is the only source stack_id the fake
// server will accept for a move (simulates churn: a stale id is rejected).
function makeProtocol({ container, acceptStackId, state, autoSale = true }) {
  const p = new EventEmitter();
  p.calls = { close: 0, command: 0 };
  let reqId = -1;
  p.isConnected = () => true;
  p.getOpenContainer = () => container.oc;
  p.sendCommand = async () => { p.calls.command++; };
  p.closeContainer = async () => { p.calls.close++; container.oc = null; return true; };
  p.sendItemStackRequest = async (actions) => {
    const id = reqId; reqId -= 2;
    const a = actions[0];
    const ok = a.type_id === 'place' ? Number(a.source.stack_id) === acceptStackId : true;
    setImmediate(() => {
      if (a.type_id === 'place' && ok) {
        // Move accepted — empty the source inventory slot, like the real server.
        const slots = [...state.inventory.slots];
        slots[a.source.slot] = { network_id: 0 };
        state.inventory.slots = slots;
      }
      p.emit('itemStackResponse', { responses: [{ request_id: id, status: ok ? 'ok' : 'error' }] });
      if (a.type_id !== 'place' && autoSale) p.emit('chat', { message: '§aYou sold items for §6$4,000' });
    });
    return id;
  };
  return p;
}

function makeState() {
  return { isPlaying: () => true, inventory: { slots: [], heldSlot: 0 }, setInventory(s) { this.inventory.slots = s; } };
}

async function test1_happyPath() {
  const state = makeState();
  state.inventory.slots[0] = invItem(100);
  const container = { oc: { windowId: 1, windowType: 'container', slots: Array(54).fill({ network_id: 0 }) } };
  container.oc.slots[53] = buttonItem();
  let sentLiveId = null;
  const proto = makeProtocol({ container, acceptStackId: 100, state });
  const origSend = proto.sendItemStackRequest;
  proto.sendItemStackRequest = async (actions) => {
    if (actions[0].type_id === 'place') sentLiveId = Number(actions[0].source.stack_id);
    return origSend(actions);
  };
  const sell = createAutoSell({ ctx: {}, config: {}, log: () => {} });
  const r = await sell.runOnce(state, proto);
  assert.strictEqual(sentLiveId, 100, 'move must carry the LIVE stack id read from state');
  assert.strictEqual(r.ok, true, 'cycle should succeed');
  assert.strictEqual(r.amount, '$4,000', 'sale amount parsed from chat');
  assert.ok(r.clicked, 'sell button clicked');
}

async function test2_deadGuiSelfHeal() {
  const state = makeState();
  state.inventory.slots[0] = invItem(100);
  const container = { oc: { windowId: 1, windowType: 'container', slots: Array(54).fill({ network_id: 0 }) } };
  container.oc.slots[53] = buttonItem();
  // Server accepts NO move (zombie GUI): every place is rejected.
  const proto = makeProtocol({ container, acceptStackId: -1, state });
  const sell = createAutoSell({ ctx: {}, config: { automation: { actions: { autoSell: { maxItemRetries: 0, settleMs: 0 } } } }, log: () => {} });
  const r = await sell.runOnce(state, proto);
  assert.strictEqual(r.reason, 'gui_dead', 'all moves rejected => GUI flagged dead');
  assert.ok(proto.calls.close >= 1, 'dead GUI must be closed to recover');
}

async function test3_reuseNoButtonRecovery() {
  const state = makeState();
  const container = { oc: { windowId: 1, windowType: 'container', slots: Array(54).fill({ network_id: 0 }) } }; // open, NO button
  const proto = makeProtocol({ container, acceptStackId: 100, state });
  // After close, no GUI reopens (sendCommand is a no-op), so the cycle ends in no_gui —
  // but the recovery close + a fresh /sell attempt must have fired.
  const sell = createAutoSell({ ctx: {}, config: { automation: { actions: { autoSell: { reuseWaitMs: 200, openTimeoutMs: 200, maxOpenRetries: 0 } } } }, log: () => {} });
  await sell.runOnce(state, proto);
  assert.ok(proto.calls.close >= 1, 'buttonless open GUI must be force-closed');
  assert.ok(proto.calls.command >= 1, '/sell must be re-sent after recovery close');
}

async function test4_circuitBreaker() {
  const state = makeState();
  for (let i = 0; i < 20; i++) state.inventory.slots[i] = invItem(100 + i);
  const container = { oc: { windowId: 1, windowType: 'container', slots: Array(54).fill({ network_id: 0 }) } };
  container.oc.slots[53] = buttonItem();
  const proto = makeProtocol({ container, acceptStackId: 100, state });
  proto.sendItemStackRequest = async () => { /* stalled link: no response ever */ return -1; };
  let clicked = false;
  const sell = createAutoSell({ ctx: {}, config: { automation: { actions: { autoSell: { perItemTimeoutMs: 30, settleMs: 0, maxConsecutiveTimeouts: 3 } } } }, log: (m) => { if (/clicked/i.test(m)) clicked = true; } });
  const r = await sell.runOnce(state, proto);
  assert.strictEqual(r.reason, 'link_stalled', 'stalled link must trip the circuit breaker');
  assert.ok(r.uncertain <= 4, `bail after ~3 timeouts, not all 20 (got ${r.uncertain})`);
  assert.strictEqual(clicked, false, 'must NOT click / false-confirm on a stalled link');
}

(async () => {
  await test1_happyPath();
  await test2_deadGuiSelfHeal();
  await test3_reuseNoButtonRecovery();
  await test4_circuitBreaker();
  console.log('✓ sell.test.js — all 4 passed');
})().catch((e) => { console.error('✕', e.message); process.exit(1); });
