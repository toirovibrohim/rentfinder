#!/usr/bin/env node
/**
 * Works out which OLX API params correspond to the website's "Tashkent",
 * "private seller" and "with photos" filters.
 *
 * Has to run on a GitHub runner — OLX answers those but not this project's
 * other egress. Each variation is one request, spaced out, and retried once
 * because the CDN refuses roughly one in five at random.
 */

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const API = 'https://www.olx.uz/api/v1/offers/';
const REFERER = 'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/';
const BASE = 'category_id=1147&limit=40&offset=0&sort_by=created_at:desc';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${level}::${String(message).replace(/\r?\n/g, ' ')}`);
  }
};

async function ask(query, { attempts = 3 } = {}) {
  for (let i = 1; i <= attempts; i++) {
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

function summarise(body) {
  const rows = body?.data || [];
  const total = body?.metadata?.total_elements ?? body?.metadata?.visible_total_count ?? null;
  const cities = [...new Set(rows.map((a) => a.location?.city?.name).filter(Boolean))];
  const business = [...new Set(rows.map((a) => (a.isBusiness === true ? 'business' : a.isBusiness === false ? 'private' : '?')))];
  const noPhotos = rows.filter((a) => !(a.photos || []).length).length;
  return { total, n: rows.length, cities, business, noPhotos };
}

async function probe(label, query) {
  const body = await ask(query);
  if (!body) {
    console.log(`  ${label.padEnd(36)} blocked after retries`);
    return null;
  }
  const s = summarise(body);
  console.log(
    `  ${label.padEnd(36)} total=${String(s.total).padStart(6)} n=${String(s.n).padStart(3)} ` +
      `cities=${s.cities.slice(0, 3).join('/') || '-'}${s.cities.length > 3 ? '…' : ''} ` +
      `seller=[${s.business.join(',')}] no-photo=${s.noPhotos}`
  );
  return s;
}

console.log('Which OLX params match the site filters?\n');

console.log('baseline');
const base = await probe('category only', BASE);
await sleep(5000);

console.log('\nTashkent');
for (const [label, q] of [
  ['city_id=4', `${BASE}&city_id=4`],
  ['region_id=5', `${BASE}&region_id=5`],
]) {
  await probe(label, q);
  await sleep(5000);
}

console.log('\nprivate sellers only');
for (const [label, q] of [
  ['filter_enum_private_business', `${BASE}&filter_enum_private_business[0]=private`],
  ['private_business=private', `${BASE}&private_business=private`],
  ['owner_type=private', `${BASE}&owner_type=private`],
]) {
  await probe(label, q);
  await sleep(5000);
}

console.log('\nwith photos only');
for (const [label, q] of [
  ['filter_refiners=spell_checker', `${BASE}&filter_refiners=spell_checker`],
  ['photos=1', `${BASE}&photos=1`],
  ['search[photos]=1', `${BASE}&search[photos]=1`],
]) {
  await probe(label, q);
  await sleep(5000);
}

annotate(
  'notice',
  base
    ? `OLX filter probe done — baseline total ${base.total}, cities ${base.cities.slice(0, 4).join('/')}.`
    : 'OLX filter probe: baseline request was blocked.'
);
