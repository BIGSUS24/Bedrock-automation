const dgram = require('dgram');
const EventEmitter = require('events');

const RAKNET_MAX_PACKET_SIZE = 65535;
const RAKNET_MTU_SIZE = 1400;

class UDPSocket extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bindAddress = options.bindAddress || '0.0.0.0';
    this.bindPort = options.bindPort || 0;
    this.socket = null;
    this.bound = false;
    this.closed = false;
    this.remoteAddress = null;
    this.remotePort = null;
    this.stats = {
      packetsSent: 0,
      packetsReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      lastSendTime: 0,
      lastReceiveTime: 0,
    };
  }

  bind() {
    return new Promise((resolve, reject) => {
      if (this.bound) {
        resolve({ address: this.bindAddress, port: this.bindPort });
        return;
      }

      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('message', (msg, rinfo) => {
        this.stats.packetsReceived++;
        this.stats.bytesReceived += msg.length;
        this.stats.lastReceiveTime = Date.now();

        this.remoteAddress = rinfo.address;
        this.remotePort = rinfo.port;

        this.emit('message', msg, rinfo);
      });

      this.socket.on('error', (err) => {
        this.emit('error', err);
        if (!this.bound) {
          reject(err);
        }
      });

      this.socket.on('listening', () => {
        const address = this.socket.address();
        this.bindAddress = address.address;
        this.bindPort = address.port;
        this.bound = true;
        this.socket.setRecvBufferSize(1024 * 1024);
        this.socket.setSendBufferSize(1024 * 1024);
        resolve(address);
      });

      this.socket.bind(this.bindPort, this.bindAddress);
    });
  }

  send(buffer, address, port) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.socket) {
        reject(new Error('Socket is closed'));
        return;
      }

      this.socket.send(buffer, 0, buffer.length, port, address, (err) => {
        if (err) {
          reject(err);
          return;
        }

        this.stats.packetsSent++;
        this.stats.bytesSent += buffer.length;
        this.stats.lastSendTime = Date.now();
        resolve();
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }

      this.closed = true;

      if (this.socket) {
        this.socket.close(() => {
          this.socket = null;
          this.bound = false;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getStats() {
    return { ...this.stats };
  }

  getLocalAddress() {
    return {
      address: this.bindAddress,
      port: this.bindPort,
    };
  }

  getRemoteAddress() {
    return {
      address: this.remoteAddress,
      port: this.remotePort,
    };
  }

  isBound() {
    return this.bound && !this.closed;
  }
}

module.exports = { UDPSocket, RAKNET_MAX_PACKET_SIZE, RAKNET_MTU_SIZE };