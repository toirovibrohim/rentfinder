/**
 * Handles messages sent to the bot.
 *
 * Only the owner can grant access. Anyone else who writes in is told their
 * chat id and that the owner has to approve it — nobody can subscribe
 * themselves, and no listing is ever sent to an unapproved chat.
 */

import { approve, revoke, isActive, remaining, activeChatIds } from './subscribers.js';

const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const OWNER_HELP = [
  '<b>Owner commands</b>',
  '',
  '/approve &lt;chat_id&gt; [hours] — grant access (default {hours}h)',
  '/revoke &lt;chat_id&gt; — remove access now',
  '/list — who currently has access',
  '/whoami — your own chat id',
].join('\n');

function describeUser(message) {
  const from = message.from || {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return name || from.username || null;
}

/**
 * Applies one incoming message.
 *
 * Returns the replies to send, and whether the approved-chat list changed.
 * Nothing is sent from here, so this stays easy to test.
 */
export function handleMessage(message, { ownerId, subscribers, accessHours }) {
  const chatId = String(message.chat?.id ?? '');
  const text = (message.text || '').trim();
  const isOwner = chatId === String(ownerId);
  const replies = [];
  let changed = false;

  if (!text.startsWith('/')) {
    // Not a command. Say something useful rather than nothing.
    if (isOwner) {
      replies.push({ to: chatId, text: OWNER_HELP.replace('{hours}', accessHours) });
    } else {
      replies.push({
        to: chatId,
        text:
          'This bot sends new rental listings to approved people only.\n\n' +
          `Your chat id is <code>${escapeHtml(chatId)}</code> — send it to the owner to ask for access.`,
      });
    }
    return { replies, changed };
  }

  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.split('@')[0].toLowerCase();

  switch (command) {
    case '/start':
    case '/help': {
      if (isOwner) {
        replies.push({ to: chatId, text: OWNER_HELP.replace('{hours}', accessHours) });
        break;
      }

      const entry = subscribers[chatId];
      if (isActive(entry)) {
        replies.push({
          to: chatId,
          text: `✅ You have access for another <b>${escapeHtml(remaining(entry))}</b>. New listings will arrive here.`,
        });
      } else {
        replies.push({
          to: chatId,
          text:
            'This bot sends new rental listings to approved people only.\n\n' +
            `Your chat id is <code>${escapeHtml(chatId)}</code> — send it to the owner to ask for access.`,
        });
        // Tell the owner, with the command ready to copy.
        replies.push({
          to: String(ownerId),
          text:
            `👤 Access requested by ${escapeHtml(describeUser(message) || 'someone')}\n` +
            `chat id: <code>${escapeHtml(chatId)}</code>\n\n` +
            `Approve with:\n<code>/approve ${escapeHtml(chatId)}</code>`,
        });
      }
      break;
    }

    case '/whoami':
      replies.push({ to: chatId, text: `Your chat id is <code>${escapeHtml(chatId)}</code>.` });
      break;

    case '/status': {
      const entry = subscribers[chatId];
      replies.push({
        to: chatId,
        text: isActive(entry)
          ? `✅ Access expires in <b>${escapeHtml(remaining(entry))}</b>.`
          : '❌ You do not have access at the moment.',
      });
      break;
    }

    case '/approve': {
      if (!isOwner) {
        replies.push({ to: chatId, text: 'Only the owner can approve access.' });
        break;
      }

      const target = (args[0] || '').replace(/[^0-9-]/g, '');
      if (!target) {
        replies.push({ to: chatId, text: 'Usage: <code>/approve &lt;chat_id&gt; [hours]</code>' });
        break;
      }

      const hours = args[1] ? Number.parseFloat(args[1]) : accessHours;
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) {
        replies.push({ to: chatId, text: `"${escapeHtml(args[1])}" is not a valid number of hours.` });
        break;
      }

      const entry = approve(subscribers, target, { hours });
      changed = true;

      replies.push({
        to: chatId,
        text: `✅ <code>${escapeHtml(target)}</code> approved for <b>${hours}h</b> (until ${escapeHtml(entry.expiresAt.slice(0, 16).replace('T', ' '))} UTC).`,
      });
      replies.push({
        to: target,
        text:
          `✅ You have been given access for <b>${hours}h</b>.\n` +
          'New rental listings will arrive here as they are posted.\n\n' +
          'Send /status any time to see how long is left.',
      });
      break;
    }

    case '/revoke': {
      if (!isOwner) {
        replies.push({ to: chatId, text: 'Only the owner can revoke access.' });
        break;
      }

      const target = (args[0] || '').replace(/[^0-9-]/g, '');
      if (!target) {
        replies.push({ to: chatId, text: 'Usage: <code>/revoke &lt;chat_id&gt;</code>' });
        break;
      }

      changed = revoke(subscribers, target);
      replies.push({
        to: chatId,
        text: changed
          ? `🚫 Access removed for <code>${escapeHtml(target)}</code>.`
          : `<code>${escapeHtml(target)}</code> did not have access.`,
      });
      break;
    }

    case '/list': {
      if (!isOwner) {
        replies.push({ to: chatId, text: 'Only the owner can list access.' });
        break;
      }

      const active = activeChatIds(subscribers);
      if (active.length === 0) {
        replies.push({ to: chatId, text: 'Nobody has access right now (you always do).' });
        break;
      }

      const lines = active.map((id) => {
        const entry = subscribers[id];
        const who = entry.name ? ` — ${escapeHtml(entry.name)}` : '';
        return `• <code>${escapeHtml(id)}</code>${who} — ${escapeHtml(remaining(entry))} left`;
      });
      replies.push({ to: chatId, text: `<b>Active access (${active.length})</b>\n${lines.join('\n')}` });
      break;
    }

    default:
      replies.push({
        to: chatId,
        text: isOwner
          ? OWNER_HELP.replace('{hours}', accessHours)
          : 'Unknown command. Send /status to check your access.',
      });
  }

  return { replies, changed };
}
