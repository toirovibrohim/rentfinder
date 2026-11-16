#!/usr/bin/env node
/**
 * Checks which listing sites are reachable from wherever this runs.
 *
 * The point is to test from a GitHub runner, not a laptop: several of these
 * sites sit behind CDNs that reject datacenter IP ranges, so a site that
 * works at home can be completely unavailable in CI. Verdicts are emitted as
 * GitHub annotations so they can be read without opening the log.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SITES = [
  {
    name: 'joymee.uz',
    url: 'https://api.joymee.uz/api/v1/announcement/?ordering=newest&page=1',
    referer: 'https://joymee.uz/',
    count: (j) => j.filtered_count,
    rows: (j) => j.results,
  },
  {
    name: 'uybor.uz',
    url: 'https://api.uybor.uz/api/v1/listings?limit=5',
    referer: 'https://uybor.uz/',
    count: (j) => j.total,
    rows: (j) => j.results,
  },
  {
    name: 'olx.uz',
    url: 'https://www.olx.uz/api/v1/offers/?category_id=1147&limit=5&offset=0',
    referer: 'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/',
    count: (j) => j.metadata?.total_elements,
    rows: (j) => j.data,
  },
  {
    name: 'makler.uz',
    url: 'https://makler.uz/',
    referer: 'https://makler.uz/',
    html: true,
  },
];

const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${level}::${String(message).replace(/\r?\n/g, ' ')}`);
  }
};

async function check(site) {
  try {
    const res = await fetch(site.url, {
      headers: {
        'User-Agent': UA,
        Accept: site.html ? 'text/html,*/*' : 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        Referer: site.referer,
      },
      signal: AbortSignal.timeout(25000),
    });

    const text = await res.text();

    if (site.html) {
      const ok = res.ok && text.length > 1000;
      console.log(`${site.name.padEnd(12)} HTTP ${res.status}, ${text.length} bytes`);
      return ok;
    }

    if (text.trimStart().startsWith('<')) {
      const title = (text.match(/<title[^>]*>([^<]*)</i) || [])[1] || '';
      console.log(`${site.name.padEnd(12)} BLOCKED — HTTP ${res.status}, html "${title.trim().slice(0, 45)}"`);
      return false;
    }

    const j = JSON.parse(text);
    const rows = site.rows(j) || [];
    console.log(`${site.name.padEnd(12)} OK — HTTP ${res.status}, ${rows.length} rows, total ${site.count(j) ?? '?'}`);
    return res.ok && rows.length > 0;
  } catch (err) {
    console.log(`${site.name.padEnd(12)} ERROR — ${err.message}`);
    return false;
  }
}

console.log(`Running ${process.env.GITHUB_ACTIONS ? 'on a GitHub runner' : 'locally'}\n`);

const reachable = [];
const blocked = [];

for (const site of SITES) {
  const ok = await check(site);
  (ok ? reachable : blocked).push(site.name);
  await new Promise((r) => setTimeout(r, 3000));
}

console.log('');
console.log(`reachable: ${reachable.join(', ') || 'none'}`);
console.log(`blocked:   ${blocked.join(', ') || 'none'}`);

annotate('notice', `Reachable from here: ${reachable.join(', ') || 'none'}.`);
if (blocked.length) {
  annotate('warning', `Not reachable from here: ${blocked.join(', ')}.`);
}
