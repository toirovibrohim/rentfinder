/**
 * Translates the website's `entity_purpose` / `entity_type` URL filters into
 * the `category` + `property_type` parameters its API actually understands.
 *
 * This matters more than it looks. The API accepts `entity_purpose` and
 * `entity_type` and then ignores them completely — a long-term-rent search
 * still returns daily rentals ("посуточно") and sale listings. Only
 * `category` narrows the deal type.
 */

const DICTIONARY_URL = 'https://api.joymee.uz/api/v1/dictionary/category/';

/** URL value -> deal type id, as used by joymee.uz itself. */
const DEAL_TYPES = {
  daily_rent: 1,
  long_term_rent: 2,
  sale: 3,
  client_long_term_rent: 101,
  client_sale: 102,
  buyer: 102,
};

/** URL value -> property type id. */
const PROPERTY_TYPES = {
  apartment: 1,
  house: 2,
  house_cottage: 2,
  hotel: 3,
  commercial: 4,
  land: 5,
};

/**
 * Fallback category ids, keyed by `dealType:propertyType`.
 * Used only when the live dictionary cannot be fetched.
 */
const FALLBACK_CATEGORIES = {
  '1:1': 1, '1:2': 2, '1:3': 3,
  '2:1': 4, '2:2': 5, '2:4': 6, '2:5': 7,
  '3:1': 8, '3:2': 9, '3:4': 10, '3:5': 11,
  '101:1': 12, '101:2': 13, '101:4': 14, '101:5': 15,
  '102:1': 16, '102:2': 17, '102:4': 18, '102:5': 19,
};

let cachedLookup = null;

/** Fetches the live deal-type/property-type -> category id table. */
async function fetchCategoryLookup() {
  if (cachedLookup) return cachedLookup;

  try {
    const res = await fetch(DICTIONARY_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    const data = await res.json();
    const groups = Array.isArray(data) ? data : data.results;
    if (!Array.isArray(groups) || groups.length === 0) throw new Error('empty dictionary');

    const lookup = {};
    for (const group of groups) {
      for (const item of group.items || []) {
        lookup[`${group.deal_type}:${item.property_type}`] = item.id;
      }
    }
    if (Object.keys(lookup).length === 0) throw new Error('no categories in dictionary');

    cachedLookup = { lookup, live: true };
  } catch (err) {
    console.warn(
      `Could not load the category dictionary (${err.message}); using the built-in table.`
    );
    cachedLookup = { lookup: FALLBACK_CATEGORIES, live: false };
  }

  return cachedLookup;
}

/** Splits a param that may be repeated and/or comma-separated. */
function splitValues(params, key) {
  return params
    .getAll(key)
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Replaces `entity_purpose` / `entity_type` in-place with the real
 * `category` and `property_type` filters.
 *
 * Returns a short description of what it did, for logging.
 */
export async function applyCategoryFilter(params) {
  const purposes = splitValues(params, 'entity_purpose');
  const types = splitValues(params, 'entity_type').filter((t) => t !== 'all');

  // Nothing to translate, and nothing already set by hand.
  if (purposes.length === 0) return { applied: false, reason: 'no entity_purpose in URL' };

  params.delete('entity_purpose');
  params.delete('entity_type');

  // Respect a category the user set explicitly.
  if (params.has('category')) {
    return { applied: false, reason: 'category already set explicitly' };
  }

  const dealTypes = purposes.map((p) => DEAL_TYPES[p]).filter((d) => typeof d === 'number');
  if (dealTypes.length === 0) {
    return { applied: false, reason: `unknown entity_purpose: ${purposes.join(', ')}` };
  }

  const propertyTypes = types.map((t) => PROPERTY_TYPES[t]).filter((p) => typeof p === 'number');

  const { lookup, live } = await fetchCategoryLookup();

  // No property type given means "any" — take every category for these deal types.
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
  if (unique.length === 0) {
    return {
      applied: false,
      reason: `no category matches ${purposes.join(',')} + ${types.join(',') || 'any'}`,
    };
  }

  params.set('category', unique.join(','));
  if (propertyTypes.length > 0) {
    params.set('property_type', [...new Set(propertyTypes)].sort((a, b) => a - b).join(','));
  }

  return {
    applied: true,
    categories: unique,
    source: live ? 'live dictionary' : 'built-in table',
  };
}
