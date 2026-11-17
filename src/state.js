/**
 * Remembers which listings have already been sent, per source, so a restart
 * or an overlapping run never re-notifies the same apartment.
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const emptySource = () => ({
  seeded: false,
  /** Publish time of the newest listing already handled, for this source. */
  watermark: null,
  /** Recently seen listing keys, oldest first. */
  seenIds: [],
});

const emptyState = () => ({
  version: 2,
  sources: {},
  totalNotified: 0,
  lastCheckedAt: null,
  lastNotifiedAt: null,
});

/**
 * Version 1 held a single flat set of joymee ids. Those are promoted into the
 * joymee source so an upgrade does not resend everything already notified.
 */
function migrate(parsed) {
  if (parsed.version === 2 && parsed.sources) {
    return { ...emptyState(), ...parsed };
  }

  const state = emptyState();
  state.totalNotified = parsed.totalNotified || 0;
  state.lastCheckedAt = parsed.lastCheckedAt || null;
  state.lastNotifiedAt = parsed.lastNotifiedAt || null;
  state.sources.joymee = {
    seeded: Boolean(parsed.seeded),
    watermark: parsed.watermark || null,
    // v1 stored bare numeric ids; v2 keys are prefixed with the source.
    seenIds: (Array.isArray(parsed.seenIds) ? parsed.seenIds : []).map((id) =>
      String(id).includes(':') ? String(id) : `joymee:${id}`
    ),
  };
  return state;
}

export async function loadState(statePath) {
  try {
    const raw = await readFile(statePath, 'utf8');
    return migrate(JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`State file at ${statePath} is unreadable (${err.message}); starting fresh.`);
    }
    return emptyState();
  }
}

export async function saveState(statePath, state) {
  const dir = path.dirname(path.resolve(statePath));
  const tmp = path.join(dir, `.${path.basename(statePath)}.tmp`);

  // Write then rename, so an interrupted run cannot leave a half-written file.
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(tmp, statePath);
}

export function sourceState(state, sourceName) {
  if (!state.sources[sourceName]) state.sources[sourceName] = emptySource();
  return state.sources[sourceName];
}

/**
 * Builds the "have we handled this already?" test for one source, so paging
 * can stop as soon as a page holds nothing new.
 *
 * A listing is known when its key has been seen before, or when it was
 * published no later than the watermark. The watermark is the second guard:
 * once the remembered-key list rolls over, an old listing resurfacing in the
 * results is not treated as new.
 */
export function makeIsKnown(sourceSt) {
  const seen = new Set(sourceSt.seenIds);
  const watermark = sourceSt.watermark ? Date.parse(sourceSt.watermark) : null;

  return (listing) => {
    if (seen.has(listing.key)) return true;
    if (watermark !== null && listing.adsAtMs !== null && listing.adsAtMs <= watermark) return true;
    return false;
  };
}

export function selectNewListings(listings, sourceSt) {
  const isKnown = makeIsKnown(sourceSt);
  return listings.filter((l) => !isKnown(l));
}

/**
 * Records listings as handled for one source and advances its watermark.
 *
 * `notBeyond` is the publish time of the oldest listing that failed to send.
 * The watermark stops just short of it, because anything at or below the
 * watermark counts as known: without this, one failed send among several
 * successes would be buried by its newer siblings and never retried.
 */
export function recordSeen(sourceSt, listings, { seenIdsToKeep, notBeyond = null }) {
  const known = new Set(sourceSt.seenIds);
  let watermarkMs = sourceSt.watermark ? Date.parse(sourceSt.watermark) : null;

  const added = [];
  for (const listing of listings) {
    if (!known.has(listing.key)) {
      known.add(listing.key);
      added.push(listing.key);
    }
    if (listing.adsAtMs !== null && (watermarkMs === null || listing.adsAtMs > watermarkMs)) {
      watermarkMs = listing.adsAtMs;
    }
  }

  if (notBeyond !== null && watermarkMs !== null && watermarkMs >= notBeyond) {
    watermarkMs = notBeyond - 1;
  }

  sourceSt.seenIds = [...sourceSt.seenIds, ...added].slice(-seenIdsToKeep);
  if (watermarkMs !== null) sourceSt.watermark = new Date(watermarkMs).toISOString();

  return sourceSt;
}
