/** Sends listing notifications through the Telegram Bot API. */

const TIMEOUT_MS = 20000;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatPrice(listing) {
  if (listing.price === null || Number.isNaN(listing.price)) return null;
  const rounded = Number.isInteger(listing.price)
    ? listing.price
    : Math.round(listing.price * 100) / 100;
  const pretty = rounded.toLocaleString('en-US');
  return listing.currency ? `${pretty} ${listing.currency}` : pretty;
}

/** Renders the publish time in Tashkent local time. */
function formatPublished(listing) {
  if (!listing.adsAtMs || Number.isNaN(listing.adsAtMs)) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(listing.adsAtMs));
}

/** Rounds 54.00 -> "54", 54.50 -> "54.5". */
function formatArea(areaM2) {
  if (areaM2 === null || areaM2 === undefined || Number.isNaN(areaM2)) return null;
  return `${Math.round(areaM2 * 10) / 10} m²`;
}

/** "3 rooms · 54 m² · floor 4/4" — whichever parts are known. */
function formatSpecs(listing) {
  const parts = [];
  if (listing.rooms) parts.push(`${listing.rooms} ${listing.rooms === 1 ? 'room' : 'rooms'}`);

  const area = formatArea(listing.areaM2);
  if (area) parts.push(area);

  if (listing.floor) {
    parts.push(listing.floorsTotal ? `floor ${listing.floor}/${listing.floorsTotal}` : `floor ${listing.floor}`);
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

export function buildMessage(listing) {
  const lines = [`🏠 <b>${escapeHtml(listing.title)}</b>`];

  const price = formatPrice(listing);
  if (price) lines.push(`💵 <b>${escapeHtml(price)}</b>`);

  const specs = formatSpecs(listing);
  if (specs) lines.push(`📐 ${escapeHtml(specs)}`);

  if (listing.address) lines.push(`📍 ${escapeHtml(listing.address)}`);

  const published = formatPublished(listing);
  if (published) lines.push(`🕒 ${escapeHtml(published)}`);

  if (listing.author) lines.push(`👤 ${escapeHtml(listing.author)}`);

  // Telegram makes a tel: link tappable, so the number can be called directly.
  if (listing.phone) {
    lines.push(`📞 <a href="tel:${escapeHtml(listing.phone)}">${escapeHtml(listing.phone)}</a>`);
  }

  lines.push('');
  lines.push(
    `<a href="${escapeHtml(listing.url)}">Open on ${escapeHtml(listing.sourceLabel || 'the site')}</a>`
  );

  return lines.join('\n');
}

export class TelegramClient {
  constructor(botToken, chatId) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  async #call(method, payload, { attempts = 3 } = {}) {
    const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        const body = await res.json().catch(() => ({}));

        if (body.ok) return body.result;

        // Telegram asks us to back off.
        if (res.status === 429) {
          const wait = (body.parameters?.retry_after ?? 2) * 1000;
          lastError = new Error(`Telegram rate limit, retry after ${wait / 1000}s`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        const description = body.description || `${res.status} ${res.statusText}`;
        // Bad token / wrong chat id will not fix themselves.
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          throw new Error(`Telegram ${method} failed: ${description} (not retrying)`);
        }
        throw new Error(`Telegram ${method} failed: ${description}`);
      } catch (err) {
        lastError = err;
        if (err.message?.includes('not retrying') || attempt === attempts) break;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError;
  }

  async sendText(text, { disablePreview = true } = {}) {
    return this.#call('sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: disablePreview,
    });
  }

  /** Sends the listing photo with the details as a caption; falls back to text. */
  async sendListing(listing) {
    const caption = buildMessage(listing);

    if (listing.image) {
      try {
        return await this.#call('sendPhoto', {
          chat_id: this.chatId,
          photo: listing.image,
          caption,
          parse_mode: 'HTML',
        });
      } catch (err) {
        console.warn(`  photo failed for ${listing.id} (${err.message}); sending as text`);
      }
    }

    return this.sendText(caption, { disablePreview: false });
  }

  async getMe() {
    return this.#call('getMe', {}, { attempts: 1 });
  }
}
