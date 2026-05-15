/**
 * test_bot.js — Interactive Bedrock Bot for DonutSMP
 *
 * Usage:
 *   node test_bot.js                    (default: donutsmp.config.js)
 *   node test_bot.js myserver.config.js (custom config)
 *
 * First run: Microsoft login link shown. After that, tokens are cached.
 *
 * In the CLI:
 *   Type a message → sends as chat
 *   /command       → sends as server command
 *   .help          → show all bot commands
 *   .afk on        → enable anti-AFK
 *   .quit          → disconnect
 */
'use strict';

const { BedrockBot }     = require('./src/main.js');
const { InteractiveCLI } = require('./src/cli/index.js');
const { AfkManager }     = require('./src/automation/afk.js');

const configFile = process.argv[2] || 'donutsmp.config.js';
const bot = new BedrockBot(configFile);

process.on('unhandledRejection', (e) => {
  console.error('\x1b[31m[Fatal]\x1b[0m', e?.message || e);
});

process.on('SIGINT', async () => {
  console.log('\nStopping bot...');
  await bot.stop();
  process.exit(0);
});

console.log('=== Bedrock-Bot v3 ===');
console.log(`Config: ${configFile}`);
console.log('Connecting...\n');

bot.start().then(() => {
  // Set up AFK manager
  const afk = new AfkManager(bot.protocol, bot.state);

  // Set up interactive CLI (suppresses duplicate chat logging in main.js)
  bot._cliAttached = true;
  const cli = new InteractiveCLI(bot);
  cli.setAfkManager(afk);
  cli.start();

  console.log('\x1b[32m✓ Bot is playing! Type .help for commands.\x1b[0m\n');
}).catch((e) => {
  console.error('\x1b[31mFailed to start:\x1b[0m', e.message);
  console.log('The bot will try to reconnect automatically...');
});
