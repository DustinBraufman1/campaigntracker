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
  const errors = [];

  const [newsResult, pollsResult] = await Promise.allSettled([fetchNews(), fetchPolls()]);

  if (newsResult.status === 'fulfilled') {
    await env.RACE_MAP_KV.put('race_map_news', JSON.stringify(newsResult.value));
  } else {
    errors.push('news: ' + newsResult.reason.message);
    console.error('[worker] News fetch failed:', newsResult.reason.message);
  }

  if (pollsResult.status === 'fulfilled') {
    await env.RACE_MAP_KV.put('race_map_polls', JSON.stringify(pollsResult.value));
  } else {
    errors.push('polls: ' + pollsResult.reason.message);
    console.error('[worker] Polls fetch failed:', pollsResult.reason.message);
  }

  meta.lastFetch = new Date().toISOString();
  if (errors.length) meta.fetchError = errors.join('; ');
  await env.RACE_MAP_KV.put('race_map_meta', JSON.stringify(meta));
  console.log('[worker] Cache refreshed at', meta.lastFetch, errors.length ? '(with errors)' : '');
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

    // Temporary debug
    if (url.pathname === '/debug-rss') {
      const results = {};
      for (const [name, testUrl] of [
        ['gdelt', 'https://api.gdeltproject.org/api/v2/doc/doc?query=Montana+congressional+2026&mode=artlist&maxrecords=3&format=json&timespan=7d&sort=DateDesc&sourcelang=english'],
        ['polls', 'https://projects.fivethirtyeight.com/polls-page/house_polls.csv'],
      ]) {
        try {
          const res = await fetch(testUrl, { headers: { 'User-Agent': 'race-map-api/1.0' }, signal: AbortSignal.timeout(10000) });
          const text = await res.text();
          results[name] = { status: res.status, length: text.length, preview: text.slice(0, 200) };
        } catch (e) {
          results[name] = { error: e.message };
        }
      }
      return jsonResponse(results);
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
