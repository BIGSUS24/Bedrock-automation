'use strict';

/**
 * RakNet Reliability — Real Implementation
 *
 * RakNet DATA datagrams use a 3-byte sequence number (LE) at the header.
 * Each frame inside the datagram has:
 *   - reliability flags (1 byte)
 *   - payload length in bits (2 bytes LE)
 *   - [if reliable]   message index  (3 bytes LE)
 *   - [if sequenced]  sequence index (3 bytes LE)
 *   - [if ordered]    order index    (3 bytes LE) + order channel (1 byte)
 *   - [if split]      split count (4 bytes BE) + split id (2 bytes BE) + split index (4 bytes BE)
 *
 * ACK/NACK packets:
 *   0xC0 = ACK   0xA0 = NACK
 *   [record count : 2 bytes BE]
 *   For each record:
 *     [isRange : 1 byte]  0 = single, 1 = range
 *     [start   : 3 bytes LE]
 *     [end     : 3 bytes LE]  (only if isRange = 1)
 */

const EventEmitter = require('events');

const Reliability = {
  UNRELIABLE:                      0,
  UNRELIABLE_SEQUENCED:            1,
  RELIABLE:                        2,
  RELIABLE_SEQUENCED:              3,
  RELIABLE_ORDERED:                4,
  RELIABLE_ORDERED_WITH_ACK_RECEIPT: 5,
};

const ReliabilityFlags = {
  RELIABLE:  (1 << 2),
  SEQUENCED: (1 << 1),
  ORDERED:   (1 << 0),
  SPLIT:     (1 << 4),
};

const MAX_WINDOW_SIZE = 512;
const RESEND_TIMEOUT  = 250;  // ms — initial RTO
const MAX_RESEND      = 8;

// ─────────────────────────────────────────────────────────────────────────────
// 3-byte LE helpers (RakNet uses UInt24 extensively)
// ─────────────────────────────────────────────────────────────────────────────
function readUInt24LE(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

function writeUInt24LE(buf, value, offset) {
  buf[offset]     =  value        & 0xFF;
  buf[offset + 1] = (value >>  8) & 0xFF;
  buf[offset + 2] = (value >> 16) & 0xFF;
}

// ─────────────────────────────────────────────────────────────────────────────
// ReliabilitySystem
// ─────────────────────────────────────────────────────────────────────────────
class ReliabilitySystem extends EventEmitter {
  constructor() {
    super();
    /** Outgoing datagram sequence number (3-byte) */
    this.sendSequence      = 0;
    /** Incoming datagram sequence number, highest seen */
    this.receiveSequence   = -1;
    /** Per reliable-message index counter */
    this.messageIndex      = 0;
    /** Per-channel ordered index counters (outgoing) */
    this.orderIndexOut     = new Array(32).fill(0);
    /** Per-channel expected order index (incoming) */
    this.orderIndexIn      = new Array(32).fill(0);
    /** Per-channel out-of-order hold queue */
    this.orderHold         = Array.from({ length: 32 }, () => new Map());

    /** Sent packets awaiting ACK: sequenceNumber → { frames, timestamp, resendCount } */
    this.sentPackets       = new Map();
    /** Received datagram sequence numbers (for dedup & NACK gap detection) */
    this.receivedSeqs      = new Set();
    /** Pending ACKs to batch-send */
    this.pendingAcks       = new Set();
    /** Pending NACKs to batch-send */
    this.pendingNacks      = new Set();

    this.resendTimers      = new Map();
  }

  // ── Outgoing sequence numbers ────────────────────────────────────────────

  nextSendSequence() {
    const n = this.sendSequence;
    this.sendSequence = (this.sendSequence + 1) & 0xFFFFFF;
    return n;
  }

  nextMessageIndex() {
    const n = this.messageIndex;
    this.messageIndex = (this.messageIndex + 1) & 0xFFFFFF;
    return n;
  }

  nextOrderIndex(channel) {
    const n = this.orderIndexOut[channel];
    this.orderIndexOut[channel] = (n + 1) & 0xFFFFFF;
    return n;
  }

  // ── Frame encoding ───────────────────────────────────────────────────────

  /**
   * Encode a single frame (inside a datagram).
   * Returns a Buffer containing the frame header + payload.
   * The caller is responsible for wrapping multiple frames into a datagram.
   *
   * @param {Buffer} data
   * @param {number} reliability  Reliability enum
   * @param {object} [opts]
   * @param {number} [opts.channel=0]   order channel
   * @param {boolean} [opts.isSplit]    is this a split-packet fragment?
   * @param {number} [opts.splitCount]
   * @param {number} [opts.splitId]
   * @param {number} [opts.splitIndex]
   */
  encodeFrame(data, reliability, opts = {}) {
    const { channel = 0, isSplit = false, splitCount, splitId, splitIndex } = opts;

    const isReliable  = (reliability === Reliability.RELIABLE ||
                         reliability === Reliability.RELIABLE_SEQUENCED ||
                         reliability === Reliability.RELIABLE_ORDERED ||
                         reliability === Reliability.RELIABLE_ORDERED_WITH_ACK_RECEIPT);
    const isSequenced = (reliability === Reliability.UNRELIABLE_SEQUENCED ||
                         reliability === Reliability.RELIABLE_SEQUENCED);
    const isOrdered   = (reliability === Reliability.RELIABLE_ORDERED ||
                         reliability === Reliability.RELIABLE_ORDERED_WITH_ACK_RECEIPT);

    // Calculate frame header size
    let headerSize = 3; // flags(1) + length_bits(2)
    if (isReliable)  headerSize += 3; // message index
    if (isSequenced) headerSize += 3; // sequence index
    if (isOrdered)   headerSize += 3 + 1; // order index + channel
    if (isSplit)     headerSize += 4 + 2 + 4; // split count + id + index

    const frame = Buffer.alloc(headerSize + data.length);
    let off = 0;

    // Flags byte
    let flags = (reliability & 0x07) << 5;
    if (isSplit) flags |= ReliabilityFlags.SPLIT;
    frame.writeUInt8(flags, off++);

    // Length in bits (16-bit LE)
    frame.writeUInt16LE(data.length * 8, off); off += 2;

    if (isReliable) {
      writeUInt24LE(frame, this.nextMessageIndex(), off); off += 3;
    }
    if (isSequenced) {
      writeUInt24LE(frame, 0, off); off += 3; // sequencing index (simplified)
    }
    if (isOrdered) {
      writeUInt24LE(frame, this.nextOrderIndex(channel), off); off += 3;
      frame.writeUInt8(channel, off++);
    }
    if (isSplit) {
      frame.writeUInt32BE(splitCount, off); off += 4;
      frame.writeUInt16BE(splitId,    off); off += 2;
      frame.writeUInt32BE(splitIndex, off); off += 4;
    }

    data.copy(frame, off);
    return frame;
  }

  /**
   * Wrap one or more frames in a RakNet DATA datagram.
   * Datagram header: dataFlags(1) + sequenceNumber(3-LE)
   *
   * @param {Buffer[]} frames
   * @param {number}   sequenceNumber
   * @returns {Buffer}
   */
  buildDatagram(frames, sequenceNumber) {
    const framesBuffer = Buffer.concat(frames);
    const datagram = Buffer.alloc(4 + framesBuffer.length);
    // DATA flag: 0x84 (reliable = bit 3, ACK = bit 7 cleared, DATA = bit 7 set? 
    // In RakNet: datagram header byte is 0x80 | flags; we use 0x84 for standard DATA)
    datagram.writeUInt8(0x84, 0);
    writeUInt24LE(datagram, sequenceNumber, 1);
    framesBuffer.copy(datagram, 4);
    return datagram;
  }

  // ── Frame decoding ───────────────────────────────────────────────────────

  /**
   * Parse all frames from a RakNet DATA datagram.
   * @param {Buffer} datagram  — full datagram including header byte
   * @returns {{ sequenceNumber: number, frames: FrameInfo[] } | null}
   */
  decodeDatagram(datagram) {
    if (datagram.length < 4) return null;
    const sequenceNumber = readUInt24LE(datagram, 1);
    const frames = [];
    let off = 4;

    while (off < datagram.length) {
      const frame = this.decodeFrame(datagram, off);
      if (!frame) break;
      frames.push(frame);
      off += frame.frameSize;
    }

    return { sequenceNumber, frames };
  }

  /**
   * Parse a single frame starting at `offset` within `buf`.
   * Returns null if buffer is too short.
   */
  decodeFrame(buf, offset = 0) {
    if (buf.length < offset + 3) return null;
    let off = offset;

    const flags      = buf.readUInt8(off++);
    const reliability = (flags >> 5) & 0x07;
    const isSplit     = (flags & ReliabilityFlags.SPLIT) !== 0;
    const lengthBits  = buf.readUInt16LE(off); off += 2;
    const payloadLen  = Math.ceil(lengthBits / 8);

    const isReliable  = (reliability === Reliability.RELIABLE ||
                         reliability === Reliability.RELIABLE_SEQUENCED ||
                         reliability === Reliability.RELIABLE_ORDERED ||
                         reliability === Reliability.RELIABLE_ORDERED_WITH_ACK_RECEIPT);
    const isSequenced = (reliability === Reliability.UNRELIABLE_SEQUENCED ||
                         reliability === Reliability.RELIABLE_SEQUENCED);
    const isOrdered   = (reliability === Reliability.RELIABLE_ORDERED ||
                         reliability === Reliability.RELIABLE_ORDERED_WITH_ACK_RECEIPT);

    let messageIndex  = null;
    let sequenceIndex = null;
    let orderIndex    = null;
    let orderChannel  = 0;
    let splitCount    = null;
    let splitId       = null;
    let splitIndex    = null;

    if (isReliable) {
      if (off + 3 > buf.length) return null;
      messageIndex = readUInt24LE(buf, off); off += 3;
    }
    if (isSequenced) {
      if (off + 3 > buf.length) return null;
      sequenceIndex = readUInt24LE(buf, off); off += 3;
    }
    if (isOrdered) {
      if (off + 4 > buf.length) return null;
      orderIndex   = readUInt24LE(buf, off); off += 3;
      orderChannel = buf.readUInt8(off++);
    }
    if (isSplit) {
      if (off + 10 > buf.length) return null;
      splitCount  = buf.readUInt32BE(off); off += 4;
      splitId     = buf.readUInt16BE(off); off += 2;
      splitIndex  = buf.readUInt32BE(off); off += 4;
    }

    if (off + payloadLen > buf.length) return null;
    const data = buf.slice(off, off + payloadLen);

    return {
      reliability, isReliable, isSequenced, isOrdered, isSplit,
      messageIndex, sequenceIndex, orderIndex, orderChannel,
      splitCount, splitId, splitIndex,
      data,
      frameSize: (off + payloadLen) - offset,
    };
  }

  // ── Incoming datagram processing ─────────────────────────────────────────

  /**
   * Process an incoming datagram. Returns an array of payloads ready to deliver.
   * Side-effects: queues ACKs/NACKs.
   *
   * @param {Buffer} datagram
   * @returns {Buffer[]}
   */
  handleDatagram(datagram) {
    const parsed = this.decodeDatagram(datagram);
    if (!parsed) return [];

    const { sequenceNumber, frames } = parsed;

    // Detect gaps for NACK
    this._detectGaps(sequenceNumber);

    // Dedup
    if (this.receivedSeqs.has(sequenceNumber)) return [];
    this.receivedSeqs.add(sequenceNumber);
    this.pendingAcks.add(sequenceNumber);

    const ready = [];
    for (const frame of frames) {
      const results = this._processFrame(frame);
      for (const r of results) ready.push(r);
    }
    return ready;
  }

  _detectGaps(incomingSeq) {
    if (this.receiveSequence < 0) {
      this.receiveSequence = incomingSeq;
      return;
    }
    const expected = (this.receiveSequence + 1) & 0xFFFFFF;
    if (incomingSeq !== expected) {
      // Gap detected — NACK everything in between
      let gap = expected;
      while (gap !== incomingSeq) {
        if (!this.receivedSeqs.has(gap)) {
          this.pendingNacks.add(gap);
        }
        gap = (gap + 1) & 0xFFFFFF;
      }
    }
    // Advance highest-seen only if it's later
    if (this._seqGT(incomingSeq, this.receiveSequence)) {
      this.receiveSequence = incomingSeq;
    }
  }

  /** Returns true if a is "greater than" b in a wrapped 24-bit window */
  _seqGT(a, b) {
    const diff = (a - b + 0x1000000) & 0xFFFFFF;
    return diff > 0 && diff < 0x800000;
  }

  _processFrame(frame) {
    if (frame.isSplit) {
      // Handled by FragmentationSystem above us — emit event
      this.emit('splitFrame', frame);
      return [];
    }

    if (!frame.isOrdered) {
      return [frame.data];
    }

    // Ordered delivery
    const ch = frame.orderChannel;
    if (frame.orderIndex === this.orderIndexIn[ch]) {
      const ready = [frame.data];
      this.orderIndexIn[ch] = (this.orderIndexIn[ch] + 1) & 0xFFFFFF;

      // Drain any buffered frames that are now in order
      let next;
      while ((next = this.orderHold[ch].get(this.orderIndexIn[ch])) !== undefined) {
        ready.push(next);
        this.orderHold[ch].delete(this.orderIndexIn[ch]);
        this.orderIndexIn[ch] = (this.orderIndexIn[ch] + 1) & 0xFFFFFF;
      }
      return ready;
    }

    if (this._seqGT(frame.orderIndex, this.orderIndexIn[ch])) {
      this.orderHold[ch].set(frame.orderIndex, frame.data);
    }
    return [];
  }

  // ── ACK / NACK handling ─────────────────────────────────────────────────

  /**
   * Build an ACK or NACK packet from a set of sequence numbers.
   * @param {Set<number>} seqs
   * @param {boolean} isAck
   * @returns {Buffer}
   */
  buildAckNack(seqs, isAck) {
    if (seqs.size === 0) return null;

    const sorted = [...seqs].sort((a, b) => a - b);
    const records = [];
    let start = sorted[0];
    let end   = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === end + 1) {
        end = sorted[i];
      } else {
        records.push({ start, end });
        start = end = sorted[i];
      }
    }
    records.push({ start, end });

    // Packet size: 1 (id) + 2 (count) + 7 per record (1 flag + 3 start + 3 end)
    const buf = Buffer.alloc(3 + records.length * 7);
    buf.writeUInt8(isAck ? 0xC0 : 0xA0, 0);
    buf.writeUInt16BE(records.length, 1);

    let off = 3;
    for (const rec of records) {
      const isRange = rec.start !== rec.end ? 1 : 0;
      buf.writeUInt8(isRange ? 0 : 1, off++); // 0 = range, 1 = single (RakNet convention)
      writeUInt24LE(buf, rec.start, off); off += 3;
      if (isRange) {
        writeUInt24LE(buf, rec.end, off);
      } else {
        writeUInt24LE(buf, rec.start, off);
      }
      off += 3;
    }

    return buf;
  }

  /**
   * Parse incoming ACK or NACK packet and return list of sequence numbers.
   * @param {Buffer} buf
   * @returns {{ isAck: boolean, sequences: number[] }}
   */
  parseAckNack(buf) {
    if (buf.length < 3) return { isAck: true, sequences: [] };

    const isAck = buf.readUInt8(0) === 0xC0;
    const count = buf.readUInt16BE(1);
    const sequences = [];
    let off = 3;

    for (let i = 0; i < count && off + 6 <= buf.length; i++) {
      const isSingle = buf.readUInt8(off++) === 1;
      const start = readUInt24LE(buf, off); off += 3;
      const end   = readUInt24LE(buf, off); off += 3;

      if (isSingle) {
        sequences.push(start);
      } else {
        for (let s = start; s <= end; s++) sequences.push(s);
      }
    }

    return { isAck, sequences };
  }

  /** Process incoming ACK — remove from sentPackets and cancel resend timers */
  handleAck(sequences) {
    for (const seq of sequences) {
      const entry = this.sentPackets.get(seq);
      if (entry) {
        this.cancelResend(seq);
        this.sentPackets.delete(seq);
      }
    }
  }

  /** Process incoming NACK — schedule immediate resend */
  handleNack(sequences) {
    for (const seq of sequences) {
      const entry = this.sentPackets.get(seq);
      if (entry && entry.resendCount < MAX_RESEND) {
        this.cancelResend(seq);
        entry.resendCount++;
        this.emit('resend', { sequenceNumber: seq, datagram: entry.datagram });
      }
    }
  }

  // ── Sent-packet tracking ─────────────────────────────────────────────────

  trackSent(sequenceNumber, datagram) {
    this.sentPackets.set(sequenceNumber, {
      datagram,
      timestamp: Date.now(),
      resendCount: 0,
    });
    this.scheduleResend(sequenceNumber, datagram);
  }

  scheduleResend(sequenceNumber, datagram) {
    if (this.resendTimers.has(sequenceNumber)) return;
    const timer = setTimeout(() => {
      const entry = this.sentPackets.get(sequenceNumber);
      if (entry && entry.resendCount < MAX_RESEND) {
        entry.resendCount++;
        this.emit('resend', { sequenceNumber, datagram: entry.datagram });
        // Exponential backoff
        this.resendTimers.delete(sequenceNumber);
        this.scheduleResend(sequenceNumber, entry.datagram);
      }
    }, RESEND_TIMEOUT * Math.pow(2, this.sentPackets.get(sequenceNumber)?.resendCount || 0));

    this.resendTimers.set(sequenceNumber, timer);
  }

  cancelResend(sequenceNumber) {
    const t = this.resendTimers.get(sequenceNumber);
    if (t) { clearTimeout(t); this.resendTimers.delete(sequenceNumber); }
  }

  // ── Flush helpers ────────────────────────────────────────────────────────

  flushAcks() {
    if (this.pendingAcks.size === 0) return null;
    const buf = this.buildAckNack(this.pendingAcks, true);
    this.pendingAcks.clear();
    return buf;
  }

  flushNacks() {
    if (this.pendingNacks.size === 0) return null;
    const buf = this.buildAckNack(this.pendingNacks, false);
    this.pendingNacks.clear();
    return buf;
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  cleanup() {
    for (const t of this.resendTimers.values()) clearTimeout(t);
    this.resendTimers.clear();
    this.sentPackets.clear();
    this.receivedSeqs.clear();
    this.pendingAcks.clear();
    this.pendingNacks.clear();
    this.sendSequence    = 0;
    this.receiveSequence = -1;
    this.messageIndex    = 0;
    this.orderIndexOut.fill(0);
    this.orderIndexIn.fill(0);
    for (const ch of this.orderHold) ch.clear();
  }

  getStats() {
    return {
      sendSequence:    this.sendSequence,
      receiveSequence: this.receiveSequence,
      sentPending:     this.sentPackets.size,
      pendingAcks:     this.pendingAcks.size,
      pendingNacks:    this.pendingNacks.size,
      resendTimers:    this.resendTimers.size,
    };
  }
}

module.exports = { ReliabilitySystem, Reliability, MAX_WINDOW_SIZE, RESEND_TIMEOUT, readUInt24LE, writeUInt24LE };