/**
 * Configuration: turns the joymee.uz search URL you copied from the browser
 * into the query the site's own backend API expects.
 */

import { readFileSync } from 'node:fs';

export const API_URL = 'https://api.joymee.uz/api/v1/announcement/';
export const SITE_BASE = 'https://joymee.uz';

/**
 * Loads a local .env file when present. On GitHub Actions the values come
 * from repository secrets instead, so a missing file is not an error.
 */
export function loadDotEnv(file = '.env') {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Real environment variables win over the file.
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** Query params that belong to the web UI only and must not be forwarded to the API. */
const UI_ONLY_PARAMS = new Set(['step', 'page', 'lang', 'locale']);

/**
 * The website's URL uses different names for some filters than its own API.
 *
 * `room_qty_min` / `room_qty_max` are the worst case: the API accepts them
 * silently and ignores them, so a 2–3 room search would quietly return
 * 1-room flats too. The API only honours the `room_quantity_*` spelling.
 */
const PARAM_ALIASES = {
  room_qty_min: 'room_quantity_min',
  room_qty_max: 'room_quantity_max',
};

/**
 * Default search, used when the SEARCH_URL variable is not set.
 *
 * TEMPORARY: currently matches every new listing on the site, with no filters
 * at all, so notifications can be seen arriving without waiting for a rare
 * match. To go back to the real search, swap which of the two is commented.
 */

// Testing: everything posted to the site, any deal type, price or district.
export const DEFAULT_SEARCH_URL = 'https://joymee.uz/?page=1';

// The real search: long-term rent, apartments, Yunusobod, 2-3 rooms, up to 600 y.e.
// export const DEFAULT_SEARCH_URL =
//   'https://joymee.uz/?step=1&entity_purpose=long_term_rent&entity_type=apartment' +
//   '&district=199&region=59&currency=2&max_price=600&room_qty_min=2&room_qty_max=3' +
//   '&country=1&page=1';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it in your .env file locally, or as a repository secret on GitHub.`
    );
  }
  return value.trim();
}

function intEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  }
  return Math.min(max, Math.max(min, n));
}

/**
 * Converts the browser URL's query string into API search params.
 * Every filter you set on the site is forwarded as-is, so changing the
 * SEARCH_URL is all it takes to change what gets watched.
 */
export function buildSearchParams(searchUrl) {
  let parsed;
  try {
    parsed = new URL(searchUrl);
  } catch {
    throw new Error(`SEARCH_URL is not a valid URL: ${JSON.stringify(searchUrl)}`);
  }

  const params = new URLSearchParams();
  for (const [key, value] of parsed.searchParams.entries()) {
    if (UI_ONLY_PARAMS.has(key)) continue;
    if (value === '') continue;
    params.append(PARAM_ALIASES[key] ?? key, value);
  }

  // Newest first. The site uses this same default.
  if (!params.has('ordering')) params.set('ordering', 'newest');

  return params;
}

export function loadConfig() {
  loadDotEnv();

  const searchUrl = (process.env.SEARCH_URL || DEFAULT_SEARCH_URL).trim();

  return {
    searchUrl,
    searchParams: buildSearchParams(searchUrl),

    telegram: {
      botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
      chatId: requireEnv('TELEGRAM_CHAT_ID'),
    },

    /** Result pages always scanned each check. */
    pagesToScan: intEnv('PAGES_TO_SCAN', 2, { min: 1, max: 20 }),

    /** Cap on adaptive paging when a burst of new listings is found. */
    maxPagesToScan: intEnv('MAX_PAGES_TO_SCAN', 12, { min: 1, max: 50 }),

    /** How many checks a single process performs before exiting. */
    pollIterations: intEnv('POLL_ITERATIONS', 1, { min: 1, max: 60 }),

    /** Seconds between checks inside one process. */
    pollIntervalSeconds: intEnv('POLL_INTERVAL_SECONDS', 60, { min: 10, max: 3600 }),

    /** Safety valve: never send more than this many messages in one check. */
    maxNotificationsPerCheck: intEnv('MAX_NOTIFICATIONS_PER_CHECK', 25, { min: 1, max: 100 }),

    /** How many listing IDs to remember for de-duplication. */
    seenIdsToKeep: intEnv('SEEN_IDS_TO_KEEP', 1000, { min: 100, max: 20000 }),

    statePath: process.env.STATE_PATH || 'state.json',
  };
}
