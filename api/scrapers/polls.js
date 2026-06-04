/**
 * polls.js
 *
 * Fetches the FiveThirtyEight Senate and House poll CSVs, filters
 * for the six races on the map, and returns a PollsResponse object
 * matching the shape expected by race_map_2026.html.
 *
 * FiveThirtyEight CSV columns used:
 *   state, seat_name, candidate_name, party, pct, pollster,
 *   end_date, sample_size, population, url
 */

// ── Race definitions ──────────────────────────────────────────────────────────
// Map 538's state/seat_name values → our internal race IDs
// "matchFn" receives a row object and returns true when it's the right race
const RACE_DEFS = [
  {
    id: 'NC-SEN',
    type: 'senate',
    matchFn: row => row.state === 'North Carolina',
    demName: 'Roy Cooper',
    repName: 'Michael Whatley',
  },
  {
    id: 'PA-01',
    type: 'house',
    matchFn: row => row.state === 'Pennsylvania' && row.seat_name === '1',
    demName: 'Bob Harvie',
    repName: 'Brian Fitzpatrick',
  },
  {
    id: 'NY-04',
    type: 'house',
    matchFn: row => row.state === 'New York' && row.seat_name === '4',
    demName: 'Laura Gillen',
    repName: "Anthony D'Esposito",
  },
  {
    id: 'MT-01',
    type: 'house',
    matchFn: row => row.state === 'Montana' && row.seat_name === '1',
    demName: 'Sam Forstag',
    repName: 'Aaron Flint',
  },
  {
    id: 'TX-28',
    type: 'house',
    matchFn: row => row.state === 'Texas' && row.seat_name === '28',
    demName: 'Henry Cuellar',
    repName: 'Tano Tijerina',
  },
  {
    id: 'TX-34',
    type: 'house',
    matchFn: row => row.state === 'Texas' && row.seat_name === '34',
    demName: 'Vicente Gonzalez',
    repName: 'Eric Flores',
  },
];

// Static fallback ratings (used when 538 doesn't have data for a race)
const FALLBACK_RATINGS = {
  'NC-SEN': { rating: 'lean-dem',  ratingLabel: 'Lean Democrat' },
  'PA-01':  { rating: 'lean-rep',  ratingLabel: 'Likely Republican (Cook)' },
  'NY-04':  { rating: 'tossup',    ratingLabel: 'Toss-Up' },
  'MT-01':  { rating: 'lean-rep',  ratingLabel: 'Likely Republican (Cook)' },
  'TX-28':  { rating: 'tossup',    ratingLabel: 'Toss-Up' },
  'TX-34':  { rating: 'tossup',    ratingLabel: 'Toss-Up' },
};

// ── CSV fetch helpers ─────────────────────────────────────────────────────────
const SENATE_URL = 'https://projects.fivethirtyeight.com/polls-page/senate_polls.csv';
const HOUSE_URL  = 'https://projects.fivethirtyeight.com/polls-page/house_polls.csv';

async function fetchCSV(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'race-map-api/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`CSV fetch failed: ${url} → ${res.status}`);
  return res.text();
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  return lines.slice(1).map(line => {
    // Basic CSV parse — handles quoted fields with commas
    const vals = [];
    let current = '', inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { vals.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    vals.push(current.trim());
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
  });
}

// ── Average the most-recent 3 polls for each candidate ───────────────────────
function averageRecentPolls(rows, candidateName, partyCode) {
  // Normalize partial name matches (538 may abbreviate)
  const nameLower = candidateName.toLowerCase();
  const relevant = rows
    .filter(r => {
      const n = (r.candidate_name || '').toLowerCase();
      return (n.includes(nameLower.split(' ').pop()) || nameLower.includes(n.split(' ').pop()))
          && r.party === partyCode;
    })
    .sort((a, b) => new Date(b.end_date) - new Date(a.end_date))
    .slice(0, 3);

  if (relevant.length === 0) return null;

  const avg = Math.round(relevant.reduce((s, r) => s + Number(r.pct), 0) / relevant.length);
  const latest = relevant[0];
  const note = `${latest.pollster} · ${latest.end_date} · n=${latest.sample_size || '?'} (avg of ${relevant.length} most recent polls)`;
  return { avg, note, url: latest.url };
}

// ── Map 538 average margin → our rating buckets ───────────────────────────────
function marginToRating(demPct, repPct) {
  const margin = demPct - repPct;
  if (margin > 7)  return { rating: 'lean-dem',  ratingLabel: 'Lean Democrat' };
  if (margin > 2)  return { rating: 'lean-dem',  ratingLabel: 'Lean Democrat' };
  if (margin < -7) return { rating: 'likely-rep', ratingLabel: 'Likely Republican' };
  if (margin < -2) return { rating: 'lean-rep',  ratingLabel: 'Lean Republican' };
  return { rating: 'tossup', ratingLabel: 'Toss-Up' };
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function fetchPolls() {
  const [senateCSV, houseCSV] = await Promise.all([
    fetchCSV(SENATE_URL),
    fetchCSV(HOUSE_URL),
  ]);

  const senateRows = parseCSV(senateCSV);
  const houseRows  = parseCSV(houseCSV);

  const output = {};

  for (const def of RACE_DEFS) {
    const pool = def.type === 'senate' ? senateRows : houseRows;
    const rows = pool.filter(def.matchFn);

    const demResult = averageRecentPolls(rows, def.demName, 'DEM');
    const repResult = averageRecentPolls(rows, def.repName, 'REP');

    const hasPolls = demResult !== null && repResult !== null;

    output[def.id] = {
      ...(hasPolls
        ? marginToRating(demResult.avg, repResult.avg)
        : FALLBACK_RATINGS[def.id]),

      dem: hasPolls ? {
        polls: [
          { label: `${def.demName.split(' ').pop()} (D)`, pct: demResult.avg, party: 'dem' },
          { label: `${def.repName.split(' ').pop()} (R)`, pct: repResult.avg, party: 'rep' },
        ],
        pollNote: demResult.note,
      } : null,

      rep: hasPolls ? {
        polls: [
          { label: `${def.repName.split(' ').pop()} (R)`, pct: repResult.avg, party: 'rep' },
          { label: `${def.demName.split(' ').pop()} (D)`, pct: demResult.avg, party: 'dem' },
        ],
        pollNote: repResult.note,
      } : null,
    };
  }

  // TX-MULTI mirrors TX-28 and TX-34 ratings (tossup if either is)
  const tx28 = output['TX-28'];
  const tx34 = output['TX-34'];
  const bothTossup = tx28?.rating === 'tossup' || tx34?.rating === 'tossup';
  output['TX-MULTI'] = {
    rating:      bothTossup ? 'tossup' : 'lean-rep',
    ratingLabel: bothTossup ? 'Toss-Up (Both Seats)' : 'Lean Republican',
    dem: null,
    rep: null,
  };

  return output;
}
