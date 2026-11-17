#!/usr/bin/env node
/**
 * Exercises the OLX adapter against the live site.
 *
 * This has to run on a GitHub runner: OLX answers runners but not this
 * project's other egress, so a local run will simply report it is blocked.
 * Nothing is sent to Telegram.
 */

import { buildSearch, fetchListings } from '../src/sources/olx.js';

const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${level}::${String(message).replace(/\r?\n/g, ' ')}`);
  }
};

const SEARCH =
  process.env.OLX_SEARCH_URL ||
  'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/' +
    '?search%5Bfilter_float_price%3Ato%5D=600' +
    '&search%5Bfilter_enum_number_of_rooms%5D%5B0%5D=2' +
    '&search%5Bfilter_enum_number_of_rooms%5D%5B1%5D=3';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) {
    failures++;
    // Named individually, because the run log is not readable without
    // repo-admin rights and "1 check failed" says nothing useful.
    annotate('warning', `OLX check failed: ${label}${detail ? ` — ${detail}` : ''}`);
  }
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const search = buildSearch(SEARCH);
  console.log(`search url : ${SEARCH}`);
  console.log(`api query  : ${search.describe()}`);
  for (const note of search.notes) console.log(`note       : ${note}`);
  console.log('');

  check('category resolved', search.params.get('category_id') === '1147', search.params.get('category_id'));
  check('price filter forwarded', search.params.get('filter_float_price:to') === '600');
  check('rooms deferred to results', search.clientFilters.length === 1);

  let result;
  try {
    result = await fetchListings(search, { pages: 1, maxPages: 1 });
  } catch (err) {
    check('reachable', false, err.message);
    annotate('error', `OLX adapter could not fetch: ${err.message}`);
    console.log(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
    return;
  }

  const { listings, filteredCount } = result;
  check('reachable', true, `${filteredCount ?? '?'} match the filters`);
  check('returned listings', listings.length > 0, `${listings.length} on page 1`);

  if (listings.length === 0) {
    annotate('warning', 'OLX adapter reached the API but got no listings.');
    process.exitCode = failures === 0 ? 0 : 1;
    return;
  }

  const withRooms = listings.filter((l) => l.rooms !== null);
  const withPrice = listings.filter((l) => l.price !== null);
  const withTime = listings.filter((l) => l.adsAtMs !== null);

  check('rooms parsed', withRooms.length > 0, `${withRooms.length}/${listings.length}`);
  check('prices parsed', withPrice.length > 0, `${withPrice.length}/${listings.length}`);
  check('publish times parsed', withTime.length === listings.length, `${withTime.length}/${listings.length}`);
  check('every listing has a url', listings.every((l) => /^https?:\/\//.test(l.url)));
  check('keys namespaced', listings.every((l) => l.key.startsWith('olx:')));
  check(
    'sorted newest first',
    listings.every((l, i) => i === 0 || (listings[i - 1].adsAtMs ?? 0) >= (l.adsAtMs ?? 0))
  );
  check(
    'room filter respected',
    withRooms.every((l) => l.rooms === 2 || l.rooms === 3),
    [...new Set(withRooms.map((l) => l.rooms))].join(',')
  );
  check(
    'price filter respected',
    withPrice.every((l) => l.price <= 600),
    `max ${Math.max(...withPrice.map((l) => l.price))}`
  );

  console.log('\nnewest 5:');
  for (const l of listings.slice(0, 5)) {
    const when = l.adsAt ? l.adsAt.slice(0, 16).replace('T', ' ') : '—';
    const specs = [l.rooms && `${l.rooms}rm`, l.areaM2 && `${l.areaM2}m2`, l.floor && `fl${l.floor}`]
      .filter(Boolean)
      .join(' ');
    console.log(`  ${when}  ${String(l.price ?? '—').padStart(6)} ${l.currency.padEnd(4)} ${specs.padEnd(16)} ${l.title.slice(0, 40)}`);
    console.log(`  ${' '.repeat(16)}  ${l.url.slice(0, 84)}`);
  }

  console.log('');
  if (failures === 0) {
    annotate('notice', `OLX adapter works: ${listings.length} listings, ${filteredCount ?? '?'} match the filters.`);
    console.log('All checks passed.');
  } else {
    annotate('error', `OLX adapter: ${failures} check(s) failed.`);
    console.log(`${failures} check(s) failed.`);
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
