#!/usr/bin/env node
/**
 * Sanity-checks that joymee.uz's API actually honours the filters in SEARCH_URL,
 * and prints what the watcher currently sees. Sends nothing to Telegram.
 *
 *   npm run verify
 */

import { API_URL, DEFAULT_SEARCH_URL, buildSearchParams, loadDotEnv } from '../src/config.js';
import { applyCategoryFilter } from '../src/categories.js';
import { fetchListings } from '../src/joymee.js';

loadDotEnv();

const SEARCH_URL = process.env.SEARCH_URL || DEFAULT_SEARCH_URL;

async function countFor(params) {
  const res = await fetch(`${API_URL}?${params.toString()}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.filtered_count ?? null;
}

/** Drops one filter and reports whether the result count changes. */
async function checkFilterHasEffect(baseParams, keys) {
  const stripped = new URLSearchParams(baseParams);
  for (const key of keys) stripped.delete(key);

  const [withFilter, withoutFilter] = await Promise.all([
    countFor(baseParams),
    countFor(stripped),
  ]);

  const label = keys.join(', ');
  if (withFilter === withoutFilter) {
    console.log(`  ⚠️  ${label}: NO EFFECT — ${withFilter} results either way`);
    return false;
  }
  console.log(`  ✅ ${label}: active — ${withFilter} with, ${withoutFilter} without`);
  return true;
}

async function main() {
  const params = buildSearchParams(SEARCH_URL);
  const category = await applyCategoryFilter(params);

  console.log(`Search URL : ${SEARCH_URL}`);
  console.log(`API query  : ${params.toString()}`);
  console.log(
    `Deal type  : ${
      category.applied
        ? `category=${category.categories.join(',')} (from ${category.source})`
        : `NOT NARROWED — ${category.reason}`
    }\n`
  );

  console.log('Filter check (does dropping each filter change the result count?)');

  const present = (...keys) => keys.filter((k) => params.has(k));
  const groups = [
    present('category'),
    present('room_quantity_min', 'room_quantity_max'),
    present('max_price', 'min_price'),
    present('district'),
  ].filter((g) => g.length > 0);

  const ineffective = [];
  for (const group of groups) {
    const ok = await checkFilterHasEffect(params, group);
    if (!ok) ineffective.push(group.join(', '));
  }

  const { listings, filteredCount, totalPages } = await fetchListings(params, { pages: 1 });

  console.log(`\nMatching listings: ${filteredCount} across ${totalPages} page(s)`);
  console.log(`Newest ${Math.min(8, listings.length)} on page 1:\n`);

  for (const l of listings.slice(0, 8)) {
    const price = l.price === null ? '—' : `${l.price} ${l.currency}`;
    const when = l.adsAt ? new Date(l.adsAt).toISOString().replace('T', ' ').slice(0, 16) : '—';
    console.log(`  ${when}  ${price.padEnd(12)} ${l.isVip ? 'VIP ' : '    '}${l.title.slice(0, 54)}`);
    console.log(`  ${' '.repeat(16)}  ${l.url}`);
  }

  if (ineffective.length > 0) {
    console.log(
      `\n⚠️  These filters appear to be ignored by the API: ${ineffective.join(' | ')}.\n` +
        `    Listings outside them may be sent to Telegram.`
    );
  } else {
    console.log('\nAll filters in the URL are honoured by the API.');
  }
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
