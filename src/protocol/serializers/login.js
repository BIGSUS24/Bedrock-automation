'use strict';

/**
 * login.js — Real Bedrock Login Packet Serializer
 *
 * Bedrock login chain structure:
 *   The Login packet (0x01) contains:
 *     - Protocol version : Int32BE
 *     - Chain data       : string (JSON-encoded, then varuint-length prefixed)
 *       {
 *         chain: [jwtToken1, jwtToken2, ...]
 *       }
 *     - Client data      : JWT (base64url-encoded JSON payload)
 *
 * For offline/unauthenticated connections:
 *   - chain = [ selfSignedJWT ]  (no Mojang certificate chain)
 *   - Client data JWT contains skin info, device info, etc.
 *
 * For authenticated connections:
 *   - chain = [ MojangRootJWT, identityJWT, selfSignedJWT ]
 *   - The bedrockToken (XBL3.0 header) is embedded in selfSignedJWT.extraData
 *
 * EC key pair (secp384r1 / P-384) is generated per-session and used to
 * sign the self-signed JWT and to verify the server's encryption request.
 *
 * JWT format used here: base64url(header).base64url(payload).base64url(signature)
 * We use Node crypto (ECDH P-384 + SHA-384) for signing.
 */

const crypto = require('crypto');
const { writeVarint } = require('../../transport/packet_router');

const LOGIN_PACKET_ID = 0x01;

// ─────────────────────────────────────────────────────────────────────────────
// EC Key management (one pair per session)
// ─────────────────────────────────────────────────────────────────────────────

function generateKeyPair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-384',
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
}

/**
 * Export a DER public key as uncompressed X9.62 point, then base64url-encode.
 * This is the identityPublicKey format Bedrock uses.
 */
function publicKeyToBase64Url(publicKeyDer) {
  // DER SPKI for P-384 is: 23-byte header + 97-byte uncompressed point
  // We need the raw 97-byte point (0x04 || X || Y)
  const key = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  const raw  = key.export({ format: 'jwk' });
  // Rebuild as base64url JWK-style (Bedrock expects the JWK x/y concatenated)
  const x = Buffer.from(raw.x, 'base64');
  const y = Buffer.from(raw.y, 'base64');
  const point = Buffer.concat([Buffer.from([0x04]), x, y]);
  return point.toString('base64');
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal JWT builder (no external deps)
// ─────────────────────────────────────────────────────────────────────────────

function b64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(JSON.stringify(buf)))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Create a signed JWT using the provided private key (PKCS8 DER).
 * @param {object} payload
 * @param {Buffer} privateKeyDer
 * @param {string} publicKeyB64  — used as the 'x5u' header (identity key)
 * @returns {string}  signed JWT
 */
function signJWT(payload, privateKeyDer, publicKeyB64) {
  const header = b64url({ alg: 'ES384', x5u: publicKeyB64 });
  const body   = b64url(payload);
  const signing = `${header}.${body}`;

  const privateKey = crypto.createPrivateKey({
    key:    privateKeyDer,
    format: 'der',
    type:   'pkcs8',
  });

  const sig = crypto.sign('SHA384', Buffer.from(signing), privateKey);

  // DER→raw (r||s) for JWT ES384
  const rawSig = derToRaw(sig, 48);

  return `${signing}.${b64url(rawSig)}`;
}

/** Convert DER ECDSA signature to raw r||s format */
function derToRaw(der, size) {
  // DER: 30 <len> 02 <rLen> <r> 02 <sLen> <s>
  let off = 2; // skip 0x30 and total length
  if (der[off] === 0x81) off++; // extended length
  off++; // skip 0x02
  const rLen = der[off++];
  const r = der.slice(off, off + rLen); off += rLen;
  off++; // skip 0x02
  const sLen = der[off++];
  const s = der.slice(off, off + sLen);

  const raw = Buffer.alloc(size * 2);
  r.copy(raw, size - r.length);
  s.copy(raw, size * 2 - s.length);
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// LoginSerializer
// ─────────────────────────────────────────────────────────────────────────────

class LoginSerializer {
  /**
   * Build a complete Bedrock Login packet buffer.
   *
   * @param {object} opts
   * @param {string}  opts.username
   * @param {string}  opts.identity        UUID
   * @param {string}  opts.xuid
   * @param {string|null} opts.bedrockToken  XBL3.0 identity token (null = offline)
   * @param {number}  opts.protocolVersion
   * @param {string}  opts.gameVersion     e.g. '1.21.50'
   * @returns {{ buffer: Buffer, keyPair: { publicKeyDer: Buffer, privateKeyDer: Buffer } }}
   */
  static buildLoginPacket({ username, identity, xuid, bedrockToken, protocolVersion, gameVersion }) {
    // Generate ephemeral EC key pair for this session
    const { publicKey: publicKeyDer, privateKey: privateKeyDer } = generateKeyPair();
    const identityPublicKey = publicKeyToBase64Url(publicKeyDer);

    // Build the JWT chain
    const chain = this._buildChain(
      username, identity, xuid, bedrockToken,
      identityPublicKey, privateKeyDer
    );

    // Build client data JWT (device info, skin placeholder)
    const clientData = this._buildClientData(identityPublicKey, privateKeyDer, gameVersion);

    // Serialize the packet
    const chainJson   = JSON.stringify({ chain });
    const chainBuf    = Buffer.from(chainJson, 'utf8');
    const clientBuf   = Buffer.from(clientData, 'utf8');

    // Packet layout:
    //   PacketID varuint
    //   ProtocolVersion Int32BE
    //   chainLength     UInt32LE  (length of chain JSON string)
    //   chainData       raw bytes
    //   clientDataLen   UInt32LE
    //   clientData      raw bytes
    const headerLen  = 5 + 4 + chainBuf.length + 4 + clientBuf.length;
    const buf        = Buffer.alloc(headerLen + 4);
    let off = 0;

    // Packet ID (varuint)
    const idBuf = writeVarint(LOGIN_PACKET_ID);
    idBuf.copy(buf, off); off += idBuf.length;

    // Protocol version
    buf.writeInt32BE(protocolVersion, off); off += 4;

    // Chain data
    buf.writeUInt32LE(chainBuf.length, off); off += 4;
    chainBuf.copy(buf, off); off += chainBuf.length;

    // Client data
    buf.writeUInt32LE(clientBuf.length, off); off += 4;
    clientBuf.copy(buf, off); off += clientBuf.length;

    return {
      buffer:  buf.slice(0, off),
      keyPair: { publicKeyDer, privateKeyDer, identityPublicKey },
    };
  }

  // ── Chain building ─────────────────────────────────────────────────────────

  static _buildChain(username, identity, xuid, bedrockToken, identityPublicKey, privateKeyDer) {
    const chain = [];

    if (bedrockToken) {
      // Authenticated: include Mojang-signed chain placeholder
      // (real Mojang tokens come from the Bedrock auth service)
      // We push the bedrockToken as the first chain element
      chain.push(bedrockToken);
    }

    // Self-signed JWT with player extraData
    const now = Math.floor(Date.now() / 1000);
    const selfSigned = signJWT({
      exp: now + 86400,
      iat: now,
      nbf: now - 60,
      identityPublicKey,
      extraData: {
        displayName: username,
        identity,
        XUID: xuid || '0',
        titleId: '896928775', // Bedrock Android client title ID
      },
    }, privateKeyDer, identityPublicKey);

    chain.push(selfSigned);
    return chain;
  }

  // ── Client data ────────────────────────────────────────────────────────────

  static _buildClientData(identityPublicKey, privateKeyDer, gameVersion) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      exp: now + 86400,
      iat: now,
      nbf: now - 60,
      identityPublicKey,
      // Device info
      DeviceOS:      1,       // Android
      DeviceId:      crypto.randomUUID(),
      DeviceModel:   'BedrockBot',
      // Client info
      ClientRandomId: Math.floor(Math.random() * 2_147_483_647),
      ServerAddress:  '0.0.0.0:19132',
      GameVersion:    gameVersion,
      // Skin (minimal placeholder)
      SkinId:              'Steve',
      SkinData:            '',
      SkinImageWidth:      64,
      SkinImageHeight:     64,
      CapeData:            '',
      CapeImageWidth:      0,
      CapeImageHeight:     0,
      SkinResourcePatch:   b64url('{"geometry":{"default":"geometry.humanoid.customSlim"}}'),
      SkinGeometryData:    '',
      AnimatedImageData:   [],
      PremiumSkin:         false,
      PersonaSkin:         false,
      CapeOnClassicSkin:   false,
      // Language / platform
      LanguageCode:       'en_US',
      UIProfile:          0,
      GuiScale:           0,
      CurrentInputMode:   1,
      DefaultInputMode:   1,
      PlatformOnlineId:   '',
      PlatformUserId:     '',
      ThirdPartyName:     '',
      ThirdPartyNameOnly: false,
    };

    return signJWT(payload, privateKeyDer, identityPublicKey);
  }
}

module.exports = { LoginSerializer, LOGIN_PACKET_ID, generateKeyPair, signJWT };