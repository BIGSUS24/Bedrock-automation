'use strict';

const { StateManager } = require('../src/state');
const { BedrockProtocolClient } = require('../src/protocol/client');
const { GameplayController } = require('../src/gameplay/controller');
const baseConfig = require('../donutsmp.config');

const query = process.argv[2] || 'deepslate';
const count = Number.parseInt(process.argv[3] || '1', 10) || 1;
const action = process.argv[4] || 'mine';

const config = JSON.parse(JSON.stringify(baseConfig));
config.reconnect = { ...(config.reconnect || {}), enabled: false };
config.automation = { ...(config.automation || {}), enabled: false };
config.gameplay.mining.maxBlocksPerCommand = count;
config.gameplay.mining.inventoryGainTimeout = 5000;
config.gameplay.mining.confirmationTimeout = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmt(pos) {
  if (!pos) return 'null';
  return `${Number(pos.x).toFixed(3)},${Number(pos.y).toFixed(3)},${Number(pos.z).toFixed(3)}`;
}

function snapshot(state) {
  const slots = state.inventory?.slots || [];
  return slots
    .map((item, i) => ({
      i,
      id: item?.network_id ?? item?.networkId ?? 0,
      count: item?.count ?? 0,
      stack: item?.stack_id ?? item?.stackId ?? 0,
      name: item?.name || item?.displayName || '',
    }))
    .filter((slot) => Number(slot.id) || Number(slot.count));
}

function log(tag, value = '') {
  const line = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(`[${new Date().toISOString()}] [${tag}] ${line}`);
}

async function main() {
  const state = new StateManager();
  const protocol = new BedrockProtocolClient(config, state);
  const originalQueueAuthInputFrame = protocol.queueAuthInputFrame.bind(protocol);
  protocol.queueAuthInputFrame = (frame = {}) => {
    if (frame.blockAction || frame.itemStackRequest || frame.transaction) {
      log('AUTH_FRAME', {
        inputData: frame.inputData,
        blockAction: frame.blockAction,
        itemStackRequest: frame.itemStackRequest,
        transaction: frame.transaction ? {
          type: frame.transaction.data?.action_type,
          pos: frame.transaction.data?.block_position,
          face: frame.transaction.data?.face,
          stack: frame.transaction.data?.held_item?.stack_id ?? frame.transaction.data?.held_item?.stackId,
        } : undefined,
      });
    }
    return originalQueueAuthInputFrame(frame);
  };
  const controller = new GameplayController(config, protocol, state);
  const seen = {
    updates: [],
    stackResponses: [],
    inventoryEvents: [],
    itemEvents: [],
  };

  protocol.on('updateBlock', (packet) => {
    const entry = {
      pos: packet.position,
      runtimeId: packet.block_runtime_id ?? packet.runtime_id,
    };
    seen.updates.push(entry);
    if (seen.updates.length <= 40) log('UPDATE_BLOCK', entry);
  });

  protocol.on('disconnected', (info) => log('DISCONNECTED', info));
  protocol.on('kicked', (info) => log('KICKED', info));
  protocol.on('error', (error) => log('PROTOCOL_ERROR', error?.message || String(error)));

  protocol.on('itemStackResponse', (packet) => {
    seen.stackResponses.push(packet);
    log('ITEM_STACK_RESPONSE', packet);
  });

  protocol.on('inventoryContent', (packet) => {
    seen.inventoryEvents.push({ kind: 'content', window: packet.window_id, slots: (packet.input || []).length });
    log('INV_CONTENT', seen.inventoryEvents[seen.inventoryEvents.length - 1]);
  });

  protocol.on('inventorySlot', (packet) => {
    seen.inventoryEvents.push({ kind: 'slot', window: packet.window_id, slot: packet.slot, item: packet.item });
    log('INV_SLOT', seen.inventoryEvents[seen.inventoryEvents.length - 1]);
  });

  protocol.on('addItemEntity', (packet) => {
    seen.itemEvents.push({
      kind: 'add',
      id: String(packet.runtime_entity_id),
      pos: packet.position,
      item: packet.item,
    });
    log('ADD_ITEM', seen.itemEvents[seen.itemEvents.length - 1]);
  });

  protocol.on('takeItemEntity', (packet) => {
    seen.itemEvents.push({
      kind: 'take',
      itemId: String(packet.item_runtime_entity_id ?? packet.item_entity_id),
      taker: String(packet.taker_runtime_entity_id ?? packet.player_runtime_id),
    });
    log('TAKE_ITEM', seen.itemEvents[seen.itemEvents.length - 1]);
  });

  let correctionLogs = 0;
  protocol.on('moveCorrection', (packet) => {
    correctionLogs++;
    if (correctionLogs <= 8 || correctionLogs % 20 === 0) {
      log('CORRECTION', {
        pos: packet.position,
        onGround: packet.on_ground,
        tick: String(packet.tick),
      });
    }
  });

  const killer = setTimeout(async () => {
    log('TIMEOUT', 'forcing disconnect');
    try {
      controller.stop();
      await protocol.disconnect('live gameplay probe timeout');
    } catch {}
    process.exit(2);
  }, 170000);

  try {
    log('CONNECT', `${config.server.address}:${config.server.port} v${config.server.version}`);
    await protocol.connect();
    log('CONNECTED', { status: state.status, pos: state.player.position, runtimeId: String(state.player.entityRuntimeId) });
    await sleep(8000);
    log('READY', {
      pos: state.player.position,
      moves: controller._serverMoveCount,
      corrections: controller._serverCorrectionCount,
      inventory: snapshot(state),
      chunkWarning: controller.world.getChunkLoadWarning(),
    });

    const origin = state.player.position;
    const deepslateTargets = controller.world.findMineTargets('deepslate', origin, 8)
      .slice(0, 12)
      .map((entry) => ({
        name: entry.block?.name,
        display: entry.block?.displayName,
        pos: entry.position,
        runtimeId: entry.runtimeId,
        dist: Math.sqrt(entry.distanceSq).toFixed(2),
        currentFace: controller._mineFaceFrom(state.player.position, entry.position),
        mineStand: controller._mineStandPositionFor(entry.position, { allowFallback: false }),
      }));
    log('DEEPSLATE_TARGETS', deepslateTargets);

    if (query.includes('ore') || query === 'ores' || process.env.LOG_ORES === '1') {
      const oreTargets = controller.world.findMineTargets('ore', origin, 32)
        .slice(0, 12)
        .map((entry) => ({
          name: entry.block?.name,
          display: entry.block?.displayName,
          pos: entry.position,
          runtimeId: entry.runtimeId,
          dist: Math.sqrt(entry.distanceSq).toFixed(2),
          currentFace: controller._mineFaceFrom(state.player.position, entry.position),
          mineStand: controller._mineStandPositionFor(entry.position, { allowFallback: false }),
        }));
      log('ORE_TARGETS', oreTargets);
    }

    let result;
    if (action === 'pull') {
      result = await controller.pull();
      log('PULL_RESULT', result);
    } else {
      result = await controller.mine(query, { count });
      log('MINE_RESULT', result);
    }

    await sleep(3000);
    log('FINAL', {
      pos: state.player.position,
      inventory: snapshot(state),
      seen: {
        updates: seen.updates.length,
        stackResponses: seen.stackResponses.length,
        inventoryEvents: seen.inventoryEvents.length,
        itemEvents: seen.itemEvents.length,
      },
    });
  } catch (error) {
    log('ERROR', error?.stack || error?.message || String(error));
    process.exitCode = 1;
  } finally {
    clearTimeout(killer);
    controller.stop();
    try {
      await protocol.disconnect('live gameplay probe complete');
    } catch {}
    await sleep(500);
    process.exit(process.exitCode || 0);
  }
}

main();
