/**
 * MiLB Card Tracker — eBay Browse API Proxy
 * Cloudflare Worker
 *
 * Responsibility:
 *   - Keep the eBay OAuth token server-side (never exposed to the browser)
 *   - Auto-refresh the token when it expires (eBay tokens last ~2 hours)
 *   - Forward player name searches to eBay Browse API
 *   - Return clean, normalized JSON to the browser
 *   - Add CORS headers so the GitHub Pages frontend can call this
 *
 * Required environment variables (set via `wrangler secret put`, NOT wrangler.toml):
 *   EBAY_CLIENT_ID      — from eBay developer dashboard → Application Keys
 *   EBAY_CLIENT_SECRET  — from eBay developer dashboard → Application Keys
 *
 * Optional environment variables (set in wrangler.toml [vars]):
 *   ALLOWED_ORIGIN      — restrict CORS to your GitHub Pages domain
 *                         e.g. "https://yourusername.github.io"
 *                         Defaults to "*" (any origin) if not set
 *   EBAY_ENVIRONMENT    — "production" or "sandbox" (defaults to production)
 *
 * Deploy:
 *   wrangler deploy
 *
 * Local dev (mock mode — no eBay account needed):
 *   wrangler dev
 *   Then call: GET http://localhost:8787/?q=Jackson+Holliday&mock=true
 */

// ─── Module-level token cache ───────────────────────────────────────────────
// Lives for the lifetime of this Worker isolate (typically minutes to hours).
// Cloudflare spins up new isolates as needed, so this is best-effort caching.
// For production with high traffic, upgrade to KV storage (see comment below).
let cachedToken  = null;
let tokenExpiry  = 0;       // Unix ms timestamp when token expires

// ─── eBay API base URLs ─────────────────────────────────────────────────────
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

// ─── Main handler ───────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    // Only allow GET requests
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }

    const url    = new URL(request.url);
    const query  = url.searchParams.get('q');
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || '10'), 20);
    const mock   = url.searchParams.get('mock') === 'true';

    if (!query || query.trim().length < 2) {
      return jsonResponse({ error: 'Missing or invalid q parameter' }, 400, origin);
    }

    // ── Mock mode (use while waiting for eBay developer approval) ─────────
    // Returns realistic-looking price data generated from the player name.
    // Remove this block once your eBay developer account is approved.
    if (mock || !env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
      const mockData = generateMockListings(query, limit);
      return jsonResponse(mockData, 200, origin);
    }

    // ── Live eBay API mode ─────────────────────────────────────────────────
    try {
      const environment = env.EBAY_ENVIRONMENT || 'production';
      const hosts       = EBAY_HOSTS[environment] || EBAY_HOSTS.production;

      // Step 1: Get a valid OAuth token (cached or freshly fetched)
      const token = await getToken(env, hosts);

      // Step 2: Search eBay Browse API for completed/active card listings
      const results = await searchEbay(query, limit, token, hosts);

      return jsonResponse(results, 200, origin);

    } catch (err) {
      console.error('eBay proxy error:', err.message);
      // Return error details in development, generic message in production
      const msg = env.ENVIRONMENT === 'development' ? err.message : 'eBay search failed';
      return jsonResponse({ error: msg, items: [], total: 0 }, 502, origin);
    }
  },
};

// ─── OAuth Token Management ─────────────────────────────────────────────────

/**
 * Returns a valid eBay OAuth access token, refreshing if expired.
 *
 * eBay uses the Client Credentials grant for app-level access (no user login).
 * POST https://api.ebay.com/identity/v1/oauth2/token
 *   Authorization: Basic base64(clientId:clientSecret)
 *   Body: grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope
 *
 * Token lifetime is typically 7,200 seconds (2 hours).
 * We refresh 5 minutes early to avoid serving with an about-to-expire token.
 *
 * For high-traffic deployments: store cachedToken/tokenExpiry in Cloudflare KV
 * so the cache survives isolate restarts:
 *   await env.KV.put('ebay_token', token, { expirationTtl: expiresIn - 300 });
 */
async function getToken(env, hosts) {
  const BUFFER_MS = 5 * 60 * 1000; // 5 min early refresh buffer

  if (cachedToken && Date.now() < tokenExpiry - BUFFER_MS) {
    return cachedToken; // Still valid
  }

  // Build Basic auth header: base64(clientId:clientSecret)
  const credentials = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);

  const res = await fetch(hosts.auth, {
    method: 'POST',
    headers: {
      'Authorization':  `Basic ${credentials}`,
      'Content-Type':   'application/x-www-form-urlencoded',
    },
    // scope must be URL-encoded
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`eBay token error ${res.status}: ${body}`);
  }

  const data = await res.json();

  if (!data.access_token) {
    throw new Error('eBay token response missing access_token');
  }

  // Cache the token in module scope
  cachedToken  = data.access_token;
  tokenExpiry  = Date.now() + (data.expires_in * 1000);

  return cachedToken;
}

// ─── eBay Browse API Search ─────────────────────────────────────────────────

/**
 * Searches eBay for baseball card listings matching a player name.
 *
 * Endpoint: GET /buy/browse/v1/item_summary/search
 *   q        = "Jackson Holliday rookie card"
 *   filter   = buyingOptions:{FIXED_PRICE}   → buy-it-now listings
 *   sort     = newlyListed                   → most recent first
 *   limit    = 10
 *   category_ids = 261328                    → Sports Trading Cards category
 *
 * Note: The Browse API returns ACTIVE listings, not completed/sold ones.
 * The completed listings API (Finding API) uses a different auth scheme.
 * Active listing prices are a strong proxy for current market value.
 * We label these as "Current Listings" in the UI, not "Sold Prices".
 *
 * Response items are normalized to our internal shape before returning.
 */
async function searchEbay(playerName, limit, token, hosts) {
  const query = encodeURIComponent(`${playerName} rookie card`);

  // Category 261328 = Sports Trading Cards on eBay
  const url = `${hosts.browse}/item_summary/search`
    + `?q=${query}`
    + `&category_ids=261328`
    + `&filter=buyingOptions%3A%7BFIXED_PRICE%7D`  // URL-encoded {FIXED_PRICE}
    + `&sort=newlyListed`
    + `&limit=${limit}`;

  const res = await fetch(url, {
    headers: {
      'Authorization':              `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID':   'EBAY_US',
      'Content-Type':               'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`eBay Browse API ${res.status}: ${body}`);
  }

  const data = await res.json();
  const items = data.itemSummaries || [];

  return {
    total: data.total || 0,
    query: playerName,
    source: 'ebay_live',
    items: items.map(normalizeItem),
  };
}

/**
 * Normalizes a raw eBay item_summary object to our internal shape.
 * Keeps only what the frontend needs — strips bulky/sensitive fields.
 */
function normalizeItem(item) {
  return {
    title:       item.title         || '',
    price:       parseFloat(item.price?.value || 0),
    currency:    item.price?.currency || 'USD',
    condition:   item.condition     || '',
    conditionId: item.conditionId   || '',
    listingDate: item.itemCreationDate || null,
    itemWebUrl:  item.itemWebUrl    || '',
    imageUrl:    item.image?.imageUrl || null,
    seller:      item.seller?.username || '',
    // Derive a simple "grade" label from condition text
    grade: extractGrade(item.title, item.condition),
  };
}

/**
 * Extracts a card grade label from the item title or condition string.
 * Looks for PSA/BGS/SGC grade patterns.
 * Returns null if ungraded.
 */
function extractGrade(title = '', condition = '') {
  const text = `${title} ${condition}`.toUpperCase();

  // PSA grades: "PSA 10", "PSA10", "PSA GEM MT 10"
  const psaMatch = text.match(/PSA\s*(?:GEM\s*MT\s*)?(\d+(?:\.\d+)?)/);
  if (psaMatch) return `PSA ${psaMatch[1]}`;

  // BGS/Beckett grades: "BGS 9.5", "BECKETT 9"
  const bgsMatch = text.match(/(?:BGS|BECKETT)\s*(\d+(?:\.\d+)?)/);
  if (bgsMatch) return `BGS ${bgsMatch[1]}`;

  // SGC grades
  const sgcMatch = text.match(/SGC\s*(\d+)/);
  if (sgcMatch) return `SGC ${sgcMatch[1]}`;

  // Raw/ungraded
  if (text.includes('RAW') || condition.toLowerCase().includes('near mint')) return 'Raw NM';

  return null;
}

// ─── Mock Data Generator ─────────────────────────────────────────────────────

/**
 * Generates realistic-looking eBay listing data for UI development
 * while waiting for eBay developer account approval.
 *
 * Prices are seeded from the player name so the same player always
 * gets consistent mock prices (makes UI testing predictable).
 *
 * DELETE this function and the mock check in the main handler
 * once your eBay developer account is approved.
 */
function generateMockListings(playerName, count = 10) {
  // Simple deterministic seed from player name characters
  const seed = playerName.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const rng  = seededRandom(seed);

  // Base price scaled loosely by "fame" (longer name = more letters = more random)
  const basePrice = 8 + (seed % 80);

  const grades    = ['PSA 10', 'PSA 9', 'PSA 8', 'BGS 9.5', 'BGS 9', 'Raw NM', 'Raw', null];
  const gradeMult = [3.5,       1.8,     1.1,     2.8,        1.5,     0.9,      0.7,   0.8];
  const sets      = [
    'Topps Chrome Rookie Autograph',
    'Bowman Chrome 1st Prospect Auto',
    'Topps Chrome Update RC',
    'Bowman Draft Prospect',
    'Topps Series 1 Rookie Card',
    'Panini Prizm Draft Picks',
    'Topps Heritage Minor League RC',
    'Bowman Platinum Prospect',
  ];

  const now = Date.now();

  const items = Array.from({ length: count }, (_, i) => {
    const gradeIdx  = Math.floor(rng() * grades.length);
    const grade     = grades[gradeIdx];
    const mult      = gradeMult[gradeIdx];
    const setName   = sets[Math.floor(rng() * sets.length)];
    const priceJitter = 0.75 + rng() * 0.50; // ±25% variance
    const price     = parseFloat((basePrice * mult * priceJitter).toFixed(2));
    const daysAgo   = Math.floor(rng() * 30);
    const listDate  = new Date(now - daysAgo * 86_400_000).toISOString();
    const title     = `${playerName} ${setName} ${grade ? grade + ' ' : ''}Baseball Card`;
    const ebayId    = 1234567890 + seed + i;

    return {
      title,
      price,
      currency:    'USD',
      condition:   grade ? 'Graded' : 'Near Mint or Better',
      conditionId: grade ? '2750' : '3000',
      listingDate: listDate,
      itemWebUrl:  `https://www.ebay.com/itm/${ebayId}`,
      imageUrl:    null,
      seller:      'mock_seller',
      grade:       grade,
    };
  });

  // Sort by most recently listed
  items.sort((a, b) => new Date(b.listingDate) - new Date(a.listingDate));

  return {
    total:  count,
    query:  playerName,
    source: 'mock',      // Frontend uses this to show a "Mock data" badge
    items,
  };
}

/** Simple seeded pseudo-random number generator (mulberry32) */
function seededRandom(seed) {
  let s = seed;
  return function() {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}
