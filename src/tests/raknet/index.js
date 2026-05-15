'use strict';

/**
 * tests/raknet/index.js — RakNet Transport Layer Tests
 */

const assert = require('assert');
const { ReliabilitySystem, Reliability, readUInt24LE, writeUInt24LE } = require('../../transport/reliability');
const { FragmentationSystem } = require('../../transport/fragmentation');
const { PacketRouter } = require('../../transport/packet_router');

const tests = {
  // ── UInt24 helpers ────────────────────────────────────────────────────────

  'UInt24LE read/write roundtrip': () => {
    const buf = Buffer.alloc(3);
    writeUInt24LE(buf, 0xABCDEF, 0);
    assert.strictEqual(readUInt24LE(buf, 0), 0xABCDEF);
  },

  'UInt24LE max value': () => {
    const buf = Buffer.alloc(3);
    writeUInt24LE(buf, 0xFFFFFF, 0);
    assert.strictEqual(readUInt24LE(buf, 0), 0xFFFFFF);
  },

  'UInt24LE zero value': () => {
    const buf = Buffer.alloc(3);
    writeUInt24LE(buf, 0, 0);
    assert.strictEqual(readUInt24LE(buf, 0), 0);
  },

  // ── Reliability system ────────────────────────────────────────────────────

  'ReliabilitySystem: sequence number wraps at 24-bit boundary': () => {
    const r = new ReliabilitySystem();
    r.sendSequence = 0xFFFFFE;
    assert.strictEqual(r.nextSendSequence(), 0xFFFFFE);
    assert.strictEqual(r.nextSendSequence(), 0xFFFFFF);
    assert.strictEqual(r.nextSendSequence(), 0); // wrap
  },

  'ReliabilitySystem: message index increments': () => {
    const r = new ReliabilitySystem();
    assert.strictEqual(r.nextMessageIndex(), 0);
    assert.strictEqual(r.nextMessageIndex(), 1);
  },

  'ReliabilitySystem: order index per channel': () => {
    const r = new ReliabilitySystem();
    assert.strictEqual(r.nextOrderIndex(0), 0);
    assert.strictEqual(r.nextOrderIndex(0), 1);
    assert.strictEqual(r.nextOrderIndex(1), 0); // different channel
  },

  'ReliabilitySystem: encodeFrame/buildDatagram roundtrip': () => {
    const r    = new ReliabilitySystem();
    const data = Buffer.from('hello world');
    const frame = r.encodeFrame(data, Reliability.RELIABLE_ORDERED, { channel: 0 });
    const seq   = r.nextSendSequence();
    const dg    = r.buildDatagram([frame], seq);

    assert(Buffer.isBuffer(dg));
    assert(dg.length > 4);
    assert.strictEqual(dg.readUInt8(0), 0x84); // data flag
    assert.strictEqual(readUInt24LE(dg, 1), seq);
  },

  'ReliabilitySystem: decodeDatagram returns correct sequence': () => {
    const r    = new ReliabilitySystem();
    const data = Buffer.from('test payload');
    const frame = r.encodeFrame(data, Reliability.UNRELIABLE);
    const dg   = r.buildDatagram([frame], 42);

    const parsed = r.decodeDatagram(dg);
    assert(parsed);
    assert.strictEqual(parsed.sequenceNumber, 42);
    assert.strictEqual(parsed.frames.length, 1);
  },

  'ReliabilitySystem: ACK packet builds and parses': () => {
    const r    = new ReliabilitySystem();
    const seqs = new Set([1, 2, 3, 10, 11]);
    const ackBuf = r.buildAckNack(seqs, true);
    assert(ackBuf);
    assert.strictEqual(ackBuf.readUInt8(0), 0xC0);

    const { isAck, sequences } = r.parseAckNack(ackBuf);
    assert.strictEqual(isAck, true);
    assert(sequences.includes(1));
    assert(sequences.includes(3));
    assert(sequences.includes(10));
  },

  'ReliabilitySystem: NACK packet builds and parses': () => {
    const r    = new ReliabilitySystem();
    const seqs = new Set([5, 7]);
    const nackBuf = r.buildAckNack(seqs, false);
    assert(nackBuf);
    assert.strictEqual(nackBuf.readUInt8(0), 0xA0);

    const { isAck, sequences } = r.parseAckNack(nackBuf);
    assert.strictEqual(isAck, false);
    assert(sequences.includes(5));
    assert(sequences.includes(7));
  },

  'ReliabilitySystem: buildAckNack returns null for empty set': () => {
    const r   = new ReliabilitySystem();
    const buf = r.buildAckNack(new Set(), true);
    assert.strictEqual(buf, null);
  },

  'ReliabilitySystem: handleAck removes from sentPackets': () => {
    const r  = new ReliabilitySystem();
    const dg = Buffer.alloc(10);
    r.sentPackets.set(5, { datagram: dg, resendCount: 0 });
    r.sentPackets.set(6, { datagram: dg, resendCount: 0 });
    r.handleAck([5]);
    assert(!r.sentPackets.has(5));
    assert(r.sentPackets.has(6));
  },

  'ReliabilitySystem: cleanup resets all state': () => {
    const r = new ReliabilitySystem();
    r.sendSequence = 100;
    r.pendingAcks.add(1);
    r.cleanup();
    assert.strictEqual(r.sendSequence, 0);
    assert.strictEqual(r.pendingAcks.size, 0);
  },

  'ReliabilitySystem: ordered channel buffers out-of-order frames': () => {
    const r = new ReliabilitySystem();

    // Build two frames: index 1 arrives before index 0
    const f1 = { isOrdered: true, orderChannel: 0, orderIndex: 1, data: Buffer.from('B'), isSplit: false };
    const f0 = { isOrdered: true, orderChannel: 0, orderIndex: 0, data: Buffer.from('A'), isSplit: false };

    const r1 = r._processFrame(f1); // arrives first — should be buffered
    assert.strictEqual(r1.length, 0, 'Frame at index 1 should be held');

    const r0 = r._processFrame(f0); // now index 0 arrives — should release both
    assert(r0.length >= 2, `Expected 2 payloads but got ${r0.length}`);
    assert(r0[0].toString() === 'A');
    assert(r0[1].toString() === 'B');
  },

  // ── Fragmentation ─────────────────────────────────────────────────────────

  'FragmentationSystem: fragment small data produces one chunk': () => {
    const fs   = new FragmentationSystem(1400);
    const data = Buffer.alloc(100, 0xAB);
    assert(!fs.needsFragmentation(data), 'Should not need fragmentation');
  },

  'FragmentationSystem: fragment large data into chunks': () => {
    const fs   = new FragmentationSystem(100);
    const data = Buffer.alloc(250, 0xCC);
    assert(fs.needsFragmentation(data));
    const frags = fs.fragment(data);
    assert.strictEqual(frags.length, 3); // ceil(250/100)
    assert.strictEqual(frags[0].splitCount, 3);
    assert.strictEqual(frags[0].splitIndex, 0);
    assert.strictEqual(frags[2].splitIndex, 2);
    assert.strictEqual(frags[0].splitId, frags[1].splitId);
  },

  'FragmentationSystem: reassemble fragments in order': () => {
    const fs   = new FragmentationSystem(100);
    const data = Buffer.alloc(250);
    for (let i = 0; i < 250; i++) data[i] = i & 0xFF;

    const frags = fs.fragment(data);
    let reassembled = null;
    for (const frag of frags) {
      reassembled = fs.handleSplitFrame({ splitCount: frag.splitCount, splitId: frag.splitId, splitIndex: frag.splitIndex, data: frag.chunk });
    }
    assert(reassembled !== null);
    assert(reassembled.equals(data));
  },

  'FragmentationSystem: reassemble fragments out of order': () => {
    const fs   = new FragmentationSystem(100);
    const data = Buffer.alloc(200, 0x99);
    const frags = fs.fragment(data);

    // Send in reverse order
    const rev = [...frags].reverse();
    let result = null;
    for (const frag of rev) {
      result = fs.handleSplitFrame({ splitCount: frag.splitCount, splitId: frag.splitId, splitIndex: frag.splitIndex, data: frag.chunk });
    }
    assert(result !== null);
    assert(result.equals(data));
  },

  'FragmentationSystem: duplicate fragment ignored': () => {
    const fs   = new FragmentationSystem(100);
    const data = Buffer.alloc(150, 0x55);
    const frags = fs.fragment(data);

    fs.handleSplitFrame({ splitCount: frags[0].splitCount, splitId: frags[0].splitId, splitIndex: 0, data: frags[0].chunk });
    // Send index 0 again — should be ignored (no reassembly yet)
    const dup = fs.handleSplitFrame({ splitCount: frags[0].splitCount, splitId: frags[0].splitId, splitIndex: 0, data: frags[0].chunk });
    assert.strictEqual(dup, null);
  },

  // ── PacketRouter ──────────────────────────────────────────────────────────

  'PacketRouter: routes packet to specific handler': () => {
    const router = new PacketRouter();
    let received = null;
    router.on(0x09, (data) => { received = data; });

    // Build a minimal batch: 0xFE + deflate-raw of [varuint(len) + payload]
    const zlib     = require('zlib');
    const payload  = Buffer.from([0x09, 0xAA, 0xBB]);
    const lenBuf   = Buffer.from([payload.length]);
    const combined = Buffer.concat([lenBuf, payload]);
    const compressed = zlib.deflateRawSync(combined);
    const batch = Buffer.concat([Buffer.from([0xFE]), compressed]);

    router.route(batch);
    assert(received !== null, 'Handler should have been called');
  },

  'PacketRouter: buildBatch produces valid decompressible output': () => {
    const zlib   = require('zlib');
    const router = new PacketRouter();
    const pkt1   = Buffer.from([0x09, 0x01]);
    const pkt2   = Buffer.from([0x2A, 0xFF]);
    const batch  = router.buildBatch([pkt1, pkt2]);

    assert.strictEqual(batch.readUInt8(0), 0xFE);
    const decompressed = zlib.inflateRawSync(batch.slice(1));
    assert(decompressed.length > 0);
  },
};

function run() {
  let passed = 0, failed = 0;
  console.log('\n[RakNet Tests]\n');
  for (const [name, fn] of Object.entries(tests)) {
    try {
      fn();
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

if (require.main === module) process.exit(run() ? 0 : 1);
module.exports = { tests, run };
