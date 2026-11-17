/**
 * Who is allowed to receive listings, and until when.
 *
 * Access is granted by the owner only — nobody can subscribe themselves — and
 * every grant expires, by default after a day.
 *
 * The file is committed to the repository so access survives between runs.
 * The repository is public, and a chat id identifies a real person, so the
 * contents are encrypted with SUBSCRIBER_KEY and only ever written as
 * ciphertext. Losing that key loses the list, which only means re-approving.
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';

function keyFrom(secret) {
  if (!secret || !secret.trim()) {
    throw new Error(
      'SUBSCRIBER_KEY is not set. It encrypts the approved-chat list, which is ' +
        'committed to a public repository. Generate one with: openssl rand -hex 32'
    );
  }
  return createHash('sha256').update(secret.trim()).digest();
}

function encrypt(plaintext, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    note: 'Encrypted approved-chat list. Decrypt with SUBSCRIBER_KEY.',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(envelope, secret) {
  const decipher = createDecipheriv(
    ALGORITHM,
    keyFrom(secret),
    Buffer.from(envelope.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

export async function loadSubscribers(filePath, secret) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }

  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    console.warn(`Approved-chat file at ${filePath} is not valid JSON; starting empty.`);
    return {};
  }

  try {
    return decrypt(envelope, secret);
  } catch (err) {
    // A wrong key must not silently wipe the list on the next write.
    throw new Error(
      `Could not decrypt ${filePath} (${err.message}). SUBSCRIBER_KEY has probably ` +
        `changed. Restore the old key, or delete the file to start over.`
    );
  }
}

export async function saveSubscribers(filePath, subscribers, secret) {
  const dir = path.dirname(path.resolve(filePath));
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp`);
  const envelope = encrypt(JSON.stringify(subscribers), secret);

  await writeFile(tmp, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
  await rename(tmp, filePath);
}

/**
 * Grants access from now, for `hours`. Re-approving extends from now.
 *
 * `backfillPending` makes the next check send everything already posted
 * today, so joining at four in the afternoon still shows the whole day
 * rather than starting from whatever happens next.
 */
export function approve(subscribers, chatId, { hours, name = null }) {
  const now = Date.now();
  const existing = subscribers[String(chatId)];

  subscribers[String(chatId)] = {
    name: name ?? existing?.name ?? null,
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + hours * 3600 * 1000).toISOString(),
    // Someone already receiving listings has had today's as they appeared.
    backfillPending: isActive(existing, now) ? Boolean(existing?.backfillPending) : true,
  };
  return subscribers[String(chatId)];
}

/** Chats that still owe a catch-up of today's listings. */
export function awaitingBackfill(subscribers, at = Date.now()) {
  return Object.entries(subscribers)
    .filter(([, entry]) => isActive(entry, at) && entry.backfillPending)
    .map(([chatId]) => chatId);
}

/** Start of the current day in Tashkent, as a timestamp. */
export function startOfToday(at = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));

  const get = (type) => parts.find((p) => p.type === type).value;
  // Tashkent is UTC+5 year-round, so the day begins at 19:00 UTC previous day.
  return Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00+05:00`);
}

export function revoke(subscribers, chatId) {
  const key = String(chatId);
  const existed = key in subscribers;
  delete subscribers[key];
  return existed;
}

export function isActive(entry, at = Date.now()) {
  if (!entry?.expiresAt) return false;
  const expires = Date.parse(entry.expiresAt);
  return Number.isFinite(expires) && expires > at;
}

/** Chat ids currently entitled to receive listings. */
export function activeChatIds(subscribers, at = Date.now()) {
  return Object.entries(subscribers)
    .filter(([, entry]) => isActive(entry, at))
    .map(([chatId]) => chatId);
}

/** Drops entries that expired a while ago, so the file cannot grow forever. */
export function pruneExpired(subscribers, { graceHours = 72 } = {}) {
  const cutoff = Date.now() - graceHours * 3600 * 1000;
  const removed = [];

  for (const [chatId, entry] of Object.entries(subscribers)) {
    const expires = Date.parse(entry?.expiresAt ?? '');
    if (!Number.isFinite(expires) || expires < cutoff) {
      delete subscribers[chatId];
      removed.push(chatId);
    }
  }

  return removed;
}

/** Human-readable remaining time, e.g. "3h 12m". */
export function remaining(entry, at = Date.now()) {
  const expires = Date.parse(entry?.expiresAt ?? '');
  if (!Number.isFinite(expires)) return 'unknown';
  const ms = expires - at;
  if (ms <= 0) return 'expired';

  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
