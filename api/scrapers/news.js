/**
 * news.js
 *
 * Fetches from Politico, AP News, and The Hill RSS feeds — all designed
 * for syndication and accessible from server-side without blocking.
 * Filters articles into race buckets by keyword matching.
 */

const RSS_FEEDS = [
  'https://rss.politico.com/congress.xml',
  'https://feeds.apnews.com/rss/apf-politics',
  'https://thehill.com/rss/syndicator/19110',
];

const RACE_KEYWORDS = {
  'NC-SEN': ['north carolina senate', 'nc senate', 'roy cooper', 'michael whatley'],
  'PA-01':  ['brian fitzpatrick', 'bob harvie', 'bucks county', 'pa-01'],
  'NY-04':  ['laura gillen', "d'esposito", 'desposito', 'nassau county', 'ny-04'],
  'MT-01':  ['sam forstag', 'aaron flint', 'montana.*district', 'mt-01'],
  'TX-28':  ['henry cuellar', 'tano tijerina', 'tx-28'],
  'TX-34':  ['vicente gonzalez', 'eric flores', 'tx-34'],
};

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
}

function extractAllTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null)
    out.push(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
  return out;
}

function parseRSS(xml) {
  return extractAllTags(xml, 'item').map(block => {
    const title   = extractTag(block, 'title').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    const link    = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const source  = extractTag(block, 'source') || '';
    const ts      = pubDate ? new Date(pubDate).getTime() : 0;
    const label   = ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '';
    return { title, url: link, source, date: label, timestamp: ts };
  }).filter(a => a.title && a.url);
}

function assignToRace(title) {
  const lower = title.toLowerCase();
  for (const [raceId, keywords] of Object.entries(RACE_KEYWORDS)) {
    if (keywords.some(kw => new RegExp(kw, 'i').test(lower))) return raceId;
  }
  return null;
}

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RaceMapBot/1.0)',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

export async function fetchNews() {
  const output = { 'NC-SEN': [], 'PA-01': [], 'NY-04': [], 'MT-01': [], 'TX-28': [], 'TX-34': [] };
  const seen   = new Set();

  const results = await Promise.allSettled(RSS_FEEDS.map(fetchFeed));

  for (const result of results) {
    if (result.status !== 'fulfilled') {
      console.warn('[news] Feed failed:', result.reason.message);
      continue;
    }
    for (const article of parseRSS(result.value)) {
      if (seen.has(article.url)) continue;
      const raceId = assignToRace(article.title);
      if (!raceId || output[raceId].length >= 8) continue;
      seen.add(article.url);
      output[raceId].push({
        headline:  article.title,
        url:       article.url,
        source:    article.source || new URL(article.url).hostname.replace('www.', ''),
        date:      article.date,
        summary:   '',
        timestamp: article.timestamp,
      });
    }
  }

  const combined = [...output['TX-28'], ...output['TX-34']];
  combined.sort((a, b) => b.timestamp - a.timestamp);
  output['TX-MULTI'] = combined.slice(0, 8);

  return output;
}
