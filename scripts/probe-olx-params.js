#!/usr/bin/env node
/**
 * Finds which part of the adapter's query OLX rejects.
 *
 * The bare query succeeds 8/8 from a runner while the adapter's is refused,
 * so the difference is in what we ask for, not where we ask from. The most
 * likely culprits are the page size and the params containing colons, which
 * URLSearchParams percent-encodes.
 *
 * Each variation is one request, spaced out.
 */

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const API = 'https://www.olx.uz/api/v1/offers/';
const REFERER = 'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raw query strings, so colon encoding can be controlled exactly.
const VARIANTS = [
  ['known good (limit 5)        ', 'category_id=1147&limit=5&offset=0'],
  ['limit 50                    ', 'category_id=1147&limit=50&offset=0'],
  ['limit 40                    ', 'category_id=1147&limit=40&offset=0'],
  ['sort_by, literal colon      ', 'category_id=1147&limit=5&offset=0&sort_by=created_at:desc'],
  ['sort_by, encoded colon      ', 'category_id=1147&limit=5&offset=0&sort_by=created_at%3Adesc'],
  ['price filter, literal colon ', 'category_id=1147&limit=5&offset=0&filter_float_price:to=600'],
  ['price filter, encoded colon ', 'category_id=1147&limit=5&offset=0&filter_float_price%3Ato=600'],
  ['currency only               ', 'category_id=1147&limit=5&offset=0&currency=USD'],
  ['adapter query, encoded      ', 'category_id=1147&filter_float_price%3Ato=600&currency=USD&sort_by=created_at%3Adesc&limit=50&offset=0'],
  ['adapter query, literal      ', 'category_id=1147&filter_float_price:to=600&currency=USD&sort_by=created_at:desc&limit=50&offset=0'],
];

const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${level}::${String(message).replace(/\r?\n/g, ' ')}`);
  }
};

async function attempt(label, query) {
  try {
    const res = await fetch(`${API}?${query}`, {
      headers: {
        'User-Agent': MOBILE_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        Referer: REFERER,
      },
      signal: AbortSignal.timeout(25000),
    });

    const text = await res.text();
    if (text.trimStart().startsWith('<')) {
      console.log(`  ${label} BLOCKED (HTTP ${res.status})`);
      return false;
    }

    const body = JSON.parse(text);
    if (!res.ok) {
      console.log(`  ${label} HTTP ${res.status} ${JSON.stringify(body).slice(0, 90)}`);
      return false;
    }

    const rows = body.data || [];
    const total = body.metadata?.total_elements ?? '?';
    console.log(`  ${label} OK (${rows.length} offers, total ${total})`);
    return true;
  } catch (err) {
    console.log(`  ${label} ERROR ${err.message.slice(0, 60)}`);
    return false;
  }
}

console.log('Which part of the query does OLX refuse?\n');

const good = [];
const bad = [];
for (const [label, query] of VARIANTS) {
  (await attempt(label, query) ? good : bad).push(label.trim());
  await sleep(6000);
}

console.log(`\n  worked: ${good.join(' | ') || 'none'}`);
console.log(`  failed: ${bad.join(' | ') || 'none'}`);

annotate(
  bad.length === 0 ? 'notice' : 'warning',
  `OLX query probe — worked: ${good.join(', ') || 'none'}. Failed: ${bad.join(', ') || 'none'}.`
);
