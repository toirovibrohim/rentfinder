/**
 * uybor.uz adapter.
 *
 * Its API is generous: rooms, area, floor and price all come back in the
 * listing results, so no per-listing request is needed.
 *
 * Filters use a `field__op` convention (`operationType__eq=rent`,
 * `square__gte=50`). Testing showed that `__eq` works for operationType,
 * category, district and priceCurrency — but `room__gte/__lte` are ignored
 * (room is stored as a string) and `price__lte` matches nothing. Those two
 * are therefore applied here, over the fields the API already returns, which
 * also means a filter can never be silently dropped.
 */

import { fetchJson } from '../http.js';
import { dedupeAndSort } from './index.js';

export const name = 'uybor';
export const label = 'uybor.uz';

const API_URL = 'https://api.uybor.uz/api/v1/listings';
const SITE_BASE = 'https://uybor.uz';

/** Params the API honours, so they can be sent rather than post-filtered. */
const SERVER_SIDE = new Set([
  'operationType__eq',
  'category__eq',
  'district__eq',
  'region__eq',
  'city__eq',
  'priceCurrency__eq',
  'square__gte',
  'square__lte',
  'isNewBuilding__eq',
  'repair__eq',
]);

/** Params the API accepts but ignores, so they must be applied to results. */
const CLIENT_SIDE = new Set(['room__gte', 'room__lte', 'room__eq', 'price__gte', 'price__lte']);

const UI_ONLY = new Set(['page', 'limit', 'offset', 'order', 'lang', 'locale']);

/**
 * Splits a uybor.uz browser URL into the query to send and the checks to
 * apply afterwards.
 */
export function buildSearch(searchUrl) {
  const parsed = new URL(searchUrl);
  const params = new URLSearchParams();
  const clientFilters = [];
  const notes = [];
  const ignored = [];

  for (const [key, value] of parsed.searchParams.entries()) {
    if (UI_ONLY.has(key) || value === '') continue;

    if (SERVER_SIDE.has(key)) {
      params.append(key, value);
      continue;
    }

    if (CLIENT_SIDE.has(key)) {
      const [field, op] = key.split('__');
      const bound = Number.parseFloat(value);
      if (!Number.isFinite(bound)) continue;

      clientFilters.push({
        describe: `${field} ${op === 'gte' ? '>=' : op === 'eq' ? '==' : '<='} ${bound}`,
        test: (listing) => {
          const actual = field === 'room' ? listing.rooms : listing.price;
          // "6+" rooms and missing values cannot be compared; keep them.
          if (actual === null || !Number.isFinite(actual)) return true;
          if (op === 'eq') return actual === bound;
          return op === 'gte' ? actual >= bound : actual <= bound;
        },
      });
      continue;
    }

    ignored.push(key);
  }

  // Ordered by when a listing last surfaced, not when it was first written.
  //
  // Landlords here re-promote rather than repost: on one check, zero rent
  // listings had been created that day while all fifty on page one had been
  // bumped, some first posted in 2022. Going by creation time meant the site
  // looked dead for a whole day while its front page was busy. joymee only
  // exposes a bump time, so this also makes the three sites agree on what
  // "new" means. De-duplication is by id, so a listing bumped repeatedly is
  // still only ever sent once.
  params.set('order', 'updatedAt');

  if (clientFilters.length > 0) {
    notes.push(`applied after fetching: ${clientFilters.map((f) => f.describe).join(', ')}`);
  }
  if (ignored.length > 0) {
    notes.push(`not understood, ignored: ${ignored.join(', ')}`);
  }
  if (params.has('operationType__eq')) {
    notes.push(`operationType=${params.get('operationType__eq')}`);
  }

  return {
    params,
    clientFilters,
    notes,
    describe: () => params.toString(),
  };
}

function normalise(raw) {
  const cover = (raw.media || []).find((m) => m?.url) || null;
  const rooms = Number.parseInt(raw.room, 10);
  const price = Number.parseFloat(raw.price);
  const square = Number.parseFloat(raw.square);

  return {
    source: name,
    sourceLabel: label,
    id: raw.id,
    key: `${name}:${raw.id}`,
    title: (raw.description || '').trim().split('\n')[0].slice(0, 90) || 'Untitled listing',
    price: Number.isFinite(price) ? price : null,
    currency: (raw.priceCurrency || '').toUpperCase(),
    // Often just a building number. uybor exposes a districtId too, but it
    // sits in a different id space from the locations endpoint, which
    // refuses to resolve it — so this is as specific as the data gets.
    address: (raw.address || '').trim(),
    image: cover?.url || null,
    // When it last surfaced on the site — see the ordering note above.
    adsAt: raw.updatedAt || raw.createdAt || null,
    adsAtMs: Date.parse(raw.updatedAt || raw.createdAt || '') || null,
    postedAt: raw.createdAt || null,
    author: null,
    isVip: Boolean(raw.isVip || raw.isPremium),
    url: `${SITE_BASE}/listing/${raw.id}`,
    // Already present — no detail request needed.
    rooms: Number.isFinite(rooms) ? rooms : null,
    areaM2: Number.isFinite(square) ? square : null,
    floor: Number.isFinite(raw.floor) ? raw.floor : null,
    floorsTotal: Number.isFinite(raw.floorTotal) ? raw.floorTotal : null,
    phone: null,
  };
}

const PAGE_SIZE = 50;

export async function fetchListings(search, { pages = 1, maxPages = 12, isKnown = null } = {}) {
  const collected = [];
  let filteredCount = null;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams(search.params);
    params.set('limit', String(PAGE_SIZE));
    // Paging is by `page`. The API also accepts `offset` and `skip` and
    // ignores both, returning page one every time — which silently turns
    // deeper paging into the same request repeated.
    params.set('page', String(page));

    const data = await fetchJson(`${API_URL}?${params.toString()}`, { referer: SITE_BASE + '/' });
    pagesFetched = page;

    if (filteredCount === null) filteredCount = data.total ?? null;

    const raw = Array.isArray(data.results) ? data.results : [];
    const onPage = raw.filter((r) => r && typeof r.id !== 'undefined').map(normalise);
    const batch = onPage.filter((listing) => search.clientFilters.every((f) => f.test(listing)));

    collected.push(...batch);

    // Stop on the raw page being short, not the filtered one: a page can
    // legitimately filter down to nothing while more results remain.
    if (raw.length < PAGE_SIZE) break;
    if (page < pages) continue;
    // Judged on the whole page, not the filtered subset. Most listings are
    // filtered out here, so a page can easily yield nothing while deeper
    // pages still hold new ones — and [].every() is true, which would stop
    // paging exactly when it should continue.
    if (!isKnown || onPage.every((l) => isKnown(l))) break;
  }

  return { listings: dedupeAndSort(collected), filteredCount, pagesFetched };
}

/** Everything is already in the listing results. */
export async function fetchDetail() {
  return {};
}
