module.exports = {
  server: {
    address: '127.0.0.1',
    port: 19132,
    version: '1.20.60',
    connectionTimeout: 30000,
    keepAliveInterval: 5000,
  },
  auth: {
    mode: 'offline',
    username: 'MyBot',
  },
  reconnect: {
    enabled: true,
    maxRetries: 10,
    baseDelay: 1000,
    maxDelay: 60000,
    backoffMultiplier: 2,
    cooldownOnSuccess: 30000,
  },
  dashboard: {
    refreshRate: 5000,
    showLatency: true,
    showAutomation: true,
  },
  automation: {
    enabled: false,
    actions: {
      jump: { enabled: false, interval: 3000 },
      move: { enabled: false, interval: 5000, distance: 1 },
      autoEat: { enabled: false, hungerThreshold: 14 },
      periodicChat: { enabled: false, interval: 60000, messages: [] },
    },
  },
  gameplay: {
    interaction: {
      usePlayerAuthInput: false,
    },
    movement: {
      positionReadyTimeout: 3000,
      useServerCorrections: true,
    },
    pull: {
      searchRadius: 32,
      yRadius: 8,
      preferWaypoints: true,
      confirmationTimeout: 2000,
      // Optional fallback if chunks do not expose the pearl pull trapdoor.
      // waypoints: [{ name: 'pearl_stasis', position: { x: 100, y: 64, z: 100 }, face: 1 }],
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
      maxBlocksPerCommand: 16,
      searchRadius: 24,
      yRadius: 24,
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
