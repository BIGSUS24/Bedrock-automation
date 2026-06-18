'use strict';

/**
 * scripts/persistent_sell_probe.js
 *
 * Validates the PERSISTENT-GUI auto-sell over many real cycles, exactly as the
 * 30s scheduler runs it: open the GUI once, then every gap transfer + click sell
 * WITHOUT closing the GUI. Asserts:
 *   - the GUI opens once and is then REUSED every cycle (open count stays 1),
 *   - no disconnects/kicks across the whole run,
 *   - the button is clicked + sale confirmed on every cycle that had items,
 *   - the lock releases so each cycle can run.
 *
 *   node scripts/persistent_sell_probe.js [cycles] [gapMs]
 */

const { StateManager } = require('../src/state');
const { BedrockProtocolClient } = require('../src/protocol/client');
const { createAutoSell, isEmptySlot } = require('../src/automation/actions/auto_sell');
const baseConfig = require('../donutsmp.config');

const CYCLES = Number.parseInt(process.argv[2] || '6', 10) || 6;
const GAP_MS = Number.parseInt(process.argv[3] || '30000', 10) || 30000;

const config = JSON.parse(JSON.stringify(baseConfig));
config.reconnect = { ...(config.reconnect || {}), enabled: false };
config.automation = { ...(config.automation || {}), enabled: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ts() { return new Date().toISOString().slice(11, 23); }
function log(tag, msg = '') {
  console.log(`[${ts()}] [${tag}] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
}
const filledCount = (slots) => (slots || []).filter((s) => !isEmptySlot(s)).length;

async function main() {
  const state = new StateManager();
  const protocol = new BedrockProtocolClient(config, state);

  let disconnected = false;
  let kicked = null;
  protocol.on('disconnected', (i) => { disconnected = true; log('DISCONNECTED', i?.reason || i); });
  protocol.on('kicked', (i) => { kicked = i?.message || i; log('KICKED', kicked); });
  protocol.on('error', (e) => log('PROTOCOL_ERROR', e?.message || String(e)));

  let opensSeen = 0;
  protocol.on('containerOpen', () => { opensSeen++; });
  let closesSeen = 0;
  protocol.on('containerClose', (c) => { closesSeen++; log('CONTAINER_CLOSE', `server=${c?.server}`); });

  const sell = createAutoSell({
    ctx: { selling: false },
    config,
    log: (m) => log('SELL', m.replace(/\x1b\[[0-9;]*m/g, '')),
  });

  // total run budget: connect + cycles*(gap + ~25s work) + slack
  const budgetMs = 20000 + CYCLES * (GAP_MS + 30000);
  const killer = setTimeout(async () => {
    log('TIMEOUT', 'forcing disconnect');
    try { await protocol.disconnect('persistent sell probe timeout'); } catch {}
    process.exit(2);
  }, Math.min(budgetMs, 590000));

  const rows = [];
  try {
    log('CONNECT', `${config.server.address}:${config.server.port} v${config.server.version} — ${CYCLES} cycles, gap ${GAP_MS}ms`);
    await protocol.connect();
    log('CONNECTED', `status=${state.status}`);
    await sleep(9000);

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      if (protocol.isConnected() === false) { log('ABORT', 'disconnected — stopping loop'); break; }
      const opensBefore = opensSeen;
      const invBefore = filledCount(state.inventory?.slots);
      log('CYCLE_START', `#${cycle}/${CYCLES} — inventory has ${invBefore} stacks, GUI open=${Boolean(protocol.getOpenContainer())}`);

      const result = await sell.runOnce(state, protocol);

      const row = {
        cycle,
        reused: Boolean(result?.reused),
        openedThisCycle: opensSeen > opensBefore,
        invBefore,
        invAfter: filledCount(state.inventory?.slots),
        moved: result?.moved ?? 0,
        clicked: Boolean(result?.clicked),
        amount: result?.amount || null,
        confirmed: Boolean(result?.confirmed),
        ok: Boolean(result?.ok),
        reason: result?.reason,
        guiStillOpen: Boolean(protocol.getOpenContainer()),
      };
      rows.push(row);
      log('CYCLE_RESULT', `#${cycle} reused=${row.reused} openedNow=${row.openedThisCycle} guiOpenAfter=${row.guiStillOpen} items=${row.invBefore}->${row.invAfter} moved=${row.moved} clicked=${row.clicked} amount=${row.amount} confirmed=${row.confirmed} ok=${row.ok}${row.reason ? ` reason=${row.reason}` : ''}`);

      if (cycle < CYCLES) { log('WAIT', `sleeping ${GAP_MS}ms (scheduler gap)…`); await sleep(GAP_MS); }
    }
  } catch (e) {
    log('ERROR', e?.stack || e?.message || String(e));
    process.exitCode = 1;
  } finally {
    clearTimeout(killer);

    const totalOpens = opensSeen;
    const salesClicked = rows.filter((r) => r.clicked).length;
    const salesConfirmed = rows.filter((r) => r.confirmed).length;
    const cyclesWithItems = rows.filter((r) => r.invBefore > 0).length;
    const itemCyclesAllSold = rows.filter((r) => r.invBefore > 0).every((r) => r.clicked && r.confirmed);
    // PASS: never disconnected/kicked; GUI opened at most once (stayed open/reused);
    // GUI open after every cycle; every cycle that had items clicked + confirmed.
    const guiStayedOpen = rows.length > 0 && rows.every((r) => r.guiStillOpen) && totalOpens <= 1;
    const noDrop = !disconnected && !kicked;
    const pass = rows.length > 0 && guiStayedOpen && noDrop && itemCyclesAllSold;

    log('SUMMARY', '================ RESULTS ================');
    log('SUMMARY', `cycles run:          ${rows.length}`);
    log('SUMMARY', `GUI opens (want 1):  ${totalOpens}`);
    log('SUMMARY', `GUI closes:          ${closesSeen}`);
    log('SUMMARY', `GUI open after each: ${rows.every((r) => r.guiStillOpen) ? 'YES' : 'NO'}`);
    log('SUMMARY', `cycles with items:   ${cyclesWithItems}`);
    log('SUMMARY', `sales clicked:       ${salesClicked}`);
    log('SUMMARY', `sales confirmed:     ${salesConfirmed}`);
    log('SUMMARY', `disconnect/kick:     ${disconnected || kicked ? `YES (${kicked || 'disconnect'})` : 'none'}`);
    log('SUMMARY', `=> PERSISTENT-LOOP ${pass ? 'PASS ✓' : 'FAIL ✗'}`);

    try { await protocol.disconnect('persistent sell probe complete'); } catch {}
    await sleep(500);
    process.exit(process.exitCode || (pass ? 0 : 3));
  }
}

main();
