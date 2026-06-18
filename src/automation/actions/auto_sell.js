'use strict';

/**
 * automation/actions/auto_sell.js
 *
 * Auto-sell flow for servers whose /sell command opens a chest-like GUI that
 * completes the sale when the container is closed (no confirm-button click).
 *
 * Sequence (per cycle):
 *   1. Run the sell command (default "/sell").
 *   2. Wait for a container_open (with timeout + retries).
 *   3. Move every player-inventory item (slots 0..35 — armor/offhand live in
 *      separate containers and are never touched) into the GUI via an
 *      ItemStackRequest take->place (through the cursor, like the vanilla client).
 *   4. Close the container the way ESC does (client-initiated container_close).
 *   5. Watch chat for the "$<amount>" sale message and log it.
 *
 * Bedrock has no high-level window API in bedrock-protocol, so item moves are
 * built by hand from the 1.26.20 ItemStackRequest schema. The exact container
 * ids a given server's GUI uses can vary, so they are configurable and the
 * debug dump (logged on open and on demand) reveals the live representation.
 *
 * Robustness: a shared `ctx.selling` flag prevents overlapping cycles; every
 * wait is bounded by a timeout; failed item moves are retried then skipped;
 * the whole thing is wrapped so one bad cycle never wedges the loop. Designed
 * to run for days.
 */

let _mcdata = null;
function itemName(item) {
  if (!item) return '(empty)';
  if (item.name) return String(item.name);
  const nid = Number(item.network_id ?? item.networkId ?? 0);
  if (nid <= 0) return '(empty)';
  try {
    if (!_mcdata) _mcdata = require('minecraft-data')('bedrock_1.26.20');
    if (_mcdata?.items?.[nid]) return _mcdata.items[nid].name;
  } catch (_) { /* mcdata optional */ }
  return `item_${nid}`;
}

function isEmptySlot(item) {
  return !item || Number(item.network_id ?? item.networkId ?? 0) === 0;
}

/** Read an item's server-assigned stack id (shape differs by packet type). */
function stackIdOf(item) {
  const raw = item?.raw || item || {};
  const sid = raw.stack_id ?? raw.stackId ?? raw.stack_net_id ?? raw.stackNetId;
  if (sid && typeof sid === 'object') return Number(sid.id ?? sid.stack_id ?? sid.value ?? 0) || 0;
  return Number(sid ?? 0) || 0;
}

function countOf(item) {
  return Number(item?.count ?? item?.raw?.count ?? 1) || 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for an emitter event matching `predicate`, or resolve null on timeout.
 */
function waitForEvent(emitter, event, predicate, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const onEvent = (payload) => {
      if (done) return;
      try {
        if (!predicate || predicate(payload)) {
          done = true;
          cleanup();
          resolve(payload);
        }
      } catch (_) { /* ignore predicate errors */ }
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve(null);
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      emitter.removeListener(event, onEvent);
    }
    emitter.on(event, onEvent);
  });
}

/**
 * @param {object} opts
 * @param {{selling:boolean}} opts.ctx   shared coordination flag
 * @param {object} opts.config           full bot config
 * @param {(msg:string)=>void} [opts.log]
 */
function createAutoSell({ ctx, config, log = console.log }) {
  const cfg = (config.automation?.actions?.autoSell) || {};
  const settings = {
    command:             cfg.command ?? '/sell',
    inventoryContainer:  cfg.inventoryContainer ?? 'hotbar_and_inventory', // ContainerSlotType for player inv (slots 0..35)
    cursorContainer:     cfg.cursorContainer ?? 'cursor',
    guiContainer:        cfg.guiContainer ?? 'container',                  // ContainerSlotType for the GUI slots
    guiSize:             cfg.guiSize ?? 54,                                // double chest
    inventorySlots:      cfg.inventorySlots ?? 36,                         // player slots 0..35
    openTimeoutMs:       cfg.openTimeoutMs ?? 5000,
    perItemTimeoutMs:    cfg.perItemTimeoutMs ?? 2500,
    settleMs:            cfg.settleMs ?? 350,                              // pace between moves (increased for Termux/mobile lag)
    saleTimeoutMs:       cfg.saleTimeoutMs ?? 3000,
    postCloseMs:         cfg.postCloseMs ?? 500,                           // wait after container close before next cycle
    maxOpenRetries:      cfg.maxOpenRetries ?? 2,
    maxItemRetries:      cfg.maxItemRetries ?? 1,
    // Matches "$4,000", "$12,500.50", "$ 3.6K", "$2M" etc. (color codes stripped first).
    saleRegex:           cfg.saleRegex ? new RegExp(cfg.saleRegex) : /\$\s*[\d,]+(?:\.\d+)?\s*[kKmMbB]?/,
    debug:               cfg.debug ?? false,
  };

  function dbg(msg) {
    if (settings.debug) log(`\x1b[90m[SELL:debug]\x1b[0m ${msg}`);
  }

  /** Log a full snapshot of a container — ids, types, slot numbers, item names. */
  function dumpContainer(oc, label = 'container') {
    if (!oc) { log(`[SELL] ${label}: <none open>`); return; }
    const cid = oc.container?.container_id ?? '?';
    log(`\x1b[36m[SELL:dump]\x1b[0m ${label} windowId=${JSON.stringify(oc.windowId)} windowType=${JSON.stringify(oc.windowType)} containerSlotType=${JSON.stringify(cid)} runtimeId=${oc.runtimeId}`);
    const slots = oc.slots || [];
    let shown = 0;
    for (let i = 0; i < slots.length; i++) {
      if (isEmptySlot(slots[i])) continue;
      log(`  GUI[${i}] ${itemName(slots[i])} x${countOf(slots[i])} (nid=${slots[i]?.network_id ?? '?'}, stackId=${stackIdOf(slots[i])})`);
      shown++;
    }
    if (!shown) log('  (all GUI slots empty)');
  }

  function dumpInventory(state) {
    const slots = state.inventory?.slots || [];
    log(`\x1b[36m[SELL:dump]\x1b[0m player inventory (${slots.length} slots):`);
    let shown = 0;
    for (let i = 0; i < Math.min(slots.length, settings.inventorySlots); i++) {
      if (isEmptySlot(slots[i])) continue;
      log(`  INV[${i}] ${itemName(slots[i])} x${countOf(slots[i])} (nid=${slots[i]?.network_id ?? '?'}, stackId=${stackIdOf(slots[i])})`);
      shown++;
    }
    if (!shown) log('  (inventory empty)');
  }

  function slotInfo(containerId, slot, stackId) {
    return {
      slot_type: { container_id: containerId, dynamic_container_id: undefined },
      slot,
      stack_id: stackId,
    };
  }

  /**
   * Build a single DIRECT place move for one inventory slot into a GUI slot.
   * Live-validated against DonutSMP: a direct place (source inventory slot ->
   * destination GUI slot, no cursor hop) is accepted; routing through the cursor
   * with take->place is rejected by this server's GUI.
   */
  function buildMoveActions(invSlot, guiSlot, count, srcStackId) {
    return [
      {
        type_id: 'place',
        count,
        source:      slotInfo(settings.inventoryContainer, invSlot, srcStackId),
        destination: slotInfo(settings.guiContainer, guiSlot, 0),
      },
    ];
  }

  /**
   * Run one full sell cycle. Returns a result object; never throws.
   * @param {import('../../state').StateManager} state
   * @param {object} protocol  BedrockProtocolClient
   * @param {{debug?:boolean}} [opts]
   */
  async function runOnce(state, protocol, opts = {}) {
    const debugThisRun = opts.debug || settings.debug;
    if (!state.isPlaying?.()) {
      return { ok: false, reason: 'not_playing' };
    }
    if (ctx.selling) {
      dbg('runOnce skipped — a sell cycle is already in progress');
      return { ok: false, reason: 'already_selling' };
    }
    ctx.selling = true;
    const startedAt = Date.now();
    log('\x1b[36m[SELL]\x1b[0m Starting sell cycle');

    // Set up the chat watcher BEFORE we trigger anything, so a fast sale message
    // is never missed.
    let saleMessage = null;
    const onChat = ({ message } = {}) => {
      if (saleMessage) return;
      // Strip Bedrock §-color codes before matching (e.g. "§r§2$ §r§f3.6K").
      const clean = String(message || '').replace(/§./g, '');
      const m = clean.match(settings.saleRegex);
      if (m) saleMessage = m[0].replace(/\s+/g, ' ').trim();
    };
    protocol.on('chat', onChat);

    // In debug mode, log the first raw item_stack_response so the exact field
    // shape (e.g. `responses`) can be confirmed against this server.
    let respDbg = null;
    if (debugThisRun) {
      let logged = false;
      respDbg = (p) => {
        if (logged) return;
        logged = true;
        dbg(`raw item_stack_response: keys=[${Object.keys(p || {}).join(',')}] ${JSON.stringify(p).slice(0, 400)}`);
      };
      protocol.on('itemStackResponse', respDbg);
    }

    try {
      // ── 1 + 2. Trigger /sell, wait for the GUI to open (with retries). ──
      let oc = null;
      for (let attempt = 1; attempt <= settings.maxOpenRetries + 1 && !oc; attempt++) {
        // If the connection dropped (e.g. mid-cycle disconnect), stop now.
        // Otherwise this loop keeps firing /sell across the reconnect and bleeds
        // the dead cycle onto the new session.
        if (protocol.isConnected?.() === false) {
          log('\x1b[33m[SELL]\x1b[0m Disconnected before GUI opened — aborting cycle');
          return { ok: false, reason: 'disconnected' };
        }
        dbg(`sending "${settings.command}" (attempt ${attempt})`);
        const openP = waitForEvent(protocol, 'containerOpen', null, settings.openTimeoutMs);
        try {
          await protocol.sendCommand(settings.command);
        } catch (e) {
          log(`\x1b[31m[SELL]\x1b[0m Failed to send command: ${e.message}`);
        }
        oc = await openP;
        if (!oc) {
          // The event may have fired just before we listened — but only trust a
          // container that opened during THIS cycle, never a stale prior GUI.
          const existing = protocol.getOpenContainer?.() || null;
          oc = (existing && (existing.openedAt || 0) >= startedAt) ? existing : null;
        }
        if (!oc && attempt <= settings.maxOpenRetries) {
          log(`\x1b[33m[SELL]\x1b[0m GUI did not open (attempt ${attempt}) — retrying`);
          await sleep(500);
        }
      }

      if (!oc) {
        log('\x1b[31m[SELL]\x1b[0m Sell GUI never opened — aborting cycle');
        return { ok: false, reason: 'no_gui' };
      }

      // Let the initial container content arrive.
      await sleep(settings.settleMs);
      oc = protocol.getOpenContainer?.() || oc;
      log(`\x1b[32m[SELL]\x1b[0m GUI opened (windowId=${JSON.stringify(oc.windowId)}, type=${JSON.stringify(oc.windowType)})`);
      if (debugThisRun) { dumpContainer(oc, 'sell GUI on open'); dumpInventory(state); }

      // ── 3. Transfer every inventory item into the GUI. ──
      // Snapshot the player inventory now (it is stable until our moves apply).
      // Bedrock confirms moves via item_stack_response, not by re-sending the
      // player window, so we iterate the snapshot and track GUI usage locally.
      const snapshot = (state.inventory?.slots || [])
        .slice(0, settings.inventorySlots)
        .map((s) => (s ? { ...s } : s));

      // Slots already occupied in the GUI on open (borders/filler) are off-limits.
      const usedGui = new Set();
      (oc.slots || []).forEach((s, i) => { if (!isEmptySlot(s)) usedGui.add(i); });

      const nextGuiSlot = () => {
        for (let i = 0; i < settings.guiSize; i++) {
          if (!usedGui.has(i)) return i;
        }
        return -1;
      };

      let moved = 0;
      let skipped = 0;
      let uncertain = 0;

      for (let invSlot = 0; invSlot < snapshot.length; invSlot++) {
        const item = snapshot[invSlot];
        if (isEmptySlot(item)) continue;

        // Bail the moment the connection drops — otherwise the loop would keep
        // sending item moves that either fail (old session) or leak onto a
        // freshly-reconnected session.
        if (protocol.isConnected?.() === false) {
          log('\x1b[33m[SELL]\x1b[0m Disconnected mid-transfer — aborting cycle');
          return { ok: false, reason: 'disconnected' };
        }

        if (!protocol.getOpenContainer?.()) {
          log('\x1b[33m[SELL]\x1b[0m GUI closed mid-transfer — stopping transfer');
          break;
        }

        const guiSlot = nextGuiSlot();
        if (guiSlot === -1) {
          log('\x1b[33m[SELL]\x1b[0m No free GUI slot left — stopping transfer');
          break;
        }

        const count = countOf(item);
        const srcStackId = stackIdOf(item);
        const name = itemName(item);

        let outcome = 'fail'; // 'ok' | 'fail' | 'timeout'
        for (let r = 0; r <= settings.maxItemRetries && outcome === 'fail'; r++) {
          dbg(`move INV[${invSlot}] ${name} x${count} (stackId=${srcStackId}) -> GUI[${guiSlot}]${r ? ` (retry ${r})` : ''}`);
          let reqId = null;
          try {
            reqId = await protocol.sendItemStackRequest(
              buildMoveActions(invSlot, guiSlot, count, srcStackId)
            );
            dbg(`  itemStackRequest sent, request_id=${reqId}`);
          } catch (e) {
            log(`\x1b[31m[SELL]\x1b[0m move send failed: ${e.message}`);
            break;
          }

          // Authoritative confirmation: item_stack_response for our request id.
          const resp = await waitForEvent(
            protocol,
            'itemStackResponse',
            (p) => (p?.responses || []).some((r2) => String(r2.request_id) === String(reqId)),
            settings.perItemTimeoutMs
          );

          if (!resp) {
            // No response in time. Do NOT resend (would risk duplicating the
            // move under lag) — assume it likely applied and move on.
            outcome = 'timeout';
            break;
          }
          const r2 = resp.responses.find((x) => String(x.request_id) === String(reqId));
          if (r2 && r2.status === 'ok') {
            outcome = 'ok';
          } else {
            dbg(`  response status=${r2?.status} — ${r < settings.maxItemRetries ? 'retrying' : 'skipping'}`);
            outcome = 'fail';
            if (r < settings.maxItemRetries) await sleep(settings.settleMs);
          }
        }

        if (outcome === 'ok') {
          usedGui.add(guiSlot);
          moved++;
          dbg(`  moved ${name} -> GUI[${guiSlot}] OK`);
        } else if (outcome === 'timeout') {
          usedGui.add(guiSlot);
          uncertain++;
          log(`\x1b[33m[SELL]\x1b[0m INV[${invSlot}] ${name}: no response (assuming sent)`);
        } else {
          skipped++;
          log(`\x1b[33m[SELL]\x1b[0m INV[${invSlot}] ${name}: move rejected — skipping`);
        }
        await sleep(settings.settleMs);
      }

      log(`\x1b[32m[SELL]\x1b[0m Transfer complete — moved ${moved}, uncertain ${uncertain}, skipped ${skipped}`);
      if (debugThisRun) dumpContainer(protocol.getOpenContainer?.(), 'sell GUI before close');

      // ── 4. Close like ESC (this completes the sale on this server). ──
      try {
        await protocol.closeContainer();
        dbg('container_close sent (ESC)');
      } catch (e) {
        log(`\x1b[31m[SELL]\x1b[0m closeContainer failed: ${e.message}`);
      }

      // Give the server time to fully process the close handshake (the server
      // sends container_close back which we now ACK). On slow devices (Termux)
      // this prevents the next /sell from arriving before the previous GUI is
      // fully torn down server-side.
      await sleep(settings.postCloseMs);

      // ── 5. Wait for + log the sale amount from chat. ──
      const deadline = Date.now() + settings.saleTimeoutMs;
      while (!saleMessage && Date.now() < deadline) {
        if (protocol.isConnected?.() === false) break; // don't block on a dead session
        await sleep(150);
      }
      if (saleMessage) {
        log(`\x1b[32m[SELL] ✓ Sold for ${saleMessage}\x1b[0m`);
      } else {
        log('\x1b[33m[SELL]\x1b[0m No sale amount detected in chat (sale may still have completed)');
      }

      return {
        ok: true,
        moved,
        uncertain,
        skipped,
        amount: saleMessage,
        durationMs: Date.now() - startedAt,
      };
    } catch (e) {
      log(`\x1b[31m[SELL]\x1b[0m Cycle error: ${e.stack || e.message}`);
      // Best-effort cleanup so a bad cycle doesn't leave a GUI open.
      try { if (protocol.getOpenContainer?.()) await protocol.closeContainer(); } catch (_) {}
      return { ok: false, reason: 'error', error: e.message };
    } finally {
      protocol.removeListener('chat', onChat);
      if (respDbg) protocol.removeListener('itemStackResponse', respDbg);
      ctx.selling = false;
    }
  }

  // Scheduler-facing condition/execute.
  function condition(state) {
    return state.isPlaying?.() && !ctx.selling;
  }
  async function execute(state, protocol) {
    await runOnce(state, protocol);
  }

  return { condition, execute, runOnce, dumpContainer, dumpInventory, settings };
}

module.exports = { createAutoSell, itemName, isEmptySlot, stackIdOf };
