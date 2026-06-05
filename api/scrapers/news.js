/**
 * news.js
 *
 * Pulls the last 72 hours of news for each race using Google News RSS.
 * RSS is free, requires no API key, and doesn't rate-limit aggressively.
 *
 * Each race has a set of search queries; we de-duplicate results across
 * queries and return a NewsResponse shaped like the map's newsData object.
 *
 * NewsItem shape:
 *   { source, date, headline, summary, url, timestamp }
 */

// ── Race → search queries ─────────────────────────────────────────────────────
// Keep queries specific enough to avoid junk but broad enough to catch coverage
const RACE_QUERIES = {
  'NC-SEN': [
    'Roy Cooper Senate campaign North Carolina',
    'Michael Whatley North Carolina Senate',
    'NC Senate race 2026 election',
    'North Carolina Senate primary 2026',
  ],
  'PA-01': [
    'Brian Fitzpatrick reelection Bucks County',
    'Bob Harvie Pennsylvania 1st district',
    'PA-01 Bucks County congressional election 2026',
  ],
  'NY-04': [
    'Laura Gillen Nassau County Congress',
    "Anthony D'Esposito reelection New York 4th",
    'NY-04 Long Island congressional race 2026',
  ],
  'MT-01': [
    'Aaron Flint Montana Congress campaign',
    'Sam Forstag Montana 1st district',
    'Montana 1st congressional district election 2026',
    'Helena Montana congressional race',
  ],
  'TX-28': [
    'Henry Cuellar indictment Texas 28th',
    'Tano Tijerina Laredo congressional',
    'Texas 28th district Laredo election 2026',
    'TX-28 South Texas congressional race',
  ],
  'TX-34': [
    'Vicente Gonzalez Texas 34th reelection',
    'Eric Flores Rio Grande Valley Congress',
    'TX-34 Rio Grande Valley election 2026',
    'Texas 34th district congressional race',
  ],
};

// ── RSS fetch & parse ─────────────────────────────────────────────────────────
function googleNewsURL(query) {
  const encoded = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
}

async function fetchRSS(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`RSS fetch failed: ${url} → ${res.status}`);
  return res.text();
}

// Minimal XML tag extractor — no external dependencies
function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
}

function extractAllTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
  }
  return results;
}

function parseRSSItems(xml) {
  const itemBlocks = extractAllTags(xml, 'item');
  return itemBlocks.map(block => {
    const title   = extractTag(block, 'title');
    const link    = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const source  = extractTag(block, 'source');
    const desc    = extractTag(block, 'description')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/<[^>]+>/g, '')  // strip any HTML tags (after decoding entities)
      .slice(0, 300);

    const ts = pubDate ? new Date(pubDate).getTime() : 0;

    // Format date as "Jun 2026" style
    const dateObj = pubDate ? new Date(pubDate) : null;
    const dateLabel = dateObj
      ? dateObj.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
      : '';

    return {
      headline:  title,
      url:       link,
      source:    source || 'Google News',
      date:      dateLabel,
      summary:   desc || '',
      timestamp: ts,
    };
  });
}

// ── Deduplication by URL ──────────────────────────────────────────────────────
function dedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

// ── Age filter: drop anything older than 72 hours ─────────────────────────────
function filterByAge(items, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const now = Date.now();
  return items.filter(item => !item.timestamp || now - item.timestamp < maxAgeMs);
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function fetchNews() {
  const output = {};

  // Fetch all RSS feeds concurrently per race, then per query within each race
  await Promise.all(
    Object.entries(RACE_QUERIES).map(async ([raceId, queries]) => {
      const allItems = [];

      // Fetch each query sequentially with a short gap to be polite
      for (const query of queries) {
        try {
          const xml   = await fetchRSS(googleNewsURL(query));
          const items = parseRSSItems(xml);
          allItems.push(...items);
        } catch (err) {
          console.warn(`[news] RSS fetch failed for "${query}":`, err.message);
        }
        // Small delay between requests to the same service
        await new Promise(r => setTimeout(r, 300));
      }

      const fresh = filterByAge(allItems);
      const unique = dedupe(fresh);

      // Sort newest first
      unique.sort((a, b) => b.timestamp - a.timestamp);

      // Cap at 8 items per race to keep the panel clean
      output[raceId] = unique.slice(0, 8);
    })
  );

  // TX-MULTI gets a merged view of TX-28 + TX-34 news
  const combined = [...(output['TX-28'] || []), ...(output['TX-34'] || [])];
  combined.sort((a, b) => b.timestamp - a.timestamp);
  output['TX-MULTI'] = dedupe(combined).slice(0, 8);

  return output;
}
