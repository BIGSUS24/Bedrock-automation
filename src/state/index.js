const EventEmitter = require('events');

const ConnectionStatus = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  AUTHENTICATING: 'authenticating',
  CONNECTED: 'connected',
  LOGGED_IN: 'logged_in',
  PLAYING: 'playing',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
};

class OutgoingMessageQueue {
  constructor(maxSize = 100) {
    this.queue = [];
    this.maxSize = maxSize;
  }

  push(message) {
    if (this.queue.length >= this.maxSize) {
      this.queue.shift();
    }
    this.queue.push(message);
  }

  clear() {
    this.queue = [];
  }

  size() {
    return this.queue.length;
  }

  isEmpty() {
    return this.queue.length === 0;
  }
}

class StateManager extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.status = ConnectionStatus.DISCONNECTED;
    this.player = {
      username: null,
      xuid: null,
      health: 20,
      hunger: 20,
      position: { x: 0, y: 0, z: 0 },
      rotation: { yaw: 0, pitch: 0 },
      dimension: 'overworld',
      onGround: false,
    };
    this.inventory = {
      slots: [],
      heldSlot: 0,
      size: 36,
    };
    this.session = {
      serverAddress: null,
      serverPort: null,
      connectedAt: null,
      lastActionTime: Date.now(),
      lastChatTime: null,
      lastPacketTime: null,
      latency: null,
    };
    this.reconnect = {
      retryCount: 0,
      lastDisconnectReason: null,
      lastDisconnectTime: null,
    };
    this.automation = {
      active: false,
      lastActionTime: null,
      runningTasks: [],
    };
    this.authData = null;
    this.outgoingQueue = new OutgoingMessageQueue();
  }

  setStatus(status) {
    const oldStatus = this.status;
    this.status = status;
    this.emit('statusChange', { oldStatus, newStatus: status });
  }

  setPlayerInfo(info) {
    this.player = { ...this.player, ...info };
    this.emit('playerUpdate', this.player);
  }

  setPosition(x, y, z) {
    this.player.position = { x, y, z };
    this.emit('positionUpdate', this.player.position);
  }

  setRotation(yaw, pitch) {
    this.player.rotation = { yaw, pitch };
    this.emit('rotationUpdate', this.player.rotation);
  }

  setHealth(health, hunger) {
    if (health !== undefined) this.player.health = health;
    if (hunger !== undefined) this.player.hunger = hunger;
    this.emit('statsUpdate', { health: this.player.health, hunger: this.player.hunger });
  }

  setInventory(slots, heldSlot = 0) {
    this.inventory.slots = slots;
    this.inventory.heldSlot = heldSlot;
    this.emit('inventoryUpdate', this.inventory);
  }

  updateSession(info) {
    this.session = { ...this.session, ...info };
  }

  recordAction() {
    this.session.lastActionTime = Date.now();
  }

  recordChat() {
    this.session.lastChatTime = Date.now();
    this.recordAction();
  }

  setLatency(latency) {
    this.session.latency = latency;
  }

  setLastPacketTime(time) {
    this.session.lastPacketTime = time;
  }

  incrementRetry() {
    this.reconnect.retryCount++;
  }

  resetRetry() {
    this.reconnect.retryCount = 0;
  }

  setDisconnectReason(reason) {
    this.reconnect.lastDisconnectReason = reason;
    this.reconnect.lastDisconnectTime = Date.now();
  }

  setAutomationActive(active) {
    this.automation.active = active;
    this.emit('automationChange', active);
  }

  setAuthData(authData) {
    this.authData = authData;
    if (authData?.username) {
      this.player.username = authData.username;
      this.player.xuid = authData.xuid;
    }
  }

  getAuthData() {
    return this.authData;
  }

  getOutgoingQueue() {
    return this.outgoingQueue;
  }

  clearOutgoingQueue() {
    this.outgoingQueue.clear();
  }

  getStatus() {
    return {
      status: this.status,
      player: this.player,
      inventory: this.inventory,
      session: this.session,
      reconnect: this.reconnect,
      automation: this.automation,
    };
  }

  getConnectionStatus() {
    return this.status;
  }

  isConnected() {
    return this.status === ConnectionStatus.CONNECTED ||
           this.status === ConnectionStatus.LOGGED_IN ||
           this.status === ConnectionStatus.PLAYING;
  }

  isPlaying() {
    return this.status === ConnectionStatus.PLAYING;
  }

  canRetry() {
    return this.status === ConnectionStatus.FAILED ||
           this.status === ConnectionStatus.DISCONNECTED;
  }

  resetSession() {
    this.session.lastPacketTime = null;
    this.session.latency = null;
  }
}

module.exports = { StateManager, ConnectionStatus, OutgoingMessageQueue };