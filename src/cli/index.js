'use strict';

/**
 * cli/index.js — Interactive terminal CLI
 *
 * Reads from stdin, displays formatted chat, handles bot commands.
 */

const readline = require('readline');
const { formatChat, formatTimestamp } = require('./formatter');
const { InputHandler } = require('./input_handler');

class InteractiveCLI {
  constructor(bot) {
    this.bot = bot;
    this.inputHandler = new InputHandler(bot);
    this.rl = null;
    this._started = false;
  }

  setAfkManager(afk) {
    this.inputHandler.setAfkManager(afk);
  }

  start() {
    if (this._started) return;
    this._started = true;

    // Wire chat display
    this.bot.protocol.on('chat', (packet) => {
      const formatted = formatChat(packet);
      if (formatted) {
        const ts = formatTimestamp();
        // Move to new line, print chat, re-show prompt
        if (this.rl) {
          process.stdout.clearLine?.(0);
          process.stdout.cursorTo?.(0);
        }
        console.log(`\x1b[90m${ts}\x1b[0m ${formatted}`);
        if (this.rl) this.rl.prompt(true);
      }
    });

    // Create readline interface
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '\x1b[36m> \x1b[0m',
      terminal: true,
    });

    console.log('\x1b[32m');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   Bedrock-Bot Interactive CLI             ║');
    console.log('║   Type messages to chat                   ║');
    console.log('║   /command for server commands             ║');
    console.log('║   .help for bot commands                   ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('\x1b[0m');

    this.rl.prompt();

    this.rl.on('line', async (line) => {
      await this.inputHandler.handle(line);
      this.rl.prompt();
    });

    this.rl.on('close', async () => {
      console.log('\nShutting down...');
      await this.bot.stop();
      process.exit(0);
    });
  }

  stop() {
    this._started = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

module.exports = { InteractiveCLI };
