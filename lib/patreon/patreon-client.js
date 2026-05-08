/**
 * Minimal Patreon Creator API v2 client.
 *
 * Uses a Patreon-issued *Creator's Access Token* (no per-user OAuth flow).
 * Generate one at https://www.patreon.com/portal/registration/register-clients
 * — the same token works for the creator's own campaign indefinitely (or until
 * they rotate it).
 *
 * Endpoint reference:
 *   https://docs.patreon.com/#fetch-a-campaign-39-s-members-and-tiers
 */

import { createHttpClient } from '../http-client.js';
import { getErrorDetails } from '../errors/error-formatter.js';

const PATREON_API_BASE = 'https://www.patreon.com';

// Pagination cap. We hard-stop after this many pages to avoid runaway loops if
// Patreon ever returns a self-referential cursor.
const MAX_PAGES = 100;

/**
 * Fetches a single page of members.
 * @returns {Promise<{data: Array, included: Array, nextCursor: string|null}>}
 */
async function fetchMembersPage(httpClient, accessToken, campaignId, cursor = null) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'whatseerr/1.0 (+https://github.com/crios-app/whatseerr)'
  };

  const query = {
    include: 'user,currently_entitled_tiers',
    'fields[member]': 'email,patron_status,full_name',
    'fields[user]': 'email,full_name',
    'fields[tier]': 'title',
    'page[count]': 200
  };
  if (cursor) {
    query['page[cursor]'] = cursor;
  }

  const res = await httpClient.request(
    'GET',
    `api/oauth2/v2/campaigns/${encodeURIComponent(campaignId)}/members`,
    { headers, query }
  );

  if (res.status === 401 || res.status === 403) {
    const err = new Error(`Patreon auth failed (HTTP ${res.status}). Check patreon.accessToken.`);
    err.status = res.status;
    throw err;
  }
  if (res.status !== 200) {
    const snippet = typeof res.data === 'string'
      ? res.data.slice(0, 300)
      : JSON.stringify(res.data || {}).slice(0, 300);
    const err = new Error(`Patreon members fetch failed: HTTP ${res.status} ${snippet}`);
    err.status = res.status;
    throw err;
  }

  const data = Array.isArray(res.data?.data) ? res.data.data : [];
  const included = Array.isArray(res.data?.included) ? res.data.included : [];
  const nextLink = res.data?.links?.next || null;
  let nextCursor = null;
  if (nextLink) {
    try {
      const u = new URL(nextLink);
      nextCursor = u.searchParams.get('page[cursor]');
    } catch {
      // ignore — we'll fall back to meta.pagination
    }
  }
  if (!nextCursor) {
    nextCursor = res.data?.meta?.pagination?.cursors?.next || null;
  }

  return { data, included, nextCursor };
}

/**
 * Walks all pages and returns a flat list of active patrons with their tier
 * titles. Each entry: { email, patronStatus, fullName, tierTitles: string[], patreonUserId }
 *
 * "Active" excludes `declined_patron` and `former_patron` — only `active_patron`
 * counts (declined card / former patron should not have access).
 */
export async function fetchActivePatrons(cfg, logger) {
  const accessToken = cfg.patreon?.accessToken;
  const campaignId = cfg.patreon?.campaignId;
  if (!accessToken || !campaignId) {
    throw new Error('patreon.accessToken and patreon.campaignId must be set');
  }

  const httpClient = createHttpClient(PATREON_API_BASE);

  const results = [];
  let cursor = null;
  let page = 0;
  while (page < MAX_PAGES) {
    page++;
    let pageResult;
    try {
      pageResult = await fetchMembersPage(httpClient, accessToken, campaignId, cursor);
    } catch (err) {
      logger?.error('Failed to fetch Patreon members page', {
        ...getErrorDetails(err, 'fetchMembersPage'),
        page,
        cursor
      });
      throw err;
    }

    // Build a tierId -> title lookup from included tiers on this page.
    const tierTitleById = new Map();
    for (const inc of pageResult.included) {
      if (inc.type === 'tier') {
        const title = inc.attributes?.title;
        if (typeof title === 'string' && title.trim()) {
          tierTitleById.set(inc.id, title.trim());
        }
      }
    }
    // user[id] -> email map for fallback lookup
    const userById = new Map();
    for (const inc of pageResult.included) {
      if (inc.type === 'user') {
        userById.set(inc.id, {
          email: inc.attributes?.email || null,
          fullName: inc.attributes?.full_name || null
        });
      }
    }

    for (const member of pageResult.data) {
      if (member.type !== 'member') continue;
      const attrs = member.attributes || {};
      if (attrs.patron_status !== 'active_patron') continue;

      const tierIds = (member.relationships?.currently_entitled_tiers?.data || [])
        .map(t => t?.id)
        .filter(Boolean);
      const tierTitles = tierIds
        .map(id => tierTitleById.get(id))
        .filter(Boolean);

      // No active tier (e.g. free follower) — not relevant for gating.
      if (tierTitles.length === 0) continue;

      const userRef = member.relationships?.user?.data;
      const userInfo = userRef?.id ? userById.get(userRef.id) : null;

      results.push({
        patreonMemberId: member.id,
        patreonUserId: userRef?.id || null,
        email: (attrs.email || userInfo?.email || '').toLowerCase().trim() || null,
        fullName: attrs.full_name || userInfo?.fullName || null,
        tierTitles
      });
    }

    cursor = pageResult.nextCursor;
    if (!cursor) break;
  }

  if (page >= MAX_PAGES) {
    logger?.warn(`Stopped paging Patreon members at the safety cap of ${MAX_PAGES} pages`, {
      collected: results.length
    });
  }

  return results;
}
