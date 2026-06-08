/**
 * news.js
 *
 * Fetches news via GDELT DOC 2.0 API (free, no API key).
 * Uses 2 combined queries to stay within GDELT's 1-req/5s rate limit
 * and Cloudflare's 30-second cron timeout.
 */

// Two broad queries covering all 6 races, then keyword-filter into buckets
const QUERIES = [
  {
    q: '"North Carolina Senate" OR "Brian Fitzpatrick" OR "Laura Gillen" 2026 election',
    races: {
      'NC-SEN': ['north carolina', 'cooper', 'whatley', 'nc senate'],
      'PA-01':  ['fitzpatrick', 'harvie', 'bucks county', 'pa-01', 'pennsylvania 1st'],
      'NY-04':  ['gillen', "d'esposito", 'desposito', 'nassau', 'ny-04', 'new york 4th'],
    },
  },
  {
    q: '"Sam Forstag" OR "Aaron Flint" OR "Henry Cuellar" OR "Vicente Gonzalez" 2026 congressional',
    races: {
      'MT-01': ['forstag', 'flint', 'montana', 'mt-01'],
      'TX-28': ['cuellar', 'tijerina', 'tx-28', 'texas 28', 'laredo'],
      'TX-34': ['gonzalez', 'flores', 'tx-34', 'texas 34', 'rio grande'],
    },
  },
];

function gdeltURL(q) {
  return `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=25&format=json&timespan=7d&sort=DateDesc&sourcelang=english`;
}

function parseDate(seendate) {
  if (!seendate || seendate.length < 8) return { ts: 0, label: '' };
  const iso = `${seendate.slice(0,4)}-${seendate.slice(4,6)}-${seendate.slice(6,8)}T00:00:00Z`;
  const ts  = new Date(iso).getTime();
  return { ts, label: new Date(ts).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) };
}

function assignToRace(title, raceMap) {
  const lower = title.toLowerCase();
  for (const [raceId, keywords] of Object.entries(raceMap)) {
    if (keywords.some(kw => lower.includes(kw))) return raceId;
  }
  return null;
}

async function fetchGroup(q) {
  const res = await fetch(gdeltURL(q), {
    headers: { 'User-Agent': 'race-map-api/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GDELT ${res.status}`);
  const json = await res.json();
  return json.articles || [];
}

export async function fetchNews() {
  const output = { 'NC-SEN': [], 'PA-01': [], 'NY-04': [], 'MT-01': [], 'TX-28': [], 'TX-34': [] };
  const seen   = new Set();

  for (let i = 0; i < QUERIES.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 6000));

    const { q, races } = QUERIES[i];
    let articles = [];
    try {
      articles = await fetchGroup(q);
    } catch (err) {
      console.warn('[news] GDELT fetch failed:', err.message);
      continue;
    }

    for (const a of articles) {
      if (!a.title || !a.url || seen.has(a.url)) continue;
      const raceId = assignToRace(a.title, races);
      if (!raceId) continue;
      if (output[raceId].length >= 8) continue;
      seen.add(a.url);
      const { ts, label } = parseDate(a.seendate);
      output[raceId].push({ headline: a.title, url: a.url, source: a.domain || 'Unknown', date: label, summary: '', timestamp: ts });
    }
  }

  // TX-MULTI = merged TX-28 + TX-34
  const combined = [...output['TX-28'], ...output['TX-34']];
  combined.sort((a, b) => b.timestamp - a.timestamp);
  output['TX-MULTI'] = combined.slice(0, 8);

  return output;
}
