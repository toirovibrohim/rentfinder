#!/usr/bin/env node
/**
 * Checks whether olx.uz is reachable from wherever this runs.
 *
 * OLX sits behind CloudFront and rate-limits hard: a burst of requests gets
 * 403 for a while, then recovers. Datacenter IP ranges are often blocked
 * outright, which is the thing worth knowing before building on it — so this
 * is meant to be run from a GitHub runner, not only from a laptop.
 *
 * Results are printed, and emitted as GitHub annotations when in Actions.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const LISTING_PAGE =
  'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/';
const OFFERS_API =
  'https://www.olx.uz/api/v1/offers/?category_id=1147&limit=5&offset=0&sort_by=created_at:desc';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${level}::${String(message).replace(/\r?\n/g, ' ')}`);
  }
};

async function probe(label, url, { json = false } = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: json ? 'application/json, text/plain, */*' : 'text/html,*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        Referer: LISTING_PAGE,
      },
      signal: AbortSignal.timeout(25000),
    });

    const text = await res.text();
    const looksHtml = text.trimStart().startsWith('<');

    if (json && looksHtml) {
      const title = (text.match(/<title[^>]*>([^<]*)</i) || [])[1] || '';
      console.log(`${label}: BLOCKED (HTTP ${res.status}, html "${title.trim().slice(0, 60)}")`);
      return { ok: false, status: res.status, blocked: true };
    }

    if (json) {
      const body = JSON.parse(text);
      const n = (body.data || []).length;
      const total = body.metadata?.total_elements ?? body.metadata?.visible_total_count ?? '?';
      const newest = body.data?.[0];
      console.log(`${label}: OK (HTTP ${res.status}, ${n} offers, total ${total})`);
      if (newest) {
        console.log(`           newest: ${newest.created_time}  ${(newest.title || '').slice(0, 50)}`);
      }
      return { ok: true, status: res.status, n, total };
    }

    console.log(`${label}: HTTP ${res.status}, ${text.length} bytes${looksHtml ? ' (html)' : ''}`);
    const hasState = text.includes('__PRERENDERED_STATE__');
    if (looksHtml) console.log(`           embedded listing state present: ${hasState}`);
    return { ok: res.ok, status: res.status, hasState };
  } catch (err) {
    console.log(`${label}: ERROR ${err.message}`);
    return { ok: false, error: err.message };
  }
}

console.log(`Running ${process.env.GITHUB_ACTIONS ? 'on a GitHub runner' : 'locally'}\n`);

// Spaced out, the way the watcher would actually poll.
const api1 = await probe('offers API  #1', OFFERS_API, { json: true });
await sleep(5000);
const api2 = await probe('offers API  #2', OFFERS_API, { json: true });
await sleep(5000);
const page = await probe('listing page  ', LISTING_PAGE);

console.log('');

const apiWorks = api1.ok && api2.ok;
const pageWorks = page.ok && page.hasState;

if (apiWorks) {
  annotate('notice', 'OLX offers API is reachable from here. A JSON adapter will work.');
  console.log('VERDICT: API usable.');
} else if (pageWorks) {
  annotate(
    'warning',
    'OLX blocks its JSON API from here, but the listing page loads with embedded data. An adapter must read the page instead.'
  );
  console.log('VERDICT: API blocked, page scraping viable.');
} else {
  annotate('error', 'OLX blocks both its API and its listing page from here. It cannot be watched from GitHub Actions.');
  console.log('VERDICT: blocked entirely.');
}
