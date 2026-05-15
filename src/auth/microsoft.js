const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const { URL } = require('url');

const MICROSOFT_CLIENT_ID = '00000000441cc96b';
const XSTS_RELYING_PARTY = 'rp://api.minecraftservices.com';

class MicrosoftAuthManager {
  constructor(config) {
    this.config = config;
    this.tokens = {
      accessToken: null,
      xstsToken: null,
      bedrockToken: null,
      refreshToken: null,
      expiresAt: null,
    };
    this.authData = null;
    this.offlineMode = false;

    const configDir = process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME);
    this.tokenPath = path.join(configDir, '.config', 'bedrock-companion', 'auth.json');
  }

  async initialize() {
    await this.loadStoredTokens();
  }

  async loadStoredTokens() {
    try {
      const data = await fs.readFile(this.tokenPath, 'utf8');
      const stored = JSON.parse(data);

      this.tokens.refreshToken = stored.refreshToken;
      this.tokens.accessToken = stored.accessToken;
      this.tokens.xstsToken = stored.xstsToken;
      this.tokens.bedrockToken = stored.bedrockToken;
      this.tokens.expiresAt = stored.expiresAt;

      if (stored.authData) {
        this.authData = stored.authData;
      }
    } catch (e) {
      // No stored tokens
    }
  }

  async saveTokens() {
    try {
      const dir = path.dirname(this.tokenPath);
      await fs.mkdir(dir, { recursive: true });

      const data = JSON.stringify({
        refreshToken: this.tokens.refreshToken,
        accessToken: this.tokens.accessToken,
        xstsToken: this.tokens.xstsToken,
        bedrockToken: this.tokens.bedrockToken,
        expiresAt: this.tokens.expiresAt,
        authData: this.authData,
      }, null, 2);

      await fs.writeFile(this.tokenPath, data, 'utf8');
    } catch (e) {
      console.error('Failed to save tokens:', e.message);
    }
  }

  async authenticate() {
    const mode = this.config.auth?.mode || 'offline';

    switch (mode) {
      case 'offline':
        return this.offlineAuth();

      case 'microsoft':
      case 'token':
        try {
          return await this.microsoftAuth();
        } catch (e) {
          console.error(`Microsoft auth failed: ${e.message}`);
          console.error('Use --offline flag for offline mode');
          throw new Error('Authentication failed. Use offline mode for local testing.');
        }

      default:
        throw new Error(`Unknown auth mode: ${mode}. Use 'offline', 'microsoft', or 'token'.`);
    }
  }

  offlineAuth() {
    if (!this.config.auth?.username) {
      throw new Error('Username required for offline mode. Set auth.username in config.');
    }

    console.log('[Auth] Using offline mode (local server only)');

    return {
      username: this.config.auth.username,
      identity: '00000000-0000-0000-0000-000000000000',
      xuid: '0',
      type: 'offline',
      token: null,
    };
  }

  async microsoftAuth() {
    // Check if we have valid tokens
    if (this.tokens.refreshToken && !this.isTokenExpired()) {
      try {
        await this.refreshTokensIfNeeded();
        return this.authData;
      } catch (e) {
        console.warn('Token refresh failed, attempting full re-auth:', e.message);
      }
    }

    // No valid tokens - need to get new ones
    if (!this.tokens.refreshToken) {
      console.log('[Auth] No stored refresh token found.');
      console.log('[Auth] To authenticate with Microsoft:');
      console.log('  1. Get a refresh token using the OAuth flow');
      console.log('  2. Save it to the auth.json file');
      console.log('');
      console.log('Alternatively, set auth.mode to "offline" in config for local server testing.');
      console.log('');
      throw new Error('No authentication token. Run with microsoft auth or use offline mode.');
    }

    await this.refreshTokensIfNeeded();
    return this.authData;
  }

  isTokenExpired() {
    if (!this.tokens.expiresAt) return true;
    return Date.now() >= this.tokens.expiresAt - 60000;
  }

  async refreshTokensIfNeeded() {
    if (!this.isTokenExpired() && this.authData) {
      return;
    }

    if (!this.tokens.refreshToken) {
      throw new Error('No refresh token available');
    }

    await this.refreshTokens();
  }

  async refreshTokens() {
    console.log('[Auth] Refreshing access token...');

    const response = await this.httpPost(
      'https://login.live.com/oauth20_token.srf',
      new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        refresh_token: this.tokens.refreshToken,
        grant_type: 'refresh_token',
        scope: 'service::user.auth.xboxlive.com::MBI_SSL',
      }).toString(),
      { 'Content-Type': 'application/x-www-form-urlencoded' }
    );

    const data = JSON.parse(response);

    if (data.error) {
      throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
    }

    this.tokens.accessToken = data.access_token;
    this.tokens.refreshToken = data.refresh_token || this.tokens.refreshToken;
    this.tokens.expiresAt = Date.now() + (data.expires_in * 1000);

    await this.getXSTS();
    await this.getBedrockToken();
    await this.saveTokens();

    console.log('[Auth] Tokens refreshed successfully');
  }

  async getXSTS() {
    console.log('[Auth] Obtaining XSTS token...');

    const requestBody = JSON.stringify({
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [this.tokens.accessToken],
      },
      RelyingParty: XSTS_RELYING_PARTY,
      TokenType: 'JWT',
    });

    const response = await this.httpPost(
      'https://xsts.auth.xboxlive.com/xsts/authorize',
      requestBody,
      { 'Content-Type': 'application/json' }
    );

    const data = JSON.parse(response);

    if (data.ErrorCode && data.ErrorCode !== 'OK') {
      throw new Error(`XSTS failed: ${data.ErrorMessage || data.ErrorCode}`);
    }

    this.tokens.xstsToken = data.Token;

    console.log('[Auth] XSTS token obtained');
  }

  async getBedrockToken() {
    console.log('[Auth] Obtaining Bedrock login token...');

    const requestBody = JSON.stringify({
      platform: 'iOS',
      token: this.tokens.xstsToken,
    });

    const response = await this.httpPost(
      'https://pocket-login.minecraft.net/brand-connection/v1/exchange',
      requestBody,
      { 'Content-Type': 'application/json' }
    );

    const data = JSON.parse(response);

    if (!data.token) {
      throw new Error('Failed to get Bedrock token from server');
    }

    this.tokens.bedrockToken = data.token;

    this.authData = {
      username: data.identityToken.displayName,
      identity: data.identityToken.identity,
      xuid: data.identityToken.xuid,
      type: 'microsoft',
      token: data.token,
    };

    console.log(`[Auth] Logged in as: ${this.authData.username}`);
  }

  httpPost(urlString, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  clearTokens() {
    this.tokens = {
      accessToken: null,
      xstsToken: null,
      bedrockToken: null,
      refreshToken: null,
      expiresAt: null,
    };
    this.authData = null;

    fs.unlink(this.tokenPath).catch(() => {});
  }

  getCurrentAuth() {
    return this.authData;
  }

  isAuthenticated() {
    return this.authData !== null && !this.isTokenExpired();
  }

  hasStoredTokens() {
    return this.tokens.refreshToken !== null;
  }
}

module.exports = { MicrosoftAuthManager, MICROSOFT_CLIENT_ID };