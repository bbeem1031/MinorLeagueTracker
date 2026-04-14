# MiLB Hot Prospects Card Tracker

Track minor league baseball players who are statistically hot before their cards get expensive.

Live stats via the MLB Stats API · Card prices via eBay Browse API · Hosted on GitHub Pages.

---

## How It Works

```
Browser (GitHub Pages)
  ├── MLB Stats API ────────────────────────────► statsapi.mlb.com (free, no key, CORS-open)
  └── Cloudflare Worker ────────────────────────► api.ebay.com (token injected server-side)
```

- **MLB data** is fetched directly from the browser — no backend needed
- **eBay prices** go through a Cloudflare Worker so your API credentials never touch the client
- The app runs entirely on free tiers (GitHub Pages + Cloudflare Workers free plan)

---

## Repo Structure

```
milb-card-tracker/
├── index.html          ← The full app (single-file, deploy to GitHub Pages)
├── worker/
│   └── ebay-proxy.js   ← Cloudflare Worker (eBay API proxy)
├── wrangler.toml       ← Cloudflare Workers config
└── README.md
```

---

## Setup Guide

### Step 1 — GitHub Repository

```bash
git init milb-card-tracker
cd milb-card-tracker
# Copy index.html, worker/, wrangler.toml, README.md into this directory
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourusername/milb-card-tracker.git
git push -u origin main
```

### Step 2 — Enable GitHub Pages

1. Go to your repo on GitHub
2. **Settings → Pages**
3. Source: **Deploy from a branch**
4. Branch: **main** · Folder: **/ (root)**
5. Click **Save**

Your app will be live at `https://yourusername.github.io/milb-card-tracker/` in ~60 seconds.

> The MLB Stats API integration works immediately — no keys required.
> eBay prices show **mock data** until the Cloudflare Worker is deployed.

---

### Step 3 — Cloudflare Worker (eBay proxy)

#### 3a. Install Wrangler CLI

```bash
npm install -g wrangler
wrangler login          # opens browser to authenticate with Cloudflare
```

#### 3b. Update wrangler.toml

Edit `wrangler.toml` and replace the placeholder with your actual GitHub Pages domain:

```toml
ALLOWED_ORIGIN = "https://yourusername.github.io"
```

#### 3c. Deploy the Worker (mock mode — before eBay approval)

```bash
wrangler deploy
```

This deploys the Worker without any eBay credentials. It will serve mock data until
you add the secrets in Step 3e. Your Worker URL will be:

```
https://milb-ebay-proxy.yourusername.workers.dev
```

#### 3d. Update index.html with your Worker URL

In `index.html`, find this line in the CONFIG object:

```js
WORKER_URL: 'https://milb-ebay-proxy.yourusername.workers.dev',
```

Replace with your actual Worker URL, then commit and push:

```bash
git add index.html
git commit -m "Add Cloudflare Worker URL"
git push
```

#### 3e. Add eBay credentials (after account approval)

**Never put these in wrangler.toml or git.**
Use `wrangler secret put` — secrets are stored encrypted in Cloudflare's vault.

```bash
wrangler secret put EBAY_CLIENT_ID
# Paste your Client ID when prompted

wrangler secret put EBAY_CLIENT_SECRET
# Paste your Client Secret when prompted
```

Once secrets are set, redeploy:

```bash
wrangler deploy
```

The Worker will now auto-refresh eBay OAuth tokens and serve live card prices.

---

### Step 4 — eBay Developer Account Setup

When your eBay developer account is approved (typically 1 business day):

1. Go to [developer.ebay.com](https://developer.ebay.com) → **My Account → Application Keys**
2. Create a **Production** keyset (your app starts in sandbox by default)
3. Copy the **Client ID** and **Client Secret**
4. Run the `wrangler secret put` commands from Step 3e
5. In `wrangler.toml`, set `EBAY_ENVIRONMENT = "production"`
6. Redeploy: `wrangler deploy`

> **Sandbox vs Production**: eBay sandbox returns fake listings with no real prices.
> Always use production for real card price data.

---

## Local Development

```bash
# Serve the frontend locally
npx serve .
# Then open http://localhost:3000

# Run the Cloudflare Worker locally (mock mode — no eBay keys needed)
wrangler dev
# Worker available at http://localhost:8787
```

To test the Worker with mock data:
```
GET http://localhost:8787/?q=Jackson+Holliday&mock=true
```

To test with live eBay (after adding secrets locally via `wrangler secret put`):
```
GET http://localhost:8787/?q=Jackson+Holliday
```

---

## Hot Score Formula

Players are ranked by a composite **Hot Score** (max ~94 points):

| Component | Weight | Formula |
|---|---|---|
| Window BA | 40% | `windowBA × 40` |
| Window OPS | 30% | `windowOPS × 30` |
| Momentum | 20% | Compares last 5 games vs prior — rising = higher score |
| Level | 10% | AAA ×1.0 · AA ×0.85 · A+ ×0.70 · A ×0.55 |

A .380 BA / 1.050 OPS AAA player on a hot streak scores ~78.
The same stats at Single-A score ~60 due to the level discount.

---

## Data Refresh

- **Leaderboard** — refreshes once daily at 6:00 AM Eastern Time
- **14-day window stats** — fetched fresh each session, cached 60 minutes
- **eBay prices** — fetched on modal open, cached 4 hours

---

## API Rate Limits

| API | Limit | Our usage |
|---|---|---|
| MLB Stats API | Unofficial ~1,000 req/min | ~200 calls on load |
| eBay Browse API | 5,000 calls/day (free tier) | 1 call per modal open |
| Cloudflare Workers | 100,000 req/day (free tier) | 1 per eBay price fetch |

---

## Stack

- **Frontend**: Vanilla HTML/CSS/JS — single file, no build step
- **Charts**: Chart.js 4.4.1 (CDN)
- **Stats**: MLB Stats API (free, no key)
- **Prices**: eBay Browse API v1 via Cloudflare Worker proxy
- **Hosting**: GitHub Pages (free)
- **Proxy**: Cloudflare Workers (free tier)

---

## Disclaimer

Not affiliated with MLB, MiLB, or eBay. For informational and entertainment purposes only.
Card prices are active listings, not guaranteed sale prices.
