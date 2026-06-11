'use strict';

/**
 * Code Way Management — Roster Metrics API
 * Netlify Function: /.netlify/functions/get-metrics  (mapped to /api/metrics via netlify.toml)
 *
 * ── SETUP ──────────────────────────────────────────────────────────────────
 * Add these in Netlify Dashboard → Site Configuration → Environment Variables:
 *
 * SPOTIFY_CLIENT_ID        Your Spotify app client ID   (developer.spotify.com/dashboard)
 * SPOTIFY_CLIENT_SECRET    Your Spotify app secret
 *
 * Per-artist Instagram tokens — generate a long-lived token for each
 * business/creator IG account via the Meta Graph API Explorer:
 * IG_USER_ID_KLASSIK       Numeric Instagram user ID for Klassik Frescobar
 * IG_TOKEN_KLASSIK         Long-lived Instagram access token (expires every 60 days — refresh it)
 * IG_USER_ID_DJKALI        Numeric Instagram user ID for DJ Kali
 * IG_TOKEN_DJKALI          Long-lived Instagram access token
 * IG_USER_ID_SAL           Numeric Instagram user ID for Sal Infrared
 * IG_TOKEN_SAL             Long-lived Instagram access token
 * IG_USER_ID_DJPRIME       Numeric Instagram user ID for DJ Prime
 * IG_TOKEN_DJPRIME         Long-lived Instagram access token
 *
 * TikTok:
 * TikTok's Research/Business API requires application approval.
 * Until approved, TikTok stats will use the fallback numbers below.
 * Apply at: https://developers.tiktok.com/
 *
 * ── ARTIST IDs ─────────────────────────────────────────────────────────────
 * Find each Spotify Artist ID from their Spotify profile URL:
 *   open.spotify.com/artist/{ARTIST_ID}
 * ───────────────────────────────────────────────────────────────────────────
 */

const https = require('https');

// ─── ARTIST CONFIGURATION ────────────────────────────────────────────────────
// Fill in the Spotify artist IDs — grab them from each artist's Spotify profile URL.
// All other credentials come from environment variables set in the Netlify dashboard.
const ARTISTS = [
  {
    id:       'klassik',
    name:     'KLASSIK FRESCOBAR',
    role:     'International Artist',
    spotifyId: 'FILL_IN_SPOTIFY_ARTIST_ID',  // e.g. '5K4W6rqBFWDnAN6FQUkS6x'
    igUserId:  process.env.IG_USER_ID_KLASSIK || '',
    igToken:   process.env.IG_TOKEN_KLASSIK   || '',
    fallback: { spotify: 87400, meta: 2400000, tiktok: 1100000 },
  },
  {
    id:       'djkali',
    name:     'DJ KALI',
    role:     'DJ / Producer',
    spotifyId: 'FILL_IN_SPOTIFY_ARTIST_ID',
    igUserId:  process.env.IG_USER_ID_DJKALI  || '',
    igToken:   process.env.IG_TOKEN_DJKALI    || '',
    fallback: { spotify: 12000, meta: 890000, tiktok: 540000 },
  },
  {
    id:       'sal',
    name:     'SAL INFRARED',
    role:     'DJ / Performer',
    spotifyId: 'FILL_IN_SPOTIFY_ARTIST_ID',
    igUserId:  process.env.IG_USER_ID_SAL     || '',
    igToken:   process.env.IG_TOKEN_SAL       || '',
    fallback: { spotify: 8500, meta: 420000, tiktok: 280000 },
  },
  {
    id:       'djprime',
    name:     'DJ PRIME',
    role:     'DJ / Media Personality',
    spotifyId: 'FILL_IN_SPOTIFY_ARTIST_ID',
    igUserId:  process.env.IG_USER_ID_DJPRIME || '',
    igToken:   process.env.IG_TOKEN_DJPRIME   || '',
    fallback: { spotify: 15000, meta: 650000, tiktok: 380000 },
  },
];

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────
function httpsGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 8000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
          resolve(body);
        });
      }
    ).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

function httpsPost(urlStr, bodyStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const buf = Buffer.from(bodyStr, 'utf8');
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Length': buf.length, ...headers },
        timeout: 8000,
      },
      (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve(out));
      }
    );
    req.on('error', reject).on('timeout', () => reject(new Error('timeout')));
    req.write(buf);
    req.end();
  });
}

// ─── SPOTIFY ──────────────────────────────────────────────────────────────────
// Spotify's public API doesn't expose monthly listeners directly.
// We scrape the public artist page, which embeds monthlyListeners in its HTML.
// If scraping fails, we fall back to followers via the official API.
let _spotifyToken = null;
let _spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyTokenExpiry) return _spotifyToken;
  const cid = process.env.SPOTIFY_CLIENT_ID;
  const cs  = process.env.SPOTIFY_CLIENT_SECRET;
  if (!cid || !cs) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');

  const creds = Buffer.from(`${cid}:${cs}`).toString('base64');
  const body  = await httpsPost(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  const json = JSON.parse(body);
  _spotifyToken       = json.access_token;
  _spotifyTokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
  return _spotifyToken;
}

async function getSpotifyMonthlyListeners(artistId) {
  if (!artistId || artistId === 'FILL_IN_SPOTIFY_ARTIST_ID') {
    throw new Error('Spotify artist ID not configured');
  }

  // 1. Try scraping the public page — Spotify embeds monthlyListeners in the HTML
  try {
    const html = await httpsGet(`https://open.spotify.com/artist/${artistId}`, {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    const m = html.match(/"monthlyListeners"\s*:\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
  } catch (_) {
    // fall through to official API
  }

  // 2. Official API fallback — returns followers (not monthly listeners, but better than nothing)
  const token  = await getSpotifyToken();
  const json   = JSON.parse(
    await httpsGet(`https://api.spotify.com/v1/artists/${artistId}`, {
      Authorization: `Bearer ${token}`,
    })
  );
  return json.followers?.total ?? null;
}

// ─── META / INSTAGRAM ────────────────────────────────────────────────────────
// Uses the Instagram Graph API (account-level insights).
// The token must belong to a Facebook Page connected to an Instagram Business or Creator account.
// Long-lived tokens expire in 60 days — set a reminder to refresh them.
async function getInstagramImpressions(userId, token) {
  if (!userId || !token) throw new Error('Instagram credentials not set');

  // Total impressions for the last 28 days (closest to "30d views" that IG exposes)
  const url =
    `https://graph.instagram.com/v19.0/${userId}/insights` +
    `?metric=impressions&period=days_28&access_token=${token}`;
  const res  = JSON.parse(await httpsGet(url));
  const data = res.data || [];

  return data.reduce((sum, item) => {
    const vals = Array.isArray(item.values) ? item.values : [];
    return sum + vals.reduce((s, v) => s + (v.value || 0), 0);
  }, 0);
}

// ─── TIKTOK ───────────────────────────────────────────────────────────────────
// TikTok's Research API and Business API both require explicit application approval.
// Apply at: https://developers.tiktok.com/
// Once approved, replace this function with real API calls.
async function getTikTokViews(/* userId, token */) {
  throw new Error('TikTok API not yet configured — using fallback');
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
exports.handler = async function () {
  const updated = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const artistResults = {};

  await Promise.all(
    ARTISTS.map(async (cfg) => {
      const stats   = { ...cfg.fallback };
      const sources = {};

      // ── Spotify ──
      try {
        const v = await getSpotifyMonthlyListeners(cfg.spotifyId);
        if (v != null && v > 0) { stats.spotify = v; sources.spotify = 'live'; }
        else throw new Error('zero / null returned');
      } catch (e) {
        sources.spotify = 'fallback — ' + e.message;
      }

      // ── Meta ──
      try {
        const v = await getInstagramImpressions(cfg.igUserId, cfg.igToken);
        if (v > 0) { stats.meta = v; sources.meta = 'live'; }
        else throw new Error('zero returned');
      } catch (e) {
        sources.meta = 'fallback — ' + e.message;
      }

      // ── TikTok ──
      try {
        const v = await getTikTokViews();
        if (v > 0) { stats.tiktok = v; sources.tiktok = 'live'; }
      } catch (e) {
        sources.tiktok = 'fallback — ' + e.message;
      }

      artistResults[cfg.id] = { ...stats, _sources: sources };
    })
  );

  return {
    statusCode: 200,
    headers: {
      'Content-Type':                'application/json',
      'Cache-Control':               'public, s-maxage=86400, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({ updated, artists: artistResults }),
  };
};
