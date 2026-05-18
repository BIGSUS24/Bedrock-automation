'use strict';

/**
 * tests/index.js — Master Test Runner
 *
 * Runs all test suites in order:
 *   1. Core unit tests (original)
 *   2. RakNet transport tests
 *   3. Protocol serializer + version registry tests
 *   4. Queue tests
 *   5. Reconnect tests
 *
 * Exit 0 if all pass, 1 if any fail.
 */

const assert = require('assert');

// ── Original unit tests ───────────────────────────────────────────────────────

const { ConfigManager, DEFAULT_CONFIG, deepMerge } = require('../config');
const { StateManager, ConnectionStatus, OutgoingMessageQueue } = require('../state');
const { VersionRegistry, VersionNegotiator } = require('../protocol/profiles/registry');
const { ReconnectManager, RECONNECT_GUARDS }  = require('../reconnect');
const { MessageBar }                          = require('../ui');
const { AutomationManager }                   = require('../automation');
const { RakNetSession, ConnectionState, Reliability, RakNetPacketIDs } = require('../transport');
const { SessionManager, AuthState }           = require('../auth');

const coreTests = {
  'Config deep merge works': () => {
    const cm = new ConfigManager();
    cm.mergeConfig({
      server: { port: 25565 },
      automation: { enabled: true, actions: { jump: { enabled: true, interval: 1000 } } },
    });
    assert(cm.get('server.port') === 25565);
    assert(cm.get('server.address') === '127.0.0.1');
    assert(cm.get('automation.enabled') === true);
    assert(cm.get('automation.actions.jump.interval') === 1000);
  },

  'Config get/set paths': () => {
    const cm = new ConfigManager();
    cm.set('server.port', 12345);
    assert(cm.get('server.port') === 12345);
    assert(cm.get('nonexistent.path') === undefined);
  },

  'Config reset restores defaults': () => {
    const cm = new ConfigManager();
    cm.set('server.port', 99999);
    cm.reset();
    assert(cm.get('server.port') === 19132);
  },

  'Deep merge function': () => {
    const target = { a: 1, b: { c: 2, d: 3 } };
    const source = { b: { d: 4, e: 5 }, f: 6 };
    const result = deepMerge(target, source);
    assert(result.a === 1);
    assert(result.b.c === 2);
    assert(result.b.d === 4);
    assert(result.b.e === 5);
    assert(result.f === 6);
  },

  'State status transitions': () => {
    const sm = new StateManager();
    sm.setStatus(ConnectionStatus.CONNECTING);
    assert(sm.getConnectionStatus() === ConnectionStatus.CONNECTING);
    sm.setStatus(ConnectionStatus.CONNECTED);
    assert(sm.isConnected() === true);
  },

  'State player info update': () => {
    const sm = new StateManager();
    sm.setPlayerInfo({ username: 'TestPlayer', health: 10 });
    const status = sm.getStatus();
    assert(status.player.username === 'TestPlayer');
    assert(status.player.health === 10);
  },

  'State position and rotation': () => {
    const sm = new StateManager();
    sm.setPosition(10, 64, 20);
    sm.setRotation(90, 45);
    const status = sm.getStatus();
    assert(status.player.position.x === 10);
    assert(status.player.rotation.yaw === 90);
  },

  'State retry tracking': () => {
    const sm = new StateManager();
    sm.incrementRetry(); sm.incrementRetry();
    assert(sm.reconnect.retryCount === 2);
    sm.resetRetry();
    assert(sm.reconnect.retryCount === 0);
  },

  'State auth data': () => {
    const sm = new StateManager();
    const authData = { username: 'Player1', xuid: '12345', token: 'abc' };
    sm.setAuthData(authData);
    assert(sm.getAuthData().username === 'Player1');
    assert(sm.player.username === 'Player1');
  },

  'RakNet ConnectionState enum': () => {
    assert(ConnectionState.DISCONNECTED === 'disconnected');
    assert(ConnectionState.CONNECTED    === 'connected');
  },

  'RakNet Reliability enum': () => {
    assert(Reliability.UNRELIABLE       === 0);
    assert(Reliability.RELIABLE         === 2);
    assert(Reliability.RELIABLE_ORDERED === 4);
  },

  'RakNet packet IDs': () => {
    assert(RakNetPacketIDs.OPEN_CONNECTION_REQUEST_1 === 0x05);
    assert(RakNetPacketIDs.OPEN_CONNECTION_REPLY_1   === 0x06);
    assert(RakNetPacketIDs.OPEN_CONNECTION_REQUEST_2 === 0x07);
    assert(RakNetPacketIDs.OPEN_CONNECTION_REPLY_2   === 0x08);
  },

  'Auth: SessionManager offline mode': async () => {
    const sm = new SessionManager({ mode: 'offline', username: 'TestBot' });
    const result = await sm.authenticate();
    assert(result.type === 'offline');
    assert(result.username === 'TestBot');
    assert(sm.getState() === AuthState.OFFLINE);
  },

  'Auth: SessionManager invalid mode throws': async () => {
    const sm = new SessionManager({ mode: 'invalid' });
    await assert.rejects(() => sm.authenticate(), /Unknown auth mode/);
  },

  'Auth: SessionManager offline requires username': async () => {
    const sm = new SessionManager({ mode: 'offline' });
    await assert.rejects(() => sm.authenticate(), /requires auth.username/);
  },

  'Auth: AuthState enum values': () => {
    assert(typeof AuthState.VALID          === 'string');
    assert(typeof AuthState.UNAUTHENTICATED === 'string');
    assert(typeof AuthState.OFFLINE        === 'string');
  },

  'RECONNECT_GUARDS: minimum guard values': () => {
    assert(RECONNECT_GUARDS.minDelay            >= 1000);
    assert(RECONNECT_GUARDS.maxRetriesPerMinute <= 10);
    assert(RECONNECT_GUARDS.jitterRange         >  0);
  },

  'MessageBar: chat vs command routing': () => {
    const sent = [];
    const mockState = { recordChat: () => {} };
    const mb = new MessageBar(mockState, { ui: { historySize: 10, prompt: '>' } }, (type, msg) => {
      sent.push({ type, msg });
    });
    mb.handleInput('hello world');
    assert(sent[0].type === 'chat');
    mb.handleInput('/help');
    assert(sent[1].type === 'command');
  },
};

// ── Sub-suite runners ─────────────────────────────────────────────────────────

async function runSuite(name, suitePath) {
  const { run } = require(suitePath);
  return run();
}

async function runCore() {
  let passed = 0, failed = 0;
  console.log('\n[Core Tests]\n');
  for (const [name, fn] of Object.entries(coreTests)) {
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function runAll() {
  const suites = [
    { name: 'Core',      fn: runCore },
    { name: 'RakNet',    fn: () => runSuite('RakNet',    './raknet') },
    { name: 'Protocol',  fn: () => runSuite('Protocol',  './protocol') },
    { name: 'Handlers',  fn: () => runSuite('Handlers',  './handlers') },
    { name: 'Queues',    fn: () => runSuite('Queues',    './queues') },
    { name: 'Reconnect', fn: () => runSuite('Reconnect', './reconnect') },
    { name: 'Gameplay',  fn: () => runSuite('Gameplay',  './gameplay') },
  ];

  let allPassed = true;
  const results = [];

  for (const suite of suites) {
    try {
      const ok = await suite.fn();
      results.push({ name: suite.name, ok });
      if (!ok) allPassed = false;
    } catch (e) {
      results.push({ name: suite.name, ok: false, error: e.message });
      allPassed = false;
    }
  }

  console.log('═══════════════════════════════════════');
  console.log('  TEST SUMMARY');
  console.log('═══════════════════════════════════════');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✕'} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  }
  console.log('═══════════════════════════════════════\n');

  return allPassed;
}

if (require.main === module) {
  runAll().then((ok) => process.exit(ok ? 0 : 1));
}

module.exports = { runAll, coreTests };
