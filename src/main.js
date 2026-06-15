'use strict';

/**
 * main.js — BedrockBot entry point v3
 *
 * Auth is now handled entirely by bedrock-protocol (prismarine-auth).
 * On first run, it shows a device code URL. After login, tokens are
 * cached in .auth_cache/ and reused automatically.
 */

const { ConfigManager }         = require('./config');
const { StateManager }          = require('./state');
const { BedrockProtocolClient } = require('./protocol');
const { ReconnectStateMachine } = require('./reconnect');
const { Logger }                = require('./utils');
const { GameplayController }    = require('./gameplay');
const { createAutomation }      = require('./automation');

class BedrockBot {
  constructor(configPath = null) {
    this.configManager = new ConfigManager();
    this.config        = configPath
      ? this.configManager.load(configPath)
      : this.configManager.getAll();

    this.logger    = new Logger(this.config);
    this.state     = new StateManager();
    this.protocol   = null;
    this.reconnect  = null;
    this.gameplay   = null;
    this.automation = null;
    this.running    = false;
  }

  async start() {
    this.logger.info('Starting Bedrock-Bot v3.0.0');
    this.logger.info(`Target: ${this.config.server.address}:${this.config.server.port}`);
    this.logger.info(`Version: ${this.config.server.version || 'latest'}  Auth: ${this.config.auth.mode}`);

    // Build protocol client (uses bedrock-protocol internally)
    this.protocol = new BedrockProtocolClient(this.config, this.state);
    this.gameplay = new GameplayController(this.config, this.protocol, this.state);
    this.automation = createAutomation(this.config, this.state, this.protocol);
    this._wireProtocolEvents();

    // Reconnect state machine
    this.reconnect = new ReconnectStateMachine(
      this.config, this.state, this.protocol, {}
    );
    this._wireReconnectEvents();

    // Connect (bedrock-protocol will show device code if first run)
    try {
      await this.protocol.connect();
      this.running = true;
      this.logger.info('Bot is now playing!');
    } catch (err) {
      this.logger.error(`Connection failed: ${err.message}`);
      this.state.setDisconnectReason(err.message);
      if (this.config.reconnect?.enabled) {
        await this.reconnect.trigger('initial connect failed');
      }
    }
  }

  _wireProtocolEvents() {
    this.protocol.on('connected', () => {
      this.logger.info('RakNet connected — login sequence starting');
    });

    this.protocol.on('loggedIn', () => {
      this.logger.info('Login accepted by server');
    });

    this.protocol.on('spawn', () => {
      this.logger.info('✓ Player spawned — ready to play!');
      if (this.automation && !this.automation.isActive()) {
        this.automation.start();
        const active = this.automation.scheduler.getRegisteredActions();
        if (active.length) this.logger.info(`Automation started: ${active.join(', ')}`);
      }
    });

    this.protocol.on('gameStart', () => {
      this.logger.info('START_GAME received');
    });

    this.protocol.on('chat', ({ sender, message }) => {
      // Only log if no interactive CLI is attached (CLI handles display itself)
      if (!this._cliAttached) this.logger.info(`[CHAT] <${sender}> ${message}`);
    });

    this.protocol.on('kicked', ({ message }) => {
      this.logger.warn(`Kicked: ${message}`);
      this._handleDisconnect(message);
    });

    this.protocol.on('disconnected', (info) => {
      this.logger.warn(`Disconnected: ${info.reason}`);
      this._handleDisconnect(info.reason);
    });

    this.protocol.on('error', (err) => {
      // Filter out harmless NBT packet-decode errors that spam the log.
      // These come from server-sent chunk/entity/level packets that bedrock-protocol
      // cannot fully parse on this version. They are non-fatal — the connection stays
      // alive. Tags 103 ('g') and 116 ('t') are ASCII bytes misread as NBT tag IDs.
      const msg = err.message || '';
      const isNbtNoise = (
        /Invalid tag:\s*\d+\s*>\s*\d+/.test(msg) ||
        /Missing characters in string/.test(msg) ||
        /Read error for undefined/.test(msg)
      );
      if (!isNbtNoise) {
        this.logger.error(`Protocol error: ${msg}`);
      }
    });

    this.state.on('statsUpdate', ({ health, hunger }) => {
      if (health <= 4) this.logger.warn(`Low health: ${health}/20`);
      if (hunger <= 4) this.logger.warn(`Low hunger: ${hunger}/20`);
    });
  }

  _wireReconnectEvents() {
    this.reconnect.on('reconnectScheduled', ({ delay, retryCount }) => {
      this.logger.info(`Reconnect attempt ${retryCount} in ${Math.round(delay / 1000)}s`);
    });

    this.reconnect.on('reconnecting', ({ retryCount }) => {
      this.logger.info(`Connecting... (attempt ${retryCount})`);
    });

    this.reconnect.on('reconnectSuccess', () => {
      this.logger.info('Reconnected successfully');
    });

    this.reconnect.on('maxRetriesReached', ({ retryCount }) => {
      this.logger.error(`Max retries (${retryCount}) reached — giving up`);
      this.running = false;
    });
  }

  _handleDisconnect(reason) {
    this.automation?.stop();
    if (this.config.reconnect?.enabled && this.reconnect) {
      this.reconnect.trigger(reason);
    } else {
      this.running = false;
      this.logger.error('Reconnect disabled — stopping');
    }
  }

  async stop() {
    this.running = false;
    this.automation?.stop();
    this.gameplay?.stop();
    this.reconnect?.stop();
    if (this.protocol) await this.protocol.disconnect('User stopped bot');
    this.logger.info('Bot stopped');
  }
}

module.exports = { BedrockBot };

if (require.main === module) {
  const bot = new BedrockBot(process.argv[2] || null);

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await bot.stop();
    process.exit(0);
  });

  process.on('unhandledRejection', (e) => {
    console.error('[Fatal]', e?.message || e);
    bot.stop().finally(() => process.exit(1));
  });

  bot.start().catch((e) => {
    console.error('[Startup error]', e.message);
    process.exit(1);
  });
}
