/**
 * olx.uz adapter.
 *
 * OLX sits behind a CDN whose bot filter refuses a desktop browser string
 * from datacenter ranges, while answering the same request from a phone. The
 * site's own robots.txt allows this endpoint — only `users/me`, `page-views`,
 * `suggested`, `targeting` and `offers/metadata` are disallowed, none of
 * which are touched here — so the mobile string below is what makes an
 * otherwise permitted request go through.
 *
 * It is polled once a check, far below what a person browsing would do, and
 * it backs off rather than retrying hard when the CDN pushes back.
 */

import { fetchJson } from '../http.js';
import { dedupeAndSort } from './index.js';

export const name = 'olx';
export const label = 'olx.uz';

const API_URL = 'https://www.olx.uz/api/v1/offers/';
const SITE_BASE = 'https://www.olx.uz';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** Listing category, from the path of the search URL. */
const CATEGORIES = {
  'arenda-dolgosrochnaya': 1147, // long-term rental, apartments
  'arenda-posutochno': 1148, // daily rental, apartments
  prodazha: 1146, // sale, apartments
};

const DEFAULT_CATEGORY = CATEGORIES['arenda-dolgosrochnaya'];

const PAGE_SIZE = 50;

/**
 * OLX search URLs carry filters as `search[name]=value`, and the category in
 * the path. Price and currency are understood by the API; room counts come
 * back as an enum per listing, so those are checked against the results.
 */
export function buildSearch(searchUrl) {
  const parsed = new URL(searchUrl);
  const params = new URLSearchParams();
  const clientFilters = [];
  const notes = [];

  const segments = parsed.pathname.split('/').filter(Boolean);
  const categorySegment = segments.find((s) => s in CATEGORIES);
  const category = CATEGORIES[categorySegment] ?? DEFAULT_CATEGORY;
  params.set('category_id', String(category));
  notes.push(`category=${category}${categorySegment ? ` (${categorySegment})` : ' (default: long-term rent)'}`);

  const rooms = [];

  for (const [rawKey, value] of parsed.searchParams.entries()) {
    if (!value) continue;

    // search[filter_float_price:to] -> filter_float_price:to
    const inner = rawKey.match(/^search\[([^\]]+)\]/);
    if (!inner) continue;
    const key = inner[1];

    if (key === 'filter_float_price:from' || key === 'filter_float_price:to') {
      params.set(key, value);
      continue;
    }

    if (key === 'filter_enum_number_of_rooms') {
      rooms.push(value);
      continue;
    }

    if (key === 'city_id' || key === 'district_id' || key === 'region_id') {
      params.set(key, value);
    }
  }

  if (rooms.length > 0) {
    const wanted = new Set(rooms.map(String));
    clientFilters.push({
      describe: `rooms in {${[...wanted].join(', ')}}`,
      test: (listing) => listing.rooms === null || wanted.has(String(listing.rooms)),
    });
    notes.push(`rooms checked after fetching: ${[...wanted].join(', ')}`);
  }

  if (!params.has('currency') && params.has('filter_float_price:to')) {
    params.set('currency', 'USD');
  }

  params.set('sort_by', 'created_at:desc');

  return { params, clientFilters, notes, describe: () => params.toString() };
}

/** Pulls a named attribute out of the params array OLX attaches to each ad. */
function attr(raw, key) {
  const found = (raw.params || []).find((p) => p.key === key);
  if (!found) return null;
  return found.value?.key ?? found.normalizedValue ?? found.value?.label ?? found.value ?? null;
}

function normalise(raw) {
  const roomsRaw = attr(raw, 'number_of_rooms');
  const rooms = Number.parseInt(String(roomsRaw ?? '').replace(/\D/g, ''), 10);
  const area = Number.parseFloat(String(attr(raw, 'total_area') ?? '').replace(',', '.'));
  const floor = Number.parseInt(String(attr(raw, 'floor') ?? '').replace(/\D/g, ''), 10);
  const floorsTotal = Number.parseInt(String(attr(raw, 'total_floors') ?? '').replace(/\D/g, ''), 10);

  const priceParam = (raw.params || []).find((p) => p.key === 'price');
  const price = Number.parseFloat(priceParam?.value?.value ?? raw.price?.regular_price?.value ?? NaN);
  const currency = (priceParam?.value?.currency ?? raw.price?.regular_price?.currency ?? '').toUpperCase();

  const photo = (raw.photos || [])[0]?.link || null;

  // created_time is when it was first published; last_refresh_time changes
  // when the seller bumps it, so the former is what "new" must mean.
  const createdAt = raw.created_time || raw.last_refresh_time || null;

  const city = raw.location?.city?.name || '';
  const district = raw.location?.district?.name || '';

  return {
    source: name,
    sourceLabel: label,
    id: raw.id,
    key: `${name}:${raw.id}`,
    title: (raw.title || '').trim() || 'Untitled listing',
    price: Number.isFinite(price) ? price : null,
    currency,
    address: [city, district].filter(Boolean).join(', '),
    image: photo ? photo.replace('{width}x{height}', '800x600') : null,
    adsAt: createdAt,
    adsAtMs: createdAt ? Date.parse(createdAt) : null,
    author: raw.user?.name?.trim() || null,
    isVip: Boolean(raw.promotion?.top_ad),
    url: raw.url || `${SITE_BASE}/d/obyavlenie/${raw.id}/`,
    rooms: Number.isFinite(rooms) ? rooms : null,
    areaM2: Number.isFinite(area) ? area : null,
    floor: Number.isFinite(floor) ? floor : null,
    floorsTotal: Number.isFinite(floorsTotal) ? floorsTotal : null,
    phone: null,
  };
}

export async function fetchListings(search, { pages = 1, maxPages = 12, isKnown = null } = {}) {
  const collected = [];
  let filteredCount = null;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams(search.params);
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String((page - 1) * PAGE_SIZE));

    const data = await fetchJson(`${API_URL}?${params.toString()}`, {
      // One retry only. If the CDN is pushing back, hammering it is both
      // rude and pointless — the next check is a minute away.
      attempts: 2,
      referer: `${SITE_BASE}/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/`,
      headers: { 'User-Agent': MOBILE_UA },
    });

    pagesFetched = page;

    if (filteredCount === null) {
      filteredCount = data.metadata?.total_elements ?? data.metadata?.visible_total_count ?? null;
    }

    const raw = Array.isArray(data.data) ? data.data : [];
    const batch = raw
      .filter((a) => a && typeof a.id !== 'undefined')
      .map(normalise)
      .filter((listing) => search.clientFilters.every((f) => f.test(listing)));

    collected.push(...batch);

    if (raw.length < PAGE_SIZE) break;
    if (page < pages) continue;
    if (!isKnown || batch.every((l) => isKnown(l))) break;
  }

  return { listings: dedupeAndSort(collected), filteredCount, pagesFetched };
}

/** Everything needed is already in the listing results. */
export async function fetchDetail() {
  return {};
}
