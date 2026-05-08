/**
 * Patreon OAuth helpers — used by the `link` command and the
 * `/patreon/callback` endpoint to verify a WhatsApp number actually
 * controls a given Patreon account.
 *
 * Flow:
 *   1. `buildAuthUrl(state)` — produces the URL we send the patron.
 *      They visit it, click "Allow", and Patreon redirects them to our
 *      callback with `?code=...&state=...`.
 *   2. `exchangeCode(code)` — server-to-server POST that swaps the code
 *      for a short-lived OAuth access token.
 *   3. `fetchIdentity(token)` — uses that token to read the patron's
 *      Patreon user id and email. We discard the OAuth token afterwards;
 *      the tier check itself uses the long-lived Creator access token.
 */

import https from 'https';
import { URL } from 'url';

const PATREON_AUTH_URL = 'https://www.patreon.com/oauth2/authorize';
const PATREON_TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';
const PATREON_IDENTITY_URL = 'https://www.patreon.com/api/oauth2/v2/identity';

// `identity` lets us read the user's id; `identity[email]` adds their email.
// We don't need `identity.memberships` here because the membership lookup
// happens against the campaign-wide cache (which is more authoritative for
// `currently_entitled_tiers`).
const SCOPES = 'identity identity[email]';

function requireOauthCfg(cfg) {
  const { clientId, clientSecret, redirectUri } = cfg.patreon || {};
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('patreon.clientId, patreon.clientSecret and patreon.redirectUri must all be set to use the OAuth link flow');
  }
  return { clientId, clientSecret, redirectUri };
}

export function isOauthConfigured(cfg) {
  return !!(cfg.patreon?.clientId && cfg.patreon?.clientSecret && cfg.patreon?.redirectUri);
}

/**
 * Build the authorization URL the patron clicks.
 */
export function buildAuthUrl(cfg, state) {
  const { clientId, redirectUri } = requireOauthCfg(cfg);
  const u = new URL(PATREON_AUTH_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('state', state);
  return u.toString();
}

/**
 * Minimal HTTPS POST helper that returns { status, body } where body is
 * either parsed JSON or the raw string. We don't use the project's shared
 * `http-client.js` because it doesn't support form-encoded bodies.
 */
function postFormEncoded(url, formObj) {
  const body = new URLSearchParams(formObj).toString();
  const target = new URL(url);
  const opts = {
    method: 'POST',
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      Accept: 'application/json',
      'User-Agent': 'whatseerr/1.0 (+https://github.com/crios-app/whatseerr)'
    }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : null; }
        catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getJson(url, accessToken) {
  const target = new URL(url);
  const opts = {
    method: 'GET',
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'whatseerr/1.0 (+https://github.com/crios-app/whatseerr)'
    }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : null; }
        catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Exchange the one-time `code` from the redirect for a short-lived OAuth
 * access token.
 */
export async function exchangeCode(cfg, code) {
  const { clientId, clientSecret, redirectUri } = requireOauthCfg(cfg);
  const res = await postFormEncoded(PATREON_TOKEN_URL, {
    code,
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri
  });
  if (res.status !== 200 || !res.body?.access_token) {
    const snippet = typeof res.body === 'string'
      ? res.body.slice(0, 300)
      : JSON.stringify(res.body || {}).slice(0, 300);
    const err = new Error(`Patreon token exchange failed: HTTP ${res.status} ${snippet}`);
    err.status = res.status;
    throw err;
  }
  return res.body.access_token;
}

/**
 * Fetch the patron's Patreon user id + email using the OAuth access token.
 */
export async function fetchIdentity(accessToken) {
  const url = new URL(PATREON_IDENTITY_URL);
  url.searchParams.set('fields[user]', 'email,full_name');
  const res = await getJson(url.toString(), accessToken);
  if (res.status !== 200 || !res.body?.data?.id) {
    const snippet = typeof res.body === 'string'
      ? res.body.slice(0, 300)
      : JSON.stringify(res.body || {}).slice(0, 300);
    const err = new Error(`Patreon identity fetch failed: HTTP ${res.status} ${snippet}`);
    err.status = res.status;
    throw err;
  }
  const data = res.body.data;
  return {
    patreonUserId: String(data.id),
    email: (data.attributes?.email || '').toLowerCase().trim() || null,
    fullName: data.attributes?.full_name || null
  };
}
