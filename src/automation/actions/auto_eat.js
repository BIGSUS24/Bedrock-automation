'use strict';

/**
 * automation/actions/auto_eat.js
 *
 * Action: on a fixed interval (default every 5 min), select the food hotbar
 * slot and hold "use item" for a fixed duration (default 10s) so the server
 * runs the eat animation to completion.
 *
 * The user manually places food in the configured slot (default 1).
 *
 * Eating is driven entirely through the player_auth_input keep-alive: while
 * the hold is active, every frame carries using_item: true (see
 * BedrockProtocolClient.setUsingItem). The hold is fire-and-forget — execute()
 * returns immediately and a timer releases the flag — so it never blocks the
 * scheduler's per-tick loop (the 1s auto-hit keeps firing meanwhile, though it
 * is suppressed for the eat window via the shared `ctx.eating` flag).
 */

/**
 * Build the eat action's condition + execute, closed over a shared context.
 * @param {{ slot: number, durationMs: number, ctx: { eating: boolean } }} opts
 */
function createAutoEat({ slot = 1, durationMs = 10000, ctx }) {
  function condition(state) {
    if (ctx.eating) return false;          // already eating — don't re-fire
    return state.isPlaying();
  }

  async function execute(state, protocol) {
    ctx.eating = true;
    try {
      await protocol.selectHotbarSlot?.(slot);
      protocol.setUsingItem?.(true);
    } catch (e) {
      // Couldn't start eating — release immediately so we retry next interval.
      protocol.setUsingItem?.(false);
      ctx.eating = false;
      return;
    }

    // Release the hold after the eat duration (non-blocking).
    setTimeout(() => {
      try {
        protocol.setUsingItem?.(false);
      } finally {
        ctx.eating = false;
      }
    }, durationMs);
  }

  return { condition, execute };
}

module.exports = { createAutoEat };
