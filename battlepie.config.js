// battlepie.js

module.exports = {
  server: {
    address: 'play.battlepie.net',
    port: 19132,
    version: '1.21.130',
    mtu: 1400,
    connectionTimeout: 30000,
    chunkRadius: 6,
  },

  protocol: {
    raknetBackend: 'raknet-native',
    networkStackLatencyScale: 1000000,
  },

  auth: {
    mode: 'microsoft',
    username: 'BedrockBot',
  },

  reconnect: {
    enabled: true,
    maxRetries: 5,
    baseDelay: 3000,
    maxDelay: 30000,
    multiplier: 2,
    jitterRange: 500,
  },

  automation: {
    enabled: false,
  },

  logging: {
    level: 'debug',
    timestamp: true,
  },
};