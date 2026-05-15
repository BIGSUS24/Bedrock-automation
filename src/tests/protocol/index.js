'use strict';

/**
 * tests/protocol/index.js — Protocol Serializer Tests
 */

const assert = require('assert');
const { TextSerializer, TextType } = require('../../protocol/serializers/text');
const { MovementSerializer, MoveMode } = require('../../protocol/serializers/movement');
const { InventorySerializer } = require('../../protocol/serializers/inventory');
const { VersionRegistry, VersionNegotiator } = require('../../protocol/profiles/registry');
const { readVarint, writeVarint } = require('../../transport/packet_router');

const tests = {
  // ── Varint ───────────────────────────────────────────────────────────────

  'Varint: encode/decode 0': () => {
    const buf = writeVarint(0);
    const { value, bytesRead } = readVarint(buf, 0);
    assert.strictEqual(value, 0);
    assert.strictEqual(bytesRead, 1);
  },

  'Varint: encode/decode 127': () => {
    const buf = writeVarint(127);
    assert.strictEqual(buf.length, 1);
    const { value } = readVarint(buf, 0);
    assert.strictEqual(value, 127);
  },

  'Varint: encode/decode 128 (2 bytes)': () => {
    const buf = writeVarint(128);
    assert.strictEqual(buf.length, 2);
    const { value } = readVarint(buf, 0);
    assert.strictEqual(value, 128);
  },

  'Varint: encode/decode large value': () => {
    const big = 2097151; // max 3-byte varint
    const buf = writeVarint(big);
    const { value } = readVarint(buf, 0);
    assert.strictEqual(value, big);
  },

  // ── TextSerializer ────────────────────────────────────────────────────────

  'TextSerializer: serialize/deserialize CHAT': () => {
    const buf = TextSerializer.serialize({
      type: TextType.CHAT,
      source: 'Steve',
      message: 'Hello world',
    });
    assert(Buffer.isBuffer(buf));
    const obj = TextSerializer.deserialize(buf);
    assert.strictEqual(obj.type, TextType.CHAT);
    assert.strictEqual(obj.source, 'Steve');
    assert.strictEqual(obj.message, 'Hello world');
  },

  'TextSerializer: RAW has no source field': () => {
    const buf = TextSerializer.serialize({ type: TextType.RAW, message: 'raw msg' });
    const obj = TextSerializer.deserialize(buf);
    assert.strictEqual(obj.type, TextType.RAW);
    assert.strictEqual(obj.source, '');
    assert.strictEqual(obj.message, 'raw msg');
  },

  'TextSerializer: SYSTEM type works': () => {
    const buf = TextSerializer.serialize({ type: TextType.SYSTEM, message: '[Server] Restarting' });
    const obj = TextSerializer.deserialize(buf);
    assert.strictEqual(obj.type, TextType.SYSTEM);
    assert.strictEqual(obj.message, '[Server] Restarting');
  },

  'TextSerializer: parameters roundtrip': () => {
    const buf = TextSerializer.serialize({
      type: TextType.TRANSLATION,
      message: 'chat.type.text',
      parameters: ['Steve', 'hello'],
    });
    const obj = TextSerializer.deserialize(buf);
    assert.deepStrictEqual(obj.parameters, ['Steve', 'hello']);
  },

  // ── MovementSerializer ────────────────────────────────────────────────────

  'MovementSerializer: serialize/deserialize basic': () => {
    const buf = MovementSerializer.serialize({
      position: { x: 100.5, y: 64.0, z: -200.25 },
      pitch:    15.0,
      yaw:      90.0,
      onGround: true,
    });
    assert(buf.length > 10);
    const obj = MovementSerializer.deserialize(buf);
    assert(Math.abs(obj.position.x - 100.5) < 0.001);
    assert(Math.abs(obj.position.y - 64.0)  < 0.001);
    assert(Math.abs(obj.position.z + 200.25) < 0.001);
    assert(Math.abs(obj.pitch - 15.0) < 0.001);
    assert(Math.abs(obj.yaw   - 90.0) < 0.001);
    assert.strictEqual(obj.onGround, true);
  },

  'MovementSerializer: teleport mode includes extra fields': () => {
    const buf = MovementSerializer.serialize({
      position: { x: 0, y: 100, z: 0 },
      pitch: 0, yaw: 0,
      mode: MoveMode.TELEPORT,
    });
    const obj = MovementSerializer.deserialize(buf);
    assert.strictEqual(obj.mode, MoveMode.TELEPORT);
    assert.strictEqual(obj.teleportCause, 0);
  },

  // ── InventorySerializer ───────────────────────────────────────────────────

  'InventorySerializer: isFood rejects empty slot': () => {
    assert(!InventorySerializer.isFood(null));
    assert(!InventorySerializer.isFood({ id: 0 }));
  },

  'InventorySerializer: isFood accepts apple (id=260)': () => {
    assert(InventorySerializer.isFood({ id: 260, count: 1, damage: 0 }));
  },

  'InventorySerializer: findBestFood returns null on empty inventory': () => {
    assert.strictEqual(InventorySerializer.findBestFood([]), null);
  },

  'InventorySerializer: findBestFood finds food slot': () => {
    const slots = [
      { id: 1, count: 64, damage: 0 },   // stone — not food
      { id: 260, count: 3, damage: 0 },  // apple — food
      { id: 0, count: 0, damage: 0 },    // empty
    ];
    const result = InventorySerializer.findBestFood(slots);
    assert(result !== null);
    assert.strictEqual(result.slotIndex, 1);
    assert.strictEqual(result.slot.id, 260);
  },

  // ── VersionRegistry ───────────────────────────────────────────────────────

  'Registry: getProfile returns correct family for 1.21.50': () => {
    const p = VersionRegistry.getProfile('1.21.50');
    assert.strictEqual(p.family, '1.21');
    assert.strictEqual(p.protocolVersion, 622);
  },

  'Registry: getProfile returns 1.21.80 for "latest"': () => {
    const p = VersionRegistry.getProfile('latest');
    assert.strictEqual(p.protocolVersion, 649);
  },

  'Registry: getProfile throws on unknown version': () => {
    assert.throws(() => VersionRegistry.getProfile('1.18.0'), /not supported/);
  },

  'Registry: getProfileByProtocol works for 622': () => {
    const p = VersionRegistry.getProfileByProtocol(622);
    assert.strictEqual(p.gameVersion, '1.21.50');
  },

  'Registry: getProfileByProtocol throws on unknown protocol': () => {
    assert.throws(() => VersionRegistry.getProfileByProtocol(999), /no mapped profile/);
  },

  'VersionNegotiator: validateVersion passes for 1.21.50': () => {
    assert.doesNotThrow(() => VersionNegotiator.validateVersion('1.21.50'));
  },

  'VersionNegotiator: validateVersion passes for latest': () => {
    assert.doesNotThrow(() => VersionNegotiator.validateVersion('latest'));
  },

  'VersionNegotiator: validateVersion rejects 1.19.x': () => {
    assert.throws(() => VersionNegotiator.validateVersion('1.19.0'), /below the minimum/);
  },

  'VersionNegotiator: validateVersion rejects bad format': () => {
    assert.throws(() => VersionNegotiator.validateVersion('not-a-version'), /Invalid version format/);
  },

  'Profile: getPacketId returns correct value': () => {
    const p = VersionRegistry.getProfile('1.21.50');
    assert.strictEqual(p.getPacketId('LOGIN'), 0x01);
    assert.strictEqual(p.getPacketId('TEXT'),  0x09);
  },

  'Profile: getPacketId throws on unknown packet name': () => {
    const p = VersionRegistry.getProfile('1.21.50');
    assert.throws(() => p.getPacketId('NONEXISTENT_PACKET'), /not defined/);
  },

  'Profile: getPacketName returns known name': () => {
    const p = VersionRegistry.getProfile('1.21.50');
    assert.strictEqual(p.getPacketName(0x01), 'LOGIN');
    assert.strictEqual(p.getPacketName(0x09), 'TEXT');
  },

  'Profile: getPacketName returns UNKNOWN for unmapped id': () => {
    const p = VersionRegistry.getProfile('1.21.50');
    const name = p.getPacketName(0xFE);
    assert(name.startsWith('UNKNOWN_'));
  },

  'Profile: supports() works for known capabilities': () => {
    const p = VersionRegistry.getProfile('1.21.50');
    assert.strictEqual(p.supports('compressionEnabled'), true);
    assert.strictEqual(p.supports('nonexistent'), false);
  },
};

async function run() {
  let passed = 0, failed = 0;
  console.log('\n[Protocol Tests]\n');
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
