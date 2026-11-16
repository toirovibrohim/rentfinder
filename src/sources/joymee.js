/**
 * joymee.uz adapter.
 *
 * Three quirks of this API, each found by testing, each of which would
 * otherwise send the wrong apartments:
 *
 *  - `room_qty_min` / `room_qty_max` from the website URL are accepted and
 *    silently ignored. Only `room_quantity_*` actually filters.
 *  - `entity_purpose` / `entity_type` are ignored too, so a long-term-rent
 *    search also returns daily rentals and sales. They must be translated
 *    into the `category` filter, via the site's own category dictionary.
 *  - Promoted ads are pinned to the top whatever the sort order, and can be
 *    days old, so results are re-sorted by publish time.
 *
 * Phone number, area, rooms and floor are absent from search results and
 * only exist on the per-listing detail endpoint.
 */

import { fetchJson } from '../http.js';
import { dedupeAndSort } from './index.js';

export const name = 'joymee';
export const label = 'joymee.uz';

const API_URL = 'https://api.joymee.uz/api/v1/announcement/';
const SITE_BASE = 'https://joymee.uz';
const DICTIONARY_URL = 'https://api.joymee.uz/api/v1/dictionary/category/';

/** Params that belong to the web UI only. */
const UI_ONLY_PARAMS = new Set(['step', 'page', 'lang', 'locale']);

/** Website URL spelling -> the spelling the API honours. */
const PARAM_ALIASES = {
  room_qty_min: 'room_quantity_min',
  room_qty_max: 'room_quantity_max',
};

const DEAL_TYPES = {
  daily_rent: 1,
  long_term_rent: 2,
  sale: 3,
  client_long_term_rent: 101,
  client_sale: 102,
  buyer: 102,
};

const PROPERTY_TYPES = {
  apartment: 1,
  house: 2,
  house_cottage: 2,
  hotel: 3,
  commercial: 4,
  land: 5,
};

/** Used only if the live category dictionary cannot be fetched. */
const FALLBACK_CATEGORIES = {
  '1:1': 1, '1:2': 2, '1:3': 3,
  '2:1': 4, '2:2': 5, '2:4': 6, '2:5': 7,
  '3:1': 8, '3:2': 9, '3:4': 10, '3:5': 11,
  '101:1': 12, '101:2': 13, '101:4': 14, '101:5': 15,
  '102:1': 16, '102:2': 17, '102:4': 18, '102:5': 19,
};

let cachedLookup = null;

async function categoryLookup() {
  if (cachedLookup) return cachedLookup;

  try {
    const data = await fetchJson(DICTIONARY_URL, { attempts: 2, referer: SITE_BASE + '/' });
    const groups = Array.isArray(data) ? data : data.results;
    if (!Array.isArray(groups) || groups.length === 0) throw new Error('empty dictionary');

    const lookup = {};
    for (const group of groups) {
      for (const item of group.items || []) {
        lookup[`${group.deal_type}:${item.property_type}`] = item.id;
      }
    }
    if (Object.keys(lookup).length === 0) throw new Error('no categories');

    cachedLookup = { lookup, live: true };
  } catch (err) {
    console.warn(`  [joymee] category dictionary unavailable (${err.message}); using built-in table`);
    cachedLookup = { lookup: FALLBACK_CATEGORIES, live: false };
  }

  return cachedLookup;
}

function splitValues(params, key) {
  return params
    .getAll(key)
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Turns a joymee.uz browser URL into the query its API actually honours. */
export async function buildSearch(searchUrl) {
  const parsed = new URL(searchUrl);
  const params = new URLSearchParams();

  for (const [key, value] of parsed.searchParams.entries()) {
    if (UI_ONLY_PARAMS.has(key) || value === '') continue;
    params.append(PARAM_ALIASES[key] ?? key, value);
  }

  if (!params.has('ordering')) params.set('ordering', 'newest');

  const notes = [];

  const purposes = splitValues(params, 'entity_purpose');
  const types = splitValues(params, 'entity_type').filter((t) => t !== 'all');
  params.delete('entity_purpose');
  params.delete('entity_type');

  if (purposes.length > 0 && !params.has('category')) {
    const dealTypes = purposes.map((p) => DEAL_TYPES[p]).filter((n) => typeof n === 'number');
    const propertyTypes = types.map((t) => PROPERTY_TYPES[t]).filter((n) => typeof n === 'number');

    if (dealTypes.length === 0) {
      notes.push(`unknown entity_purpose (${purposes.join(',')}) — deal type not narrowed`);
    } else {
      const { lookup, live } = await categoryLookup();
      const categories = [];

      for (const dealType of dealTypes) {
        if (propertyTypes.length > 0) {
          for (const propertyType of propertyTypes) {
            const id = lookup[`${dealType}:${propertyType}`];
            if (typeof id === 'number') categories.push(id);
          }
        } else {
          for (const [key, id] of Object.entries(lookup)) {
            if (key.startsWith(`${dealType}:`)) categories.push(id);
          }
        }
      }

      const unique = [...new Set(categories)].sort((a, b) => a - b);
      if (unique.length > 0) {
        params.set('category', unique.join(','));
        if (propertyTypes.length > 0) {
          params.set('property_type', [...new Set(propertyTypes)].sort((a, b) => a - b).join(','));
        }
        notes.push(`category=${unique.join(',')} (${live ? 'live dictionary' : 'built-in table'})`);
      } else {
        notes.push('no matching category — deal type not narrowed');
      }
    }
  } else if (purposes.length === 0) {
    notes.push('no entity_purpose in URL — all deal types included');
  }

  return { params, notes, describe: () => params.toString() };
}

function normalise(raw) {
  const pricing = raw.pricing || {};
  const priceValue = pricing.price ?? pricing.price_from ?? null;
  const price = priceValue === null ? null : Number.parseFloat(priceValue);

  return {
    source: name,
    sourceLabel: label,
    id: raw.id,
    key: `${name}:${raw.id}`,
    title: (raw.title || '').trim() || 'Untitled listing',
    price: Number.isFinite(price) ? price : null,
    currency: (pricing.currency_display || '').trim(),
    address: (raw.address_line || '').trim(),
    image: raw.image || null,
    adsAt: raw.ads_at || null,
    adsAtMs: raw.ads_at ? Date.parse(raw.ads_at) : null,
    author: raw.created_by?.full_name?.trim() || raw.created_by?.username || null,
    isVip: raw.subscription === 2,
    url: `${SITE_BASE}/announcements/${raw.id}`,
    // Filled in by fetchDetail.
    rooms: null, areaM2: null, floor: null, floorsTotal: null, phone: null,
  };
}

export async function fetchListings(search, { pages = 1, maxPages = 12, isKnown = null } = {}) {
  const collected = [];
  let filteredCount = null;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams(search.params);
    params.set('page', String(page));

    const data = await fetchJson(`${API_URL}?${params.toString()}`, { referer: SITE_BASE + '/' });
    pagesFetched = page;

    if (filteredCount === null) filteredCount = data.filtered_count ?? null;

    const batch = (Array.isArray(data.results) ? data.results : [])
      .filter((raw) => raw && typeof raw.id !== 'undefined')
      .map(normalise);
    collected.push(...batch);

    if (!data.next || batch.length === 0) break;
    if (page < pages) continue;
    if (!isKnown || batch.every((l) => isKnown(l))) break;
  }

  return { listings: dedupeAndSort(collected), filteredCount, pagesFetched };
}

/** Phone, area, rooms and floor live only on the detail endpoint. */
export async function fetchDetail(listing) {
  try {
    const data = await fetchJson(`${API_URL}${listing.id}/`, {
      attempts: 2,
      referer: SITE_BASE + '/',
    });
    const detail = data.detail || {};
    const num = (v) => {
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : null;
    };

    return {
      phone: (data.phone_number || '').trim() || null,
      areaM2: num(detail.area_m2),
      rooms: num(detail.room_quantity),
      floor: num(detail.floor_number),
      floorsTotal: num(detail.floors_count),
    };
  } catch (err) {
    console.warn(`  [joymee] no details for ${listing.id}: ${err.message}`);
    return {};
  }
}
