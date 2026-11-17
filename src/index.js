#!/usr/bin/env node
/**
 * rent-watcher
 *
 * Checks one or more filtered property searches on a schedule and sends
 * every newly published listing to Telegram, exactly once.
 */

import { loadConfig } from './config.js';
import { sourceForUrl } from './sources/index.js';
import { TelegramClient } from './telegram.js';
import {
  accessEnabled,
  readSubscribers,
  writeSubscribers,
  processCommands,
  recipients,
  broadcastListing,
  backfillToday,
} from './access.js';
import {
  loadState,
  saveState,
  sourceState,
  selectNewListings,
  recordSeen,
  makeIsKnown,
} from './state.js';

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

/** Resolves each configured URL to its adapter and prepared query. */
async function prepareSearches(config) {
  const searches = [];

  for (const url of config.searchUrls) {
    const source = sourceForUrl(url);
    const search = await source.buildSearch(url);

    console.log(`\n[${source.label}] ${url}`);
    console.log(`  query: ${search.describe()}`);
    for (const note of search.notes || []) console.log(`  note:  ${note}`);

    searches.push({ source, search, url });
  }

  return searches;
}

/**
 * Checks one source. Returns what it sent and whether it failed, leaving
 * state updated in place.
 */
async function checkSource({ source, search }, config, state, telegram, ctx, { seedOnly }) {
  const sourceSt = sourceState(state, source.name);

  const { listings, filteredCount, pagesFetched } = await source.fetchListings(search, {
    pages: config.pagesToScan,
    maxPages: config.maxPagesToScan,
    // Seeding wants a snapshot, not a catch-up, so it never pages further.
    isKnown: sourceSt.seeded && !seedOnly ? makeIsKnown(sourceSt) : null,
  });

  const tag = `[${source.label}]`;

  if (listings.length === 0) {
    console.log(`  ${tag} nothing matched the filters`);
    return { sent: 0, failed: 0 };
  }

  if (pagesFetched > config.pagesToScan) {
    console.log(`  ${tag} went ${pagesFetched} pages deep — a burst was posted`);
  }

  // First run for this source: remember what is already listed without
  // notifying, otherwise the first check would send hundreds of old ads.
  if (!sourceSt.seeded || seedOnly) {
    recordSeen(sourceSt, listings, { seenIdsToKeep: config.seenIdsToKeep });
    sourceSt.seeded = true;
    console.log(
      `  ${tag} seeded with ${listings.length} listings (${filteredCount ?? '?'} match). Only new ads from now on.`
    );
    return { sent: 0, failed: 0 };
  }

  const fresh = selectNewListings(listings, sourceSt);
  if (fresh.length === 0) {
    console.log(`  ${tag} no new listings (${listings.length} scanned)`);
    return { sent: 0, failed: 0 };
  }

  // Oldest first, so Telegram shows them in publication order.
  const toSend = fresh.slice(0, config.maxNotificationsPerCheck).reverse();
  const skipped = fresh.slice(config.maxNotificationsPerCheck);

  console.log(`  ${tag} ${fresh.length} new listing(s)`);

  const delivered = [];
  let failures = 0;

  for (const listing of toSend) {
    try {
      // Some sources keep phone, area and floor on a per-listing endpoint.
      const detail = await source.fetchDetail(listing);
      await broadcastListing(telegram, { ...listing, ...detail }, ctx.chatIds, {
        subscribers: ctx.subscribers,
        onChange: () => { ctx.subscribersChanged = true; },
      });
      delivered.push(listing);
      const to = ctx.chatIds.length > 1 ? ` → ${ctx.chatIds.length} chats` : '';
      console.log(`    sent ${listing.key}${to} — ${listing.title.slice(0, 50)}`);
      await sleep(400); // stay under Telegram's per-chat rate limit
    } catch (err) {
      failures++;
      console.error(`    FAILED ${listing.key}: ${err.message}`);
      // Left unrecorded, so the next check retries it.
    }
  }

  if (skipped.length > 0) {
    try {
      const note =
        `ℹ️ ${skipped.length} more new listing(s) on ${source.label} matched but were not sent, ` +
        `to avoid flooding. They will not be re-sent — open the search to see them.`;
      for (const chatId of ctx.chatIds) {
        await telegram.sendText(note, { to: chatId }).catch(() => {});
      }
    } catch (err) {
      console.error(`    could not send the overflow note: ${err.message}`);
    }
    // Mark them handled so they do not pile up forever.
    delivered.push(...skipped);
  }

  if (delivered.length > 0) {
    recordSeen(sourceSt, delivered, { seenIdsToKeep: config.seenIdsToKeep });
  }

  return { sent: delivered.length, failed: failures };
}

/** One check across every configured source. */
async function runCheck(searches, config, telegram, { seedOnly = false } = {}) {
  const state = await loadState(config.statePath);
  const subscribers = await readSubscribers(config);

  // Answer anyone who wrote in before deciding who this check's listings
  // go to, so an approval granted a moment ago already counts.
  const commands = await processCommands(telegram, config, state, subscribers);
  if (commands.handled > 0) console.log(`  handled ${commands.handled} message(s)`);

  const ctx = {
    subscribers,
    chatIds: recipients(config, subscribers),
    subscribersChanged: commands.changed,
  };

  if (ctx.chatIds.length > 1) {
    console.log(`  recipients: owner + ${ctx.chatIds.length - 1} approved`);
  }

  let sent = 0;
  let failed = 0;

  for (const entry of searches) {
    try {
      const result = await checkSource(entry, config, state, telegram, ctx, { seedOnly });
      sent += result.sent;
      failed += result.failed;
    } catch (err) {
      // One site being down must not stop the others.
      failed++;
      console.error(`  [${entry.source.label}] check failed: ${err.message}`);
    }
  }

  // Anyone approved part-way through today gets the rest of it. Done after
  // the normal check, so a listing found moments ago is included.
  if (!seedOnly) {
    try {
      sent += await backfillToday(telegram, config, searches, subscribers, {
        onChange: () => {
          ctx.subscribersChanged = true;
        },
      });
    } catch (err) {
      failed++;
      console.error(`  catch-up failed: ${err.message}`);
    }
  }

  state.lastCheckedAt = new Date().toISOString();
  if (sent > 0) {
    state.lastNotifiedAt = new Date().toISOString();
    state.totalNotified = (state.totalNotified || 0) + sent;
  }
  await saveState(config.statePath, state);

  if (ctx.subscribersChanged) await writeSubscribers(config, subscribers);

  return { sent, failed };
}

async function main() {
  const config = loadConfig();
  const telegram = new TelegramClient(config.telegram.botToken, config.telegram.chatId);

  if (flags.has('--test-telegram')) {
    const me = await telegram.getMe();
    await telegram.sendText(
      '✅ <b>Rent watcher</b> is connected.\n' +
        'You will get a message here whenever a new listing matches your filters.'
    );
    console.log(`Telegram OK — bot @${me.username}, test message sent to chat ${config.telegram.chatId}.`);
    return;
  }

  if (accessEnabled(config)) {
    console.log(`Access control: on — approvals last ${config.accessHours}h`);
  } else {
    console.log('Access control: off — only the owner receives listings');
    console.log('  (set SUBSCRIBER_KEY to let the owner approve other chats)');
  }

  const searches = await prepareSearches(config);
  console.log('');

  if (flags.has('--seed')) {
    await runCheck(searches, config, telegram, { seedOnly: true });
    return;
  }

  const iterations = flags.has('--once') ? 1 : config.pollIterations;

  let totalSent = 0;
  let totalFailed = 0;

  for (let i = 1; i <= iterations; i++) {
    console.log(`[${stamp()}] check ${i}/${iterations}`);
    const result = await runCheck(searches, config, telegram);
    totalSent += result.sent;
    totalFailed += result.failed;

    if (i < iterations) await sleep(config.pollIntervalSeconds * 1000);
  }

  console.log(`\nRun finished: ${totalSent} sent, ${totalFailed} failure(s).`);

  // Make the run go red so a broken token or a dead site is noticed, rather
  // than listings being dropped quietly every few minutes.
  if (totalFailed > 0) {
    throw new Error(
      `${totalFailed} failure(s) during this run. Check the log above. ` +
        `Anything undelivered will be retried next run.`
    );
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);

  // Also emit it as a GitHub Actions annotation, so the reason shows on the
  // run summary instead of only inside the log.
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error::${String(err.message).replace(/\r?\n/g, ' ')}`);
  }

  process.exit(1);
});
