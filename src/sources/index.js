/** Registry of the sites the watcher knows how to read. */

import * as joymee from './joymee.js';
import * as uybor from './uybor.js';
import * as olx from './olx.js';

const SOURCES = [joymee, uybor, olx];

/**
 * De-duplicates by key and orders newest first.
 *
 * Both of these sites pin promoted listings to the top of every page
 * regardless of sort order, and those can be days old. Without this a pinned
 * old ad looks like the newest listing and drags the watermark backwards.
 * Promoted ads also repeat across pages, hence the de-duplication.
 */
export function dedupeAndSort(listings) {
  const byKey = new Map();
  for (const listing of listings) {
    if (!byKey.has(listing.key)) byKey.set(listing.key, listing);
  }
  return [...byKey.values()].sort((a, b) => (b.adsAtMs ?? 0) - (a.adsAtMs ?? 0));
}

/** Picks the adapter for a search URL by its hostname. */
const HOSTS = {
  'joymee.uz': joymee,
  'www.joymee.uz': joymee,
  'api.joymee.uz': joymee,
  'uybor.uz': uybor,
  'www.uybor.uz': uybor,
  'api.uybor.uz': uybor,
  'olx.uz': olx,
  'www.olx.uz': olx,
  'm.olx.uz': olx,
};

export function sourceForUrl(searchUrl) {
  let host;
  try {
    host = new URL(searchUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`Not a valid search URL: ${JSON.stringify(searchUrl)}`);
  }

  const source = HOSTS[host];
  if (!source) {
    throw new Error(
      `No adapter for ${host}. Supported: ${Object.keys(HOSTS).filter((h) => !h.startsWith('api.') && !h.startsWith('www.')).join(', ')}`
    );
  }
  return source;
}

export function sourceByName(name) {
  const source = SOURCES.find((s) => s.name === name);
  if (!source) throw new Error(`Unknown source: ${name}`);
  return source;
}

export { SOURCES };
