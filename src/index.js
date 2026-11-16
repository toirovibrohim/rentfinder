#!/usr/bin/env node
/**
 * joymee-rent-watcher
 *
 * Checks a filtered joymee.uz search on a schedule and sends every newly
 * published listing to Telegram, exactly once.
 */

import { loadConfig } from './config.js';
import { applyCategoryFilter } from './categories.js';
import { fetchListings } from './joymee.js';
import { TelegramClient } from './telegram.js';
import { loadState, saveState, selectNewListings, recordSeen, makeIsKnown } from './state.js';

const flags = new Set(process.argv.slice(2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tashkent',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());

/**
 * One check: fetch, diff against state, notify, persist.
 * Returns true when at least one notification was sent.
 */
async function runCheck(config, telegram, { seedOnly = false } = {}) {
  let state = await loadState(config.statePath);

  const { listings, filteredCount, pagesFetched } = await fetchListings(config.searchParams, {
    pages: config.pagesToScan,
    maxPages: config.maxPagesToScan,
    // Seeding wants a snapshot, not a catch-up, so it never pages further.
    isKnown: state.seeded && !seedOnly ? makeIsKnown(state) : null,
  });

  if (pagesFetched > config.pagesToScan) {
    console.log(`[${stamp()}] went ${pagesFetched} pages deep — a burst of listings was posted`);
  }

  if (listings.length === 0) {
    console.log(`[${stamp()}] no results returned — filters may be too narrow`);
    await saveState(config.statePath, { ...state, lastCheckedAt: new Date().toISOString() });
    return { sent: 0, failed: 0 };
  }

  // First ever run: remember everything currently listed without notifying,
  // otherwise the first check would send hundreds of old ads.
  if (!state.seeded || seedOnly) {
    state = recordSeen(state, listings, { seenIdsToKeep: config.seenIdsToKeep });
    state.seeded = true;
    state.lastCheckedAt = new Date().toISOString();
    await saveState(config.statePath, state);

    console.log(
      `[${stamp()}] seeded with ${listings.length} existing listings ` +
        `(${filteredCount ?? '?'} match the filter). Only ads posted from now on will be sent.`
    );
    return { sent: 0, failed: 0 };
  }

  const fresh = selectNewListings(listings, state);

  if (fresh.length === 0) {
    state.lastCheckedAt = new Date().toISOString();
    await saveState(config.statePath, state);
    console.log(`[${stamp()}] no new listings (${listings.length} scanned)`);
    return { sent: 0, failed: 0 };
  }

  // Oldest first, so Telegram shows them in the order they were published.
  const toSend = fresh.slice(0, config.maxNotificationsPerCheck).reverse();
  const skipped = fresh.length - toSend.length;

  console.log(`[${stamp()}] ${fresh.length} new listing(s) found`);

  const delivered = [];
  let failures = 0;
  for (const listing of toSend) {
    try {
      await telegram.sendListing(listing);
      delivered.push(listing);
      console.log(`  sent #${listing.id} — ${listing.title.slice(0, 60)}`);
      await sleep(400); // stay under Telegram's per-chat rate limit
    } catch (err) {
      failures++;
      console.error(`  FAILED #${listing.id}: ${err.message}`);
      // Leave it unrecorded so the next check retries it.
    }
  }

  if (skipped > 0) {
    const note =
      `ℹ️ ${skipped} more new listing(s) matched but were not sent, to avoid flooding. ` +
      `They will not be re-sent — open the search to see them.`;
    try {
      await telegram.sendText(note);
    } catch (err) {
      console.error(`  could not send the overflow note: ${err.message}`);
    }
    // Mark the skipped ones as handled so they do not pile up forever.
    delivered.push(...fresh.slice(config.maxNotificationsPerCheck));
  }

  if (delivered.length > 0) {
    state = recordSeen(state, delivered, { seenIdsToKeep: config.seenIdsToKeep });
    state.lastNotifiedAt = new Date().toISOString();
    state.totalNotified = (state.totalNotified || 0) + delivered.length;
  }

  state.lastCheckedAt = new Date().toISOString();
  await saveState(config.statePath, state);

  return { sent: delivered.length, failed: failures };
}

async function main() {
  const config = loadConfig();
  const telegram = new TelegramClient(config.telegram.botToken, config.telegram.chatId);

  if (flags.has('--test-telegram')) {
    const me = await telegram.getMe();
    await telegram.sendText(
      '✅ <b>Joymee rent watcher</b> is connected.\n' +
        'You will get a message here whenever a new listing matches your filters.'
    );
    console.log(`Telegram OK — bot @${me.username}, test message sent to chat ${config.telegram.chatId}.`);
    return;
  }

  // The API ignores entity_purpose/entity_type, so translate them into the
  // `category` filter it does respect. Without this, daily rentals and sale
  // listings leak into a long-term-rent search.
  const category = await applyCategoryFilter(config.searchParams);
  if (category.applied) {
    console.log(`Deal type: category=${category.categories.join(',')} (from ${category.source})`);
  } else {
    console.warn(`Deal type not narrowed — ${category.reason}`);
  }

  console.log(`Watching: ${config.searchUrl}`);
  console.log(`API query: ${config.searchParams.toString()}`);

  if (flags.has('--seed')) {
    await runCheck(config, telegram, { seedOnly: true });
    return;
  }

  const iterations = flags.has('--once') ? 1 : config.pollIterations;

  let totalSent = 0;
  let totalFailed = 0;
  let checksFailed = 0;

  for (let i = 1; i <= iterations; i++) {
    try {
      const result = await runCheck(config, telegram);
      totalSent += result.sent;
      totalFailed += result.failed;
    } catch (err) {
      // A single failed check must not kill the run; the next one may succeed.
      checksFailed++;
      console.error(`[${stamp()}] check failed: ${err.message}`);
    }

    if (i < iterations) await sleep(config.pollIntervalSeconds * 1000);
  }

  console.log(`Run finished: ${totalSent} sent, ${totalFailed} failed to send.`);

  // Make the run go red so a broken token or chat id is noticed, rather than
  // silently dropping listings every five minutes.
  if (totalFailed > 0) {
    throw new Error(
      `${totalFailed} listing(s) could not be delivered to Telegram. ` +
        `Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. They will be retried next run.`
    );
  }
  if (checksFailed === iterations) {
    throw new Error(`All ${iterations} check(s) failed.`);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
