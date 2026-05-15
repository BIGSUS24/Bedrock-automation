'use strict';

/**
 * xsts.js — Xbox Live + XSTS Token Exchange
 *
 * Flow:
 *   MS Access Token → XBL Token (user hash + XBL token)
 *               → XSTS Token (relying party = Bedrock services)
 *
 * Error codes for XSTS:
 *   2148916233 → Account has no Xbox profile
 *   2148916235 → Xbox Live is banned in the user's region
 *   2148916236/7 → Adult verification required
 *   2148916238 → Child account — parental consent required
 */

const https = require('https');
const { URL } = require('url');

const XBL_URL  = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';

const BEDROCK_RELYING_PARTY = 'https://multiplayer.minecraft.net/';

const XSTS_ERROR_MESSAGES = {
  2148916233: 'This Microsoft account does not have an Xbox profile. Please create one at xbox.com.',
  2148916235: 'Xbox Live is not available in your region.',
  2148916236: 'Adult verification required on your Xbox account.',
  2148916237: 'Adult verification required on your Xbox account.',
  2148916238: 'This account belongs to a child and requires parental consent for Minecraft.',
};

class XSTSManager {
  /**
   * Exchange a Microsoft access token for an XSTS token.
   * Returns { xblToken, xblUserHash, xstsToken, xstsUserHash }
   *
   * @param {string} msAccessToken
   * @returns {Promise<{ xblToken: string, xblUserHash: string, xstsToken: string, xstsUserHash: string }>}
   */
  static async exchange(msAccessToken) {
    const xbl  = await this._getXBLToken(msAccessToken);
    const xsts = await this._getXSTSToken(xbl.token);

    return {
      xblToken:     xbl.token,
      xblUserHash:  xbl.userHash,
      xstsToken:    xsts.token,
      xstsUserHash: xsts.userHash,
    };
  }

  static async _getXBLToken(msAccessToken) {
    const body = JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName:   'user.auth.xboxlive.com',
        RpsTicket:  `t=${msAccessToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType:    'JWT',
    });

    const data = await httpPostJson(XBL_URL, body);

    if (!data.Token) {
      throw new Error(`XBL auth failed: ${JSON.stringify(data)}`);
    }

    const userHash = data.DisplayClaims?.xui?.[0]?.uhs;
    if (!userHash) {
      throw new Error('XBL response missing user hash (uhs)');
    }

    return { token: data.Token, userHash };
  }

  static async _getXSTSToken(xblToken) {
    const body = JSON.stringify({
      Properties: {
        SandboxId:  'RETAIL',
        UserTokens: [xblToken],
      },
      RelyingParty: BEDROCK_RELYING_PARTY,
      TokenType:    'JWT',
    });

    const data = await httpPostJson(XSTS_URL, body);

    if (data.XErr) {
      const known = XSTS_ERROR_MESSAGES[data.XErr];
      throw new Error(known || `XSTS error ${data.XErr}: ${data.Message || 'Unknown error'}`);
    }

    if (!data.Token) {
      throw new Error(`XSTS auth failed: ${JSON.stringify(data)}`);
    }

    const userHash = data.DisplayClaims?.xui?.[0]?.uhs;
    if (!userHash) {
      throw new Error('XSTS response missing user hash (uhs)');
    }

    return { token: data.Token, userHash };
  }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpPostJson(urlString, body) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlString);
    const bodyBuf = Buffer.from(body, 'utf8');

    const req = https.request({
      hostname: url.hostname,
      port:     443,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': bodyBuf.length,
        Accept:           'application/json',
        'x-xbl-contract-version': '0',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Non-JSON response from ${urlString} (HTTP ${res.statusCode}): ${data}`)); }
      });
    });

    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

module.exports = { XSTSManager, BEDROCK_RELYING_PARTY };
