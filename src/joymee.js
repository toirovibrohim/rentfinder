/** Talks to joymee.uz's public listing API. */

import { API_URL, SITE_BASE } from './config.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 20000;

async function fetchJson(url, { attempts = 3 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'ru,uz;q=0.9,en;q=0.8',
          'User-Agent': USER_AGENT,
          Referer: SITE_BASE + '/',
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        // 4xx other than 429 will not get better by retrying.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`Joymee API returned ${res.status} ${res.statusText} (not retrying)`);
        }
        throw new Error(`Joymee API returned ${res.status} ${res.statusText}`);
      }

      return await res.json();
    } catch (err) {
      lastError = err;
      if (err.message?.includes('not retrying') || attempt === attempts) break;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/** Permanent public URL of a listing. */
export function listingUrl(id) {
  return `${SITE_BASE}/announcements/${id}`;
}

/**
 * Fetches the extra fields the search results leave out — phone number, floor
 * area, room count, floor. One request per listing, so this is only done for
 * listings that are about to be sent.
 *
 * Returns {} if the listing cannot be loaded; the notification still goes out
 * with whatever the search results provided.
 */
export async function fetchListingDetail(id) {
  try {
    const data = await fetchJson(`${API_URL}${id}/`, { attempts: 2 });
    const detail = data.detail || {};

    const area = Number.parseFloat(detail.area_m2);
    const rooms = Number.parseInt(detail.room_quantity, 10);
    const floor = Number.parseInt(detail.floor_number, 10);
    const floorsTotal = Number.parseInt(detail.floors_count, 10);

    return {
      phone: (data.phone_number || '').trim() || null,
      areaM2: Number.isFinite(area) ? area : null,
      rooms: Number.isFinite(rooms) ? rooms : null,
      floor: Number.isFinite(floor) ? floor : null,
      floorsTotal: Number.isFinite(floorsTotal) ? floorsTotal : null,
      description: (data.description || '').trim() || null,
    };
  } catch (err) {
    console.warn(`  could not load details for ${id}: ${err.message}`);
    return {};
  }
}

/** Normalises one API result into the shape the rest of the app uses. */
function normalise(raw) {
  const pricing = raw.pricing || {};
  const priceValue = pricing.price ?? pricing.price_from ?? null;

  return {
    id: raw.id,
    title: (raw.title || '').trim() || 'Untitled listing',
    price: priceValue === null ? null : Number.parseFloat(priceValue),
    priceRaw: priceValue,
    currency: (pricing.currency_display || '').trim(),
    address: (raw.address_line || '').trim(),
    image: raw.image || null,
    // When the ad went live. This is what "newly added" is judged on.
    adsAt: raw.ads_at || null,
    adsAtMs: raw.ads_at ? Date.parse(raw.ads_at) : null,
    author: raw.created_by?.full_name?.trim() || raw.created_by?.username || null,
    isVip: raw.subscription === 2,
    url: listingUrl(raw.id),
  };
}

/**
 * Fetches listings matching the search, newest first.
 *
 * Paging is adaptive: it always reads `pages` pages, then keeps going while
 * the last page still held listings that `isKnown` did not recognise. Agencies
 * on this site publish ten or more ads in the same second, so a fixed page
 * count would silently drop the overflow. A normal quiet check still costs
 * only `pages` requests.
 *
 * The API pins promoted ("VIP") ads to the top regardless of sort order, so
 * results are re-sorted by publish time before they are returned.
 */
export async function fetchListings(
  searchParams,
  { pages = 1, maxPages = 12, isKnown = null } = {}
) {
  const collected = [];
  let filteredCount = null;
  let totalPages = null;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams(searchParams);
    params.set('page', String(page));

    const data = await fetchJson(`${API_URL}?${params.toString()}`);
    pagesFetched = page;

    if (filteredCount === null) filteredCount = data.filtered_count ?? null;
    if (totalPages === null) totalPages = data.total_pages ?? null;

    const results = Array.isArray(data.results) ? data.results : [];
    const batch = [];
    for (const raw of results) {
      if (raw && typeof raw.id !== 'undefined') batch.push(normalise(raw));
    }
    collected.push(...batch);

    if (!data.next || batch.length === 0) break;
    if (page < pages) continue;

    // Past the guaranteed pages: stop as soon as a page holds nothing new.
    if (!isKnown) break;
    if (batch.every((listing) => isKnown(listing))) break;
  }

  // De-duplicate across pages (promoted ads repeat), then newest first.
  const byId = new Map();
  for (const item of collected) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }

  const listings = [...byId.values()].sort((a, b) => (b.adsAtMs ?? 0) - (a.adsAtMs ?? 0));

  return { listings, filteredCount, totalPages, pagesFetched };
}
