'use strict';

/**
 * scripts/sell_probe.js
 *
 * Connects to the live server, waits for spawn + inventory sync, fires /sell,
 * and dumps EVERY inventory packet (container_open / inventory_content /
 * inventory_slot) in full detail so we can see exactly where the GUI's slots
 * (borders + green "$" button) actually arrive.
 *
 *   node scripts/sell_probe.js
 */

const { StateManager } = require('../src/state');
const { BedrockProtocolClient } = require('../src/protocol/client');
const { createAutoSell, itemName, itemDisplayName, isEmptySlot, stackIdOf } = require('../src/automation/actions/auto_sell');
const baseConfig = require('../donutsmp.config');

const config = JSON.parse(JSON.stringify(baseConfig));
config.reconnect = { ...(config.reconnect || {}), enabled: false };
config.automation = { ...(config.automation || {}), enabled: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ts() { return new Date().toISOString().slice(11, 23); }
function log(tag, msg = '') {
  console.log(`[${ts()}] [${tag}] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
}

function describeItems(items, prefix) {
  let shown = 0;
  (items || []).forEach((it, i) => {
    if (isEmptySlot(it)) return;
    const label = itemDisplayName(it);
    log(prefix, `[${i}] ${itemName(it)} x${it?.count ?? '?'} (nid=${it?.network_id ?? '?'}, stackId=${stackIdOf(it)})${label ? ` "${label}"` : ''}`);
    shown++;
  });
  if (!shown) log(prefix, '(none non-empty)');
  return shown;
}

async function main() {
  const state = new StateManager();
  const protocol = new BedrockProtocolClient(config, state);

  protocol.on('disconnected', (i) => log('DISCONNECTED', i?.reason || i));
  protocol.on('kicked', (i) => log('KICKED', i?.message || i));
  protocol.on('error', (e) => log('PROTOCOL_ERROR', e?.message || String(e)));

  // ── Full inventory-packet trace ──
  protocol.on('containerOpen', (oc) => {
    log('CONTAINER_OPEN', `windowId=${JSON.stringify(oc.windowId)} type=${JSON.stringify(oc.windowType)} runtimeId=${oc.runtimeId}`);
  });
  protocol.on('containerContent', (p) => {
    log('CONTAINER_CONTENT', `windowId=${JSON.stringify(p.windowId)} container_id=${JSON.stringify(p.container?.container_id)} slots=${(p.slots || []).length}`);
    describeItems(p.slots, 'CC_ITEM');
  });
  protocol.on('containerSlot', (p) => {
    log('CONTAINER_SLOT', `windowId=${JSON.stringify(p.windowId)} slot=${p.slot} ${itemName(p.item)} (nid=${p.item?.network_id ?? '?'})${itemDisplayName(p.item) ? ` "${itemDisplayName(p.item)}"` : ''}`);
  });
  let guiRawLogged = false;
  protocol.on('inventoryContent', (packet) => {
    const items = packet.input || [];
    const filled = items.filter((it) => !isEmptySlot(it)).length;
    log('INV_CONTENT', `window_id=${JSON.stringify(packet.window_id)} keys=[${Object.keys(packet).join(',')}] container_id=${JSON.stringify(packet.container?.container_id ?? packet.container)} count=${items.length} filled=${filled}`);
    if (filled) describeItems(items, 'IC_ITEM');
    // For the GUI window ("first"), dump the RAW structure regardless of the
    // empty filter — we need to see what fields the items actually carry.
    if (String(packet.window_id) === 'first' && items.length && !guiRawLogged) {
      guiRawLogged = true;
      log('GUI_RAW', `summary: ${items.map((it, i) => `${i}:nid=${it?.network_id ?? '?'}/c=${it?.count ?? '?'}`).join(' ').slice(0, 800)}`);
      const sample = items.filter((it) => Number(it?.network_id ?? 0) !== 0).slice(0, 4);
      const toShow = sample.length ? sample : items.slice(0, 4);
      toShow.forEach((it, i) => log('GUI_RAW_ITEM', `${i}: ${JSON.stringify(it).slice(0, 900)}`));
    }
  });
  protocol.on('inventorySlot', (packet) => {
    log('INV_SLOT', `window_id=${JSON.stringify(packet.window_id)} slot=${packet.slot} ${itemName(packet.item)} (nid=${packet.item?.network_id ?? '?'})${itemDisplayName(packet.item) ? ` "${itemDisplayName(packet.item)}"` : ''}`);
  });
  protocol.on('chat', ({ message }) => {
    const clean = String(message || '').replace(/§./g, '');
    if (clean.trim()) log('CHAT', clean.slice(0, 120));
  });

  const killer = setTimeout(async () => {
    log('TIMEOUT', 'forcing disconnect');
    try { await protocol.disconnect('sell probe timeout'); } catch {}
    process.exit(2);
  }, 90000);

  try {
    log('CONNECT', `${config.server.address}:${config.server.port} v${config.server.version} [${config.auth.mode}]`);
    await protocol.connect();
    log('CONNECTED', `status=${state.status}`);

    // Let inventory + chunks sync.
    await sleep(8000);
    const inv = state.inventory?.slots || [];
    log('INVENTORY', `${inv.filter((s) => !isEmptySlot(s)).length} filled / ${inv.length} slots`);
    describeItems(inv.slice(0, 36), 'INV');
    // Raw dump of the player inventory state so we can see exactly what auto_sell
    // would snapshot — network_id / count / has nbt — for slots 0..8.
    inv.slice(0, 9).forEach((it, i) => {
      log('INV_RAW', `[${i}] nid=${it?.network_id ?? '?'} count=${it?.count ?? '?'} hasNbt=${Boolean(it?.extra?.has_nbt || it?.raw?.extra?.has_nbt)} ${JSON.stringify(it).slice(0, 200)}`);
    });

    // ── Full end-to-end production cycle: runOnce does /sell, transfer, click,
    //    confirm, close. This is the real code path the scheduler uses. ──
    const sell = createAutoSell({ ctx: { selling: false }, config, log: (m) => log('CYCLE', m) });
    log('SELL', 'running full sell cycle via runOnce(debug) …');
    const result = await sell.runOnce(state, protocol, { debug: true });
    log('RESULT', result);

    await sleep(2000);
    const after = state.inventory?.slots || [];
    log('INVENTORY_AFTER', `${after.filter((s) => !isEmptySlot(s)).length} filled / ${after.length} slots`);
  } catch (e) {
    log('ERROR', e?.stack || e?.message || String(e));
    process.exitCode = 1;
  } finally {
    clearTimeout(killer);
    try { await protocol.disconnect('sell probe complete'); } catch {}
    await sleep(500);
    process.exit(process.exitCode || 0);
  }
}

main();
