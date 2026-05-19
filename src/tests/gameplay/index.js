'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer');
const { StateManager } = require('../../state');
const { BedrockProtocolClient } = require('../../protocol/client');
const { BlockMatcher } = require('../../gameplay/block_matcher');
const { WorldTracker, keyOf } = require('../../gameplay/world_tracker');
const { GameplayController } = require('../../gameplay/controller');

class MockProtocol extends EventEmitter {
  constructor() {
    super();
    this.actions = [];
    this.input = null;
  }

  isConnected() { return true; }
  getActiveVersion() { return '1.26.20'; }
  setGameplayInputState(input) { this.input = input; }
  clearGameplayInputState() { this.input = null; }
  async sendSwing() { this.actions.push(['swing']); }
  async sendMineStackRequest() { this.actions.push(['mine_stack']); }

  async sendItemUseOnBlock(args) {
    this.actions.push(['use', args]);
    setTimeout(() => this.emit('blockEvent', { position: args.position, type: 'change_state', data: 1 }), 1);
  }

  async sendBlockBreakAction(action, position, face) {
    this.actions.push(['break', action, position, face]);
    if (action === 'predict_break') {
      const matcher = new BlockMatcher('1.26.20');
      setTimeout(() => this.emit('updateBlock', {
        position,
        block_runtime_id: matcher.getByName('air').defaultState,
      }), 1);
    }
  }
}

const gameplayTests = {
  'BlockMatcher resolves trapdoors and ores': () => {
    const matcher = new BlockMatcher('1.26.20');
    assert(matcher.isTrapdoor(matcher.getByName('oak_trapdoor') || matcher.getByName('trapdoor')));
    assert(matcher.matches(matcher.getByName('diamond_ore'), 'diamond'));
    assert(matcher.matches(matcher.getByName('iron_ore'), 'ores'));
  },

  'WorldTracker indexes update_block targets': () => {
    const state = new StateManager();
    const protocol = new MockProtocol();
    const world = new WorldTracker({ server: { version: '1.26.20' } }, protocol, state);
    const matcher = world.matcher;
    world.attach();

    protocol.emit('updateBlock', {
      position: { x: 10, y: 64, z: 9 },
      block_runtime_id: matcher.getByName('diamond_ore').defaultState,
    });

    const found = world.findMineTargets('diamond_ore', { x: 10, y: 64, z: 10 }, 8);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].block.name, 'diamond_ore');
    world.detach();
  },

  'WorldTracker remaps signed Bedrock subchunk indexes': () => {
    const state = new StateManager();
    const protocol = new MockProtocol();
    const world = new WorldTracker({ server: { version: '1.26.20' } }, protocol, state);
    const chunk = {
      co: 4,
      sections: [
        null,
        null,
        null,
        null,
        { y: 252, label: 'section_-4' },
        { y: 253, label: 'section_-3' },
        { y: 0, label: 'section_0' },
      ],
    };

    world._remapSignedSubChunkSections(chunk);
    assert.strictEqual(chunk.sections[0].label, 'section_-4');
    assert.strictEqual(chunk.sections[1].label, 'section_-3');
    assert.strictEqual(chunk.sections[4].label, 'section_0');
    assert.strictEqual(chunk.sections[0].y, -4);
    assert.strictEqual(chunk.sections[1].y, -3);
  },

  'WorldTracker finds nearest item entity drops': () => {
    const state = new StateManager();
    const protocol = new MockProtocol();
    const world = new WorldTracker({ server: { version: '1.26.20' } }, protocol, state);
    world.attach();

    protocol.emit('addItemEntity', {
      runtime_entity_id: 1n,
      position: { x: 5.25, y: 64, z: 5.25 },
    });
    protocol.emit('addItemEntity', {
      runtime_entity_id: 2n,
      position: { x: 2.25, y: 64, z: 2.25 },
    });

    const drop = world.findNearestItem({ x: 0, y: 64, z: 0 }, 8);
    assert.strictEqual(String(drop.packet.runtime_entity_id), '2');
    assert.strictEqual(Math.floor(drop.position.x), 2);
    world.detach();
  },

  'Protocol client merges gameplay input into player_auth_input': () => {
    const state = new StateManager();
    state.player.entityRuntimeId = 123n;
    state.setPosition(1, 65, 2);
    state.setRotation(90, 0);

    const protocol = new BedrockProtocolClient({
      server: { version: '1.26.20' },
      auth: {},
      protocol: {},
    }, state);

    const queued = [];
    protocol._connected = true;
    protocol._activeVersion = '1.26.20';
    protocol._client = { queue: (name, payload) => queued.push({ name, payload }) };
    protocol.setGameplayInputState({
      position: { x: 2, y: 65, z: 3 },
      yaw: 45,
      pitch: 5,
      moveVector: { x: 0, z: 1 },
      delta: { x: 1, y: 0, z: 1 },
      inputData: { up: true },
    });
    protocol.queueAuthInputFrame({
      inputData: { block_action: true },
      blockAction: [{ action: 'start_break', position: { x: 2, y: 64, z: 4 }, face: 1 }],
    });

    protocol._sendPlayerAuthInput();
    assert.strictEqual(queued.length, 1);
    assert.strictEqual(queued[0].name, 'player_auth_input');
    assert.strictEqual(queued[0].payload.position.x, 2);
    assert.strictEqual(queued[0].payload.input_data.up, true);
    assert.strictEqual(queued[0].payload.input_data.block_action, true);
    assert.strictEqual(queued[0].payload.block_action[0].action, 'start_break');
  },

  'Protocol client acknowledges server teleport corrections': () => {
    const state = new StateManager();
    state.player.entityRuntimeId = 123n;
    state.setPosition(1, 65, 2);

    const protocol = new BedrockProtocolClient({
      server: { version: '1.26.20' },
      auth: {},
      protocol: {},
    }, state);

    const queued = [];
    protocol._connected = true;
    protocol._activeVersion = '1.26.20';
    protocol._client = { queue: (name, payload) => queued.push({ name, payload }) };
    protocol._pendingTeleportAck = true;

    protocol._sendPlayerAuthInput();
    assert.strictEqual(queued[0].name, 'player_auth_input');
    assert.strictEqual(queued[0].payload.input_data.handled_teleport, true);
    assert.strictEqual(protocol._pendingTeleportAck, false);
  },

  'Protocol gameplay packets serialize through bedrock-protocol': async () => {
    const state = new StateManager();
    state.player.entityRuntimeId = 1n;
    state.setPosition(1, 64, 2);
    state.setRotation(0, 0);
    state.setInventory([{ network_id: 0 }], 0);
    const serializer = createSerializer('1.26.20');
    const protocol = new BedrockProtocolClient({
      server: { version: '1.26.20' },
      auth: {},
      protocol: {},
    }, state);

    const serialized = [];
    protocol._connected = true;
    protocol._activeVersion = '1.26.20';
    protocol._client = {
      queue: (name, params) => {
        serialized.push(serializer.createPacketBuffer({ name, params }));
      },
    };

    await protocol.selectHotbarSlot(0);
    await protocol.sendItemUseOnBlock({ position: { x: 1, y: 64, z: 2 }, face: 1, blockRuntimeId: 12531 });
    await protocol.sendBlockBreakAction('start_break', { x: 1, y: 64, z: 2 }, 1);
    await protocol.sendMineStackRequest();
    assert.strictEqual(serialized.length, 5);
    assert(serialized.every(Buffer.isBuffer));
  },

  'GameplayController pull interacts with nearest trapdoor': async () => {
    const state = new StateManager();
    state.setPosition(0, 64, 0);
    const protocol = new MockProtocol();
    const controller = new GameplayController({
      server: { version: '1.26.20' },
      gameplay: {
        movement: { speed: 100, tickMs: 1, maxNodes: 128 },
        pull: { searchRadius: 8, confirmationTimeout: 80 },
      },
    }, protocol, state);

    const trapdoor = controller.world.matcher.getByName('trapdoor');
    protocol.emit('updateBlock', {
      position: { x: 1, y: 64, z: 0 },
      block_runtime_id: trapdoor.defaultState,
    });

    const result = await controller.pull();
    assert.strictEqual(result.ok, true);
    assert(protocol.actions.some((entry) => entry[0] === 'use'));
    controller.stop();
  },

  'GameplayController pull prefers configured waypoint over scanned trapdoor': async () => {
    const state = new StateManager();
    state.setPosition(0, 64, 0);
    const protocol = new MockProtocol();
    const controller = new GameplayController({
      server: { version: '1.26.20' },
      gameplay: {
        movement: { speed: 100, tickMs: 1, maxNodes: 128 },
        pull: {
          searchRadius: 8,
          confirmationTimeout: 80,
          preferWaypoints: true,
          waypoints: [{ position: { x: 3, y: 64, z: 0 }, face: 1 }],
        },
      },
    }, protocol, state);

    const trapdoor = controller.world.matcher.getByName('trapdoor');
    protocol.emit('updateBlock', {
      position: { x: 1, y: 64, z: 0 },
      block_runtime_id: trapdoor.defaultState,
    });

    const result = await controller.pull();
    const use = protocol.actions.find((entry) => entry[0] === 'use');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(use[1].position, { x: 3, y: 64, z: 0 });
    controller.stop();
  },

  'GameplayController mining sends break sequence and confirms air update': async () => {
    const state = new StateManager();
    state.setPosition(0, 64, 0);
    const protocol = new MockProtocol();
    const controller = new GameplayController({
      server: { version: '1.26.20' },
      gameplay: {
        movement: { speed: 100, tickMs: 1, maxNodes: 128 },
        mining: { searchRadius: 8, confirmationTimeout: 80, maxBlocksPerCommand: 1, requireInventoryGain: false },
      },
    }, protocol, state);

    const target = {
      block: { name: 'diamond_ore', displayName: 'Diamond Ore', hardness: 0, transparent: false, boundingBox: 'block' },
      runtimeId: 1,
      position: { x: 1, y: 64, z: 0 },
      source: 'test',
      updatedAt: Date.now(),
    };
    controller.world.blockUpdates.set(keyOf(target.position), target);

    const result = await controller.mine('diamond_ore', { count: 1 });
    assert.strictEqual(result.ok, true);
    assert(protocol.actions.some((entry) => entry[0] === 'break' && entry[1] === 'start_break'));
    assert(protocol.actions.some((entry) => entry[0] === 'break' && entry[1] === 'predict_break'));
    assert(protocol.actions.some((entry) => entry[0] === 'mine_stack'));
    controller.stop();
  },

  'GameplayController strict mining refuses block changes without inventory gain': async () => {
    const state = new StateManager();
    state.setPosition(0, 64, 0);
    state.setInventory([], 0);
    const protocol = new MockProtocol();
    const controller = new GameplayController({
      server: { version: '1.26.20' },
      gameplay: {
        movement: { speed: 100, tickMs: 1, maxNodes: 128 },
        mining: {
          searchRadius: 8,
          confirmationTimeout: 80,
          inventoryGainTimeout: 20,
          maxBlocksPerCommand: 1,
          requireInventoryGain: true,
        },
      },
    }, protocol, state);

    const target = {
      block: { name: 'diamond_ore', displayName: 'Diamond Ore', hardness: 0, transparent: false, boundingBox: 'block' },
      runtimeId: 1,
      position: { x: 1, y: 64, z: 0 },
      source: 'test',
      updatedAt: Date.now(),
    };
    controller.world.blockUpdates.set(keyOf(target.position), target);

    const result = await controller.mine('diamond_ore', { count: 1 });
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /inventory did not gain/i);
    controller.stop();
  },

  'GameplayController strict mining accepts confirmed inventory gain': async () => {
    const state = new StateManager();
    state.setPosition(0, 64, 0);
    state.setInventory([], 0);
    const protocol = new MockProtocol();
    const controller = new GameplayController({
      server: { version: '1.26.20' },
      gameplay: {
        movement: { speed: 100, tickMs: 1, maxNodes: 128 },
        mining: {
          searchRadius: 8,
          confirmationTimeout: 80,
          inventoryGainTimeout: 120,
          maxBlocksPerCommand: 1,
          requireInventoryGain: true,
        },
      },
    }, protocol, state);

    const target = {
      block: { name: 'diamond_ore', displayName: 'Diamond Ore', hardness: 0, transparent: false, boundingBox: 'block' },
      runtimeId: 1,
      position: { x: 1, y: 64, z: 0 },
      source: 'test',
      updatedAt: Date.now(),
    };
    controller.world.blockUpdates.set(keyOf(target.position), target);
    protocol.on('updateBlock', () => {
      setTimeout(() => state.setInventory([{ network_id: 264, count: 1 }], 0), 25);
    });

    const result = await controller.mine('diamond_ore', { count: 1 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mined.length, 1);
    controller.stop();
  },
};

async function run() {
  let passed = 0;
  let failed = 0;
  console.log('\n[Gameplay Tests]\n');

  for (const [name, fn] of Object.entries(gameplayTests)) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✕ ${name}`);
      console.log(`    ${e.stack || e.message}`);
      failed++;
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

if (require.main === module) {
  run().then((ok) => process.exit(ok ? 0 : 1));
}

module.exports = { run, gameplayTests };
