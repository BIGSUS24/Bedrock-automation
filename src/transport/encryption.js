'use strict';

/**
 * transport/encryption.js — Bedrock AES-CFB8 Encryption Layer
 *
 * Protocol flow (after RakNet connected):
 *   1. Server sends SERVER_TO_CLIENT_HANDSHAKE (0x03) containing a JWT
 *   2. JWT header has `x5u` (server EC public key, base64url)
 *   3. JWT payload has `salt` (base64url, 16 bytes)
 *   4. Client derives shared secret:
 *        ECDH(clientPrivateKey, serverPublicKey) → raw shared secret
 *   5. Encryption key (32 bytes):
 *        SHA-256( salt || sharedSecret )
 *   6. IV = first 16 bytes of key
 *   7. Cipher: AES-256-CFB8
 *   8. Client sends CLIENT_TO_SERVER_HANDSHAKE (0x04, empty body)
 *   9. All subsequent packets are AES-256-CFB8 encrypted
 */

const crypto = require('crypto');

class EncryptionSession {
  constructor() {
    this._encryptCipher = null;
    this._decryptCipher = null;
    this._active        = false;
    this._encryptSeq    = 0n;  // for send-counter MAC (optional)
  }

  isActive() { return this._active; }

  /**
   * Derive the session key from the shared ECDH secret and the server salt.
   * Returns the 32-byte AES key (and the 16-byte IV derived from it).
   *
   * @param {Buffer} clientPrivateKeyDer   PKCS8 DER private key from login keygen
   * @param {string} serverPublicKeyB64    x5u value from SERVER_TO_CLIENT_HANDSHAKE JWT
   * @param {string} saltB64               salt value from SERVER_TO_CLIENT_HANDSHAKE JWT payload
   * @returns {{ key: Buffer, iv: Buffer }}
   */
  static deriveKey(clientPrivateKeyDer, serverPublicKeyB64, saltB64) {
    // Decode server public key from base64 (uncompressed point or DER)
    const serverPubRaw = Buffer.from(serverPublicKeyB64, 'base64');
    let serverPublicKey;

    try {
      // Try DER SPKI first
      serverPublicKey = crypto.createPublicKey({
        key:    serverPubRaw,
        format: 'der',
        type:   'spki',
      });
    } catch {
      // Fall back: raw uncompressed EC point (0x04 || X || Y) → build SPKI
      serverPublicKey = this._pointToPublicKey(serverPubRaw, 'prime256v1');
    }

    const clientPrivateKey = crypto.createPrivateKey({
      key:    clientPrivateKeyDer,
      format: 'der',
      type:   'pkcs8',
    });

    // ECDH shared secret
    const ecdh     = crypto.createECDH('prime256v1');
    // Export private key as raw scalar so we can set it on the ECDH object
    const jwk      = clientPrivateKey.export({ format: 'jwk' });
    const dBuf     = Buffer.from(jwk.d, 'base64');
    ecdh.setPrivateKey(dBuf);

    // Server public key as raw point
    const srvJwk   = serverPublicKey.export({ format: 'jwk' });
    const srvX     = Buffer.from(srvJwk.x, 'base64');
    const srvY     = Buffer.from(srvJwk.y, 'base64');
    const point    = Buffer.concat([Buffer.from([0x04]), srvX, srvY]);
    const shared   = ecdh.computeSecret(point);

    const salt  = Buffer.from(saltB64, 'base64');
    const keyMaterial = Buffer.concat([salt, shared]);
    const key   = crypto.createHash('sha256').update(keyMaterial).digest();
    const iv    = key.slice(0, 16);

    return { key, iv };
  }

  /**
   * Activate encryption with the derived key material.
   * All subsequent encrypt/decrypt calls use AES-256-CFB8.
   */
  activate(key, iv) {
    this._encryptCipher = crypto.createCipheriv('aes-256-cfb8', key, iv);
    this._decryptCipher = crypto.createDecipheriv('aes-256-cfb8', key, iv);
    this._active        = true;
  }

  /**
   * Encrypt a plaintext game packet buffer.
   * @param {Buffer} plaintext
   * @returns {Buffer}
   */
  encrypt(plaintext) {
    if (!this._active) return plaintext;
    return this._encryptCipher.update(plaintext);
  }

  /**
   * Decrypt an incoming encrypted buffer.
   * @param {Buffer} ciphertext
   * @returns {Buffer}
   */
  decrypt(ciphertext) {
    if (!this._active) return ciphertext;
    return this._decryptCipher.update(ciphertext);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  static _pointToPublicKey(point, curve) {
    // Build minimal DER SPKI wrapper for a raw uncompressed EC point
    // OID for prime256v1: 1.2.840.10045.3.1.7
    const oidCurve = Buffer.from([
      0x06, 0x08,
      0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
    ]);
    const oidEC = Buffer.from([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);

    const algSeq = Buffer.concat([
      Buffer.from([0x30, oidEC.length + oidCurve.length]),
      oidEC, oidCurve,
    ]);

    const bitString = Buffer.concat([
      Buffer.from([0x03, point.length + 1, 0x00]),
      point,
    ]);

    const spki = Buffer.concat([
      Buffer.from([0x30, algSeq.length + bitString.length]),
      algSeq,
      bitString,
    ]);

    return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  }

  /**
   * Parse the SERVER_TO_CLIENT_HANDSHAKE JWT payload.
   * Returns { serverPublicKeyB64, saltB64 }
   *
   * @param {Buffer} buf  (payload after packet ID consumed)
   */
  static parseHandshakePacket(buf) {
    // Payload layout: varuint-length-prefixed JWT string
    let off = 0;
    // varuint length
    let len = 0, shift = 0;
    while (off < buf.length) {
      const byte = buf[off++];
      len |= (byte & 0x7F) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    const jwtStr = buf.slice(off, off + len).toString('utf8');
    return this._parseJWT(jwtStr);
  }

  static _parseJWT(jwtStr) {
    const parts = jwtStr.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT in handshake');

    const header  = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

    return {
      serverPublicKeyB64: header.x5u,
      saltB64:            payload.salt,
    };
  }
}

module.exports = { EncryptionSession };
