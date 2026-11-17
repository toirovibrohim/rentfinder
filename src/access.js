/**
 * The access layer: reads commands sent to the bot, and decides who a
 * listing goes to.
 *
 * The owner always receives listings and never expires. Everyone else has to
 * be approved by the owner, and that approval runs out.
 */

import { handleMessage, handleCallback } from './commands.js';
import { isUnreachableChat } from './telegram.js';
import {
  loadSubscribers,
  saveSubscribers,
  activeChatIds,
  awaitingBackfill,
  startOfToday,
  pruneExpired,
  revoke,
} from './subscribers.js';

/** Access control is only on when a key is configured to protect the list. */
export function accessEnabled(config) {
  return Boolean(config.subscriberKey && config.subscriberKey.trim());
}

export async function readSubscribers(config) {
  if (!accessEnabled(config)) return {};
  return loadSubscribers(config.subscribersPath, config.subscriberKey);
}

export async function writeSubscribers(config, subscribers) {
  if (!accessEnabled(config)) return;
  await saveSubscribers(config.subscribersPath, subscribers, config.subscriberKey);
}

/**
 * Processes everything people have sent the bot since last time.
 *
 * `state.lastUpdateId` is the cursor. It is bumped even for messages that
 * produce no reply, so a message is never handled twice.
 */
export async function processCommands(telegram, config, state, subscribers) {
  if (!accessEnabled(config)) return { changed: false, handled: 0 };

  let updates;
  try {
    updates = await telegram.getUpdates(state.lastUpdateId ? state.lastUpdateId + 1 : undefined);
  } catch (err) {
    console.warn(`  could not read messages: ${err.message}`);
    return { changed: false, handled: 0 };
  }

  if (!Array.isArray(updates) || updates.length === 0) return { changed: false, handled: 0 };

  let changed = false;
  let handled = 0;

  for (const update of updates) {
    state.lastUpdateId = Math.max(state.lastUpdateId || 0, update.update_id);

    // A tapped Approve/Deny button.
    if (update.callback_query) {
      handled++;
      const query = update.callback_query;

      const outcome = handleCallback(query, {
        ownerId: config.telegram.chatId,
        subscribers,
        accessHours: config.accessHours,
      });

      if (outcome.changed) changed = true;

      // Telegram leaves the button spinning until this is answered.
      await telegram.answerCallback(query.id, outcome.toast).catch(() => {});

      // Rewrite the request so the decision is visible, and the buttons gone.
      if (outcome.edit && query.message) {
        await telegram
          .editText(query.message.chat.id, query.message.message_id, outcome.edit)
          .catch((err) => console.warn(`  could not update the request message: ${err.message}`));
      }

      for (const reply of outcome.replies) {
        try {
          await telegram.sendText(reply.text, { to: reply.to });
        } catch (err) {
          console.warn(`  could not tell ${reply.to}: ${err.message}`);
        }
      }

      continue;
    }

    const message = update.message;
    if (!message?.chat?.id) continue;

    handled++;

    const result = handleMessage(message, {
      ownerId: config.telegram.chatId,
      subscribers,
      accessHours: config.accessHours,
    });

    if (result.changed) changed = true;

    for (const reply of result.replies) {
      try {
        await telegram.sendText(reply.text, { to: reply.to, buttons: reply.buttons ?? null });
      } catch (err) {
        // Someone who has not started a chat with the bot cannot be written
        // to. That is expected for a freshly approved id.
        console.warn(`  could not reply to ${reply.to}: ${err.message}`);
      }
    }
  }

  const removed = pruneExpired(subscribers);
  if (removed.length > 0) changed = true;

  return { changed, handled };
}

/** Everyone a listing should go to: the owner, plus anyone with live access. */
export function recipients(config, subscribers) {
  const owner = String(config.telegram.chatId);
  if (!accessEnabled(config)) return [owner];

  const others = activeChatIds(subscribers).filter((id) => id !== owner);
  return [owner, ...others];
}

/**
 * Sends one listing to everyone entitled to it.
 *
 * Delivery counts as successful if the owner got it. A recipient who has
 * blocked the bot is dropped rather than retried forever; a listing is never
 * resent to the others because one person's chat is broken.
 */
export async function broadcastListing(telegram, listing, chatIds, { subscribers, onChange }) {
  const owner = chatIds[0];
  let ownerDelivered = false;

  for (const chatId of chatIds) {
    try {
      await telegram.sendListing(listing, { to: chatId });
      if (chatId === owner) ownerDelivered = true;
    } catch (err) {
      if (chatId === owner) throw err;

      if (isUnreachableChat(err)) {
        console.warn(`  ${chatId} is unreachable (${err.message}); access removed`);
        if (revoke(subscribers, chatId)) onChange?.();
      } else {
        console.warn(`  could not send to ${chatId}: ${err.message}`);
      }
    }

    // Telegram allows roughly one message per second per chat.
    await new Promise((r) => setTimeout(r, 120));
  }

  return ownerDelivered;
}

/**
 * Sends everything already posted today to people approved part-way through
 * it, so joining in the afternoon still shows the whole day.
 *
 * This is a separate, deeper fetch: the ordinary check only looks far enough
 * back to spot what is new, which is nowhere near a full day.
 */
export async function backfillToday(telegram, config, searches, subscribers, { onChange }) {
  const pending = awaitingBackfill(subscribers).filter(
    (chatId) => chatId !== String(config.telegram.chatId)
  );
  if (pending.length === 0) return 0;

  const since = startOfToday();
  console.log(`  catching ${pending.length} new recipient(s) up on today's listings`);

  // Gather today's listings once, then send the same set to each of them.
  const today = [];
  for (const { source, search } of searches) {
    try {
      const { listings } = await source.fetchListings(search, {
        pages: 1,
        maxPages: config.maxPagesToScan,
        // Keep paging while the page still holds something from today.
        isKnown: (listing) => listing.adsAtMs !== null && listing.adsAtMs < since,
      });
      for (const listing of listings) {
        if (listing.adsAtMs !== null && listing.adsAtMs >= since) today.push({ listing, source });
      }
    } catch (err) {
      console.warn(`  [${source.label}] could not gather today's listings: ${err.message}`);
    }
  }

  today.sort((a, b) => (a.listing.adsAtMs ?? 0) - (b.listing.adsAtMs ?? 0));

  const selected = today.slice(-config.maxBackfillListings);
  const omitted = today.length - selected.length;

  // Resolve details once for the whole set, not once per recipient.
  const capped = [];
  for (const { listing, source } of selected) {
    const detail = await source.fetchDetail(listing).catch(() => ({}));
    capped.push({ ...listing, ...detail });
  }

  let sent = 0;
  for (const chatId of pending) {
    try {
      await telegram.sendText(
        capped.length === 0
          ? 'Nothing has been posted yet today. New listings will arrive here as they appear.'
          : `📋 Catching you up on <b>${capped.length}</b> listing(s) posted today` +
              (omitted > 0 ? `, the most recent of ${today.length}` : '') +
              '. New ones will follow as they appear.',
        { to: chatId }
      );

      let inBatch = 0;
      for (const listing of capped) {
        await telegram.sendListing(listing, { to: chatId });
        sent++;

        // Same pacing as a normal check: short gaps, then a pause, so a long
        // catch-up arrives steadily instead of being refused part-way.
        inBatch++;
        if (inBatch >= config.batchSize) {
          inBatch = 0;
          await new Promise((r) => setTimeout(r, config.batchPauseSeconds * 1000));
        } else {
          await new Promise((r) => setTimeout(r, config.sendIntervalMs));
        }
      }

      subscribers[chatId].backfillPending = false;
      onChange?.();
    } catch (err) {
      if (isUnreachableChat(err)) {
        console.warn(`  ${chatId} is unreachable (${err.message}); access removed`);
        if (revoke(subscribers, chatId)) onChange?.();
      } else {
        // Left pending, so the next check tries again.
        console.warn(`  could not catch ${chatId} up: ${err.message}`);
      }
    }
  }

  return sent;
}
