#!/usr/bin/env node
/**
 * Narrows down why the configured OLX search returns nothing.
 *
 * Yunusobod 3-room listings are visible on page one, yet the full filter
 * chain yields none. Either one filter is wrong, or the chain's intersection
 * is genuinely empty — this applies them one at a time to tell which.
 *
 * It also checks whether `offset` actually pages. uybor accepts it and
 * returns page one every time, and the same fault here would mean every
 * "page" is the same 65 listings.
 */

import { buildSearch, fetchListings } from '../src/sources/olx.js';
import { DEFAULT_SEARCH_URLS } from '../src/config.js';

const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${level}::${String(message).replace(/\r?\n/g, ' ')}`);
  }
};

const url = DEFAULT_SEARCH_URLS.find((u) => u.includes('olx.uz'));
const search = buildSearch(url);

const { listings: all } = await fetchListings(
  { ...search, clientFilters: [] },
  { pages: 1, maxPages: 1 }
);

annotate('notice', `OLX stages: fetched ${all.length}`);

// One filter at a time, then cumulatively.
let remaining = all;
for (const f of search.clientFilters) {
  const alone = all.filter((l) => f.test(l)).length;
  remaining = remaining.filter((l) => f.test(l));
  annotate('notice', `OLX stage "${f.describe}": ${alone} alone, ${remaining.length} cumulative`);
}

// What do the Yunusobod ones actually look like?
const yunus = all.filter((l) => (l.district || '').toLowerCase().includes('юнусабад'));
annotate(
  'notice',
  `OLX Yunusobod detail: ${yunus
    .slice(0, 8)
    .map((l) => `r${l.rooms}/biz=${l.isBusiness}/photo=${l.image ? 'y' : 'n'}`)
    .join(' ')}`
);

// Does offset page, or repeat page one?
const page1 = await fetchListings({ ...search, clientFilters: [] }, { pages: 1, maxPages: 1 });
const deeper = new URLSearchParams(search.params);
const probe = { ...search, clientFilters: [], params: deeper };
const { listings: page2 } = await fetchListings(probe, { pages: 2, maxPages: 2 });

const firstIds = new Set(page1.listings.map((l) => l.id));
const overlap = page2.filter((l) => firstIds.has(l.id)).length;
annotate(
  'notice',
  `OLX paging: page1=${page1.listings.length}, two pages=${page2.length} unique, overlap=${overlap}` +
    (page2.length <= page1.listings.length ? ' — OFFSET LOOKS IGNORED' : ' — offset pages properly')
);
