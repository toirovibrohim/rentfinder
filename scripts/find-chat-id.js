#!/usr/bin/env node
/**
 * Looks up the chat id to notify, by reading the messages people have sent
 * the bot. Message the bot once, then run this.
 *
 *   npm run find-chat-id
 *
 * The token is read from .env and never printed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { loadDotEnv } from '../src/config.js';

loadDotEnv();

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set in .env');
    return 1;
  }

  const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

  const me = await (await fetch(api('getMe'))).json();
  if (!me.ok) {
    console.error(`Token rejected by Telegram: ${me.description}`);
    return 1;
  }
  console.log(`Bot: @${me.result.username} (${me.result.first_name})\n`);

  const updates = await (await fetch(api('getUpdates'))).json();
  if (!updates.ok) {
    console.error(`getUpdates failed: ${updates.description}`);
    return 1;
  }

  const chats = new Map();
  for (const u of updates.result) {
    const msg = u.message || u.edited_message || u.channel_post || u.my_chat_member;
    const chat = msg?.chat;
    if (chat && !chats.has(chat.id)) chats.set(chat.id, chat);
  }

  if (chats.size === 0) {
    console.log('No conversations found yet.');
    console.log(`Open Telegram, find @${me.result.username}, and send it any message.`);
    console.log('Then run this again. (A bot cannot message you until you message it first.)');
    return 2;
  }

  console.log('Chats that have talked to this bot:');
  for (const chat of chats.values()) {
    const who = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || '';
    const handle = chat.username ? ` (@${chat.username})` : '';
    console.log(`  id=${chat.id}   type=${chat.type}   ${who}${handle}`);
  }

  // With exactly one private chat, wire it straight into .env.
  const privateChats = [...chats.values()].filter((c) => c.type === 'private');
  if (privateChats.length === 1) {
    const id = String(privateChats[0].id);
    const env = readFileSync('.env', 'utf8');
    const updated = /TELEGRAM_CHAT_ID=.*/.test(env)
      ? env.replace(/TELEGRAM_CHAT_ID=.*/, `TELEGRAM_CHAT_ID=${id}`)
      : `${env.trimEnd()}\nTELEGRAM_CHAT_ID=${id}\n`;
    writeFileSync('.env', updated, 'utf8');
    console.log(`\nWrote TELEGRAM_CHAT_ID=${id} to .env`);
  } else {
    console.log('\nMore than one chat found — put the right id in .env yourself.');
  }

  return 0;
}

process.exitCode = await main();
