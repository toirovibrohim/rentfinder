#!/usr/bin/env node
/**
 * Settles whether OLX's "private seller" filter can be reproduced.
 *
 * The earlier probe showed every candidate param returning the same count as
 * no filter, and no seller flag on the results — but that probe read
 * `isBusiness`, which the HTML page carries and this API may not. This dumps
 * what the API actually returns before concluding the filter is unavailable.
 */

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const API = 'https://www.olx.uz/api/v1/offers/';
const BASE = 'category_id=1147&city_id=4&limit=40&offset=0&sort_by=created_at:desc';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${level}::${String(message).replace(/\r?\n/g, ' ')}`);
  }
};

async function ask(query, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${API}?${query}`, {
        headers: {
          'User-Agent': MOBILE_UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          Referer: 'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/',
        },
        signal: AbortSignal.timeout(25000),
      });
      const text = await res.text();
      if (text.trimStart().startsWith('<')) {
        if (i === attempts) return null;
        await sleep(2500 * i);
        continue;
      }
      return JSON.parse(text);
    } catch {
      if (i === attempts) return null;
      await sleep(2500 * i);
    }
  }
  return null;
}

const body = await ask(BASE);
if (!body) {
  annotate('warning', 'OLX seller probe: blocked after retries.');
  process.exit(0);
}

const ads = body.data || [];
const first = ads[0] || {};

annotate('notice', `OLX ad fields: ${Object.keys(first).join(',').slice(0, 380)}`);

const sellerish = Object.keys(first).filter((k) =>
  /business|private|user|owner|shop|partner|seller|company/i.test(k)
);
annotate('notice', `OLX seller-ish fields: ${sellerish.join(', ') || 'none'}`);

for (const key of sellerish.slice(0, 4)) {
  const values = [...new Set(ads.map((a) => JSON.stringify(a[key])))].slice(0, 3);
  annotate('notice', `OLX ${key} values: ${values.join(' | ').slice(0, 220)}`);
}

// If a seller flag exists, does the website's filter actually narrow by it?
const flagKey = sellerish.find((k) => /business/i.test(k));
if (flagKey) {
  const split = (rows) => {
    const priv = rows.filter((a) => a[flagKey] === false).length;
    const biz = rows.filter((a) => a[flagKey] === true).length;
    return `private=${priv} business=${biz} unknown=${rows.length - priv - biz}`;
  };
  annotate('notice', `OLX unfiltered split: ${split(ads)}`);

  await sleep(5000);
  const filtered = await ask(`${BASE}&filter_enum_private_business[0]=private`);
  annotate(
    'notice',
    filtered
      ? `OLX with private filter: ${split(filtered.data || [])}`
      : 'OLX with private filter: blocked'
  );
}
