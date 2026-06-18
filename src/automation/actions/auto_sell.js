'use strict';

/**
 * automation/actions/auto_sell.js
 *
 * Persistent-GUI auto-sell for servers (DonutSMP/Geyser) whose /sell command
 * opens a chest-style GUI confirmed by clicking a green stained-glass "$" button.
 *
 * DESIGN (per live behaviour): the GUI stays open indefinitely after you click
 * the sell button — it does NOT close. So we open it ONCE and then, every cycle,
 * just transfer the inventory into it and click the button again. We never close
 * the GUI and never reopen it unless a disconnect/reconnect wiped it. This kills
 * the open/close churn that caused the old "GUI did not open" failures and the
 * sell-cycle disconnects.
 *
 * Each runOnce() (the scheduler fires it every intervalMs ≈ 30s):
 *   1. ENSURE the sell GUI is open — reuse the already-open one if present,
 *      otherwise send /sell once and wait for it (with retries).
 *   2. LOCATE the green "$" button (dynamic, by NBT display name).
 *   3. TRANSFER every player-inventory item (slots 0..35) into free GUI slots
 *      via a direct ItemStackRequest place.
 *   4. CLICK the button exactly once (ItemStackRequest take — how the vanilla
 *      client taps a GUI button). Confirmed by item_stack_response.
 *   5. CONFIRM the sale: a "$<amount>" chat line OR the filled slots emptying.
 *   6. LEAVE THE GUI OPEN. The next cycle reuses it.
 *
 * Geyser maps items to NEGATIVE network_ids, so emptiness is network_id === 0
 * ONLY (see isEmptySlot). The sell button itself is a negative-id item (nid=-647
 * on DonutSMP) matched by its "$" display name, not by item type.
 *
 * Robustness: a shared `ctx.selling` flag prevents overlapping cycles; every
 * wait is bounded; failed item moves are retried then skipped; every await bails
 * the moment the connection drops; one bad cycle never wedges the loop.
 */

let _mcdata = null;
function itemName(item) {
  if (!item) return '(empty)';
  if (item.name) return String(item.name);
  const nid = Number(item.network_id ?? item.networkId ?? 0);
  if (nid === 0) return '(empty)';
  // Geyser servers (DonutSMP) map items to NEGATIVE runtime network_ids — these
  // are real items, not empty slots. minecraft-data only knows vanilla positive
  // ids, so negatives fall through to the item_<nid> label (the GUI button etc.
  // are matched by their NBT display name, not this name).
  try {
    if (!_mcdata) _mcdata = require('minecraft-data')('bedrock_1.26.20');
    if (nid > 0 && _mcdata?.items?.[nid]) return _mcdata.items[nid].name;
  } catch (_) { /* mcdata optional */ }
  return `item_${nid}`;
}

function isEmptySlot(item) {
  // Per the 1.26.20 Item/ItemNew schema the ONLY void marker is network_id === 0.
  // A negative network_id is a REAL Geyser-mapped item (verified live on DonutSMP:
  // inventory stacks decode as nid=-320/-337/… and the sell button as nid=-647,
  // each with count>0, a stack_id, and a block_runtime_id). A "<= 0" rule treats
  // every Geyser item as empty, so the bot sees an empty inventory/GUI and never
  // transfers or sells anything.
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

/** Strip Bedrock §-colour codes so name/label matching is colour-agnostic. */
function stripColors(s) {
  return String(s || '').replace(/§./g, '');
}

/**
 * Read an item's NBT custom display name (the "Click to Sell" / "$" text), or ''.
 * Bedrock stores it at extra.nbt.nbt.value.display.value.Name.value (same root
 * the durability reader in the protocol client uses for Damage).
 */
function itemDisplayName(item) {
  const root = item?.extra?.nbt?.nbt?.value ?? item?.raw?.extra?.nbt?.nbt?.value ?? null;
  const name = root?.display?.value?.Name?.value;
  return typeof name === 'string' ? stripColors(name) : '';
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

    // Timeouts (generous — reliability over speed; tuned for Termux/mobile lag).
    openTimeoutMs:       cfg.openTimeoutMs ?? 6000,                        // wait for container_open
    buttonWaitMs:        cfg.buttonWaitMs ?? 8000,                         // max wait for GUI content + button to appear
    reuseWaitMs:         cfg.reuseWaitMs ?? 1500,                          // short poll to confirm an already-open GUI is usable
    contentSettleMs:     cfg.contentSettleMs ?? 600,                       // content unchanged this long → stop polling
    perItemTimeoutMs:    cfg.perItemTimeoutMs ?? 2500,                     // wait for an item move ack
    clickTimeoutMs:      cfg.clickTimeoutMs ?? 3000,                       // wait for the button-click ack
    saleTimeoutMs:       cfg.saleTimeoutMs ?? 5000,                        // wait for sale confirmation
    settleMs:            cfg.settleMs ?? 300,                              // pace between moves
    postSaleMs:          cfg.postSaleMs ?? 300,                            // settle after sale

    maxOpenRetries:      cfg.maxOpenRetries ?? 2,
    maxItemRetries:      cfg.maxItemRetries ?? 1,

    // Matches "$4,000", "$12,500.50", "$ 3.6K", "$2M" etc. (colour codes stripped first).
    saleRegex:           cfg.saleRegex ? new RegExp(cfg.saleRegex) : /\$\s*[\d,]+(?:\.\d+)?\s*[kKmMbB]?/,

    // ── Sell-button detection (dynamic, with optional hard fallback) ──────────
    buttonNamePattern:   cfg.buttonNamePattern ? new RegExp(cfg.buttonNamePattern, 'i') : /stained_glass_pane/i,
    buttonLabelPattern:  cfg.buttonLabelPattern ? new RegExp(cfg.buttonLabelPattern, 'i') : /\$|sell/i,
    buttonFallbackSlot:  cfg.buttonFallbackSlot ?? 53, // bottom-right of a 54-slot double chest (DonutSMP)
    buttonClickType:     cfg.buttonClickType ?? 'take',
    buttonMinScore:      cfg.buttonMinScore ?? 3,

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
      const label2 = itemDisplayName(slots[i]);
      log(`  GUI[${i}] ${itemName(slots[i])} x${countOf(slots[i])} (nid=${slots[i]?.network_id ?? '?'}, stackId=${stackIdOf(slots[i])})${label2 ? ` "${label2}"` : ''}`);
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
   * destination GUI slot, no cursor hop) is accepted.
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
   * Build the "click the sell button" action — a `take` of the button stack
   * toward the cursor. The server-side GUI intercepts it, runs the sale, and the
   * stack never actually moves (the GUI stays open).
   */
  function buildClickActions(buttonSlot, count, stackId) {
    return [
      {
        type_id: settings.buttonClickType,
        count,
        source:      slotInfo(settings.guiContainer, buttonSlot, stackId),
        destination: slotInfo(settings.cursorContainer, 0, 0),
      },
    ];
  }

  /**
   * Score every non-empty GUI slot and return the best sell-button candidate, or
   * null. The real "$" button scores highest via its NBT display name; a green
   * stained-glass pane alone also clears the default threshold.
   */
  function findSellButton(slots) {
    let best = null;
    for (let i = 0; i < (slots?.length || 0); i++) {
      const it = slots[i];
      if (isEmptySlot(it)) continue;
      const name = itemName(it).toLowerCase();
      const label = itemDisplayName(it).toLowerCase();
      let score = 0;
      if (settings.buttonNamePattern.test(name)) score += 2;
      if (/green/.test(name)) score += 1;
      if (label.includes('$')) score += 3;
      if (/click\s*to\s*sell/.test(label)) score += 3;
      else if (/sell/.test(label)) score += 2;
      else if (settings.buttonLabelPattern.test(label)) score += 2;
      if (score > 0 && (!best || score > best.score)) {
        best = { slot: i, item: it, score, name, label: itemDisplayName(it) };
      }
    }
    return best;
  }
  

  const connectedFn = (protocol) => protocol.isConnected?.() !== false;

  /**
   * Poll the live open container until the sell button appears (or content
   * settles). Returns { oc, button } — button may be null if none was found.
   */
  async function pollForButton(protocol, maxMs) {
    let lastFilled = -1;
    let stableSince = Date.now();
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (!connectedFn(protocol)) return { oc: null, button: null, reason: 'disconnected' };
      const oc = protocol.getOpenContainer?.();
      if (!oc) return { oc: null, button: null, reason: 'gui_closed' };
      const slots = oc.slots || [];
      const filled = slots.filter((s) => !isEmptySlot(s)).length;
      if (filled !== lastFilled) { lastFilled = filled; stableSince = Date.now(); }
      const cand = findSellButton(slots);
      if (cand && cand.score >= settings.buttonMinScore) return { oc, button: cand };
      if (filled > 0 && Date.now() - stableSince >= settings.contentSettleMs) {
        return { oc, button: cand && cand.score >= settings.buttonMinScore ? cand : null };
      }
      await sleep(150);
    }
    const oc = protocol.getOpenContainer?.() || null;
    return { oc, button: oc ? findSellButton(oc.slots || []) : null };
  }

  /**
   * Ensure the sell GUI is open and the button located. Reuses an already-open
   * GUI (the common case — we never close it); otherwise sends /sell with retries.
   * Returns { oc, button, reused } or { error }.
   */
  async function acquireGui(protocol, startedAt, debugThisRun) {
    // 1. Reuse path — a GUI is already open from a previous cycle.
    if (protocol.getOpenContainer?.()) {
      const { oc, button, reason } = await pollForButton(protocol, settings.reuseWaitMs);
      if (reason === 'disconnected') return { error: 'disconnected' };
      if (button) {
        dbg('reusing already-open sell GUI');
        return { oc, button, reused: true };
      }
      // A container is open but has no recognisable button — fall through and
      // (re)send /sell; the server replaces the GUI in place.
      dbg('open container has no sell button — sending /sell to refresh');
    }

    // 2. Open path — send /sell and wait for the GUI (with retries).
    let oc = null;
    for (let attempt = 1; attempt <= settings.maxOpenRetries + 1 && !oc; attempt++) {
      if (!connectedFn(protocol)) return { error: 'disconnected' };

      const lingering = protocol.getOpenContainer?.() || null;
      if (lingering && (lingering.openedAt || 0) >= startedAt) {
        oc = lingering;
        dbg('adopted already-open container (event raced ahead of listener)');
        break;
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
        const existing = protocol.getOpenContainer?.() || null;
        oc = (existing && (existing.openedAt || 0) >= startedAt) ? existing : null;
      }
      if (!oc && attempt <= settings.maxOpenRetries) {
        log(`\x1b[33m[SELL]\x1b[0m GUI failed to open (attempt ${attempt}/${settings.maxOpenRetries + 1}) — retrying`);
        await sleep(600);
      }
    }
    if (!oc) return { error: 'no_gui' };

    // 3. Wait for content + locate the button.
    const { button } = await pollForButton(protocol, settings.buttonWaitMs);
    oc = protocol.getOpenContainer?.() || oc;
    if (debugThisRun) { dumpContainer(oc, 'sell GUI on open'); }
    return { oc, button, reused: false };
  }

  /**
   * Run one full sell cycle. Returns a result object; never throws. Leaves the
   * GUI OPEN for the next cycle to reuse.
   */
  async function runOnce(state, protocol, opts = {}) {
    const debugThisRun = opts.debug || settings.debug;
    const connected = () => connectedFn(protocol);

    if (!state.isPlaying?.()) return { ok: false, reason: 'not_playing' };
    if (ctx.selling) {
      dbg('runOnce skipped — a sell cycle is already in progress');
      return { ok: false, reason: 'already_selling' };
    }
    ctx.selling = true;
    const startedAt = Date.now();
    log('\x1b[36m[SELL]\x1b[0m Starting sell cycle');

    let saleMessage = null;
    const onChat = ({ message } = {}) => {
      if (saleMessage) return;
      const m = stripColors(message).match(settings.saleRegex);
      if (m) saleMessage = m[0].replace(/\s+/g, ' ').trim();
    };
    protocol.on('chat', onChat);

    let respDbg = null;
    let invDbg = null;
    let slotDbg = null;
    if (debugThisRun) {
      let logged = false;
      respDbg = (p) => {
        if (logged) return;
        logged = true;
        dbg(`raw item_stack_response: keys=[${Object.keys(p || {}).join(',')}] ${JSON.stringify(p).slice(0, 400)}`);
      };
      protocol.on('itemStackResponse', respDbg);
      invDbg = (p) => {
        const items = p?.input || [];
        dbg(`inventory_content window_id=${JSON.stringify(p?.window_id)} container_id=${JSON.stringify(p?.container?.container_id ?? '?')} count=${items.length} filled=${items.filter((it) => !isEmptySlot(it)).length}`);
      };
      slotDbg = (p) => dbg(`inventory_slot window_id=${JSON.stringify(p?.window_id)} slot=${p?.slot} ${itemName(p?.item)}${itemDisplayName(p?.item) ? ` "${itemDisplayName(p?.item)}"` : ''}`);
      protocol.on('inventoryContent', invDbg);
      protocol.on('inventorySlot', slotDbg);
    }

    try {
      // ── 1. ENSURE the sell GUI is open (reuse if possible). ──
      const acq = await acquireGui(protocol, startedAt, debugThisRun);
      if (acq.error === 'disconnected') {
        log('\x1b[33m[SELL]\x1b[0m Disconnected while opening GUI — aborting cycle');
        return { ok: false, reason: 'disconnected' };
      }
      if (acq.error === 'no_gui' || !acq.oc) {
        log('\x1b[31m[SELL]\x1b[0m Sell GUI never opened — aborting cycle (will retry next interval)');
        return { ok: false, reason: 'no_gui' };
      }
      let oc = acq.oc;
      let button = acq.button;

      // ── 2. LOCATE / fall back to the sell button. ──
      if (button) {
        log(`\x1b[32m[SELL]\x1b[0m GUI ${acq.reused ? 'reused (still open)' : 'opened'} — sell button at GUI[${button.slot}] "${button.label}" (score ${button.score})`);
      } else if (settings.buttonFallbackSlot !== null && !isEmptySlot((oc.slots || [])[settings.buttonFallbackSlot])) {
        const fb = oc.slots[settings.buttonFallbackSlot];
        button = { slot: settings.buttonFallbackSlot, item: fb, score: 0, name: itemName(fb), label: itemDisplayName(fb) };
        log(`\x1b[33m[SELL]\x1b[0m Sell button not matched dynamically — using fallback slot ${button.slot}`);
      } else {
        log('\x1b[31m[SELL]\x1b[0m Sell button NOT found — skipping cycle (GUI left open). Dump:');
        dumpContainer(oc, 'sell GUI (no button found)');
        dumpInventory(state);
        return { ok: false, reason: 'no_button' };
      }

      // ── 3. TRANSFER every inventory item into free GUI slots. ──
      const snapshot = (state.inventory?.slots || [])
        .slice(0, settings.inventorySlots)
        .map((s) => (s ? { ...s } : s));

      const usedGui = new Set();
      (oc.slots || []).forEach((s, i) => { if (!isEmptySlot(s)) usedGui.add(i); });
      usedGui.add(button.slot);

      const placedSlots = [];     // GUI destination slots we filled
      const placedInvSlots = [];  // player-inventory source slots we emptied
      const nextGuiSlot = () => {
        for (let i = 0; i < settings.guiSize; i++) if (!usedGui.has(i)) return i;
        return -1;
      };

      let moved = 0;
      let skipped = 0;
      let uncertain = 0;

      for (let invSlot = 0; invSlot < snapshot.length; invSlot++) {
        const item = snapshot[invSlot];
        if (isEmptySlot(item)) continue;

        if (!connected()) {
          log('\x1b[33m[SELL]\x1b[0m Disconnected mid-transfer — aborting cycle');
          return { ok: false, reason: 'disconnected' };
        }
        if (!protocol.getOpenContainer?.()) {
          log('\x1b[33m[SELL]\x1b[0m GUI closed mid-transfer — aborting (will reopen next interval)');
          return { ok: false, reason: 'gui_closed', moved };
        }

        const guiSlot = nextGuiSlot();
        if (guiSlot === -1) { log('\x1b[33m[SELL]\x1b[0m No free GUI slot left — stopping transfer'); break; }

        const count = countOf(item);
        const srcStackId = stackIdOf(item);
        const name = itemName(item);

        let outcome = 'fail';
        for (let r = 0; r <= settings.maxItemRetries && outcome === 'fail'; r++) {
          dbg(`move INV[${invSlot}] ${name} x${count} (stackId=${srcStackId}) -> GUI[${guiSlot}]${r ? ` (retry ${r})` : ''}`);
          let reqId = null;
          try {
            reqId = await protocol.sendItemStackRequest(buildMoveActions(invSlot, guiSlot, count, srcStackId));
          } catch (e) {
            log(`\x1b[31m[SELL]\x1b[0m move send failed: ${e.message}`);
            break;
          }
          const resp = await waitForEvent(
            protocol,
            'itemStackResponse',
            (p) => (p?.responses || []).some((r2) => String(r2.request_id) === String(reqId)),
            settings.perItemTimeoutMs
          );
          if (!resp) { outcome = 'timeout'; break; }
          const r2 = resp.responses.find((x) => String(x.request_id) === String(reqId));
          if (r2 && r2.status === 'ok') outcome = 'ok';
          else { outcome = 'fail'; if (r < settings.maxItemRetries) await sleep(settings.settleMs); }
        }

        if (outcome === 'ok') { usedGui.add(guiSlot); placedSlots.push(guiSlot); placedInvSlots.push(invSlot); moved++; }
        else if (outcome === 'timeout') { usedGui.add(guiSlot); placedSlots.push(guiSlot); placedInvSlots.push(invSlot); uncertain++; log(`\x1b[33m[SELL]\x1b[0m INV[${invSlot}] ${name}: no response (assuming sent)`); }
        else { skipped++; log(`\x1b[33m[SELL]\x1b[0m INV[${invSlot}] ${name}: move rejected — skipping`); }
        await sleep(settings.settleMs);
      }

      log(`\x1b[32m[SELL]\x1b[0m Items transferred — moved ${moved}, uncertain ${uncertain}, skipped ${skipped}`);

      if (moved === 0 && uncertain === 0) {
        log('\x1b[33m[SELL]\x1b[0m Nothing to sell this cycle — GUI left open, waiting for next interval');
        return { ok: true, moved: 0, uncertain: 0, skipped, clicked: false, amount: null, reused: acq.reused, durationMs: Date.now() - startedAt };
      }

      // ── 4. CLICK the sell button exactly once. ──
      if (!connected()) return { ok: false, reason: 'disconnected', moved };
      const liveButton = (protocol.getOpenContainer?.()?.slots || oc.slots || [])[button.slot];
      const buttonStackId = stackIdOf(liveButton ?? button.item);
      const buttonCount = countOf(liveButton ?? button.item);

      let clicked = false;
      try {
        const reqId = await protocol.sendItemStackRequest(buildClickActions(button.slot, buttonCount, buttonStackId));
        log(`\x1b[32m[SELL]\x1b[0m Sell button clicked (GUI[${button.slot}], ${settings.buttonClickType}, request_id=${reqId})`);
        clicked = true;
        const resp = await waitForEvent(
          protocol,
          'itemStackResponse',
          (p) => (p?.responses || []).some((r2) => String(r2.request_id) === String(reqId)),
          settings.clickTimeoutMs
        );
        if (resp) {
          const r2 = resp.responses.find((x) => String(x.request_id) === String(reqId));
          dbg(`button click response status=${r2?.status}`);
        }
      } catch (e) {
        log(`\x1b[31m[SELL]\x1b[0m Sell button click failed: ${e.message}`);
      }

      // ── 5. CONFIRM the sale (chat amount OR placed slots clearing). ──
      const slotsEmptied = () => {
        const cur = protocol.getOpenContainer?.()?.slots || [];
        return placedSlots.length > 0 && placedSlots.every((s) => isEmptySlot(cur[s]));
      };
      const deadline = Date.now() + settings.saleTimeoutMs;
      let confirmedBySlots = false;
      while (!saleMessage && Date.now() < deadline) {
        if (!connected()) break;
        if (clicked && slotsEmptied()) { confirmedBySlots = true; break; }
        await sleep(150);
      }

      const confirmed = Boolean(saleMessage || confirmedBySlots);
      if (saleMessage) log(`\x1b[32m[SELL] ✓ Sale completed — sold for ${saleMessage}\x1b[0m`);
      else if (confirmedBySlots) log('\x1b[32m[SELL] ✓ Sale completed — GUI slots cleared\x1b[0m');
      else log('\x1b[33m[SELL]\x1b[0m Sale not confirmed this cycle (will retry next interval) — GUI left open');

      // The server is slow to re-send the player inventory after items leave it
      // (verified: state stayed stale ~30s after a sale). Once the sale is
      // confirmed those source slots are definitively empty, so clear them in
      // local state now — otherwise the next cycle wastes time re-transferring
      // already-sold "ghost" items. Any later authoritative update is still applied.
      if (confirmed && placedInvSlots.length && typeof state.setInventory === 'function') {
        try {
          const slots = [...(state.inventory?.slots || [])];
          for (const inv of placedInvSlots) slots[inv] = { network_id: 0 };
          state.setInventory(slots, state.inventory?.heldSlot || 0);
          dbg(`cleared ${placedInvSlots.length} sold inventory slots in local state`);
        } catch (e) { dbg(`local inventory clear failed: ${e.message}`); }
      }

      await sleep(settings.postSaleMs);

      // ── 6. LEAVE THE GUI OPEN. No close. ──
      return {
        ok: true,
        moved,
        uncertain,
        skipped,
        clicked,
        amount: saleMessage,
        confirmed,
        reused: acq.reused,
        durationMs: Date.now() - startedAt,
      };
    } catch (e) {
      log(`\x1b[31m[SELL]\x1b[0m Cycle error: ${e.stack || e.message}`);
      // Do NOT close — leave the GUI open for the next cycle to reuse.
      return { ok: false, reason: 'error', error: e.message };
    } finally {
      protocol.removeListener('chat', onChat);
      if (respDbg) protocol.removeListener('itemStackResponse', respDbg);
      if (invDbg) protocol.removeListener('inventoryContent', invDbg);
      if (slotDbg) protocol.removeListener('inventorySlot', slotDbg);
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

  return { condition, execute, runOnce, dumpContainer, dumpInventory, findSellButton, settings };
}

module.exports = { createAutoSell, itemName, isEmptySlot, stackIdOf, itemDisplayName, stripColors };
