#!/usr/bin/env node
/**
 * Shows where OLX listings are lost between the API and Telegram.
 *
 * Plenty is posted there each day and almost none reaches the bot, so this
 * follows a page through each stage — sort order, private-seller filter,
 * photo filter, freshness — and reports the count at each one, plus how the
 * available sort orders differ.
 *
 * Runs on a GitHub runner; OLX does not answer this project's other egress.
 */

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const API = 'https://www.olx.uz/api/v1/offers/';
const REFERER = 'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/';
const BASE = 'category_id=1147&city_id=4&limit=50&offset=0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${level}::${String(message).replace(/\r?\n/g, ' ')}`);
  }
};

async function ask(query, attempts = 4) {
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

/** Midnight Tashkent, as a timestamp. */
function startOfToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00+05:00`);
}

const since = startOfToday();

async function funnel(label, query) {
  const body = await ask(query);
  if (!body) {
    annotate('warning', `OLX funnel [${label}]: blocked after retries`);
    return;
  }

  const ads = body.data || [];
  const createdToday = ads.filter((a) => Date.parse(a.created_time) >= since).length;
  const refreshedToday = ads.filter((a) => Date.parse(a.last_refresh_time) >= since).length;
  const priv = ads.filter((a) => a.business === false);
  const privWithPhoto = priv.filter((a) => (a.photos || []).length > 0);
  const privPhotoToday = privWithPhoto.filter(
    (a) => Date.parse(a.last_refresh_time || a.created_time) >= since
  ).length;

  annotate(
    'notice',
    `OLX funnel [${label}]: fetched=${ads.length} createdToday=${createdToday} ` +
      `refreshedToday=${refreshedToday} private=${priv.length} +photo=${privWithPhoto.length} ` +
      `+today=${privPhotoToday}`
  );

  const first = ads[0];
  const last = ads[ads.length - 1];
  if (first && last) {
    annotate(
      'notice',
      `OLX funnel [${label}] span: first created=${String(first.created_time).slice(0, 16)} ` +
        `refreshed=${String(first.last_refresh_time).slice(0, 16)} | last created=${String(last.created_time).slice(0, 16)}`
    );
  }
}

await funnel('sort created_at:desc', `${BASE}&sort_by=created_at:desc`);
await sleep(6000);
await funnel('sort filter_refiners', `${BASE}&sort_by=filter_refiners:desc`);
await sleep(6000);
await funnel('no sort param', BASE);
