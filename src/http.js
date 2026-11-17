/** Shared JSON fetching with timeouts and sensible retries. */

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 20000;

/**
 * GETs JSON, retrying on network errors, 5xx and 429.
 * 4xx responses are not retried — they will not fix themselves.
 */
export async function fetchJson(url, { attempts = 3, referer, headers = {} } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'ru,uz;q=0.9,en;q=0.8',
          'User-Agent': BROWSER_UA,
          ...(referer ? { Referer: referer } : {}),
          ...headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const text = await res.text();

      // A CDN block returns an HTML challenge page with a 2xx or 4xx status.
      //
      // This is worth retrying. Measuring one of these CDNs showed it
      // refusing roughly one request in five at random — the same query
      // succeeding and failing minutes apart — so treating a block as
      // permanent throws away listings that a second attempt would get.
      if (text.trimStart().startsWith('<')) {
        const title = (text.match(/<title[^>]*>([^<]*)</i) || [])[1] || '';
        const blocked = new Error(
          `blocked by the site — got HTML instead of JSON (HTTP ${res.status}${title ? `, "${title.trim().slice(0, 40)}"` : ''})`
        );
        blocked.blocked = true;
        throw blocked;
      }

      if (!res.ok) {
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`HTTP ${res.status} ${res.statusText} (not retrying)`);
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      if (err.message?.includes('not retrying') || attempt === attempts) break;

      // Back off harder after a block than after a network blip, and add
      // jitter so repeated runs do not line up into a pattern.
      const base = err.blocked ? 2000 : 1000;
      const wait = base * attempt + Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  throw lastError;
}
