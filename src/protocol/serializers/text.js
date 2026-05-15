'use strict';

/**
 * text.js — Bedrock Text packet (0x09) serializer / deserializer
 *
 * Text packet layout:
 *   message_type   : byte (TextType enum)
 *   needs_translation : bool (byte)
 *   [if CHAT/WHISPER/ANNOUNCEMENT] source_name : string
 *   message        : string
 *   parameters     : string[] (varuint count + strings)
 *   xuid           : string
 *   platform_chat_id : string
 *
 * TextType:
 *   RAW=0  CHAT=1  TRANSLATION=2  POPUP=3  JUKEBOX_POPUP=4
 *   TIP=5  SYSTEM=6  WHISPER=7  ANNOUNCEMENT=8  OBJECT=9
 *   OBJECT_WHISPER=10
 */

const { readVarint, writeVarint } = require('../../transport/packet_router');

const TextType = {
  RAW:            0,
  CHAT:           1,
  TRANSLATION:    2,
  POPUP:          3,
  JUKEBOX_POPUP:  4,
  TIP:            5,
  SYSTEM:         6,
  WHISPER:        7,
  ANNOUNCEMENT:   8,
  OBJECT:         9,
  OBJECT_WHISPER: 10,
};

const HAS_SOURCE = new Set([TextType.CHAT, TextType.WHISPER, TextType.ANNOUNCEMENT]);

class TextSerializer {
  // ── Serialize ────────────────────────────────────────────────────────────

  /**
   * @param {object} opts
   * @param {number}   opts.type          TextType
   * @param {boolean}  [opts.needsTranslation=false]
   * @param {string}   [opts.source='']   sender name (for CHAT/WHISPER)
   * @param {string}   opts.message
   * @param {string[]} [opts.parameters=[]]
   * @param {string}   [opts.xuid='']
   * @param {string}   [opts.platformChatId='']
   * @returns {Buffer}
   */
  static serialize({ type = TextType.CHAT, needsTranslation = false, source = '', message = '', parameters = [], xuid = '', platformChatId = '' }) {
    const parts = [];

    parts.push(Buffer.from([type & 0xFF]));
    parts.push(Buffer.from([needsTranslation ? 1 : 0]));

    if (HAS_SOURCE.has(type)) {
      parts.push(writeString(source));
    }

    parts.push(writeString(message));

    // parameters array
    parts.push(writeVarint(parameters.length));
    for (const p of parameters) parts.push(writeString(p));

    parts.push(writeString(xuid));
    parts.push(writeString(platformChatId));

    return Buffer.concat(parts);
  }

  // ── Deserialize ──────────────────────────────────────────────────────────

  /**
   * @param {Buffer} buf  — payload (after packet ID varuint has been consumed)
   * @returns {object}
   */
  static deserialize(buf) {
    let off = 0;

    const type             = buf.readUInt8(off++);
    const needsTranslation = buf.readUInt8(off++) !== 0;

    let source = '';
    if (HAS_SOURCE.has(type)) {
      const r = readString(buf, off); source = r.value; off += r.bytesRead;
    }

    const msgR   = readString(buf, off); const message = msgR.value; off += msgR.bytesRead;

    const paramCountR = readVarint(buf, off); off += paramCountR.bytesRead;
    const parameters  = [];
    for (let i = 0; i < paramCountR.value; i++) {
      const r = readString(buf, off); parameters.push(r.value); off += r.bytesRead;
    }

    const xuidR = readString(buf, off); const xuid = xuidR.value; off += xuidR.bytesRead;
    const platR = readString(buf, off); const platformChatId = platR.value;

    return { type, needsTranslation, source, message, parameters, xuid, platformChatId };
  }
}

// ── String helpers ────────────────────────────────────────────────────────────

function writeString(str) {
  const strBuf = Buffer.from(str || '', 'utf8');
  return Buffer.concat([writeVarint(strBuf.length), strBuf]);
}

function readString(buf, offset) {
  const lenR = readVarint(buf, offset);
  const start = offset + lenR.bytesRead;
  const value = buf.slice(start, start + lenR.value).toString('utf8');
  return { value, bytesRead: lenR.bytesRead + lenR.value };
}

module.exports = { TextSerializer, TextType, writeString, readString };
