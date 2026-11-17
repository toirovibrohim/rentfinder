/** Configuration: which searches to watch, and how often. */

import { readFileSync } from 'node:fs';

/**
 * Searches watched when SEARCH_URLS is not set. One URL per site, copied
 * from that site's address bar with the filters applied.
 *
 * All three are apartments for long-term rent in Tashkent, with no price or
 * room limits. Private owners only where the site supports it — joymee and
 * OLX do, uybor has no such filter and no way to tell from a listing, so it
 * includes agencies.
 */
export const DEFAULT_SEARCH_URLS = [
  // joymee: long-term rent, apartments, Tashkent city, private owners.
  'https://joymee.uz/?entity_purpose=long_term_rent&entity_type=apartment' +
    '&region=59&advertiser=1',

  // uybor: rent, apartments, Tashkent. No owner-only filter exists here.
  'https://uybor.uz/listings?operationType__eq=rent&category__eq=7&region__eq=13',

  // olx: long-term rent, apartments, Tashkent, private sellers, with photos.
  'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/' +
    '?search%5Bprivate_business%5D=private&search%5Bphotos%5D=1',
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

    /**
     * Most of today's listings to send someone approved part-way through the
     * day. Beyond this they get the most recent, and are told so.
     */
    maxBackfillListings: intEnv('MAX_BACKFILL_LISTINGS', 30, { min: 1, max: 200 }),

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
