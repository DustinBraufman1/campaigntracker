/**
 * news.js
 *
 * Pulls recent news for each race using the GDELT DOC 2.0 API.
 * Free, no API key required, indexes thousands of outlets.
 *
 * NewsItem shape:
 *   { source, date, headline, summary, url, timestamp }
 */

const RACE_QUERIES = {
  'NC-SEN': 'North Carolina Senate race 2026 election',
  'PA-01':  'Brian Fitzpatrick Pennsylvania congressional 2026',
  'NY-04':  'Laura Gillen D\'Esposito New York 4th district 2026',
  'MT-01':  'Montana 1st congressional district 2026 Sam Forstag',
  'TX-28':  'Henry Cuellar Texas 28th district 2026',
  'TX-34':  'Vicente Gonzalez Texas 34th district 2026',
};

const MAX_RECORDS = 8;
const TIMESPAN    = '7d';

function gdeltURL(query) {
  const q = encodeURIComponent(query);
  return `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=${MAX_RECORDS}&format=json&timespan=${TIMESPAN}&sort=DateDesc&sourcelang=english`;
}

function parseGdeltDate(seendate) {
  // Format: "20260605T180000Z"
  if (!seendate || seendate.length < 8) return { ts: 0, label: '' };
  const year  = seendate.slice(0, 4);
  const month = seendate.slice(4, 6);
  const day   = seendate.slice(6, 8);
  const ts    = new Date(`${year}-${month}-${day}T00:00:00Z`).getTime();
  const label = new Date(ts).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  return { ts, label };
}

async function fetchRaceNews(query) {
  const res = await fetch(gdeltURL(query), {
    headers: { 'User-Agent': 'race-map-api/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GDELT fetch failed: ${res.status}`);

  const json = await res.json();
  const articles = json.articles || [];

  return articles.map(a => {
    const { ts, label } = parseGdeltDate(a.seendate);
    return {
      headline:  a.title  || '',
      url:       a.url    || '',
      source:    a.domain || 'Unknown',
      date:      label,
      summary:   '',
      timestamp: ts,
    };
  }).filter(a => a.headline && a.url);
}

export async function fetchNews() {
  const output = {};

  for (const [raceId, query] of Object.entries(RACE_QUERIES)) {
    try {
      output[raceId] = await fetchRaceNews(query);
    } catch (err) {
      console.warn(`[news] GDELT fetch failed for ${raceId}:`, err.message);
      output[raceId] = [];
    }
    await new Promise(r => setTimeout(r, 6000));
  }

  const combined = [...(output['TX-28'] || []), ...(output['TX-34'] || [])];
  combined.sort((a, b) => b.timestamp - a.timestamp);
  const seen = new Set();
  output['TX-MULTI'] = combined.filter(a => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  }).slice(0, 8);

  return output;
}
