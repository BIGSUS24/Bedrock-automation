'use strict';

/**
 * session_manager.js — Auth State Machine
 *
 * States:
 *   UNAUTHENTICATED  → no tokens at all
 *   DEVICE_CODE      → waiting for user to complete device code flow
 *   REFRESHING       → exchanging refresh token for new access token
 *   EXCHANGING       → getting XBL/XSTS/Bedrock tokens from MS access token
 *   VALID            → all tokens are fresh; authData ready
 *   EXPIRED          → tokens expired and refresh failed
 *   OFFLINE          → offline mode (no real auth)
 *
 * Only this class may perform auth network calls.
 * Consumers call getAuthData() — it always returns valid data or throws.
 */

const EventEmitter     = require('events');
const { TokenStore }   = require('./token_store');
const { DeviceCodeFlow } = require('./device_code');
const { RefreshManager } = require('./refresh_manager');
const { XSTSManager }  = require('./xsts');

const AuthState = {
  UNAUTHENTICATED: 'unauthenticated',
  DEVICE_CODE:     'device_code',
  REFRESHING:      'refreshing',
  EXCHANGING:      'exchanging',
  VALID:           'valid',
  EXPIRED:         'expired',
  OFFLINE:         'offline',
};

class SessionManager extends EventEmitter {
  /**
   * @param {{ mode: string, username?: string }} authConfig
   * @param {string} [storePath]  Override default token store path
   */
  constructor(authConfig, storePath) {
    super();
    this.authConfig     = authConfig;
    this.store          = new TokenStore(storePath);
    this.refreshManager = new RefreshManager(this.store);
    this.state          = AuthState.UNAUTHENTICATED;
    this._authData      = null;

    // When access token is proactively refreshed, re-derive downstream tokens
    this.refreshManager.on('refreshed', () => this._onAccessTokenRefreshed());
    this.refreshManager.on('refreshFailed', ({ error }) => {
      console.error('[Auth] Proactive refresh failed:', error);
      this._setState(AuthState.EXPIRED);
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Ensure the session is authenticated.
   * Returns authData on success, throws on failure.
   *
   * @returns {Promise<AuthData>}
   */
  async authenticate() {
    const mode = this.authConfig.mode || 'offline';

    if (mode === 'offline') {
      return this._offlineAuth();
    }

    if (mode !== 'microsoft') {
      throw new Error(`Unknown auth mode: "${mode}". Valid modes: offline, microsoft`);
    }

    this.store.load();

    // Already valid?
    if (this.state === AuthState.VALID && this._authData && this.store.isMsTokenValid()) {
      return this._authData;
    }

    // Try refresh path first
    if (this.store.hasRefreshToken()) {
      try {
        return await this._refreshAndExchange();
      } catch (e) {
        console.warn('[Auth] Refresh path failed, falling back to device code:', e.message);
      }
    }

    // Device code flow
    return await this._deviceCodeAuth();
  }

  /**
   * Returns current authData if valid, else null.
   * @returns {AuthData|null}
   */
  getAuthData() {
    if (this.state === AuthState.VALID || this.state === AuthState.OFFLINE) {
      return this._authData;
    }
    return null;
  }

  getState() { return this.state; }

  isAuthenticated() {
    return this.state === AuthState.VALID || this.state === AuthState.OFFLINE;
  }

  /** Stop background refresh scheduling (call on shutdown). */
  stop() {
    this.refreshManager.stop();
  }

  // ── Auth paths ─────────────────────────────────────────────────────────────

  _offlineAuth() {
    const username = this.authConfig.username;
    if (!username || typeof username !== 'string' || username.trim() === '') {
      throw new Error('Offline mode requires auth.username in config.');
    }

    this._authData = {
      username:  username.trim(),
      identity:  '00000000-0000-0000-0000-000000000000',
      xuid:      '0',
      type:      'offline',
      xblToken:  null,
      xstsToken: null,
    };
    this._setState(AuthState.OFFLINE);
    return this._authData;
  }

  async _refreshAndExchange() {
    this._setState(AuthState.REFRESHING);
    await this.refreshManager.refresh();
    return this._exchangeTokens();
  }

  async _deviceCodeAuth() {
    this._setState(AuthState.DEVICE_CODE);

    const tokens = await DeviceCodeFlow.authenticate((info) => {
      console.log('\n[Auth] ─────────────────────────────────────────');
      console.log('[Auth] Microsoft Device Code Login');
      console.log(`[Auth] 1. Open: ${info.verification_uri}`);
      console.log(`[Auth] 2. Enter code: ${info.user_code}`);
      console.log(`[Auth] Code expires in ${Math.floor(info.expires_in / 60)} minutes`);
      console.log('[Auth] ─────────────────────────────────────────\n');
      this.emit('deviceCode', info);
    });

    this.store.setMany({
      msAccessToken:  tokens.access_token,
      msRefreshToken: tokens.refresh_token,
      msExpiresAt:    Date.now() + tokens.expires_in * 1000,
    });
    this.store.save();

    return this._exchangeTokens();
  }

  async _exchangeTokens() {
    this._setState(AuthState.EXCHANGING);

    const msAccessToken = this.store.get('msAccessToken');
    if (!msAccessToken) throw new Error('[Auth] No access token after refresh');

    const xsts = await XSTSManager.exchange(msAccessToken);

    // Build Bedrock identity token (XBL auth header format)
    // Bedrock uses: XBL3.0 x=<userHash>;<xstsToken>
    const bedrockIdentityToken = `XBL3.0 x=${xsts.xstsUserHash};${xsts.xstsToken}`;

    // Store tokens
    this.store.setMany({
      xblToken:      xsts.xblToken,
      xstsToken:     xsts.xstsToken,
      xstsUserHash:  xsts.xstsUserHash,
      bedrockToken:  bedrockIdentityToken,
      bedrockExpiresAt: Date.now() + 24 * 60 * 60 * 1000, // XSTS valid ~24h
    });
    this.store.save();

    // Build authData — username/xuid from XSTS DisplayClaims
    // (stored in xstsUserHash; real xuid comes from the XSTS claims)
    this._authData = {
      username:  this.store.get('authUsername') || 'BedrockBot',
      identity:  this.store.get('authIdentity') || '00000000-0000-0000-0000-000000000000',
      xuid:      this.store.get('authXuid')     || xsts.xstsUserHash,
      type:      'microsoft',
      xblToken:  xsts.xblToken,
      xstsToken: xsts.xstsToken,
      bedrockToken: bedrockIdentityToken,
    };

    this._setState(AuthState.VALID);
    this.refreshManager._scheduleProactive();

    console.log(`[Auth] Authenticated as: ${this._authData.username}`);
    return this._authData;
  }

  async _onAccessTokenRefreshed() {
    try {
      await this._exchangeTokens();
    } catch (e) {
      console.error('[Auth] Token re-exchange failed after refresh:', e.message);
      this._setState(AuthState.EXPIRED);
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _setState(newState) {
    const old = this.state;
    this.state = newState;
    this.emit('stateChange', { from: old, to: newState });
  }
}

/** @typedef {{ username: string, identity: string, xuid: string, type: string, xblToken: string|null, xstsToken: string|null, bedrockToken: string|null }} AuthData */

module.exports = { SessionManager, AuthState };
