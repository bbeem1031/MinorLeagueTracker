/**
 * MiLB Card Tracker — eBay Finding API Proxy
 * Cloudflare Worker
 *
 * Switches from Browse API (active listings) to Finding API (sold listings only).
 * The Finding API uses App ID directly — no OAuth token refresh needed.
 *
 * Runs two parallel searches per player:
 *   1. Raw Bowman Chrome auto (no grading companies in title)
 *   2. PSA 10 Bowman Chrome auto
 *
 * Required environment variables (set via `wrangler secret put`):
 *   EBAY_APP_ID   — your eBay App ID (Client ID) from developer dashboard
 *
 * Optional (set in wrangler.toml [vars]):
 *   ALLOWED_ORIGIN      — your GitHub Pages domain
 *   EBAY_ENVIRONMENT    — "production" or "sandbox"
 *
 * Deploy:   wrangler deploy --name milb-card-proxy
 * Secrets:  wrangler secret put EBAY_APP_ID
 */

// ─── eBay Finding API endpoints ─────────────────────────────────────────────
const FINDING_HOSTS = {
  production: 'https://svcs.ebay.com/services/search/FindingService/v1',
  sandbox:    'https://svcs.sandbox.ebay.com/services/search/FindingService/v1',
};

// ─── Main handler ───────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';

    // Handle CORS preflight
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
      return jsonResponse({ error: 'Missing or invalid q parameter' }, 400, origin);
    }

    // ── Mock mode ──────────────────────────────────────────────────────────
    // Returns realistic sold price data for UI development / before eBay approval.
    // The Finding API requires a production App ID — mock mode bypasses this.
    if (mock || !env.EBAY_APP_ID) {
      return jsonResponse(generateMockSoldListings(query), 200, origin);
    }

    // ── Live mode ──────────────────────────────────────────────────────────
    try {
      const environment = env.EBAY_ENVIRONMENT || 'production';
      const endpoint    = FINDING_HOSTS[environment] || FINDING_HOSTS.production;

      // Run raw and PSA 10 searches in parallel
      const [rawResults, psa10Results] = await Promise.all([
        searchSoldListings(query, 'raw',   env.EBAY_APP_ID, endpoint),
        searchSoldListings(query, 'psa10', env.EBAY_APP_ID, endpoint),
      ]);

      return jsonResponse({
        raw:    rawResults,
        psa10:  psa10Results,
        source: 'ebay_sold',
        query:  query,
      }, 200, origin);

    } catch (err) {
      console.error('eBay proxy error:', err.message);
      const msg = env.ENVIRONMENT === 'development' ? err.message : 'eBay search failed';
      return jsonResponse({ error: msg, raw: [], psa10: [], source: 'error' }, 502, origin);
    }
  },
};

// ─── Finding API Search ──────────────────────────────────────────────────────

/**
 * Searches eBay completed/sold listings using the Finding API.
 *
 * The Finding API is separate from the Browse API and uses the App ID
 * directly as a query parameter — no OAuth needed.
 *
 * Endpoint: GET https://svcs.ebay.com/services/search/FindingService/v1
 *   ?OPERATION-NAME=findCompletedItems
 *   &SECURITY-APPNAME={appId}
 *   &keywords={query}
 *   &itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true
 *   etc.
 *
 * @param {string} playerName
 * @param {'raw'|'psa10'} type
 * @param {string} appId
 * @param {string} endpoint
 * @returns {object[]} normalized sold listing objects
 */
async function searchSoldListings(playerName, type, appId, endpoint) {
  // Build search keywords based on type
  // Raw: Bowman Chrome auto, exclude grading companies and noise
  // PSA 10: specifically graded PSA 10 Bowman Chrome auto
  const keywords = type === 'psa10'
    ? `"${playerName}" "bowman chrome" auto "PSA 10"`
    : `"${playerName}" "bowman chrome" auto -PSA -BGS -SGC -redemption -lot -reprint`;

  // Build Finding API query string
  // All params must be URL-encoded
  const params = new URLSearchParams({
    'OPERATION-NAME':          'findCompletedItems',
    'SERVICE-VERSION':         '1.0.0',
    'SECURITY-APPNAME':        appId,
    'RESPONSE-DATA-FORMAT':    'JSON',
    'REST-PAYLOAD':            '',
    'keywords':                keywords,
    'sortOrder':               'EndTimeSoonest',  // most recently sold first
    'paginationInput.entriesPerPage': '20',
    // Category 261328 = Sports Trading Cards
    'categoryId':              '261328',
    // Filter 1: sold items only
    'itemFilter(0).name':      'SoldItemsOnly',
    'itemFilter(0).value':     'true',
    // Filter 2: listing type — auctions and fixed price
    'itemFilter(1).name':      'ListingType',
    'itemFilter(1).value(0)':  'Auction',
    'itemFilter(1).value(1)':  'FixedPrice',
    'itemFilter(1).value(2)':  'AuctionWithBIN',
    // Output selectors for the fields we need
    'outputSelector(0)':       'SellingStatus',
    'outputSelector(1)':       'PictureURLLarge',
  });

  const res = await fetch(`${endpoint}?${params.toString()}`);
  if (!res.ok) throw new Error(`Finding API ${res.status}: ${await res.text()}`);

  const data = await res.json();

  // Navigate Finding API response structure
  // findCompletedItemsResponse[0].searchResult[0].item[]
  const items = data?.findCompletedItemsResponse?.[0]
    ?.searchResult?.[0]?.item || [];

  return items
    .filter(item => !isNoiseListing(item, type))
    .map(item => normalizeSoldItem(item, type))
    .filter(item => item.price > 0)
    .slice(0, 15);
}

/**
 * Filters out listings that are noise — lots, redemptions, reprints, etc.
 * The Finding API keyword exclusions (-PSA etc.) help but aren't perfect.
 */
function isNoiseListing(item, type) {
  const title = (item.title?.[0] || '').toUpperCase();

  // Always exclude
  if (/\bLOT\b|\d+\s*CARDS?\b/.test(title))    return true; // multi-card lots
  if (/REPRINT|REPLICA|CUSTOM|FAKE/.test(title)) return true; // reprints
  if (/REDEMPTION(?!\s*REDEEMED)/.test(title))   return true; // unredeemed redemptions

  // For raw searches, double-check no grading company slipped through
  if (type === 'raw') {
    if (/\bPSA\b|\bBGS\b|\bSGC\b|\bCSG\b|\bBVG\b/.test(title)) return true;
  }

  // For PSA 10, make sure it's actually graded PSA 10 (not PSA 9 or other)
  if (type === 'psa10') {
    if (!/PSA\s*10/.test(title)) return true;
  }

  return false;
}

/**
 * Normalizes a raw Finding API item into our internal shape.
 *
 * Finding API item structure (relevant fields):
 * {
 *   title: ['Player Name Bowman Chrome Auto PSA 10'],
 *   sellingStatus: [{ currentPrice: [{ __value__: '145.00' }], sellingState: ['EndedWithSales'] }],
 *   listingInfo: [{ endTime: ['2025-04-15T...'] }],
 *   viewItemURL: ['https://www.ebay.com/itm/...']
 * }
 */
function normalizeSoldItem(item, type) {
  const title     = item.title?.[0] || '';
  const priceRaw  = item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'];
  const price     = parseFloat(priceRaw) || 0;
  const endTime   = item.listingInfo?.[0]?.endTime?.[0] || null;
  const itemUrl   = item.viewItemURL?.[0] || '';

  // Extract parallel type from title
  const parallel  = extractParallel(title);

  return {
    title,
    price,
    type,           // 'raw' or 'psa10'
    parallel,       // e.g. 'Refractor', 'Gold Refractor', 'Base', null
    date:     endTime,
    itemUrl,
  };
}

/**
 * Extracts the card parallel from the listing title.
 * Checks for common Bowman Chrome parallel names in order of rarity.
 */
function extractParallel(title) {
  const t = title.toUpperCase();
  if (/SUPERFRACTOR|SUPERFRACTOR/.test(t))              return 'Superfractor 1/1';
  if (/BLACK\s*REFRACTOR/.test(t))                      return 'Black Refractor';
  if (/ORANGE\s*REFRACTOR/.test(t))                     return 'Orange Refractor';
  if (/RED\s*REFRACTOR/.test(t))                        return 'Red Refractor';
  if (/GOLD\s*REFRACTOR/.test(t))                       return 'Gold Refractor';
  if (/PURPLE\s*REFRACTOR/.test(t))                     return 'Purple Refractor';
  if (/BLUE\s*REFRACTOR/.test(t))                       return 'Blue Refractor';
  if (/GREEN\s*REFRACTOR/.test(t))                      return 'Green Refractor';
  if (/ATOMIC\s*REFRACTOR/.test(t))                     return 'Atomic Refractor';
  if (/PRISM\s*REFRACTOR/.test(t))                      return 'Prism Refractor';
  if (/\bREFRACTOR\b/.test(t))                          return 'Refractor';
  if (/SAPPHIRE/.test(t))                               return 'Sapphire';
  if (/1ST\s*(BOWMAN|AUTO)|FIRST\s*BOWMAN/.test(t))     return '1st Bowman';
  return 'Base';
}

// ─── Mock Data ───────────────────────────────────────────────────────────────

/**
 * Generates realistic-looking sold price data for UI development.
 * Prices are seeded from player name for consistency across sessions.
 * Raw autos typically sell for 10-20% of PSA 10 value.
 *
 * DELETE or comment out once eBay Finding API is confirmed working.
 */
function generateMockSoldListings(playerName) {
  const seed    = playerName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng     = seededRandom(seed);
  const baseRaw = 15 + (seed % 60);      // $15–$75 for raw
  const basePsa = baseRaw * (4 + rng()); // PSA 10 ~4-5x raw

  const parallels = ['Base', 'Refractor', 'Blue Refractor', 'Gold Refractor', 'Orange Refractor'];
  const now       = Date.now();

  const makeItems = (basePrice, type, count) =>
    Array.from({ length: count }, (_, i) => {
      const daysAgo  = Math.floor(rng() * 45);
      const jitter   = 0.75 + rng() * 0.50;
      const parallel = type === 'psa10' ? 'Base' : parallels[Math.floor(rng() * parallels.length)];
      // Parallels command premium on raw
      const parallelMult = { Base: 1, Refractor: 1.5, 'Blue Refractor': 2, 'Gold Refractor': 4, 'Orange Refractor': 6 }[parallel] || 1;
      return {
        title:    `${playerName} Bowman Chrome Auto ${parallel} ${type === 'psa10' ? 'PSA 10' : ''}`.trim(),
        price:    parseFloat((basePrice * jitter * (type === 'raw' ? parallelMult : 1)).toFixed(2)),
        type,
        parallel,
        date:     new Date(now - daysAgo * 86_400_000).toISOString(),
        itemUrl:  `https://www.ebay.com/itm/${1234567890 + seed + i}`,
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
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
