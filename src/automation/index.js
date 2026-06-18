'use strict';

/**
 * automation/index.js — Wires the tick-based Scheduler with the built-in actions.
 *
 * Built-in actions:
 *   - autoHit: every interval, select the sword slot and swing (left-click).
 *   - autoEat: every interval, select the food slot and hold "use item" for a
 *     fixed duration (eat/drink).
 *
 * Both action specs are always built so they can be toggled on/off at runtime
 * (e.g. from the `.hit` / `.eat` CLI commands), regardless of their initial
 * config `enabled` flag. The scheduler only ticks while at least one action is
 * registered; enabling an action starts it, disabling the last one is harmless
 * (the tick loop keeps running cheaply but does nothing).
 *
 * The two actions share a small `ctx` object so a hit never fires mid-eat
 * (swinging cancels eating in vanilla).
 *
 * The legacy interval-based AutomationManager is still exported for the test
 * harness, but is no longer part of the default automation stack.
 */

const { AutomationManager } = require('./legacy_manager');
const { Scheduler }         = require('./scheduler');
const { CooldownTracker }   = require('./cooldowns');
const { createAutoHit }     = require('./actions/auto_hit');
const { createAutoEat }     = require('./actions/auto_eat');
const { createAutoSell }    = require('./actions/auto_sell');

/**
 * Create and wire up the automation stack.
 *
 * @param {object} config            Full bot config
 * @param {import('../state').StateManager} stateManager
 * @param {object} protocolClient    BedrockProtocolClient
 */
function createAutomation(config, stateManager, protocolClient) {
  const automCfg   = config.automation || {};
  const actionsCfg = automCfg.actions || {};
  const scheduler  = new Scheduler(stateManager, protocolClient, automCfg.tickMs || 50);

  // Shared coordination flags across actions.
  const ctx = { eating: false, selling: false };

  const hitCfg  = actionsCfg.autoHit || {};
  const eatCfg  = actionsCfg.autoEat || {};
  const sellCfg = actionsCfg.autoSell || {};

  // Build both specs up front so runtime toggles always have something to register.
  const hitSpec = {
    name: 'autoHit',
    slot: hitCfg.slot ?? 0,
    interval: hitCfg.intervalMs ?? 1000,
    ...createAutoHit({ slot: hitCfg.slot ?? 0, ctx }),
  };
  const eatSpec = {
    name: 'autoEat',
    slot: eatCfg.slot ?? 1,
    interval: eatCfg.intervalMs ?? 300000,    // 5 min
    durationMs: eatCfg.durationMs ?? 10000,   // 10 s
    ...createAutoEat({ slot: eatCfg.slot ?? 1, durationMs: eatCfg.durationMs ?? 10000, ctx }),
  };

  const sellAction = createAutoSell({ ctx, config, log: console.log });
  const sellSpec = {
    name: 'autoSell',
    interval: sellCfg.intervalMs ?? 30000,    // 30 sec
    condition: sellAction.condition,
    execute: sellAction.execute,
  };

  // ── Internal register / unregister ──────────────────────────────────────────

  /**
   * @param {object} spec
   * @param {object} [opts]
   * @param {boolean} [opts.defer]  If true, wait one full interval before first fire.
   *                                If false, the action fires on the next tick.
   */
  function enable(spec, { defer = false } = {}) {
    scheduler.register(spec.name, spec.condition, spec.execute, spec.interval);
    if (defer) {
      scheduler.cooldowns.record(spec.name);  // start the interval now → first fire after it
    } else {
      scheduler.cooldowns.reset(spec.name);    // ready immediately → fire next tick
    }
    if (!scheduler.isRunning()) scheduler.start();
  }

  function disable(spec) {
    scheduler.unregister(spec.name);
    if (spec.name === 'autoEat') {
      // Never leave a held eat across a disable.
      ctx.eating = false;
      protocolClient?.setUsingItem?.(false);
    }
  }

  function isOn(name) {
    return scheduler.actions.has(name);
  }

  return {
    scheduler,

    /** Turn auto-hit on/off. Fires immediately when turned on. */
    setHit(on) {
      if (on) enable(hitSpec);
      else disable(hitSpec);
      return isOn('autoHit');
    },

    /** Turn auto-eat on/off. Eats immediately when turned on, then every interval. */
    setEat(on) {
      if (on) enable(eatSpec);
      else disable(eatSpec);
      return isOn('autoEat');
    },

    /** Turn auto-sell on/off. First cycle is deferred one interval when enabled. */
    setSell(on) {
      if (on) enable(sellSpec, { defer: true });
      else disable(sellSpec);
      return isOn('autoSell');
    },

    /** Run a single sell cycle now (manual .sell). */
    async sellOnce(stateMgr = stateManager, proto = protocolClient) {
      return sellAction.runOnce(stateMgr, proto);
    },

    /** Run a single sell cycle now with full debug logging (.sell debug). */
    async sellDebug(stateMgr = stateManager, proto = protocolClient) {
      return sellAction.runOnce(stateMgr, proto, { debug: true });
    },

    isHitOn() { return isOn('autoHit'); },
    isEatOn() { return isOn('autoEat'); },
    isSellOn() { return isOn('autoSell'); },

    getStatus() {
      return {
        running:     scheduler.isRunning(),
        hit:         isOn('autoHit'),
        eat:         isOn('autoEat'),
        sell:        isOn('autoSell'),
        eating:      ctx.eating,
        selling:     ctx.selling,
        hitSlot:     hitSpec.slot,
        hitInterval: hitSpec.interval,
        eatSlot:     eatSpec.slot,
        eatInterval: eatSpec.interval,
        eatDuration: eatSpec.durationMs,
        sellInterval: sellSpec.interval,
      };
    },

    /** Called on spawn — auto-registers whatever the config enabled. */
    start() {
      if (hitCfg.enabled)  enable(hitSpec);                  // hit starts firing right away
      if (eatCfg.enabled)  enable(eatSpec, { defer: true });  // first eat deferred one interval
      if (sellCfg.enabled) enable(sellSpec, { defer: true }); // first sell deferred one interval
    },

    /** Called on disconnect / shutdown. */
    stop() {
      scheduler.stop();
      ctx.eating = false;
      ctx.selling = false;
      protocolClient?.setUsingItem?.(false);
    },

    isActive() { return scheduler.isRunning(); },
  };
}

module.exports = {
  createAutomation,
  AutomationManager,
  Scheduler,
  CooldownTracker,
};
