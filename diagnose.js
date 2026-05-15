/**
 * diagnose.js — Raw RakNet handshake with COOKIE support
 * 
 * Tests whether echoing the cookie in OCR2 yields a proper OCReply2.
 */
'use strict';

const dgram = require('dgram');
const dns   = require('dns').promises;

const HOSTNAME = 'donutsmp.net';
const PORT     = 19132;

const MAGIC = Buffer.from([
  0x00, 0xFF, 0xFF, 0x00, 0xFE, 0xFE, 0xFE, 0xFE,
  0xFD, 0xFD, 0xFD, 0xFD, 0x12, 0x34, 0x56, 0x78,
]);

const PKT_NAMES = {
  0x01: 'UNCONNECTED_PING',
  0x05: 'OPEN_CONNECTION_REQUEST_1',
  0x06: 'OPEN_CONNECTION_REPLY_1',
  0x07: 'OPEN_CONNECTION_REQUEST_2',
  0x08: 'OPEN_CONNECTION_REPLY_2',
  0x09: 'CONNECTION_REQUEST',
  0x10: 'CONNECTION_REQUEST_ACCEPTED',
  0x13: 'NEW_INCOMING_CONNECTION',
  0x15: 'DISCONNECT',
  0x1C: 'UNCONNECTED_PONG',
};

function writeAddress(buf, off, ipStr, port) {
  buf.writeUInt8(4, off++); // IPv4 family
  for (const part of ipStr.split('.')) {
    buf.writeUInt8((~parseInt(part)) & 0xFF, off++);
  }
  buf.writeUInt16BE(port, off); off += 2;
  return off;
}

function clientGuid() {
  const b = Buffer.allocUnsafe(8);
  for (let i = 0; i < 8; i++) b[i] = Math.floor(Math.random() * 256);
  b[0] &= 0x7F;
  return b;
}

function makePing(guid) {
  const buf = Buffer.allocUnsafe(33);
  buf.writeUInt8(0x01, 0);
  buf.writeBigInt64BE(BigInt(Date.now()), 1);
  MAGIC.copy(buf, 9);
  guid.copy(buf, 25);
  return buf;
}

function makeOCR1(mtu) {
  const totalLen = mtu;
  const buf = Buffer.alloc(totalLen, 0);
  buf.writeUInt8(0x05, 0);
  MAGIC.copy(buf, 1);
  buf.writeUInt8(11, 17); // RakNet protocol 11
  return buf;
}

/**
 * Build OCR2 WITH cookie (39 bytes):
 *   ID(1) + MAGIC(16) + COOKIE(4) + CLIENT_WROTE_CHALLENGE(1=0x00)
 *   + SERVER_ADDR(7) + MTU(2) + CLIENT_GUID(8)
 */
function makeOCR2WithCookie(serverIp, serverPort, mtu, guid, cookie) {
  const buf = Buffer.alloc(39, 0);
  let off = 0;

  buf.writeUInt8(0x07, off++);               // ID
  MAGIC.copy(buf, off); off += 16;            // MAGIC
  buf.writeUInt32BE(cookie, off); off += 4;   // COOKIE (echo from server)
  buf.writeUInt8(0x00, off++);                // clientWroteChallenge = false
  off = writeAddress(buf, off, serverIp, serverPort); // SERVER_ADDR (7 bytes)
  buf.writeUInt16BE(mtu, off); off += 2;      // MTU
  guid.copy(buf, off); off += 8;              // CLIENT_GUID

  return buf.slice(0, off);
}

/**
 * Build OCR2 WITHOUT cookie (34 bytes) — original format
 */
function makeOCR2NoCookie(serverIp, serverPort, mtu, guid) {
  const buf = Buffer.alloc(34, 0);
  let off = 0;

  buf.writeUInt8(0x07, off++);
  MAGIC.copy(buf, off); off += 16;
  off = writeAddress(buf, off, serverIp, serverPort);
  buf.writeUInt16BE(mtu, off); off += 2;
  guid.copy(buf, off); off += 8;

  return buf.slice(0, off);
}

async function main() {
  const { address: serverIp } = await dns.lookup(HOSTNAME, { family: 4 });
  console.log(`Resolved ${HOSTNAME} → ${serverIp}\n`);

  const sock = dgram.createSocket('udp4');
  const guid = clientGuid();
  let mtu = 1400;
  let step = 'PING';

  sock.on('message', (buf, rinfo) => {
    const id = buf[0];
    const name = PKT_NAMES[id] || `DATA_FRAME(0x${id.toString(16).padStart(2,'0')})`;
    console.log(`← [${name}] ${buf.length} bytes from ${rinfo.address}:${rinfo.port}`);
    console.log(`  HEX: ${buf.slice(0, Math.min(80, buf.length)).toString('hex')}`);

    if (id === 0x1C && step === 'PING') {
      // Got PONG — send OCR1
      step = 'OCR1';
      console.log(`\n→ [OCR1] MTU=1400 protocol=11`);
      const ocr1 = makeOCR1(mtu);
      sock.send(ocr1, PORT, serverIp);
    }

    if (id === 0x06 && step === 'OCR1') {
      // Got OCReply1 — parse carefully
      const serverGuid = buf.slice(17, 25);
      const useSecurity = buf[25];
      let cookie = null;
      let serverMtu;

      if (useSecurity === 1) {
        cookie = buf.readUInt32BE(26);
        serverMtu = buf.readUInt16BE(30);
        console.log(`  ★ use_security=1  cookie=0x${cookie.toString(16)}  MTU=${serverMtu}`);
      } else {
        serverMtu = buf.readUInt16BE(26);
        console.log(`  use_security=0  MTU=${serverMtu}`);
      }

      mtu = Math.min(serverMtu, 1400);

      // Send OCR2 WITH cookie
      step = 'OCR2';
      let ocr2;
      if (cookie !== null) {
        ocr2 = makeOCR2WithCookie(serverIp, PORT, mtu, guid, cookie);
        console.log(`\n→ [OCR2 WITH COOKIE] ${ocr2.length} bytes, MTU=${mtu}, cookie=0x${cookie.toString(16)}`);
      } else {
        ocr2 = makeOCR2NoCookie(serverIp, PORT, mtu, guid);
        console.log(`\n→ [OCR2 NO COOKIE] ${ocr2.length} bytes, MTU=${mtu}`);
      }
      console.log(`  HEX: ${ocr2.toString('hex')}`);
      sock.send(ocr2, PORT, serverIp);
    }

    if (id === 0x08 && step === 'OCR2') {
      console.log('\n✅ GOT OPEN_CONNECTION_REPLY_2 — RakNet handshake SUCCEEDED!');
      const serverGuid = buf.slice(17, 25);
      const clientAddr = buf.slice(25, 32);
      const replyMtu = buf.readUInt16BE(32);
      console.log(`  Server GUID: ${serverGuid.toString('hex')}`);
      console.log(`  Reply MTU: ${replyMtu}`);
      step = 'DONE';
      sock.close();
      process.exit(0);
    }

    // Log any data frames
    if (id >= 0x80 && id <= 0x8f) {
      console.log(`  ↳ This is a RakNet data frame (server thinks we're connected)`);
    }
  });

  sock.bind(0, () => {
    const local = sock.address();
    console.log(`Bound to local port ${local.port}`);
    console.log(`\n→ [PING] to ${serverIp}:${PORT}`);
    sock.send(makePing(guid), PORT, serverIp);
  });

  setTimeout(() => {
    console.log(`\n❌ TIMEOUT (15s) — last step: ${step}`);
    sock.close();
    process.exit(1);
  }, 15000);
}

main().catch(console.error);
