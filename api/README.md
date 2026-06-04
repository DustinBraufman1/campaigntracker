# race-map-api (Cloudflare Workers)

Auto-updating polls & news backend for `race_map_2026.html`.
Runs on Cloudflare Workers — no server, no cold starts, free forever.

**Data sources:**
- Polls → FiveThirtyEight Senate & House CSV feeds
- News  → Google News RSS (no API key required)

**Refresh schedule:** Cloudflare Cron Trigger fires every 6 hours,
writes fresh data to KV. Requests read from KV — fast, no live fetching per request.

---

## One-time setup

### 1. Install Wrangler and log in

```bash
npm install
npx wrangler login
```

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create RACE_MAP_KV
npx wrangler kv namespace create RACE_MAP_KV --preview
```

Each command prints an ID — paste both into wrangler.toml:

```toml
[[kv_namespaces]]
binding    = "RACE_MAP_KV"
id         = "abc123..."
preview_id = "xyz789..."
```

### 3. Deploy

```bash
npm run deploy
```

Wrangler prints: `https://race-map-api.YOUR-SUBDOMAIN.workers.dev`

### 4. Seed the cache (do this once right after deploy)

Hit this URL in your browser:
`https://race-map-api.YOUR-SUBDOMAIN.workers.dev/refresh`

Wait ~15 seconds, then check `/health` to confirm data is populated.

### 5. Wire up the HTML

In `race_map_2026.html`, find DATA_SOURCES (~line 845):

```js
const DATA_SOURCES = {
  news:      'https://race-map-api.YOUR-SUBDOMAIN.workers.dev/api/news',
  polls:     'https://race-map-api.YOUR-SUBDOMAIN.workers.dev/api/polls',
  refreshMs: 6 * 60 * 60 * 1000,
};
```

---

## Local dev

```bash
npm run dev   # spins up at http://localhost:8787
```

## Routes

| Route | Description |
|-------|-------------|
| GET /api/news | NewsResponse JSON |
| GET /api/polls | PollsResponse JSON |
| GET /health | Cache status + last fetch time |
| GET /refresh | Manually trigger a cache refresh |

## Troubleshooting

- **/health shows "warming"** → hit /refresh, wait 15s, check again
- **wrangler deploy fails** → make sure you replaced placeholder IDs in wrangler.toml
- **Empty news** → Google News RSS is sometimes sparse for low-profile races; HTML falls back to static newsData
- **No poll %s** → 538 CSVs are sparse early in cycle; falls back to FALLBACK_RATINGS and HTML shows "No public polling available"
