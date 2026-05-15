'use strict';

/**
 * RakNetSession — Real Bedrock-grade RakNet client session
 *
 * Handshake flow:
 *   1. Send OCR1 (Open Connection Request 1)  → receive OCReply1
 *   2. Send OCR2 (Open Connection Request 2)  → receive OCReply2
 *   3. Send ConnectionRequest (internal ping) → receive ConnectionRequestAccepted
 *   4. Send NewIncomingConnection             → CONNECTED
 *
 * Ongoing:
 *   - ACK/NACK flushed every tick (50 ms)
 *   - Heartbeat ConnectedPing every 5 s
 *   - Timeout monitor every 5 s (30 s silence = disconnect)
 *   - Resend wired from ReliabilitySystem 'resend' event
 *   - Split frames wired through FragmentationSystem
 */

const EventEmitter          = require('events');
const { UDPSocket }         = require('./udp_socket');
const { ReliabilitySystem, Reliability } = require('./reliability');
const { FragmentationSystem }            = require('./fragmentation');
const { PacketRouter }                   = require('./packet_router');
const dns                                = require('dns');

// ── Constants ────────────────────────────────────────────────────────────────

const RAKNET_PROTOCOL_VERSION = 11;

// RakNet offline magic (16 bytes)
const RAKNET_MAGIC = Buffer.from([
  0x00, 0xFF, 0xFF, 0x00, 0xFE, 0xFE, 0xFE, 0xFE,
  0xFD, 0xFD, 0xFD, 0xFD, 0x12, 0x34, 0x56, 0x78,
]);

const PacketID = {
  CONNECTED_PING:                     0x00,
  UNCONNECTED_PING:                   0x01,
  UNCONNECTED_PONG:                   0x1C,
  CONNECTED_PONG:                     0x03,
  OPEN_CONNECTION_REQUEST_1:          0x05,
  OPEN_CONNECTION_REPLY_1:            0x06,
  OPEN_CONNECTION_REQUEST_2:          0x07,
  OPEN_CONNECTION_REPLY_2:            0x08,
  CONNECTION_REQUEST:                 0x09,
  CONNECTION_REQUEST_ACCEPTED:        0x10,
  NEW_INCOMING_CONNECTION:            0x13,
  NO_FREE_INCOMING_CONNECTIONS:       0x14,
  DISCONNECT_NOTIFICATION:            0x15,
  ACK:                                0xC0,
  NACK:                               0xA0,
  // DATA datagrams: 0x80 – 0x8F
};

const ConnectionState = {
  DISCONNECTED:  'disconnected',
  CONNECTING:    'connecting',
  HANDSHAKING:   'handshaking',
  CONNECTED:     'connected',
  DISCONNECTING: 'disconnecting',
};

const MTU_SIZES = [1492, 1400, 576]; // Bedrock tries these in order

// ── RakNetSession ────────────────────────────────────────────────────────────

class RakNetSession extends EventEmitter {
  constructor(serverAddress, serverPort, config = {}) {
    super();
    this.serverAddress  = serverAddress;
    this.serverPort     = serverPort;
    this.config         = config;

    this.state          = ConnectionState.DISCONNECTED;
    this.socket         = null;
    this.mtu            = config.mtu || 1400;
    this.clientGuid     = this._generateGuid();
    this.serverGuid     = null;

    this.reliability    = new ReliabilitySystem();
    this.fragmentation  = new FragmentationSystem(this.mtu - 60);
    this.router         = new PacketRouter();

    /** Pending handshake promises: packetId → { resolve, reject, timer } */
    this.pendingHandlers = new Map();

    this._heartbeatTimer = null;
    this._timeoutTimer   = null;
    this._ackFlushTimer  = null;
    this._lastPingTime   = 0;
    this._lastPongTime   = Date.now();
    this._clientTime     = BigInt(0); // monotonic send-time for pings
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async connect() {
    if (this.state !== ConnectionState.DISCONNECTED) {
      throw new Error(`Cannot connect from state: ${this.state}`);
    }

    // Resolve DNS first so we can write real IPv4 addresses in RakNet handshakes
    this.serverAddress = await new Promise((resolve, reject) => {
      dns.lookup(this.serverAddress, (err, address, family) => {
        if (err) return reject(err);
        if (family !== 4) return reject(new Error('IPv6 not currently supported for RakNet handshake'));
        resolve(address);
      });
    });

    this.socket = new UDPSocket();
    this.socket.on('message', (msg) => this._handleRaw(msg));
    await this.socket.bind();

    console.log('[RakNet] Sending preliminary UNCONNECTED_PING for anti-bot bypass...');
    const pingBuf = Buffer.alloc(33);
    pingBuf.writeUInt8(0x01, 0); // UNCONNECTED_PING
    pingBuf.writeBigInt64BE(BigInt(Date.now()), 1);
    RAKNET_MAGIC.copy(pingBuf, 9);
    pingBuf.copy(this.clientGuid, 25); // Just padding for ping
    await this.socket.send(pingBuf, this.serverAddress, this.serverPort);
    
    // Wait a brief moment to simulate human client behavior and let the proxy register the IP
    await new Promise((r) => setTimeout(r, 500));

    this.state = ConnectionState.CONNECTING;

    console.log('[RakNet] Attempting MTU negotiation...');
    await this._negotiateMTU();
    console.log('[RakNet] MTU negotiated:', this.mtu);

    this.state = ConnectionState.HANDSHAKING;

    console.log('[RakNet] Sending OCR2...');
    await this._sendOCR2();
    await this._waitForPacket(PacketID.OPEN_CONNECTION_REPLY_2);
    console.log('[RakNet] Received OCReply2');

    console.log('[RakNet] Sending ConnectionRequest...');
    await this._sendConnectionRequest();
    await this._waitForPacket(PacketID.CONNECTION_REQUEST_ACCEPTED);
    console.log('[RakNet] Received ConnectionRequestAccepted');

    console.log('[RakNet] Sending NewIncomingConnection...');

    this.state = ConnectionState.CONNECTED;
    this._wireReliability();
    this._startTimers();

    this.emit('connected');
    return true;
  }

  /**
   * Send a game payload (already serialized) through the session.
   * Automatically fragments if payload exceeds MTU payload size.
   *
   * @param {Buffer} data
   * @param {number} [reliability=Reliability.RELIABLE_ORDERED]
   * @param {number} [channel=0]
   */
  async send(data, reliability = Reliability.RELIABLE_ORDERED, channel = 0) {
    if (this.state !== ConnectionState.CONNECTED) {
      throw new Error(`Cannot send in state: ${this.state}`);
    }

    if (this.fragmentation.needsFragmentation(data)) {
      await this._sendFragmented(data, reliability, channel);
    } else {
      await this._sendSingle(data, reliability, channel);
    }
  }

  disconnect(reason = 'Client disconnect') {
    if (this.state === ConnectionState.DISCONNECTED) return;
    this.state = ConnectionState.DISCONNECTING;

    const pkt = Buffer.from([PacketID.DISCONNECT_NOTIFICATION]);
    this.socket?.send(pkt, this.serverAddress, this.serverPort).catch(() => {});

    setTimeout(() => {
      this._cleanup();
      this.state = ConnectionState.DISCONNECTED;
      this.emit('disconnected', { reason });
    }, 100);
  }

  isConnected()   { return this.state === ConnectionState.CONNECTED; }
  getState()      { return this.state; }
  getMtu()        { return this.mtu; }
  getClientGuid() { return this.clientGuid; }
  getServerGuid() { return this.serverGuid; }
  getLatency()    {
    return this._lastPongTime > 0 ? Date.now() - this._lastPingTime : null;
  }

  // ── MTU Negotiation ────────────────────────────────────────────────────────

  async _negotiateMTU() {
    for (const mtuSize of MTU_SIZES) {
      try {
        await this._sendOCR1(mtuSize);
        await this._waitForPacket(PacketID.OPEN_CONNECTION_REPLY_1, 3000);
        this.mtu = mtuSize;
        this.fragmentation.maxSize = mtuSize - 60;
        return; // success
      } catch (err) {
        console.error(`[RakNet] MTU ${mtuSize} failed:`, err.message);
      }
    }
    throw new Error('MTU negotiation failed for all sizes');
  }

  // ── Handshake Packet Builders ──────────────────────────────────────────────

  _sendOCR1(mtuSize) {
    // OCR1: ID(1) + MAGIC(16) + PROTOCOL(1) + NULL_PADDING(mtu - 18)
    const paddingLen = mtuSize - 18;
    const buf = Buffer.alloc(18 + Math.max(0, paddingLen));
    let off = 0;
    buf.writeUInt8(PacketID.OPEN_CONNECTION_REQUEST_1, off++);
    RAKNET_MAGIC.copy(buf, off); off += 16;
    buf.writeUInt8(RAKNET_PROTOCOL_VERSION, off++);
    // rest is zero padding (mtu size advertisement)
    return this.socket.send(buf, this.serverAddress, this.serverPort);
  }

  _sendOCR2() {
    // OCR2: ID(1) + MAGIC(16) + CLIENT_ADDR(variable) + MTU(2) + CLIENT_GUID(8)
    const buf = Buffer.alloc(34);
    let off = 0;
    buf.writeUInt8(PacketID.OPEN_CONNECTION_REQUEST_2, off++);
    RAKNET_MAGIC.copy(buf, off); off += 16;
    // Server address: IPv4 family=4, addr(4), port(2)
    off = this._writeAddress(buf, off, this.serverAddress, this.serverPort);
    buf.writeUInt16BE(this.mtu, off); off += 2;
    this.clientGuid.copy(buf, off);
    return this.socket.send(buf.slice(0, off + 8), this.serverAddress, this.serverPort);
  }

  _sendConnectionRequest() {
    // ConnectionRequest: ID(1) + CLIENT_GUID(8) + TIME(8 BE) + USE_SECURITY(1)
    const buf = Buffer.alloc(18);
    buf.writeUInt8(PacketID.CONNECTION_REQUEST, 0);
    this.clientGuid.copy(buf, 1);
    buf.writeBigInt64BE(BigInt(Date.now()), 9);
    buf.writeUInt8(0, 17); // use_security = false
    return this._sendReliable(buf, Reliability.RELIABLE_ORDERED);
  }

  _sendNewIncomingConnection() {
    // NewIncomingConnection: ID(1) + SERVER_ADDR(variable) + INTERNAL_ADDR(variable) + SEND_PING(8) + SEND_PONG(8)
    const buf = Buffer.alloc(94);
    let off = 0;
    buf.writeUInt8(PacketID.NEW_INCOMING_CONNECTION, off++);
    // Server address (IPv4)
    off = this._writeAddress(buf, off, this.serverAddress, this.serverPort);
    // Internal addresses: 10 x (IPv4 addr)
    for (let i = 0; i < 10; i++) {
      off = this._writeAddress(buf, off, '127.0.0.1', 0);
    }
    buf.writeBigInt64BE(BigInt(Date.now()), off); off += 8;
    buf.writeBigInt64BE(BigInt(0), off); off += 8;
    return this._sendReliable(buf.slice(0, off), Reliability.RELIABLE_ORDERED);
  }

  _writeAddress(buf, off, address, port) {
    buf.writeUInt8(4, off++); // AF_INET
    const parts = address.split('.').map(Number);
    // DNS names like 'donutsmp.net' cannot be parsed via split('.').map(Number)
    // If it fails to parse, fallback to ~0.0.0.0
    if (parts.length !== 4 || parts.some(isNaN)) {
      for (let i = 0; i < 4; i++) buf.writeUInt8(~0 & 0xFF, off++);
    } else {
      for (const p of parts) buf.writeUInt8(~p & 0xFF, off++);
    }
    buf.writeUInt16BE(port, off); off += 2;
    return off;
  }

  // ── Incoming packet handling ───────────────────────────────────────────────

  _handleRaw(msg) {
    if (!msg || msg.length < 1) return;
    const id = msg.readUInt8(0);

    // DATA datagrams
    if (id >= 0x80 && id <= 0x8F) {
      this._handleDataDatagram(msg);
      return;
    }

    // ACK / NACK
    if (id === PacketID.ACK || id === PacketID.NACK) {
      this._handleAckNack(msg);
      return;
    }

    // Offline / handshake packets
    switch (id) {
      case PacketID.OPEN_CONNECTION_REPLY_1:    this._handleOCReply1(msg);    break;
      case PacketID.OPEN_CONNECTION_REPLY_2:    this._handleOCReply2(msg);    break;
      case PacketID.CONNECTION_REQUEST_ACCEPTED: this._handleCRAccepted(msg); break;
      case PacketID.CONNECTED_PING:             this._handleConnectedPing(msg); break;
      case PacketID.CONNECTED_PONG:             this._handleConnectedPong(msg); break;
      case PacketID.DISCONNECT_NOTIFICATION:    this._handleDisconnect(msg);  break;
      case PacketID.NO_FREE_INCOMING_CONNECTIONS:
        this._rejectPending(PacketID.OPEN_CONNECTION_REPLY_2, 'No free incoming connections');
        break;
    }
  }

  _handleDataDatagram(datagram) {
    const payloads = this.reliability.handleDatagram(datagram);
    for (const payload of payloads) {
      this.router.route(payload);
    }
    // Schedule ACK flush (will batch within current tick)
    this._scheduleAckFlush();
  }

  _handleAckNack(msg) {
    const { isAck, sequences } = this.reliability.parseAckNack(msg);
    if (isAck) {
      this.reliability.handleAck(sequences);
    } else {
      this.reliability.handleNack(sequences);
    }
  }

  _handleOCReply1(msg) {
    // OCReply1: ID(1) + MAGIC(16) + SERVER_GUID(8) + USE_SECURITY(1) + MTU(2)
    if (msg.length < 28) return;
    this.serverGuid = msg.slice(17, 25);
    const serverMTU = msg.readUInt16BE(26);
    this.mtu = Math.min(serverMTU, this.mtu);
    this.fragmentation.maxSize = this.mtu - 60;
    this._resolvePending(PacketID.OPEN_CONNECTION_REPLY_1, msg);
  }

  _handleOCReply2(msg) {
    this._resolvePending(PacketID.OPEN_CONNECTION_REPLY_2, msg);
  }

  _handleCRAccepted(msg) {
    this._resolvePending(PacketID.CONNECTION_REQUEST_ACCEPTED, msg);
  }

  _handleConnectedPing(msg) {
    if (msg.length < 9) return;
    const pingTime = msg.readBigInt64BE(1);
    const pong = Buffer.alloc(17);
    pong.writeUInt8(PacketID.CONNECTED_PONG, 0);
    pong.writeBigInt64BE(pingTime, 1);
    pong.writeBigInt64BE(BigInt(Date.now()), 9);
    this._sendReliable(pong, Reliability.UNRELIABLE);
  }

  _handleConnectedPong(msg) {
    if (msg.length < 17) return;
    this._lastPongTime = Date.now();
    const latency = Number(BigInt(Date.now()) - msg.readBigInt64BE(1));
    this.emit('pong', latency);
  }

  _handleDisconnect() {
    this._cleanup();
    this.state = ConnectionState.DISCONNECTED;
    this.emit('disconnected', { reason: 'Server disconnect' });
  }

  // ── Sending helpers ────────────────────────────────────────────────────────

  async _sendSingle(data, reliability, channel) {
    const frameData = this.reliability.encodeFrame(data, reliability, { channel });
    const seqNum    = this.reliability.nextSendSequence();
    const datagram  = this.reliability.buildDatagram([frameData], seqNum);

    if (this._isReliable(reliability)) {
      this.reliability.trackSent(seqNum, datagram);
    }

    await this.socket.send(datagram, this.serverAddress, this.serverPort);
  }

  async _sendFragmented(data, reliability, channel) {
    const fragments = this.fragmentation.fragment(data);
    for (const frag of fragments) {
      const frameData = this.reliability.encodeFrame(frag.chunk, reliability, {
        channel,
        isSplit:    true,
        splitCount: frag.splitCount,
        splitId:    frag.splitId,
        splitIndex: frag.splitIndex,
      });
      const seqNum   = this.reliability.nextSendSequence();
      const datagram = this.reliability.buildDatagram([frameData], seqNum);

      if (this._isReliable(reliability)) {
        this.reliability.trackSent(seqNum, datagram);
      }

      await this.socket.send(datagram, this.serverAddress, this.serverPort);
    }
  }

  _sendReliable(data, reliability = Reliability.RELIABLE_ORDERED) {
    return this._sendSingle(data, reliability, 0);
  }

  _isReliable(reliability) {
    return reliability >= Reliability.RELIABLE;
  }

  // ── Reliability wiring ─────────────────────────────────────────────────────

  _wireReliability() {
    // Resend lost packets
    this.reliability.on('resend', ({ datagram }) => {
      this.socket?.send(datagram, this.serverAddress, this.serverPort).catch(() => {});
    });

    // Wire split frames to fragmentation system
    this.reliability.on('splitFrame', (frame) => {
      const reassembled = this.fragmentation.handleSplitFrame(frame);
      if (reassembled) {
        this.router.route(reassembled);
      }
    });

    // Wire game packets to emit
    this.router.on('packet', (packet) => {
      this.emit('gamePacket', packet);
    });

    this.fragmentation.startCleanup();
  }

  // ── Timers ─────────────────────────────────────────────────────────────────

  _startTimers() {
    // Heartbeat ping
    this._heartbeatTimer = setInterval(() => {
      if (this.state !== ConnectionState.CONNECTED) return;
      const ping = Buffer.alloc(9);
      ping.writeUInt8(PacketID.CONNECTED_PING, 0);
      ping.writeBigInt64BE(BigInt(Date.now()), 1);
      this._lastPingTime = Date.now();
      this._sendReliable(ping, Reliability.UNRELIABLE).catch(() => {});
    }, 5000);

    // Timeout monitor
    this._timeoutTimer = setInterval(() => {
      if (this.state !== ConnectionState.CONNECTED) return;
      const silence = Date.now() - this._lastPongTime;
      if (silence > 30_000) {
        this._cleanup();
        this.state = ConnectionState.DISCONNECTED;
        this.emit('timeout', { silence });
        this.emit('disconnected', { reason: 'Connection timeout' });
      }
    }, 5000);
  }

  _scheduleAckFlush() {
    if (this._ackFlushTimer) return;
    this._ackFlushTimer = setImmediate(() => {
      this._ackFlushTimer = null;
      this._flushAcks();
    });
  }

  _flushAcks() {
    const ackBuf = this.reliability.flushAcks();
    if (ackBuf) {
      this.socket?.send(ackBuf, this.serverAddress, this.serverPort).catch(() => {});
    }
    const nackBuf = this.reliability.flushNacks();
    if (nackBuf) {
      this.socket?.send(nackBuf, this.serverAddress, this.serverPort).catch(() => {});
    }
  }

  // ── Handshake promise helpers ──────────────────────────────────────────────

  _waitForPacket(packetId, timeout = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHandlers.delete(packetId);
        reject(new Error(`Timeout waiting for packet 0x${packetId.toString(16)}`));
      }, timeout);

      this.pendingHandlers.set(packetId, { resolve, reject, timer });
    });
  }

  _resolvePending(packetId, data) {
    const pending = this.pendingHandlers.get(packetId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(data);
      this.pendingHandlers.delete(packetId);
    }
  }

  _rejectPending(packetId, reason) {
    const pending = this.pendingHandlers.get(packetId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingHandlers.delete(packetId);
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  _generateGuid() {
    const bytes = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[0] &= 0x7F; // ensure high bit is CLEAR (positive guid)
    return bytes;
  }

  _cleanup() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._timeoutTimer)   { clearInterval(this._timeoutTimer);   this._timeoutTimer   = null; }
    if (this._ackFlushTimer)  { clearImmediate(this._ackFlushTimer); this._ackFlushTimer  = null; }

    for (const { timer } of this.pendingHandlers.values()) clearTimeout(timer);
    this.pendingHandlers.clear();

    this.reliability.cleanup();
    this.fragmentation.cleanup();
    this.router.clear();

    if (this.socket) { this.socket.close(); this.socket = null; }
  }
}

const RakNetPacketIDs = PacketID;

module.exports = {
  RakNetSession,
  ConnectionState,
  Reliability,
  RakNetPacketIDs,
  RAKNET_PROTOCOL_VERSION,
  RAKNET_MAGIC,
};