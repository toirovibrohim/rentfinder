#!/usr/bin/env node
/**
 * Tries every way into olx.uz we know of, to settle whether it can be
 * watched from CI at all.
 *
 * A previous probe showed the JSON API returning 403 from a GitHub runner
 * while working from a home connection, which points at CloudFront rejecting
 * datacenter IP ranges rather than at anything we send. This widens that to
 * the mobile host, the plain listing page and the sitemap, so the conclusion
 * is about the whole site rather than one endpoint.
 *
 * Requests are spaced out: OLX rate-limits, and a burst would produce a
 * false negative.
 */

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const LISTING = 'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/';

const ROUTES = [
  {
    name: 'JSON API (desktop UA)',
    url: 'https://www.olx.uz/api/v1/offers/?category_id=1147&limit=5&offset=0',
    ua: DESKTOP_UA,
    expect: 'json',
  },
  {
    name: 'JSON API (mobile UA) ',
    url: 'https://www.olx.uz/api/v1/offers/?category_id=1147&limit=5&offset=0',
    ua: MOBILE_UA,
    expect: 'json',
  },
  {
    name: 'listing page HTML   ',
    url: LISTING,
    ua: DESKTOP_UA,
    expect: 'html',
  },
  {
    name: 'mobile host m.olx.uz',
    url: 'https://m.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/',
    ua: MOBILE_UA,
    expect: 'html',
  },
  {
    name: 'sitemap index       ',
    url: 'https://www.olx.uz/sitemap.xml',
    ua: DESKTOP_UA,
    expect: 'xml',
  },
  {
    name: 'robots.txt          ',
    url: 'https://www.olx.uz/robots.txt',
    ua: DESKTOP_UA,
    expect: 'text',
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${level}::${String(message).replace(/\r?\n/g, ' ')}`);
  }
};

async function tryRoute(route) {
  try {
    const res = await fetch(route.url, {
      headers: {
        'User-Agent': route.ua,
        Accept: route.expect === 'json' ? 'application/json, */*' : 'text/html,*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9,uz;q=0.8',
        Referer: LISTING,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });

    const text = await res.text();
    const blockedPage = /the request could not be satisfied|access denied|captcha/i.test(
      text.slice(0, 2000)
    );

    if (res.status === 403 || blockedPage) {
      console.log(`  ${route.name}  BLOCKED (HTTP ${res.status})`);
      return false;
    }
    if (!res.ok) {
      console.log(`  ${route.name}  HTTP ${res.status}`);
      return false;
    }

    let detail = `${text.length} bytes`;
    if (route.expect === 'json') {
      try {
        const n = (JSON.parse(text).data || []).length;
        detail = `${n} offers`;
      } catch {
        console.log(`  ${route.name}  HTTP ${res.status} but not JSON — likely a block page`);
        return false;
      }
    }

    console.log(`  ${route.name}  OK (HTTP ${res.status}, ${detail})`);
    return true;
  } catch (err) {
    console.log(`  ${route.name}  ERROR ${err.message}`);
    return false;
  }
}

console.log(`Probing olx.uz from ${process.env.GITHUB_ACTIONS ? 'a GitHub runner' : 'this machine'}\n`);

const working = [];
for (const route of ROUTES) {
  if (await tryRoute(route)) working.push(route.name.trim());
  await sleep(6000);
}

console.log('');
if (working.length === 0) {
  console.log('VERDICT: no route into olx.uz works from here.');
  annotate('error', 'OLX: every route blocked from here — it cannot be watched from GitHub Actions.');
} else {
  console.log(`VERDICT: usable route(s): ${working.join(', ')}`);
  annotate('notice', `OLX reachable from here via: ${working.join(', ')}.`);
}
