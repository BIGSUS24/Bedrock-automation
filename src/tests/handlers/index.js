'use strict';

/**
 * tests/handlers/index.js — Protocol Handler Tests
 *
 * Tests: NetworkSettings, ResourcePacks, PlayStatus, ChunkRadius, Encryption
 */

const assert  = require('assert');
const crypto  = require('crypto');
const { NetworkSettingsHandler }  = require('../../protocol/handlers/network_settings');
const { ResourcePackHandler, ResourcePackStatus } = require('../../protocol/handlers/resource_packs');
const { PlayStatusHandler, PlayStatusCode } = require('../../protocol/handlers/play_status');
const { ChunkRadiusHandler }      = require('../../protocol/handlers/chunk_radius');
const { EncryptionSession }       = require('../../transport/encryption');

const tests = {
  // ── NetworkSettings ─────────────────────────────────────────────────────────

  'NetworkSettings: buildResponse is a buffer': () => {
    const buf = NetworkSettingsHandler.buildResponse();
    assert(Buffer.isBuffer(buf));
    assert(buf.length > 4);
  },

  'NetworkSettings: buildResponse contains 0xC1 as first varuint': () => {
    const buf = NetworkSettingsHandler.buildResponse();
    assert.strictEqual(buf.readUInt8(0), 0xC1);
  },

  'NetworkSettings: parseRequest extracts protocol version': () => {
    const body = Buffer.alloc(4);
    body.writeInt32BE(649, 0);
    const { protocolVersion } = NetworkSettingsHandler.parseRequest(body);
    assert.strictEqual(protocolVersion, 649);
  },

  'NetworkSettings: parseRequest handles short buffer': () => {
    const { protocolVersion } = NetworkSettingsHandler.parseRequest(Buffer.alloc(2));
    assert.strictEqual(protocolVersion, 0);
  },

  // ── ResourcePacks ──────────────────────────────────────────────────────────

  'ResourcePacks: buildHaveAllPacks status byte = 3': () => {
    const buf = ResourcePackHandler.buildHaveAllPacks();
    assert(Buffer.isBuffer(buf));
    // 0x08 varuint is 1 byte, then status byte
    assert.strictEqual(buf.readUInt8(1), ResourcePackStatus.HAVE_ALL_PACKS);
  },

  'ResourcePacks: buildCompleted status byte = 4': () => {
    const buf = ResourcePackHandler.buildCompleted();
    assert.strictEqual(buf.readUInt8(1), ResourcePackStatus.COMPLETED);
  },

  'ResourcePacks: buildResponse with pack IDs includes count': () => {
    const buf = ResourcePackHandler.buildResponse(ResourcePackStatus.SEND_PACKS, ['pack-uuid-1', 'pack-uuid-2']);
    assert(buf.length > 6);
    // 1 byte ID + 1 byte status + 2 bytes count
    const count = buf.readUInt16LE(2);
    assert.strictEqual(count, 2);
  },

  'ResourcePacks: REFUSED = 1, HAVE_ALL = 3, COMPLETED = 4': () => {
    assert.strictEqual(ResourcePackStatus.REFUSED,        1);
    assert.strictEqual(ResourcePackStatus.HAVE_ALL_PACKS, 3);
    assert.strictEqual(ResourcePackStatus.COMPLETED,      4);
  },

  // ── PlayStatus ─────────────────────────────────────────────────────────────

  'PlayStatus: LOGIN_SUCCESS is not error': () => {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(PlayStatusCode.LOGIN_SUCCESS, 0);
    const { code, isError } = PlayStatusHandler.parse(buf);
    assert.strictEqual(code, 0);
    assert.strictEqual(isError, false);
  },

  'PlayStatus: PLAYER_SPAWN is not error': () => {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(PlayStatusCode.PLAYER_SPAWN, 0);
    const { isError } = PlayStatusHandler.parse(buf);
    assert.strictEqual(isError, false);
  },

  'PlayStatus: FAILED_CLIENT is error with message': () => {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(PlayStatusCode.FAILED_CLIENT, 0);
    const { isError, message } = PlayStatusHandler.parse(buf);
    assert.strictEqual(isError, true);
    assert(message.length > 0);
  },

  'PlayStatus: SERVER_FULL produces human-readable message': () => {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(PlayStatusCode.FAILED_SERVER_FULL, 0);
    const { message } = PlayStatusHandler.parse(buf);
    assert(message.toLowerCase().includes('full'));
  },

  'PlayStatus: short buffer returns error': () => {
    const { code } = PlayStatusHandler.parse(Buffer.alloc(2));
    assert.strictEqual(code, -1);
  },

  'PlayStatus: isSuccess/isSpawn/isError helpers correct': () => {
    assert(PlayStatusHandler.isSuccess(PlayStatusCode.LOGIN_SUCCESS));
    assert(!PlayStatusHandler.isSuccess(PlayStatusCode.PLAYER_SPAWN));
    assert(PlayStatusHandler.isSpawn(PlayStatusCode.PLAYER_SPAWN));
    assert(PlayStatusHandler.isError(PlayStatusCode.FAILED_SERVER_FULL));
    assert(!PlayStatusHandler.isError(PlayStatusCode.LOGIN_SUCCESS));
  },

  // ── ChunkRadius ────────────────────────────────────────────────────────────

  'ChunkRadius: buildRequest produces buffer with correct ID': () => {
    const buf = ChunkRadiusHandler.buildRequest(8);
    assert(Buffer.isBuffer(buf));
    assert.strictEqual(buf.readUInt8(0), 0x45);
  },

  'ChunkRadius: buildRequest clamps to [4, 16]': () => {
    const low  = ChunkRadiusHandler.buildRequest(1);
    const high = ChunkRadiusHandler.buildRequest(32);
    // radius varuint is at offset 1 (after 0x45)
    assert.strictEqual(low.readUInt8(1),  4);
    assert.strictEqual(high.readUInt8(1), 16);
  },

  'ChunkRadius: parseUpdate reads varuint correctly': () => {
    const { writeVarint } = require('../../transport/packet_router');
    const body = writeVarint(12);
    const { chunkRadius } = ChunkRadiusHandler.parseUpdate(body);
    assert.strictEqual(chunkRadius, 12);
  },

  // ── Encryption ────────────────────────────────────────────────────────────

  'Encryption: inactive session returns plaintext unchanged': () => {
    const enc = new EncryptionSession();
    const plain = Buffer.from('hello world');
    assert(enc.encrypt(plain).equals(plain));
    assert(enc.decrypt(plain).equals(plain));
  },

  'Encryption: activate → encrypt → decrypt roundtrip': () => {
    const key = crypto.randomBytes(32);
    const iv  = crypto.randomBytes(16);

    const enc1 = new EncryptionSession();
    const enc2 = new EncryptionSession();
    enc1.activate(key, iv);
    enc2.activate(key, iv);

    const plain      = Buffer.from('test payload 12345');
    const ciphertext = enc1.encrypt(plain);
    const recovered  = enc2.decrypt(ciphertext);

    assert(!ciphertext.equals(plain), 'Ciphertext must differ from plaintext');
    assert(recovered.equals(plain),   'Decrypted must equal original');
  },

  'Encryption: different keys produce different ciphertext': () => {
    const plain  = Buffer.from('same data');
    const iv     = crypto.randomBytes(16);

    const enc1 = new EncryptionSession();
    const enc2 = new EncryptionSession();
    enc1.activate(crypto.randomBytes(32), iv);
    enc2.activate(crypto.randomBytes(32), iv);

    const c1 = enc1.encrypt(plain);
    const c2 = enc2.encrypt(Buffer.from(plain));
    assert(!c1.equals(c2), 'Different keys must produce different ciphertext');
  },

  'Encryption: parseHandshakePacket extracts x5u and salt': () => {
    // Build a fake handshake: varuint(len) + jwt_string
    const header  = Buffer.from(JSON.stringify({ alg: 'ES384', x5u: 'dGVzdA==' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ salt: 'c2FsdA==' })).toString('base64url');
    const sig     = 'fakesig';
    const jwt     = `${header}.${payload}.${sig}`;

    const { writeVarint } = require('../../transport/packet_router');
    const jwtBuf = Buffer.from(jwt, 'utf8');
    const buf    = Buffer.concat([writeVarint(jwtBuf.length), jwtBuf]);

    const result = EncryptionSession.parseHandshakePacket(buf);
    assert.strictEqual(result.serverPublicKeyB64, 'dGVzdA==');
    assert.strictEqual(result.saltB64,            'c2FsdA==');
  },

  'Encryption: isActive false before activate, true after': () => {
    const enc = new EncryptionSession();
    assert.strictEqual(enc.isActive(), false);
    enc.activate(crypto.randomBytes(32), crypto.randomBytes(16));
    assert.strictEqual(enc.isActive(), true);
  },
};

async function run() {
  let passed = 0, failed = 0;
  console.log('\n[Handler + Encryption Tests]\n');
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
