'use strict';

/**
 * state/reducers/index.js — Reducer barrel
 *
 * Each reducer handles a single class of incoming packet payloads
 * and writes updates exclusively through StateManager methods.
 *
 * Usage:
 *   const reducers = createReducers(stateManager);
 *   protocol.on('SET_HEALTH',        (buf) => reducers.health.reduce(buf));
 *   protocol.on('MOVE_PLAYER',       (buf) => reducers.position.reduceMovePlayer(buf));
 *   protocol.on('INVENTORY_CONTENT', (buf) => reducers.inventory.reduce(buf));
 */

const { HealthReducer }    = require('./health');
const { HungerReducer }    = require('./hunger');
const { PositionReducer }  = require('./position');
const { InventoryReducer } = require('./inventory');

/**
 * Create all reducers, each bound to the same StateManager instance.
 * @param {import('../index').StateManager} stateManager
 */
function createReducers(stateManager) {
  const health    = new HealthReducer(stateManager);
  const hunger    = new HungerReducer(stateManager);
  const position  = new PositionReducer(stateManager);
  const inventory = new InventoryReducer(stateManager);

  return { health, hunger, position, inventory };
}

module.exports = {
  createReducers,
  HealthReducer,
  HungerReducer,
  PositionReducer,
  InventoryReducer,
};
