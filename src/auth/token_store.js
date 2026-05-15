'use strict';

/**
 * token_store.js — Secure persistent token storage
 *
 * Tokens are stored in JSON at a platform-appropriate config path.
 * Writes are atomic (write to temp → rename) to prevent corruption.
 * Fields stored:
 *   - msAccessToken, msRefreshToken, msExpiresAt
 *   - xblToken, xstsToken
 *   - bedrockToken, bedrockExpiresAt
 *   - authData { username, xuid, identity, type }
 *   - savedAt (timestamp)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

function getStorePath() {
  const base =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));

  return path.join(base, 'bedrock-companion', 'auth.json');
}

class TokenStore {
  constructor(storePath) {
    this.storePath = storePath || getStorePath();
    this._data     = null;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Load tokens from disk. Returns empty object if not found or corrupt. */
  load() {
    try {
      const raw  = fs.readFileSync(this.storePath, 'utf8');
      this._data = JSON.parse(raw);
    } catch {
      this._data = {};
    }
    return this._data;
  }

  get(key) {
    if (!this._data) this.load();
    return this._data[key];
  }

  getAll() {
    if (!this._data) this.load();
    return { ...this._data };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  set(key, value) {
    if (!this._data) this.load();
    this._data[key] = value;
  }

  setMany(fields) {
    if (!this._data) this.load();
    Object.assign(this._data, fields);
  }

  /** Atomically persist to disk */
  save() {
    if (!this._data) return;

    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this._data.savedAt = Date.now();
    const json  = JSON.stringify(this._data, null, 2);
    const tmp   = this.storePath + '.tmp';

    try {
      fs.writeFileSync(tmp, json, 'utf8');
      fs.renameSync(tmp, this.storePath);
    } catch (e) {
      console.error('[TokenStore] Failed to save:', e.message);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Remove all stored tokens from disk and memory */
  clear() {
    this._data = {};
    try { fs.unlinkSync(this.storePath); } catch {}
  }

  /** Returns true if a Microsoft refresh token exists */
  hasRefreshToken() {
    return !!(this.get('msRefreshToken'));
  }

  /**
   * Returns true if the Microsoft access token is still valid.
   * Considers a 5-minute buffer before expiry.
   */
  isMsTokenValid() {
    const expiresAt = this.get('msExpiresAt');
    if (!expiresAt) return false;
    return Date.now() < expiresAt - 5 * 60 * 1000;
  }

  /**
   * Returns true if the Bedrock session token is still valid.
   */
  isBedrockTokenValid() {
    const expiresAt = this.get('bedrockExpiresAt');
    if (!expiresAt) return false;
    return Date.now() < expiresAt - 5 * 60 * 1000;
  }
}

module.exports = { TokenStore, getStorePath };
