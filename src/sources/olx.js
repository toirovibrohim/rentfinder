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

/**
 * City from the path. Without one the API returns the whole country —
 * Samarkand, Chirchik and Fergana come back alongside Tashkent.
 */
const CITIES = {
  tashkent: 4,
  toshkent: 4,
  samarkand: 2,
  andijan: 1,
  bukhara: 3,
  fergana: 5,
  namangan: 7,
  nukus: 8,
  qarshi: 9,
  urgench: 12,
};

const PAGE_SIZE = 50;

/**
 * Price filters on this site are written in USD, matching how rents are
 * quoted locally, but listings are posted in either USD or som.
 */
const PRICE_CURRENCY = 'USD';

/**
 * Som per dollar, for comparing a som-priced listing against a dollar limit.
 * Approximate by nature — set OLX_UZS_PER_USD to keep it current. A listing
 * near the limit may fall on the wrong side of it as the rate drifts.
 */
const UZS_PER_USD = Number.parseFloat(process.env.OLX_UZS_PER_USD || '') || 12600;

/**
 * Currencies that already mean dollars.
 *
 * Rents here are usually quoted in "у.е." — conventional units, a dollar in
 * all but name — which this API reports as UYE. Treating that as unknown
 * would let every such listing skip the price filter entirely.
 */
const DOLLAR_CURRENCIES = new Set(['USD', 'UYE', 'U.E.', 'У.Е.', 'УЕ', 'YE']);
const SOM_CURRENCIES = new Set(['UZS', 'SUM', 'СУМ', 'SO‘M', "SO'M"]);

/** A listing's price in dollars, or null when it cannot be compared. */
function toPriceCurrency(listing) {
  if (listing.price === null || !Number.isFinite(listing.price)) return null;

  const currency = (listing.currency || '').toUpperCase();
  if (DOLLAR_CURRENCIES.has(currency)) return listing.price;
  if (SOM_CURRENCIES.has(currency)) return listing.price / UZS_PER_USD;
  return null;
}

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

  const citySegment = segments.find((s) => s in CITIES);
  if (citySegment) {
    params.set('city_id', String(CITIES[citySegment]));
    notes.push(`city=${CITIES[citySegment]} (${citySegment})`);
  } else {
    notes.push('no city in the URL — the whole country is included');
  }

  const rooms = [];

  for (const [rawKey, value] of parsed.searchParams.entries()) {
    if (!value) continue;

    // search[filter_float_price:to] -> filter_float_price:to
    const inner = rawKey.match(/^search\[([^\]]+)\]/);
    if (!inner) continue;
    const key = inner[1];

    // The API accepts the price filter and ignores it — listings far above
    // the limit come back — so it is applied to the results instead.
    if (key === 'filter_float_price:from' || key === 'filter_float_price:to') {
      const bound = Number.parseFloat(value);
      if (!Number.isFinite(bound)) continue;
      const isMax = key.endsWith(':to');

      clientFilters.push({
        describe: `price ${isMax ? '<=' : '>='} ${bound} ${PRICE_CURRENCY}`,
        test: (listing) => {
          const amount = toPriceCurrency(listing);
          if (amount === null) return true; // unpriced or unknown currency: keep
          return isMax ? amount <= bound : amount >= bound;
        },
      });
      notes.push(`price checked after fetching: ${isMax ? 'max' : 'min'} ${bound} ${PRICE_CURRENCY}`);
      continue;
    }

    if (key === 'filter_enum_number_of_rooms') {
      rooms.push(value);
      continue;
    }

    if (key === 'city_id' || key === 'district_id' || key === 'region_id') {
      params.set(key, value);
      continue;
    }

    // Every private-seller param returns the same count as no filter, so it
    // is checked on the results. The ads carry a `business` flag, and most
    // of them are agencies — in one sample, 44 of 51.
    if (key === 'private_business' && value === 'private') {
      clientFilters.push({
        describe: 'private sellers only',
        test: (listing) => listing.isBusiness === false,
      });
      notes.push('private sellers only, checked after fetching');
      continue;
    }

    if (key === 'photos' && (value === '1' || value === 'true')) {
      clientFilters.push({
        describe: 'has at least one photo',
        test: (listing) => Boolean(listing.image),
      });
      notes.push('listings with a photo only, checked after fetching');
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
    // `business` distinguishes agencies from private sellers. Undefined
    // rather than false when absent, so an unknown is never taken as private.
    isBusiness: typeof raw.business === 'boolean' ? raw.business : null,
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
      // The CDN refuses roughly one request in five at random, so a handful
      // of spaced-out attempts is what makes this usable. It backs off
      // between them rather than hammering.
      attempts: 4,
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
