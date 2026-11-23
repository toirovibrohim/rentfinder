#!/usr/bin/env node
/**
 * Exercises the OLX adapter against the live site.
 *
 * This has to run on a GitHub runner: OLX answers runners but not this
 * project's other egress, so a local run will simply report it is blocked.
 * Nothing is sent to Telegram.
 */

import { buildSearch, fetchListings } from '../src/sources/olx.js';
import { DEFAULT_SEARCH_URLS } from '../src/config.js';

const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${level}::${String(message).replace(/\r?\n/g, ' ')}`);
  }
};

const SEARCH =
  process.env.OLX_SEARCH_URL ||
  DEFAULT_SEARCH_URLS.find((u) => u.includes('olx.uz'));

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
  check('city resolved to Tashkent', search.params.get('city_id') === '4', search.params.get('city_id'));
  check(
    'not sorted by creation, which would hide bumped listings',
    !search.params.has('sort_by'),
    search.params.get('sort_by') || 'default order'
  );
  check(
    'filters the API ignores are checked here instead',
    search.clientFilters.length >= 1,
    search.clientFilters.map((f) => f.describe).join('; ')
  );

  // What districts does OLX name at all? Needed to tell a wrong match
  // string apart from a genuinely empty page.
  const unfiltered = { ...search, clientFilters: [] };
  try {
    const { listings: raw } = await fetchListings(unfiltered, { pages: 1, maxPages: 1 });
    const names = [...new Set(raw.map((l) => l.district).filter(Boolean))];
    annotate('notice', `OLX district names seen: ${names.join(' | ') || 'none'}`);
    const matching = raw.filter((l) => (l.district || '').toLowerCase().includes('юнусабад'));
    annotate('notice', `OLX Yunusobod on page 1: ${matching.length} of ${raw.length} (rooms: ${matching.map((l) => l.rooms).join(',') || 'none'})`);
  } catch (err) {
    annotate('warning', `OLX district survey failed: ${err.message}`);
  }

  let result;
  try {
    // The watcher pages deeper than this; a narrow filter can legitimately
    // find nothing on one page.
    result = await fetchListings(search, { pages: 3, maxPages: 6 });
  } catch (err) {
    check('reachable', false, err.message);
    annotate('error', `OLX adapter could not fetch: ${err.message}`);
    console.log(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
    return;
  }

  const { listings, filteredCount } = result;
  check('reachable', true, `${filteredCount ?? '?'} match the filters`);
  check('returned listings', listings.length > 0, `${listings.length} across the pages read`);

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
  const districts = [...new Set(listings.map((l) => l.district).filter(Boolean))];
  annotate('notice', `OLX districts returned: ${districts.join(' | ') || 'none'}`);
  check(
    'only the requested district',
    districts.every((d) => d.toLowerCase().includes('юнусабад')),
    districts.join(', ') || 'no listings to judge'
  );
  check(
    'only the requested room count',
    withRooms.every((l) => l.rooms === 3),
    [...new Set(withRooms.map((l) => l.rooms))].join(',') || 'none with a room count'
  );

  const dollars = withPrice.filter((l) => ['USD', 'UYE'].includes(l.currency));
  check(
    'price filter respected for dollar listings',
    dollars.every((l) => l.price <= 600),
    dollars.length ? `max ${Math.max(...dollars.map((l) => l.price))} of ${dollars.length}` : 'none in dollars'
  );

  const som = withPrice.filter((l) => l.currency === 'UZS');
  const rate = Number.parseFloat(process.env.OLX_UZS_PER_USD || '') || 12600;
  check(
    'price filter respected for som listings',
    som.every((l) => l.price / rate <= 600),
    som.length ? `max ${Math.round(Math.max(...som.map((l) => l.price)) / rate)} USD-equiv of ${som.length}` : 'none in som'
  );

  check(
    'every price is in a currency we understand',
    withPrice.every((l) => ['USD', 'UYE', 'UZS'].includes(l.currency)),
    [...new Set(withPrice.map((l) => l.currency))].join(',')
  );

  // The price filter is ignored by the API, so it has to be applied here —
  // which needs to know exactly how price and currency are reported.
  const currencies = [...new Set(listings.map((l) => l.currency))];
  annotate('notice', `OLX currencies seen: ${currencies.join(', ') || 'none'}`);
  annotate(
    'notice',
    `OLX price samples: ${listings.slice(0, 6).map((l) => `${l.price} ${l.currency}`).join(' | ')}`
  );

  // The age cutoff is what keeps re-promoted adverts out. OLX bumps
  // listings first posted years ago, so this confirms the dates needed to
  // spot them are actually present and parsed.
  const withPostedAt = listings.filter((l) => l.postedAt);
  check('original post date present', withPostedAt.length === listings.length, `${withPostedAt.length}/${listings.length}`);

  const ages = withPostedAt
    .map((l) => Math.floor((l.adsAtMs - Date.parse(l.postedAt)) / 86400000))
    .filter((n) => Number.isFinite(n));

  if (ages.length > 0) {
    const fresh = ages.filter((a) => a <= 1).length;
    annotate(
      'notice',
      `OLX ages: ${fresh}/${ages.length} posted within a day; oldest ${Math.max(...ages)} days, median ${ages.sort((a, b) => a - b)[Math.floor(ages.length / 2)]} days`
    );
    check('ages are computable', ages.every((a) => a >= 0), `min ${Math.min(...ages)}`);
  }

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
