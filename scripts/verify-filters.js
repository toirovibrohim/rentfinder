#!/usr/bin/env node
/**
 * Shows what each configured search currently matches, and checks that the
 * filters are actually being applied. Sends nothing to Telegram.
 *
 *   npm run verify
 *
 * Both of these APIs accept filter parameters and silently ignore some of
 * them, so this drops each filter in turn and reports any that make no
 * difference to the result count.
 */

import { DEFAULT_SEARCH_URLS, loadDotEnv } from '../src/config.js';
import { sourceForUrl } from '../src/sources/index.js';

loadDotEnv();

function searchUrls() {
  const many = process.env.SEARCH_URLS;
  if (many && many.trim()) return many.split(/[\n,]+/).map((u) => u.trim()).filter(Boolean);
  if (process.env.SEARCH_URL) return [process.env.SEARCH_URL.trim()];
  return DEFAULT_SEARCH_URLS;
}

/** Result count for a query, by asking for a single listing. */
async function countFor(source, search) {
  const probe = { ...search, params: new URLSearchParams(search.params), clientFilters: [] };
  const { filteredCount } = await source.fetchListings(probe, { pages: 1, maxPages: 1 });
  return filteredCount;
}

async function checkFilters(source, search) {
  const keys = [...new Set([...search.params.keys()])].filter(
    (k) => !['ordering', 'order', 'page', 'limit', 'offset'].includes(k)
  );

  if (keys.length === 0) {
    console.log('  (no server-side filters in this search)');
    return;
  }

  const base = await countFor(source, search);

  for (const key of keys) {
    const stripped = new URLSearchParams(search.params);
    stripped.delete(key);
    const without = await countFor(source, { ...search, params: stripped });

    if (base === without) {
      console.log(`  ⚠️  ${key}: NO EFFECT — ${base} results either way`);
    } else {
      console.log(`  ✅ ${key}: active — ${base} with, ${without} without`);
    }
  }
}

async function main() {
  for (const url of searchUrls()) {
    const source = sourceForUrl(url);
    const search = await source.buildSearch(url);

    console.log(`\n${'='.repeat(70)}`);
    console.log(`${source.label}`);
    console.log(`  url:   ${url}`);
    console.log(`  query: ${search.describe()}`);
    for (const note of search.notes || []) console.log(`  note:  ${note}`);
    console.log('');

    await checkFilters(source, search);

    const { listings, filteredCount } = await source.fetchListings(search, { pages: 1, maxPages: 1 });
    console.log(`\n  matching now: ${filteredCount ?? '?'}`);
    console.log(`  newest ${Math.min(6, listings.length)}:\n`);

    for (const l of listings.slice(0, 6)) {
      const price = l.price === null ? '—' : `${l.price} ${l.currency}`;
      const when = l.adsAt ? l.adsAt.replace('T', ' ').slice(0, 16) : '—';
      const specs = [l.rooms && `${l.rooms}rm`, l.areaM2 && `${l.areaM2}m2`].filter(Boolean).join(' ');
      console.log(`   ${when}  ${price.padEnd(12)} ${specs.padEnd(12)} ${l.title.slice(0, 44)}`);
      console.log(`   ${' '.repeat(16)}  ${l.url}`);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
