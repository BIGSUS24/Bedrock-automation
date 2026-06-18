'use strict';

/**
 * automation/actions/auto_hit.js
 *
 * Action: every interval, select the sword hotbar slot and swing ("hit").
 *
 * This emulates a left-click auto-hitter. It sends the arm-swing animation
 * only — it does NOT target a specific entity, so on a survival server it
 * will not necessarily deal damage to a mob/player. It is intended for
 * anti-AFK / "hold attack" setups where a swing on the held item is enough.
 *
 * The user manually places a sword in the configured slot (default 0).
 *
 * Suppressed while an eat is in progress, because swinging cancels eating
 * in vanilla. Coordination is via the shared `ctx.eating` flag.
 */

/**
 * Build the hit action's condition + execute, closed over a shared context.
 * @param {{ slot: number, ctx: { eating: boolean } }} opts
 */
function createAutoHit({ slot = 0, ctx }) {
  function condition(state) {
    if (ctx.eating) return false;          // don't swing mid-eat (would cancel it)
    if (ctx.selling) return false;         // don't swing mid-sell (slot changes corrupt container transactions)
    return state.isPlaying();
  }

  async function execute(state, protocol) {
    try {
      await protocol.selectHotbarSlot?.(slot);
      await protocol.sendSwing?.();
    } catch (e) {
      // Transient (e.g. mid-reconnect) — let the next tick retry.
    }
  }

  return { condition, execute };
}

module.exports = { createAutoHit };
