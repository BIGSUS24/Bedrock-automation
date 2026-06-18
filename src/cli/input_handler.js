'use strict';

/**
 * cli/input_handler.js — Parse user input & route to handlers
 *
 *  /command    → server command
 *  .botcmd     → local bot command
 *  anything    → chat message
 */

const { stripColors } = require('./formatter');

const HELP_TEXT = `
╔══════════════════════════════════════════════════╗
║              Bedrock-Bot Commands                ║
╠══════════════════════════════════════════════════╣
║  CHAT & COMMANDS                                 ║
║  Just type      — Send as chat message           ║
║  /command       — Send server command            ║
║                                                  ║
║  BOT COMMANDS (.prefix)                          ║
║  .help          — Show this help                 ║
║  .status        — Health, hunger, position       ║
║  .pos           — Show current position          ║
║  .quit          — Disconnect and exit            ║
║                                                  ║
║  AFK CONTROLS                                    ║
║  .afk on        — Enable anti-AFK (jump+look)    ║
║  .afk off       — Disable anti-AFK               ║
║  .afk jump <s>  — Set jump interval (default 30) ║
║  .afk status    — Show AFK settings              ║
║                                                  ║
║  AUTOMATION                                      ║
║  .hit [on|off]  — Toggle auto-hit (sword swing)  ║
║  .eat [on|off]  — Toggle auto-eat (hold use)     ║
║  .sell          — Sell once (dump inv → GUI)     ║
║  .sell on|off   — Toggle auto-sell loop (30s)    ║
║  .sell debug    — Sell once + dump GUI/inventory ║
║  .auto          — Show automation status         ║
║                                                  ║
║  TPA                                             ║
║  .tpa <player>  — Send /tpa <player>             ║
║  .tpaccept      — Accept TPA request             ║
║  .tpadeny       — Deny TPA request               ║
║                                                  ║
║  DONUTSMP SHORTCUTS                              ║
║  .warp <name>   — /warp spawn, crates, shop...   ║
║  .home          — /home                          ║
║  .bal           — /bal                           ║
║  .pay <p> <amt> — /pay <player> <amount>         ║
║  .kit           — /kit                           ║
╚══════════════════════════════════════════════════╝
`;

const GAMEPLAY_HELP_TEXT = `
GAMEPLAY
  .pull [x y z] [face] Use configured pearl pull trapdoor, or exact coords if given
  .mine <block> [n]    Mine loaded blocks/ores, e.g. .mine diamond_ore 3
  .mine stop           Stop active mining task
  .worldinfo           Show world tracker state (loaded chunks, block updates)
  .scan <block>        Scan for blocks around current position
  .blockat <x> <y> <z> Check what block is at a position
`;

class InputHandler {
  constructor(bot) {
    this.bot = bot;
    this.protocol = bot.protocol;
    this.state = bot.state;
    this.gameplay = bot.gameplay;
    this.afkManager = null;  // set later
  }

  setAfkManager(afk) {
    this.afkManager = afk;
  }

  async handle(rawInput) {
    const input = rawInput.trim();
    if (!input) return;

    // Server command: /something
    if (input.startsWith('/')) {
      return this._sendCommand(input);
    }

    // Bot command: .something
    if (input.startsWith('.')) {
      return this._handleBotCommand(input);
    }

    // Regular chat message
    return this._sendChat(input);
  }

  async _sendChat(message) {
    try {
      await this.protocol.sendChat(message);
      console.log(`\x1b[36m[YOU]\x1b[0m ${message}`);
    } catch (e) {
      console.log(`\x1b[31m[ERROR] Can't send: ${e.message}\x1b[0m`);
    }
  }

  async _sendCommand(command) {
    try {
      await this.protocol.sendCommand(command);
      console.log(`\x1b[33m[CMD]\x1b[0m ${command}`);
    } catch (e) {
      console.log(`\x1b[31m[ERROR] Can't send: ${e.message}\x1b[0m`);
    }
  }

  async _handleBotCommand(input) {
    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case 'help':
        console.log(HELP_TEXT);
        console.log(GAMEPLAY_HELP_TEXT);
        break;

      case 'status':
        this._showStatus();
        break;

      case 'pos':
        this._showPosition();
        break;

      case 'pull':
        await this._handlePull(args);
        break;

      case 'mine':
        await this._handleMine(args);
        break;

      case 'quit':
      case 'exit':
      case 'disconnect':
        console.log('\x1b[33mDisconnecting...\x1b[0m');
        await this.bot.stop();
        process.exit(0);
        break;

      case 'say':
        if (args.length) await this._sendChat(args.join(' '));
        else console.log('\x1b[31mUsage: .say <message>\x1b[0m');
        break;

      case 'cmd':
        if (args.length) await this._sendCommand('/' + args.join(' '));
        else console.log('\x1b[31mUsage: .cmd <command>\x1b[0m');
        break;

      // AFK commands
      case 'afk':
        this._handleAfk(args);
        break;

      // Automation toggles
      case 'hit':
        this._handleAutomationToggle('hit', args);
        break;

      case 'eat':
        this._handleAutomationToggle('eat', args);
        break;

      case 'auto':
        this._showAutomationStatus();
        break;

      case 'sell':
        await this._handleSell(args);
        break;

      // TPA shortcuts
      case 'tpa':
        if (args.length) await this._sendCommand(`/tpa ${args.join(' ')}`);
        else console.log('\x1b[31mUsage: .tpa <player>\x1b[0m');
        break;

      case 'tpaccept':
        await this._sendCommand('/tpaccept');
        break;

      case 'tpadeny':
      case 'tpdeny':
        await this._sendCommand('/tpdeny');
        break;

      // DonutSMP shortcuts
      case 'warp':
        if (args.length) await this._sendCommand(`/warp ${args.join(' ')}`);
        else console.log('\x1b[31mUsage: .warp <name>  (spawn, crates, shop, pvp)\x1b[0m');
        break;

      case 'home':
        await this._sendCommand('/home');
        break;

      case 'spawn':
        await this._sendCommand('/warp spawn');
        break;

      case 'bal':
      case 'balance':
        await this._sendCommand('/bal');
        break;

      case 'pay':
        if (args.length >= 2) await this._sendCommand(`/pay ${args[0]} ${args[1]}`);
        else console.log('\x1b[31mUsage: .pay <player> <amount>\x1b[0m');
        break;

      case 'kit':
        await this._sendCommand('/kit');
        break;

      case 'worldinfo':
        this._showWorldInfo();
        break;

      case 'scan':
        this._handleScan(args);
        break;

      case 'blockat':
        this._handleBlockAt(args);
        break;

      case 'inv':
        this._showInventory();
        break;

      default:
        console.log(`\x1b[31mUnknown command: .${cmd}  (type .help)\x1b[0m`);
    }
  }

  /**
   * .hit / .eat  → toggle
   * .hit on|off  → set explicitly
   * .hit status  → show automation status
   */
  _handleAutomationToggle(kind, args) {
    const auto = this.bot.automation;
    if (!auto) {
      console.log('\x1b[31mAutomation not loaded\x1b[0m');
      return;
    }

    const sub = args[0]?.toLowerCase();
    if (sub === 'status') {
      this._showAutomationStatus();
      return;
    }

    const isOn = kind === 'hit' ? auto.isHitOn() : auto.isEatOn();
    let target;
    if (sub === 'on')       target = true;
    else if (sub === 'off') target = false;
    else if (!sub)          target = !isOn;          // bare command toggles
    else {
      console.log(`\x1b[31mUsage: .${kind} on|off|status\x1b[0m`);
      return;
    }

    const result = kind === 'hit' ? auto.setHit(target) : auto.setEat(target);
    const label  = kind === 'hit' ? 'Auto-hit' : 'Auto-eat';
    if (result) {
      const st = auto.getStatus();
      const detail = kind === 'hit'
        ? `slot ${st.hitSlot}, every ${st.hitInterval / 1000}s`
        : `slot ${st.eatSlot}, ${st.eatDuration / 1000}s every ${st.eatInterval / 1000}s`;
      console.log(`\x1b[32m✓ ${label} ENABLED\x1b[0m (${detail})`);
    } else {
      console.log(`\x1b[33m✗ ${label} disabled\x1b[0m`);
    }
  }

  /**
   * .sell           → run one sell cycle now
   * .sell on|off    → toggle the 3-min auto-sell loop
   * .sell debug     → run one sell cycle with full container/inventory dump
   * .sell status    → show automation status
   */
  async _handleSell(args) {
    const auto = this.bot.automation;
    if (!auto) {
      console.log('\x1b[31mAutomation not loaded\x1b[0m');
      return;
    }
    const sub = args[0]?.toLowerCase();

    if (sub === 'status') { this._showAutomationStatus(); return; }

    if (sub === 'on' || sub === 'off') {
      const on = auto.setSell(sub === 'on');
      console.log(on
        ? `\x1b[32m✓ Auto-sell ENABLED\x1b[0m (every ${auto.getStatus().sellInterval / 1000}s)`
        : '\x1b[33m✗ Auto-sell disabled\x1b[0m');
      return;
    }

    if (sub && sub !== 'debug' && sub !== 'now') {
      console.log('\x1b[31mUsage: .sell [on|off|debug|status]\x1b[0m');
      return;
    }

    // Bare `.sell` or `.sell debug` → run one cycle immediately.
    const debug = sub === 'debug';
    console.log(`\x1b[36m[SELL]\x1b[0m Running ${debug ? 'debug ' : ''}sell cycle...`);
    try {
      const result = debug ? await auto.sellDebug() : await auto.sellOnce();
      if (!result.ok) {
        console.log(`\x1b[33m[SELL]\x1b[0m Cycle did not complete: ${result.reason || 'unknown'}`);
      } else {
        console.log(`\x1b[32m[SELL]\x1b[0m Done — moved ${result.moved}, uncertain ${result.uncertain || 0}, skipped ${result.skipped}${result.amount ? `, earned ${result.amount}` : ''}`);
      }
    } catch (e) {
      console.log(`\x1b[31m[SELL]\x1b[0m ${e.message}`);
    }
  }

  _showAutomationStatus() {
    const auto = this.bot.automation;
    if (!auto) {
      console.log('\x1b[31mAutomation not loaded\x1b[0m');
      return;
    }
    const s = auto.getStatus();
    const on  = '\x1b[32mON\x1b[0m';
    const off = '\x1b[31mOFF\x1b[0m';
    console.log(`\x1b[36m[AUTO]\x1b[0m hit: ${s.hit ? on : off}  (slot ${s.hitSlot}, every ${s.hitInterval / 1000}s)`);
    console.log(`\x1b[36m[AUTO]\x1b[0m eat: ${s.eat ? on : off}  (slot ${s.eatSlot}, ${s.eatDuration / 1000}s every ${s.eatInterval / 1000}s)${s.eating ? '  \x1b[33m[eating now]\x1b[0m' : ''}`);
    console.log(`\x1b[36m[AUTO]\x1b[0m sell: ${s.sell ? on : off}  (every ${s.sellInterval / 1000}s)${s.selling ? '  \x1b[33m[selling now]\x1b[0m' : ''}`);
  }

  _handleAfk(args) {
    const sub = args[0]?.toLowerCase();

    if (!this.afkManager) {
      console.log('\x1b[31mAFK manager not loaded\x1b[0m');
      return;
    }

    switch (sub) {
      case 'on':
        this.afkManager.start();
        console.log('\x1b[32m✓ Anti-AFK enabled (jump + random look)\x1b[0m');
        break;
      case 'off':
        this.afkManager.stop();
        console.log('\x1b[33m✗ Anti-AFK disabled\x1b[0m');
        break;
      case 'jump':
        const interval = parseInt(args[1]) || 30;
        this.afkManager.setJumpInterval(interval);
        console.log(`\x1b[32m✓ Jump interval: ${interval}s\x1b[0m`);
        break;
      case 'status':
        const status = this.afkManager.getStatus();
        console.log(`  AFK: ${status.active ? '\x1b[32mON\x1b[0m' : '\x1b[31mOFF\x1b[0m'}`);
        console.log(`  Jump interval: ${status.jumpInterval}s`);
        console.log(`  Jumps sent: ${status.jumpCount}`);
        break;
      default:
        console.log('Usage: .afk on|off|jump <secs>|status');
    }
  }

  async _handlePull(args = []) {
    if (!this.gameplay) {
      console.log('\x1b[31mGameplay controller not loaded\x1b[0m');
      return;
    }

    const explicitTarget = this._parseBlockTarget(args);
    console.log(`\x1b[36m[PULL]\x1b[0m ${explicitTarget ? `Using target ${explicitTarget.position.x}, ${explicitTarget.position.y}, ${explicitTarget.position.z}...` : 'Searching for pearl pull trapdoor...'}`);
    try {
      const result = await this.gameplay.pull(explicitTarget || {});
      console.log(`${result.ok ? '\x1b[32m[PULL]\x1b[0m' : '\x1b[31m[PULL]\x1b[0m'} ${result.message}`);
    } catch (e) {
      console.log(`\x1b[31m[PULL]\x1b[0m ${e.message}`);
    }
  }

  async _handleMine(args) {
    if (!this.gameplay) {
      console.log('\x1b[31mGameplay controller not loaded\x1b[0m');
      return;
    }

    const target = args[0]?.toLowerCase();
    if (!target) {
      console.log('\x1b[31mUsage: .mine <block/ore> [count]  or  .mine stop\x1b[0m');
      return;
    }

    const count = Number.parseInt(args[1], 10);
    console.log(`\x1b[36m[MINE]\x1b[0m ${target === 'stop' ? 'Stopping mining...' : `Mining ${target}${Number.isFinite(count) ? ` x${count}` : ''}...`}`);
    try {
      const result = await this.gameplay.mine(target, Number.isFinite(count) ? { count } : {});
      console.log(`${result.ok ? '\x1b[32m[MINE]\x1b[0m' : '\x1b[31m[MINE]\x1b[0m'} ${result.message}`);
    } catch (e) {
      console.log(`\x1b[31m[MINE]\x1b[0m ${e.message}`);
    }
  }

  _showStatus() {
    const p = this.state.player || {};
    const s = this.state.session || {};
    const connected = this.protocol.isConnected();
    const uptime = s.connectedAt ? Math.round((Date.now() - s.connectedAt) / 1000) : 0;

    console.log(`
  ┌─────────────────────────────────┐
  │ Status: ${connected ? '\x1b[32mCONNECTED\x1b[0m' : '\x1b[31mDISCONNECTED\x1b[0m'}             │
  │ Health: \x1b[31m❤ ${p.health ?? '?'}/20\x1b[0m              │
  │ Hunger: \x1b[33m🍖 ${p.hunger ?? '?'}/20\x1b[0m              │
  │ Position: ${Math.round(p.position?.x ?? 0)}, ${Math.round(p.position?.y ?? 0)}, ${Math.round(p.position?.z ?? 0)}
  │ Uptime: ${uptime}s                      │
  └─────────────────────────────────┘`);
  }

  _showPosition() {
    const pos = this.state.player?.position;
    if (pos) {
      console.log(`  Position: X=${pos.x.toFixed(2)}  Y=${pos.y.toFixed(2)}  Z=${pos.z.toFixed(2)}`);
    } else {
      console.log('  Position: unknown');
    }
  }

  _showWorldInfo() {
    if (!this.gameplay?.world) {
      console.log('\x1b[31mWorld tracker not available\x1b[0m');
      return;
    }
    const stats = this.gameplay.world.getStats();
    console.log(`\x1b[36m[WORLD]\x1b[0m Loaded chunks: ${stats.loadedChunks}`);
    console.log(`\x1b[36m[WORLD]\x1b[0m Received chunks: ${stats.receivedChunks}`);
    console.log(`\x1b[36m[WORLD]\x1b[0m Failed chunks: ${stats.failedChunks}`);
    console.log(`\x1b[36m[WORLD]\x1b[0m Block updates: ${stats.blockUpdates}`);
    console.log(`\x1b[36m[WORLD]\x1b[0m Tracked items: ${stats.trackedItems}`);
    if (stats.chunkWarning) console.log(`\x1b[33m[WORLD]\x1b[0m Warning: ${stats.chunkWarning}`);
  }

  _handleScan(args) {
    if (!this.gameplay?.world) {
      console.log('\x1b[31mWorld tracker not available\x1b[0m');
      return;
    }
    const query = args[0]?.toLowerCase();
    if (!query) {
      console.log('\x1b[31mUsage: .scan <block>  e.g. .scan spruce_trapdoor\x1b[0m');
      return;
    }
    const origin = this.state.player?.position || { x: 0, y: 0, z: 0 };
    const results = this.gameplay.world.findBlocks({
      origin,
      radius: 48,
      yRadius: 16,
      limit: 10,
      match: (block) => this.gameplay.world.matcher.matches(block, query),
    });
    if (!results.length) {
      console.log(`\x1b[33m[SCAN]\x1b[0m No ${query} found within 48 blocks`);
      return;
    }
    console.log(`\x1b[32m[SCAN]\x1b[0m Found ${results.length} ${query}:`);
    for (const r of results) {
      const dist = Math.sqrt(r.distanceSq).toFixed(1);
      console.log(`  ${r.block?.name || 'unknown'} at ${r.position.x}, ${r.position.y}, ${r.position.z} (dist=${dist}, runtime=${r.runtimeId}, source=${r.source || 'chunk'})`);
    }
  }

  _handleBlockAt(args) {
    if (!this.gameplay?.world) {
      console.log('\x1b[31mWorld tracker not available\x1b[0m');
      return;
    }
    if (args.length < 3) {
      console.log('\x1b[31mUsage: .blockat <x> <y> <z>\x1b[0m');
      return;
    }
    const [x, y, z] = args.map(Number);
    if (![x, y, z].every(Number.isFinite)) {
      console.log('\x1b[31mInvalid coordinates\x1b[0m');
      return;
    }
    const entry = this.gameplay.world.getBlock({ x, y, z });
    if (!entry) {
      const loaded = this.gameplay.world.isChunkLoaded({ x, y, z });
      const received = this.gameplay.world.isChunkReceived({ x, y, z });
      console.log(`\x1b[33m[BLOCK]\x1b[0m No data at ${x}, ${y}, ${z} (chunk loaded=${loaded}, received=${received})`);
    } else {
      console.log(`\x1b[32m[BLOCK]\x1b[0m ${entry.block?.name || 'unknown'} at ${x}, ${y}, ${z} (runtime=${entry.runtimeId}, source=${entry.source || 'chunk'})`);
    }
  }

  _parseBlockTarget(args) {
    if (!args || args.length < 3) return null;
    const [x, y, z] = args.slice(0, 3).map((value) => Number(value));
    if (![x, y, z].every(Number.isFinite)) return null;
    const face = Number(args[3]);
    return {
      position: { x, y, z },
      ...(Number.isFinite(face) ? { face } : {}),
    };
  }
  _showInventory() {
    const slots = this.bot.state?.inventory?.slots || [];
    const heldSlot = this.bot.state?.inventory?.heldSlot || 0;
    const resolveName = this.gameplay?._resolveItemName?.bind(this.gameplay);
    console.log(`[INV] Hotbar (held=${heldSlot}):`);
    for (let i = 0; i < Math.min(9, slots.length); i++) {
      const s = slots[i];
      if (!s || (Number(s.network_id ?? s.id ?? 0) === 0)) {
        console.log(`  [${i}] (empty)`);
        continue;
      }
      const nid = Number(s.network_id ?? s.id ?? 0);
      const name = resolveName ? resolveName(s) : `id_${nid}`;
      const count = s.count ?? 1;
      const marker = i === heldSlot ? ' ◄' : '  ';
      console.log(`  [${i}]${marker} ${name} x${count} (nid=${nid})`);
    }
  }
}

module.exports = { InputHandler };
