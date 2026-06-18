module.exports = {
  server: {
    address: 'donutsmp.net',
    port: 19132,
    version: '1.26.20', // current version advertised by DonutSMP
    mtu: 1400,
    connectionTimeout: 30000,
    chunkRadius: 6,
  },
  protocol: {
    raknetBackend: 'raknet-native',
    // DonutSMP's Boar/Geyser stack expects Bedrock latency replies in ns.
    // It validates responseTimestamp / 1_000_000 against the sent id.
    networkStackLatencyScale: 1000000,
  },
  auth: {
    mode: 'microsoft',
    username: 'BedrockBot',
  },
  reconnect: {
    enabled: true,
    maxRetries: 15,
    baseDelay: 3000,
    maxDelay: 30000,
    multiplier: 2,
    jitterRange: 500,
  },
  automation: {
    enabled: true,
    tickMs: 50,
    actions: {
      // Swing the sword every 1s. Put a sword in the 1st hotbar slot (index 0).
      autoHit: { enabled: false, slot: 0, intervalMs: 1000 },
      // Eat for 10s every 5 min. Put food in the 2nd hotbar slot (index 1).
      autoEat: { enabled: false, slot: 1, intervalMs: 300000, durationMs: 10000 },
      // Run /sell every 45s and dump the whole inventory into the GUI.
      // Run `.sell debug` once to confirm guiContainer matches this server.
      autoSell: { enabled: true, intervalMs: 30000, command: '/sell' },
    },
  },
  gameplay: {
    // Chunk decoding + block indexing is heavy and only needed for pull/mining.
    // Leave false on low-resource hosts (Termux/old phone): the world tracker
    // then attaches lazily only when a pull/mining command actually runs, so an
    // autosell-only bot never decodes a single chunk. Set true to track eagerly.
    worldTracking: false,
    interaction: {
      // Live validation on DonutSMP accepted trapdoor use through inventory_transaction.
      usePlayerAuthInput: false,
    },
    movement: {
      speed: 4.0,
      tickMs: 50,
      arrivalRadius: 0.35,
      pathArrivalRadius: 0.6,
      maxNodes: 4096,
      positionReadyTimeout: 5000,
      useServerCorrections: true,
    },
    pull: {
      searchRadius: 48,
      yRadius: 16,
      preferWaypoints: true,
      confirmationTimeout: 2000,
      standYOffsets: [0, -1, -2, 1],
      // Add the exact spruce trapdoor block coordinates here when known.
      // Example: { name: 'pearl_stasis', position: { x: -161561, y: -42, z: -10547 }, face: 1 }
      waypoints: [],
      allowedBlocks: ['spruce_trapdoor', 'wooden_trapdoor', 'trapdoor'],
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
      searchRadius: 32,
      yRadius: 32,
      confirmationTimeout: 4000,
      maxBlocksPerCommand: 16,
      collectDrops: true,
      collectRadius: 8,
      requireInventoryGain: true,
      inventoryGainTimeout: 3000,
      autoSelectTool: true,
      standYOffsets: [0, 1, -1, 2, -2],
    },
  },
  logging: {
    level: 'debug',
    timestamp: true,
  },
};
