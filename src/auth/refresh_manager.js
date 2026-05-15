'use strict';

/**
 * refresh_manager.js — Proactive MS Access Token Refresh
 *
 * Responsibilities:
 *   - Refresh the Microsoft access token using the stored refresh_token
 *   - Retry with exponential backoff on transient failures
 *   - Schedule proactive refresh 5 minutes before expiry
 *   - Emit events so session_manager can re-derive XSTS + Bedrock tokens
 */

const EventEmitter = require('events');
const https        = require('https');
const { URL, URLSearchParams } = require('url');
const { CLIENT_ID } = require('./device_code');

const TOKEN_URL       = 'https://login.live.com/oauth20_token.srf';
const SCOPE           = 'service::user.auth.xboxlive.com::MBI_SSL';
const REFRESH_BEFORE  = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES     = 3;
const BASE_DELAY_MS   = 2000;

class RefreshManager extends EventEmitter {
  /**
   * @param {import('./token_store').TokenStore} store
   */
  constructor(store) {
    super();
    this.store        = store;
    this._refreshTimer = null;
    this._retrying     = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Perform an immediate refresh using the stored refresh token.
   * Updates the store and emits 'refreshed' on success.
   *
   * @returns {Promise<{ access_token: string, refresh_token: string, expires_in: number }>}
   */
  async refresh() {
    const refreshToken = this.store.get('msRefreshToken');
    if (!refreshToken) {
      throw new Error('No refresh token available — device code login required');
    }

    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await this._doRefresh(refreshToken);
        this._storeResult(result);
        this._scheduleProactive();
        this.emit('refreshed', { expiresAt: this.store.get('msExpiresAt') });
        return result;
      } catch (e) {
        lastError = e;
        if (this._isPermanentError(e)) break;
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
      }
    }

    this.emit('refreshFailed', { error: lastError.message });
    throw lastError;
  }

  /**
   * Schedule a proactive refresh based on the stored expiry time.
   * Cancels any previously scheduled refresh first.
   */
  _scheduleProactive() {
    this._cancelProactive();

    const expiresAt = this.store.get('msExpiresAt');
    if (!expiresAt) return;

    const delay = Math.max(0, expiresAt - Date.now() - REFRESH_BEFORE);

    this._refreshTimer = setTimeout(async () => {
      try {
        await this.refresh();
      } catch (e) {
        console.error('[RefreshManager] Proactive refresh failed:', e.message);
        this.emit('refreshFailed', { error: e.message });
      }
    }, delay);
  }

  /** Cancel any pending proactive refresh. */
  _cancelProactive() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  stop() {
    this._cancelProactive();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _doRefresh(refreshToken) {
    const body = new URLSearchParams({
      client_id:     CLIENT_ID,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
      scope:         SCOPE,
    }).toString();

    return new Promise((resolve, reject) => {
      const bodyBuf = Buffer.from(body, 'utf8');
      const url = new URL(TOKEN_URL);

      const req = https.request({
        hostname: url.hostname,
        port:     443,
        path:     url.pathname,
        method:   'POST',
        headers: {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': bodyBuf.length,
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); }
          catch { return reject(new Error(`Non-JSON token response: ${data.slice(0, 100)}`)); }

          if (parsed.error) {
            return reject(new Error(`Token refresh failed: ${parsed.error_description || parsed.error}`));
          }
          resolve(parsed);
        });
      });

      req.on('error', reject);
      req.write(bodyBuf);
      req.end();
    });
  }

  _storeResult(result) {
    this.store.setMany({
      msAccessToken:  result.access_token,
      msRefreshToken: result.refresh_token || this.store.get('msRefreshToken'),
      msExpiresAt:    Date.now() + result.expires_in * 1000,
    });
    this.store.save();
  }

  /** Permanent errors mean no point retrying (e.g. invalid_grant). */
  _isPermanentError(e) {
    const msg = e.message.toLowerCase();
    return msg.includes('invalid_grant') ||
           msg.includes('invalid_client') ||
           msg.includes('unauthorized_client');
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { RefreshManager };
