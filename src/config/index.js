const path = require('path');

const DEFAULT_CONFIG = {
  server: {
    address: '127.0.0.1',
    port: 19132,
    version: '1.21.50',
    mtu: 1400,
    connectionTimeout: 30000,
    keepAliveInterval: 5000,
    chunkRadius: 8,
  },
  protocol: {
    queueMaxSize: 128,
    sendInterval: 50,
    compressionThreshold: 256,
  },
  auth: {
    mode: 'offline',
    username: 'BedrockBot',
    clientId: '00000000441cc96b',
    redirectUri: 'https://login.live.com/oauth20_desktop.srf',
  },
  reconnect: {
    enabled: true,
    maxRetries: 10,
    baseDelay: 1000,
    maxDelay: 60000,
    multiplier: 2,
    jitterRange: 500,
    minDelay: 1000,
    maxAttemptsPerMin: 5,
    cooldownOnSuccess: 30000,
  },
  dashboard: {
    refreshRate: 5000,
    showLatency: true,
    showAutomation: true,
  },
  automation: {
    enabled: false,
    tickMs: 50,
    actions: {
      // Select the sword slot and swing every intervalMs (left-click auto-hit).
      // slot is 0-indexed: 0 = first hotbar slot. Put a sword there manually.
      autoHit: { enabled: false, slot: 0, intervalMs: 1000 },
      // Select the food slot and hold "use item" for durationMs every intervalMs.
      // slot is 0-indexed: 1 = second hotbar slot. Put food there manually.
      autoEat: { enabled: false, slot: 1, intervalMs: 300000, durationMs: 10000 },
      // Every intervalMs: run `command`, dump every inventory item into the
      // opened GUI, then close it (ESC) to complete the sale. Container ids are
      // ContainerSlotType names from the protocol; run `.sell debug` once to see
      // what your server's GUI uses and adjust if needed.
      autoSell: {
        enabled: false,
        intervalMs: 30000,             // 30 sec
        command: '/sell',
        inventoryContainer: 'hotbar_and_inventory', // source: player slots 0..35
        cursorContainer: 'cursor',
        guiContainer: 'container',     // destination: the sell GUI slots
        guiSize: 54,                   // double-chest sized GUI
        inventorySlots: 36,
        openTimeoutMs: 5000,
        perItemTimeoutMs: 2500,
        settleMs: 250,
        saleTimeoutMs: 5000,
        maxOpenRetries: 2,
        maxItemRetries: 1,
        saleRegex: '',                 // empty → default /\$[\d,]+(\.\d+)?/
        debug: false,
      },
    },
  },
  gameplay: {
    interaction: {
      usePlayerAuthInput: false,
    },
    movement: {
      speed: 4.0,
      tickMs: 50,
      arrivalRadius: 0.35,
      pathArrivalRadius: 0.6,
      maxNodes: 4096,
      positionReadyTimeout: 3000,
      useServerCorrections: true,
    },
    pull: {
      searchRadius: 32,
      yRadius: 8,
      interactRange: 4.5,
      confirmationTimeout: 1500,
      preferWaypoints: true,
      waypoints: [],
      standYOffsets: [0, -1, -2, 1],
      allowedBlocks: [
        'spruce_trapdoor',
        'oak_trapdoor',
        'birch_trapdoor',
        'jungle_trapdoor',
        'acacia_trapdoor',
        'dark_oak_trapdoor',
        'mangrove_trapdoor',
        'cherry_trapdoor',
        'bamboo_trapdoor',
        'crimson_trapdoor',
        'warped_trapdoor',
        'wooden_trapdoor',
        'trapdoor',
      ],
      deniedBlocks: [
        'copper_trapdoor',
        'exposed_copper_trapdoor',
        'weathered_copper_trapdoor',
        'oxidized_copper_trapdoor',
        'waxed_copper_trapdoor',
        'waxed_exposed_copper_trapdoor',
        'waxed_weathered_copper_trapdoor',
        'waxed_oxidized_copper_trapdoor',
      ],
    },
    mining: {
      searchRadius: 24,
      yRadius: 24,
      interactRange: 4.5,
      confirmationTimeout: 3500,
      maxBlocksPerCommand: 16,
      collectDrops: true,
      collectRadius: 8,
      requireInventoryGain: true,
      inventoryGainTimeout: 2500,
      autoSelectTool: true,
      standYOffsets: [0, 1, -1, 2, -2],
    },
  },
  ui: {
    historySize: 50,
    prompt: '> ',
  },
  logging: {
    level: 'info',
    timestamp: true,
  },
};

function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (sourceValue === null || sourceValue === undefined) {
      continue;
    }

    if (Array.isArray(sourceValue)) {
      result[key] = sourceValue;
    } else if (typeof sourceValue === 'object' && sourceValue !== null) {
      if (typeof targetValue === 'object' && targetValue !== null) {
        result[key] = deepMerge(targetValue, sourceValue);
      } else {
        result[key] = sourceValue;
      }
    } else {
      result[key] = sourceValue;
    }
  }

  return result;
}

class ConfigManager {
  constructor() {
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.configPath = null;
  }

  load(configPath) {
    this.configPath = configPath;
    try {
      // Resolve relative to CWD so `node src/main.js --config foo.js` works
      const resolved = path.resolve(process.cwd(), configPath);
      const userConfig = require(resolved);
      this.config = deepMerge(DEFAULT_CONFIG, userConfig);
    } catch (e) {
      console.warn(`Failed to load config from ${configPath}, using defaults: ${e.message}`);
    }
    return this.config;
  }

  get(path) {
    const keys = path.split('.');
    let result = this.config;
    for (const key of keys) {
      result = result?.[key];
    }
    return result;
  }

  set(path, value) {
    const keys = path.split('.');
    let target = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      target = target[keys[i]];
    }
    target[keys[keys.length - 1]] = value;
  }

  getAll() {
    return JSON.parse(JSON.stringify(this.config));
  }

  mergeConfig(userConfig) {
    this.config = deepMerge(this.config, userConfig);
  }

  reset() {
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

module.exports = { ConfigManager, DEFAULT_CONFIG, deepMerge };
