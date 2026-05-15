'use strict';

/**
 * reconnect/index.js — Public reconnect API
 *
 * Exports ReconnectStateMachine as the primary interface.
 * The old ReconnectManager is replaced — ReconnectStateMachine is the authoritative reconnect controller.
 *
 * Usage:
 *   const { ReconnectStateMachine } = require('./reconnect');
 *   const rm = new ReconnectStateMachine(config, stateManager, protocolClient, { automation, queue });
 *   protocol.on('disconnected', () => rm.trigger('server disconnected'));
 */

const { ReconnectStateMachine, ReconnectState } = require('./state_machine');
const { CleanupManager }                        = require('./cleanup');
const { BackoffCalculator }                     = require('./backoff');

// Backwards-compatible alias
const ReconnectManager = ReconnectStateMachine;

const RECONNECT_GUARDS = {
  minDelay:            1000,
  maxRetriesPerMinute: 10,
  jitterRange:         500,
};

module.exports = {
  ReconnectStateMachine,
  ReconnectManager,       // backwards compat
  ReconnectState,
  CleanupManager,
  BackoffCalculator,
  RECONNECT_GUARDS,
};