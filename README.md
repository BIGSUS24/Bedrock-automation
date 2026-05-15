# Bedrock-Bot v3 — Usage Guide

A production-grade AFK bot for Minecraft Bedrock Edition servers (including Geyser/Cloudflare-proxied servers like DonutSMP).

---

## Quick Start

```cmd
npm install
node test_bot.js
```

`npm install` pulls in `bedrock-protocol` and the other dependencies listed in `package.json`. Then `node test_bot.js` launches the bot against `donutsmp.config.js` (pass a different config file as the first argument to target another server).

**First run only:** A Microsoft login link will appear:
```
To sign in, use a web browser to open the page https://www.microsoft.com/link
and use the code XXXXXXXX
```
Open that URL in your browser, enter the code, and sign in with your Minecraft account.
After this, tokens are cached in `.auth_cache/` — **you never need to do this again**.

---

  ## Interactive CLI

  Once connected, you'll see a `>` prompt. Here's how to use it:

  ### Send a Chat Message
  Just type and press Enter:
  ```
  > hello everyone!
  ```

  ### Send a Server Command
  Prefix with `/`:
  ```
  > /warp spawn
  > /tpa PlayerName
  > /bal
  > /home
  ```

### Bot Commands (`.` prefix)
These control the bot itself — they're NOT sent to the server:

| Command | What it does |
|---------|-------------|
| `.help` | Show all commands |
| `.status` | Show health, hunger, position, uptime |
| `.pos` | Show current coordinates |
| `.quit` | Disconnect and exit |
| `.afk on` | Enable anti-AFK (auto-jump + random look) |
| `.afk off` | Disable anti-AFK |
| `.afk jump 20` | Set jump interval to 20 seconds |
| `.afk status` | Show AFK settings |
| `.hit [on/off]` | Toggle auto-hit — selects the sword slot and swings every second |
| `.eat [on/off]` | Toggle auto-eat — selects the food slot and holds use-item every 5 min |
| `.sell` | Run one sell cycle now (dump inventory into the /sell GUI, then close to sell) |
| `.sell on/off` | Toggle the auto-sell loop (runs every 30s) |
| `.sell debug` | Run a sell cycle with full container/inventory/packet logging |
| `.auto` | Show automation status (hit / eat / sell) |
| `.tpa PlayerName` | Send /tpa PlayerName |
| `.tpaccept` | Accept incoming TPA |
| `.tpadeny` | Deny incoming TPA |
| `.warp spawn` | Shortcut for /warp spawn |
| `.home` | Shortcut for /home |
| `.bal` | Shortcut for /bal |
| `.pay Player 1000` | Shortcut for /pay Player 1000 |
| `.kit` | Shortcut for /kit |

### Stop the Bot
Press `Ctrl+C` or type `.quit`.

---

## Connect to a Different Server

### Option 1: Edit the config
Edit `donutsmp.config.js`:
```js
module.exports = {
  server: {
    address: 'play.example.net',   // Server IP or hostname
    port: 19132,                   // Bedrock port
    version: 'latest',             // or '1.21.130'
  },
  auth: {
    mode: 'microsoft',             // 'microsoft' or 'offline'
    username: 'MyBot',             // Used in offline mode only
  },
  reconnect: {
    enabled: true,
    maxRetries: 5,
    baseDelay: 3000,
  },
};
```

### Option 2: Use a separate config file
```cmd
node test_bot.js myserver.config.js
```

---

## Features

| Feature | Status |
|---------|--------|
| Microsoft Auth (device code + token caching) | ✅ |
| RakNet Cookie Handshake (Geyser/Cloudflare) | ✅ |
| Auto-Reconnect (exponential backoff) | ✅ |
| Interactive CLI (chat + commands) | ✅ |
| Anti-AFK (jump + random look) | ✅ |
| Auto-hit (timed sword swing) | ✅ |
| Auto-eat (timed hold use-item) | ✅ |
| Auto-sell (dump inventory into /sell GUI, detect $ earned in chat) | ✅ |
| TPA Shortcuts | ✅ |
| Chat Display (color codes stripped) | ✅ |
| Health/Hunger Tracking | ✅ |
| Position Tracking | ✅ |
| Keep-Alive (network_stack_latency) | ✅ |

---

## Troubleshooting

### "Outdated Bedrock client"
Edit your config version:
```js
version: '1.21.130',  // match whatever the server says it supports
```

### "Connect timed out"
Run `node diagnose.js` to debug the raw RakNet handshake.

### "Timed out!" kick after connecting
The server kicked for inactivity. Enable anti-AFK:
```
> .afk on
```

### Re-authenticate
Delete cached tokens and restart:
```cmd
rmdir /s /q .auth_cache
node test_bot.js
```

### After `npm install` — patches lost
The `jsp-raknet` patches will be overwritten. Save them permanently:
```cmd
npm install patch-package
npx patch-package jsp-raknet
```
This saves patches to `patches/` and auto-applies on future installs.

---

## Project Structure

```
Bedrock-automation/
├── test_bot.js              # Main launcher (interactive CLI)
├── donutsmp.config.js       # Server config (config.example.js is the template)
├── diagnose.js              # Raw RakNet packet debugger
├── src/
│   ├── main.js              # Bot orchestrator
│   ├── protocol/            # bedrock-protocol wrapper, packet profiles, serializers
│   │   └── client.js        # Connection, packet I/O, container/item-stack helpers
│   ├── transport/           # RakNet session, reliability, fragmentation, encryption
│   ├── cli/
│   │   ├── index.js         # Interactive terminal
│   │   ├── input_handler.js # Command router (chat / server / bot commands)
│   │   └── formatter.js     # Chat formatter
│   ├── automation/
│   │   ├── index.js         # Automation controller (scheduler + toggles)
│   │   ├── scheduler.js     # Tick-based action scheduler
│   │   ├── afk.js           # Anti-AFK system
│   │   └── actions/         # auto_hit, auto_eat, auto_sell
│   ├── gameplay/            # World tracking, block matching, pathfinding
│   ├── reconnect/           # Auto-reconnect state machine
│   ├── state/               # Health, hunger, position, inventory tracking
│   └── config/              # Config loader + defaults
```

> Note: `.auth_cache/` holds your Microsoft tokens and is **git-ignored** — it is created locally on first login and never committed.
