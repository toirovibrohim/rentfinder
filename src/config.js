/** Configuration: which searches to watch, and how often. */

import { readFileSync } from 'node:fs';

/**
 * Searches watched when SEARCH_URLS is not set. One URL per site, copied
 * from that site's address bar with the filters applied.
 *
 * TEMPORARY: joymee is currently unfiltered, so notifications can be seen
 * arriving without waiting for a rare match. Swap the commented line back
 * when that is no longer needed.
 */
export const DEFAULT_SEARCH_URLS = [
  // Testing: everything posted to joymee, any deal type, price or district.
  'https://joymee.uz/?page=1',

  // The real joymee search: long-term rent, apartments, Yunusobod,
  // 2-3 rooms, up to 600 y.e.
  // 'https://joymee.uz/?step=1&entity_purpose=long_term_rent&entity_type=apartment' +
  //   '&district=199&region=59&currency=2&max_price=600&room_qty_min=2&room_qty_max=3' +
  //   '&country=1&page=1',

  // uybor: long-term rent, apartments.
  'https://uybor.uz/listings?operationType__eq=rent&category__eq=7',

  // olx: long-term rent, apartments, Tashkent.
  'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/',
];

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

    if (!(key in process.env)) process.env[key] = value;
  }
}

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
 * Reads the searches to watch.
 *
 * SEARCH_URLS takes a newline- or comma-separated list. SEARCH_URL is still
 * accepted for a single search, so existing setups keep working.
 */
function readSearchUrls() {
  const many = process.env.SEARCH_URLS;
  if (many && many.trim()) {
    return many
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
  }

  const one = process.env.SEARCH_URL;
  if (one && one.trim()) return [one.trim()];

  return DEFAULT_SEARCH_URLS;
}

export function loadConfig() {
  loadDotEnv();

  return {
    searchUrls: readSearchUrls(),

    telegram: {
      botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
      /** The owner. Always receives listings, and is the only one who can grant access. */
      chatId: requireEnv('TELEGRAM_CHAT_ID'),
    },

    /** Encrypts the approved-chat list, which is committed to a public repo. */
    subscriberKey: process.env.SUBSCRIBER_KEY || '',
    subscribersPath: process.env.SUBSCRIBERS_PATH || 'subscribers.json',

    /** How long an approval lasts, in hours. */
    accessHours: intEnv('ACCESS_HOURS', 24, { min: 1, max: 24 * 365 }),

    /** Result pages always read per check, per source. */
    pagesToScan: intEnv('PAGES_TO_SCAN', 2, { min: 1, max: 20 }),

    /** Cap on adaptive paging when a burst of new listings is found. */
    maxPagesToScan: intEnv('MAX_PAGES_TO_SCAN', 12, { min: 1, max: 50 }),

    /** How many checks a single process performs before exiting. */
    pollIterations: intEnv('POLL_ITERATIONS', 1, { min: 1, max: 60 }),

    /** Seconds between checks inside one process. */
    pollIntervalSeconds: intEnv('POLL_INTERVAL_SECONDS', 60, { min: 10, max: 3600 }),

    /** Safety valve: never send more than this many messages in one check. */
    maxNotificationsPerCheck: intEnv('MAX_NOTIFICATIONS_PER_CHECK', 25, { min: 1, max: 100 }),

    /** How many listing keys to remember per source, for de-duplication. */
    seenIdsToKeep: intEnv('SEEN_IDS_TO_KEEP', 1000, { min: 100, max: 20000 }),

    statePath: process.env.STATE_PATH || 'state.json',
  };
}
