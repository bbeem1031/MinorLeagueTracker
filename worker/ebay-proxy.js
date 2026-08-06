/**
 * MiLB Card Tracker — eBay Browse API Proxy
 * Cloudflare Worker
 *
 * Uses eBay Browse API (not Finding API — Finding API blocks datacenter IPs).
 * Searches specifically for Bowman Chrome auto sold/active listings.
 * Returns separate raw auto and PSA 10 price arrays.
 *
 * Required secrets (wrangler secret put):
 *   EBAY_CLIENT_ID      — App ID from eBay developer dashboard
 *   EBAY_CLIENT_SECRET  — Cert ID from eBay developer dashboard
 *
 * Optional vars (wrangler.toml):
 *   ALLOWED_ORIGIN      — your GitHub Pages domain
 *   EBAY_ENVIRONMENT    — "production" or "sandbox"
 */

let cachedToken = null;
let tokenExpiry = 0;

const EBAY_HOSTS = {
  production: {
    auth:   'https://api.ebay.com/identity/v1/oauth2/token',
    browse: 'https://api.ebay.com/buy/browse/v1',
  },
  sandbox: {
    auth:   'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
    browse: 'https://api.sandbox.ebay.com/buy/browse/v1',
  },
};

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }

    const url   = new URL(request.url);
    const query = url.searchParams.get('q');
    const mock  = url.searchParams.get('mock') === 'true';

    if (!query || query.trim().length < 2) {
      return jsonResponse({ error: 'Missing q parameter' }, 400, origin);
    }

    // Mock mode — no eBay credentials needed
    if (mock || !env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
      return jsonResponse(generateMockSoldListings(query), 200, origin);
    }

    try {
      const environment = env.EBAY_ENVIRONMENT || 'production';
      const hosts       = EBAY_HOSTS[environment] || EBAY_HOSTS.production;
      const token       = await getToken(env, hosts);

      // Run raw and PSA 10 searches in parallel
      const [rawResults, psa10Results] = await Promise.all([
        searchBrowse(query, 'raw',   token, hosts),
        searchBrowse(query, 'psa10', token, hosts),
      ]);

      return jsonResponse({
        raw:    rawResults,
        psa10:  psa10Results,
        source: 'ebay_live',
        query,
      }, 200, origin);

    } catch (err) {
      console.error('eBay error:', err.message);
      return jsonResponse({ error: err.message, raw: [], psa10: [], source: 'error' }, 502, origin);
    }
  },
};

// ─── OAuth Token ─────────────────────────────────────────────────────────────

async function getToken(env, hosts) {
  const BUFFER = 5 * 60 * 1000;
  if (cachedToken && Date.now() < tokenExpiry - BUFFER) return cachedToken;

  const credentials = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const res = await fetch(hosts.auth, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });

  if (!res.ok) throw new Error(`Token error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('No access_token in response');

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

// ─── Browse API Search ────────────────────────────────────────────────────────

/**
 * Searches eBay Browse API for Bowman Chrome auto listings.
 *
 * Browse API searches active + recently sold listings.
 * We filter to Sports Trading Cards category (261328) and
 * use specific keyword patterns to target Bowman Chrome autos only.
 *
 * Raw:   "{playerName}" "bowman chrome" "auto" -PSA -BGS -SGC -redemption -lot
 * PSA10: "{playerName}" "bowman chrome" "auto" "PSA 10"
 *
 * GET /buy/browse/v1/item_summary/search
 *   ?q={keywords}
 *   &category_ids=261328
 *   &sort=newlyListed
 *   &limit=20
 */
async function searchBrowse(playerName, type, token, hosts) {
  const keywords = type === 'psa10'
    ? `"${playerName}" "bowman chrome" auto "PSA 10"`
    : `"${playerName}" "bowman chrome" auto -PSA -BGS -SGC -redemption -lot -reprint`;

  const params = new URLSearchParams({
    q:            keywords,
    category_ids: '261328',   // Sports Trading Cards
    sort:         'newlyListed',
    limit:        '20',
  });

  const res = await fetch(`${hosts.browse}/item_summary/search?${params}`, {
    headers: {
      'Authorization':            `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID':  'EBAY_US',
      'Content-Type':             'application/json',
    },
  });

  if (!res.ok) throw new Error(`Browse API ${res.status}: ${await res.text()}`);
  const data  = await res.json();
  const items = data.itemSummaries || [];

  return items
    .filter(item => !isNoise(item, type))
    .map(item => normalizeItem(item, type))
    .filter(item => item.price > 0)
    .slice(0, 15);
}

function isNoise(item, type) {
  const title = (item.title || '').toUpperCase();
  if (/\bLOT\b|\d+\s*CARDS?\b/.test(title))       return true;
  if (/REPRINT|REPLICA|CUSTOM|FAKE/.test(title))   return true;
  if (/REDEMPTION(?!\s*REDEEMED)/.test(title))     return true;
  if (type === 'raw' && /\bPSA\b|\bBGS\b|\bSGC\b|\bCSG\b/.test(title)) return true;
  if (type === 'psa10' && !/PSA\s*10/.test(title)) return true;
  return false;
}

function normalizeItem(item, type) {
  return {
    title:    item.title || '',
    price:    parseFloat(item.price?.value || 0),
    type,
    parallel: extractParallel(item.title || ''),
    date:     item.itemCreationDate || null,
    itemUrl:  item.itemWebUrl || '',
  };
}

function extractParallel(title) {
  const t = title.toUpperCase();
  if (/SUPERFRACTOR/.test(t))          return 'Superfractor 1/1';
  if (/BLACK\s*REFRACTOR/.test(t))     return 'Black Refractor';
  if (/ORANGE\s*REFRACTOR/.test(t))    return 'Orange Refractor';
  if (/RED\s*REFRACTOR/.test(t))       return 'Red Refractor';
  if (/GOLD\s*REFRACTOR/.test(t))      return 'Gold Refractor';
  if (/PURPLE\s*REFRACTOR/.test(t))    return 'Purple Refractor';
  if (/BLUE\s*REFRACTOR/.test(t))      return 'Blue Refractor';
  if (/GREEN\s*REFRACTOR/.test(t))     return 'Green Refractor';
  if (/ATOMIC\s*REFRACTOR/.test(t))    return 'Atomic Refractor';
  if (/\bREFRACTOR\b/.test(t))         return 'Refractor';
  if (/SAPPHIRE/.test(t))              return 'Sapphire';
  if (/1ST\s*(BOWMAN|AUTO)/.test(t))   return '1st Bowman';
  return 'Base';
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

function generateMockSoldListings(playerName) {
  const seed    = playerName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng     = seededRandom(seed);
  const baseRaw = 15 + (seed % 60);
  const basePsa = baseRaw * (4 + rng());

  const parallels = ['Base', 'Refractor', 'Blue Refractor', 'Gold Refractor', 'Orange Refractor'];
  const parallelMult = { Base: 1, Refractor: 1.5, 'Blue Refractor': 2, 'Gold Refractor': 4, 'Orange Refractor': 6 };
  const now = Date.now();

  const makeItems = (basePrice, type, count) =>
    Array.from({ length: count }, (_, i) => {
      const daysAgo  = Math.floor(rng() * 45);
      const jitter   = 0.75 + rng() * 0.50;
      const parallel = type === 'psa10' ? 'Base' : parallels[Math.floor(rng() * parallels.length)];
      const mult     = type === 'raw' ? (parallelMult[parallel] || 1) : 1;
      return {
        title:   `${playerName} Bowman Chrome Auto ${parallel}${type === 'psa10' ? ' PSA 10' : ''}`.trim(),
        price:   parseFloat((basePrice * jitter * mult).toFixed(2)),
        type,
        parallel,
        date:    new Date(now - daysAgo * 86_400_000).toISOString(),
        itemUrl: `https://www.ebay.com/itm/${1234567890 + seed + i}`,
      };
    }).sort((a, b) => new Date(b.date) - new Date(a.date));

  return {
    raw:    makeItems(baseRaw,  'raw',   12),
    psa10:  makeItems(basePsa, 'psa10', 10),
    source: 'mock',
    query:  playerName,
  };
}

function seededRandom(seed) {
  let s = seed;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
