/**
 * news.js
 *
 * Fetches news via a single GDELT DOC 2.0 query covering all tracked
 * candidates. One request = no rate-limit issues.
 */

// Keywords used to bucket each article into a race
const RACE_KEYWORDS = {
  'NC-SEN': ['north carolina senate', 'roy cooper', 'michael whatley'],
  'PA-01':  ['fitzpatrick', 'bob harvie', 'bucks county', 'pa-01'],
  'NY-04':  ['laura gillen', "d'esposito", 'desposito', 'nassau county', 'ny-04'],
  'MT-01':  ['sam forstag', 'aaron flint', 'montana.*congressional', 'mt-01'],
  'TX-28':  ['henry cuellar', 'tano tijerina', 'tx-28', 'laredo.*congress'],
  'TX-34':  ['vicente gonzalez', 'eric flores.*texas', 'tx-34'],
};

// Single query covering all candidates — GDELT returns up to 25 results
const QUERY = '"Brian Fitzpatrick" OR "Laura Gillen" OR "Sam Forstag" OR "Henry Cuellar" OR "Vicente Gonzalez" OR "North Carolina Senate" 2026';

function gdeltURL() {
  return `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(QUERY)}&mode=artlist&maxrecords=25&format=json&timespan=14d&sort=DateDesc&sourcelang=english`;
}

function parseDate(seendate) {
  if (!seendate || seendate.length < 8) return { ts: 0, label: '' };
  const iso = `${seendate.slice(0,4)}-${seendate.slice(4,6)}-${seendate.slice(6,8)}T00:00:00Z`;
  const ts  = new Date(iso).getTime();
  return { ts, label: new Date(ts).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) };
}

function assignToRace(title) {
  const lower = title.toLowerCase();
  for (const [raceId, keywords] of Object.entries(RACE_KEYWORDS)) {
    if (keywords.some(kw => new RegExp(kw, 'i').test(lower))) return raceId;
  }
  return null;
}

export async function fetchNews() {
  const output = { 'NC-SEN': [], 'PA-01': [], 'NY-04': [], 'MT-01': [], 'TX-28': [], 'TX-34': [] };

  const res = await fetch(gdeltURL(), {
    headers: { 'User-Agent': 'race-map-api/1.0' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`GDELT ${res.status}`);

  const json     = await res.json();
  const articles = json.articles || [];
  const seen     = new Set();

  for (const a of articles) {
    if (!a.title || !a.url || seen.has(a.url)) continue;
    const raceId = assignToRace(a.title);
    if (!raceId || output[raceId].length >= 8) continue;
    seen.add(a.url);
    const { ts, label } = parseDate(a.seendate);
    output[raceId].push({ headline: a.title, url: a.url, source: a.domain || 'Unknown', date: label, summary: '', timestamp: ts });
  }

  const combined = [...output['TX-28'], ...output['TX-34']];
  combined.sort((a, b) => b.timestamp - a.timestamp);
  output['TX-MULTI'] = combined.slice(0, 8);

  return output;
}
