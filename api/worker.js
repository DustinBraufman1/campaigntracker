/**
 * worker.js — Cloudflare Workers entry point
 *
 * Replaces Express + in-memory cache with:
 *   - Workers fetch() handler for routing
 *   - Cloudflare KV for caching (bound as RACE_MAP_KV in wrangler.toml)
 *   - Cloudflare Cron Trigger for scheduled refresh (every 6 hours)
 *
 * KV keys used:
 *   race_map_news   → JSON string of NewsResponse
 *   race_map_polls  → JSON string of PollsResponse
 *   race_map_meta   → JSON string of { lastFetch, fetchError }
 */

import { fetchNews }  from './scrapers/news.js';
import { fetchPolls } from './scrapers/polls.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET',
  'Content-Type': 'application/json',
};

// ── Scheduled refresh (Cron Trigger) ─────────────────────────────────────────
// Runs every 6 hours via the cron defined in wrangler.toml.
// Fetches fresh data and writes it to KV.
export async function scheduled(event, env, ctx) {
  ctx.waitUntil(refreshCache(env));
}

async function refreshCache(env) {
  const meta = { lastFetch: null, fetchError: null };
  try {
    const [news, polls] = await Promise.all([fetchNews(), fetchPolls()]);
    await Promise.all([
      env.RACE_MAP_KV.put('race_map_news',  JSON.stringify(news)),
      env.RACE_MAP_KV.put('race_map_polls', JSON.stringify(polls)),
    ]);
    meta.lastFetch = new Date().toISOString();
    console.log('[worker] Cache refreshed at', meta.lastFetch);
  } catch (err) {
    meta.fetchError = err.message;
    console.error('[worker] Refresh failed:', err.message);
  }
  await env.RACE_MAP_KV.put('race_map_meta', JSON.stringify(meta));
}

// ── Request handler ───────────────────────────────────────────────────────────
export default {
  // Scheduled trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshCache(env));
  },

  // HTTP requests
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // On first-ever request, if KV is empty, do a live refresh so the
    // worker isn't broken before the first cron fires.
    // Uses waitUntil so the response isn't delayed.
    const isWarm = await env.RACE_MAP_KV.get('race_map_meta');
    if (!isWarm) {
      ctx.waitUntil(refreshCache(env));
    }

    // ── Routes ────────────────────────────────────────────────────────────────
    if (url.pathname === '/api/news') {
      const data = await env.RACE_MAP_KV.get('race_map_news');
      if (!data) return jsonResponse({ error: 'Data not yet available — try again in ~15 seconds' }, 503);
      return jsonResponse(JSON.parse(data));
    }

    if (url.pathname === '/api/polls') {
      const data = await env.RACE_MAP_KV.get('race_map_polls');
      if (!data) return jsonResponse({ error: 'Data not yet available — try again in ~15 seconds' }, 503);
      return jsonResponse(JSON.parse(data));
    }

    if (url.pathname === '/health') {
      const meta = await env.RACE_MAP_KV.get('race_map_meta');
      const parsed = meta ? JSON.parse(meta) : {};
      return jsonResponse({
        status:     parsed.lastFetch ? 'ok' : 'warming',
        lastFetch:  parsed.lastFetch  ?? null,
        fetchError: parsed.fetchError ?? null,
      });
    }

    // Force a manual refresh (useful after adding a new race)
    if (url.pathname === '/refresh') {
      ctx.waitUntil(refreshCache(env));
      return jsonResponse({ message: 'Refresh triggered — check /health in ~15 seconds' });
    }

    // Temporary debug: test GDELT API fetch
    if (url.pathname === '/debug-rss') {
      const testUrl = 'https://api.gdeltproject.org/api/v2/doc/doc?query=Montana+congressional+race+2026&mode=artlist&maxrecords=5&format=json&timespan=7d&sort=DateDesc&sourcelang=english';
      try {
        const res = await fetch(testUrl, { headers: { 'User-Agent': 'race-map-api/1.0' } });
        const text = await res.text();
        return jsonResponse({ status: res.status, length: text.length, preview: text.slice(0, 1000) });
      } catch (e) {
        return jsonResponse({ error: e.message });
      }
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}
