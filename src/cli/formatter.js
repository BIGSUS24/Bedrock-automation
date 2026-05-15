'use strict';

/**
 * cli/formatter.js — Minecraft color code stripper & chat formatter
 */

// Match ALL Minecraft § formatting codes (§ + any single character)
const COLOR_REGEX = /§./gi;

function stripColors(text) {
  return (text || '').replace(COLOR_REGEX, '').trim();
}

function formatChat(packet) {
  const sender  = stripColors(packet.sender || '');
  const message = stripColors(packet.message || '');
  const type    = packet.type || 'chat';

  // Skip UI-only packets
  if (type === 'tip' || type === 'popup' || type === 'jukebox_popup') return null;
  if (!message) return null;

  // If sender is present and valid
  if (sender && sender !== 'undefined') {
    return `\x1b[37m<\x1b[36m${sender}\x1b[37m>\x1b[0m ${message}`;
  }

  // Server/system message — try to parse "PlayerName: message" pattern
  const chatMatch = message.match(/^[+*]*\s*\.?([A-Za-z0-9_]{3,20})\s*:\s*(.+)$/);
  if (chatMatch) {
    const [, name, msg] = chatMatch;
    return `\x1b[37m<\x1b[36m${name}\x1b[37m>\x1b[0m ${msg}`;
  }

  // Pure system message
  return `\x1b[33m[SERVER]\x1b[0m ${message}`;
}

function formatTimestamp() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

module.exports = { stripColors, formatChat, formatTimestamp };
