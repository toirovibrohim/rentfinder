/**
 * Remembers which listings have already been sent, so a restart or an
 * overlapping run never re-notifies the same apartment.
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const EMPTY_STATE = {
  version: 1,
  seeded: false,
  /** Publish time of the newest listing we have already handled. */
  watermark: null,
  /** Recently seen listing IDs, newest last. */
  seenIds: [],
  lastCheckedAt: null,
  lastNotifiedAt: null,
  totalNotified: 0,
};

export async function loadState(statePath) {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...EMPTY_STATE,
      ...parsed,
      seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds : [],
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...EMPTY_STATE };
    // A corrupt state file should not stop the watcher; start fresh but say so.
    console.warn(`State file at ${statePath} is unreadable (${err.message}); starting fresh.`);
    return { ...EMPTY_STATE };
  }
}

export async function saveState(statePath, state) {
  const dir = path.dirname(path.resolve(statePath));
  const tmp = path.join(dir, `.${path.basename(statePath)}.tmp`);
  const json = JSON.stringify(state, null, 2) + '\n';

  // Write then rename so an interrupted run cannot leave a half-written file.
  await writeFile(tmp, json, 'utf8');
  await rename(tmp, statePath);
}

/**
 * Picks out listings that have not been notified about yet.
 *
 * A listing counts as new when its ID has not been seen before. The watermark
 * is a second guard: once the remembered-ID list rolls over, an old listing
 * resurfacing in the results is not treated as new.
 */
export function selectNewListings(listings, state) {
  const isKnown = makeIsKnown(state);
  return listings.filter((listing) => !isKnown(listing));
}

/**
 * Builds the "have we handled this already?" test, so paging can stop as soon
 * as a page holds nothing new.
 */
export function makeIsKnown(state) {
  const seen = new Set(state.seenIds);
  const watermark = state.watermark ? Date.parse(state.watermark) : null;

  return (listing) => {
    if (seen.has(listing.id)) return true;
    if (watermark !== null && listing.adsAtMs !== null && listing.adsAtMs <= watermark) {
      return true;
    }
    return false;
  };
}

/** Records listings as handled and advances the watermark. */
export function recordSeen(state, listings, { seenIdsToKeep }) {
  const seen = new Set(state.seenIds);
  let watermarkMs = state.watermark ? Date.parse(state.watermark) : null;

  for (const listing of listings) {
    seen.add(listing.id);
    if (listing.adsAtMs !== null && (watermarkMs === null || listing.adsAtMs > watermarkMs)) {
      watermarkMs = listing.adsAtMs;
    }
  }

  // Keep insertion order (oldest first) and trim from the front.
  const ordered = [...state.seenIds.filter((id) => seen.has(id))];
  for (const id of seen) {
    if (!ordered.includes(id)) ordered.push(id);
  }

  return {
    ...state,
    seenIds: ordered.slice(-seenIdsToKeep),
    watermark: watermarkMs === null ? state.watermark : new Date(watermarkMs).toISOString(),
  };
}
