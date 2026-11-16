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
