'use strict';

/**
 * device_code.js — Microsoft OAuth 2.0 Device Code Flow
 *
 * Flow:
 *   1. POST /devicecode → get user_code + device_code + polling interval
 *   2. Show user_code to user with verification_uri
 *   3. Poll /token every `interval` seconds until:
 *      - authorization_pending → keep waiting
 *      - slow_down             → increase interval by 5s
 *      - access_token          → success
 *      - error                 → fail
 *
 * Client ID: Microsoft's public Minecraft client (no secret needed)
 */

const https = require('https');
const { URL, URLSearchParams } = require('url');

const CLIENT_ID = '00000000441cc96b';
const SCOPE     = 'service::user.auth.xboxlive.com::MBI_SSL';

const DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf';
const TOKEN_URL       = 'https://login.live.com/oauth20_token.srf';

const MAX_POLL_SECONDS = 900; // 15 minutes

class DeviceCodeFlow {
  /**
   * Start the device code flow.
   * Calls `onCode({ user_code, verification_uri, expires_in })` when the code is ready.
   * Returns { access_token, refresh_token, expires_in } on success.
   *
   * @param {Function} onCode  Called once with the device code info to show the user
   * @returns {Promise<{ access_token: string, refresh_token: string, expires_in: number }>}
   */
  static async authenticate(onCode) {
    const deviceData = await this._requestDeviceCode();
    onCode({
      user_code:        deviceData.user_code,
      verification_uri: deviceData.verification_uri,
      expires_in:       deviceData.expires_in,
    });

    return this._pollForToken(deviceData.device_code, deviceData.interval || 5);
  }

  static async _requestDeviceCode() {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      scope:     SCOPE,
      response_type: 'device_code',
    }).toString();

    const res = await httpPost(DEVICE_CODE_URL, body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    if (res.error) {
      throw new Error(`Device code request failed: ${res.error_description || res.error}`);
    }

    return res;
  }

  static async _pollForToken(deviceCode, intervalSecs) {
    const body = new URLSearchParams({
      client_id:   CLIENT_ID,
      grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    }).toString();

    const deadline = Date.now() + MAX_POLL_SECONDS * 1000;
    let pollInterval = intervalSecs * 1000;

    while (Date.now() < deadline) {
      await sleep(pollInterval);

      let res;
      try {
        res = await httpPost(TOKEN_URL, body, {
          'Content-Type': 'application/x-www-form-urlencoded',
        });
      } catch (e) {
        throw new Error(`Token poll HTTP error: ${e.message}`);
      }

      if (res.access_token) {
        return {
          access_token:  res.access_token,
          refresh_token: res.refresh_token,
          expires_in:    res.expires_in,
        };
      }

      switch (res.error) {
        case 'authorization_pending':
          break; // keep polling
        case 'slow_down':
          pollInterval += 5000;
          break;
        case 'authorization_declined':
          throw new Error('User declined authorization');
        case 'expired_token':
          throw new Error('Device code expired. Please restart authentication.');
        default:
          throw new Error(`Token poll error: ${res.error_description || res.error}`);
      }
    }

    throw new Error('Device code authentication timed out after 15 minutes');
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function httpPost(urlString, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const bodyBuf = Buffer.from(body, 'utf8');

    const req = https.request({
      hostname: url.hostname,
      port:     443,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': bodyBuf.length,
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ error: 'parse_error', error_description: data });
        }
      });
    });

    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { DeviceCodeFlow, CLIENT_ID };
