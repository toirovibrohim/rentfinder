#!/usr/bin/env node
/**
 * Exercises access control without touching Telegram or the live state.
 *
 *   node scripts/test-access.js
 */

import { unlink } from 'node:fs/promises';
import { handleMessage, handleCallback } from '../src/commands.js';
import {
  loadSubscribers, saveSubscribers, approve, isActive,
  activeChatIds, pruneExpired, remaining,
} from '../src/subscribers.js';

const OWNER = '1453486493';
const GUEST = '555000111';
const KEY = 'test-key-not-a-real-secret';
const FILE = 'test-subscribers.json';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         expected ${JSON.stringify(expected)}\n         got      ${JSON.stringify(actual)}`}`);
}

const msg = (chatId, text) => ({ chat: { id: chatId }, from: { first_name: 'Test' }, text });
const run = (subs, chatId, text) =>
  handleMessage(msg(chatId, text), { ownerId: OWNER, subscribers: subs, accessHours: 24 });

console.log('\nstranger cannot grant themselves access');
{
  const subs = {};
  const r = run(subs, GUEST, '/approve ' + GUEST);
  check('refused', r.replies[0].text.includes('Only the owner'), true);
  check('nothing granted', Object.keys(subs), []);
  check('list unchanged', r.changed, false);
}

console.log('\nstranger sending /start notifies the owner with buttons');
{
  const subs = {};
  const r = run(subs, GUEST, '/start');
  check('two replies', r.replies.length, 2);
  check('owner notified', r.replies[1].to, OWNER);
  check('request shows the chat id', r.replies[1].text.includes(GUEST), true);
  check('request carries buttons', Array.isArray(r.replies[1].buttons), true);

  const data = r.replies[1].buttons.flat().map((b) => b.callback_data);
  check('approve / 7d / deny', data, [`approve:${GUEST}:24`, `approve:${GUEST}:168`, `deny:${GUEST}`]);
  check('callback data within Telegram 64 bytes', data.every((d) => Buffer.byteLength(d) <= 64), true);
  check('still not approved', activeChatIds(subs), []);
}

console.log('\nowner is notified even when the requester already has access');
{
  const subs = {};
  approve(subs, GUEST, { hours: 5 });
  const r = run(subs, GUEST, '/start');
  check('owner still told', r.replies[1].to, OWNER);
  check('notes existing access', r.replies[1].text.includes('already have access'), true);
}

const tap = (subs, fromId, data) =>
  handleCallback(
    { id: 'q', from: { id: fromId }, data, message: { chat: { id: OWNER }, message_id: 7 } },
    { ownerId: OWNER, subscribers: subs, accessHours: 24 }
  );

console.log('\nonly the owner can tap the buttons');
{
  const subs = {};
  const stranger = tap(subs, GUEST, `approve:${GUEST}:24`);
  check('refused', stranger.toast.includes('Only the owner'), true);
  check('granted nothing', activeChatIds(subs), []);
  check('message left alone', stranger.edit, null);

  const owner = tap(subs, OWNER, `approve:${GUEST}:24`);
  check('owner tap approves', activeChatIds(subs), [GUEST]);
  check('toast confirms', owner.toast, 'Approved for 24h');
  check('request rewritten', owner.edit.includes('Approved'), true);
  check('guest told', owner.replies[0].to, GUEST);
}

console.log('\ndeny button');
{
  const subs = {};
  approve(subs, GUEST, { hours: 24 });
  const denied = tap(subs, OWNER, `deny:${GUEST}`);
  check('access removed', activeChatIds(subs), []);
  check('changed', denied.changed, true);
  check('guest told', denied.replies[0].text.includes('removed'), true);

  const again = tap(subs, OWNER, `deny:${GUEST}`);
  check('denying twice is harmless', again.changed, false);
  check('no pointless message', again.replies.length, 0);
}

console.log('\nthe 7-day button grants 7 days');
{
  const subs = {};
  tap(subs, OWNER, `approve:${GUEST}:168`);
  check('~168h', Math.round((Date.parse(subs[GUEST].expiresAt) - Date.now()) / 3600000), 168);
}

console.log('\nmalformed callback data is rejected');
{
  const subs = {};
  check('empty', tap(subs, OWNER, '').toast.includes('no longer valid'), true);
  check('unknown action', tap(subs, OWNER, 'explode:123').toast.includes('Unknown'), true);
  check('granted nothing', activeChatIds(subs), []);
}

console.log('\nowner approves, guest gains access');
{
  const subs = {};
  const r = run(subs, OWNER, `/approve ${GUEST}`);
  check('changed', r.changed, true);
  check('guest active', activeChatIds(subs), [GUEST]);
  check('guest is told', r.replies.some((x) => x.to === GUEST), true);

  const s = run(subs, GUEST, '/status');
  check('guest sees access', s.replies[0].text.includes('expires in'), true);
}

console.log('\naccess expires');
{
  const subs = {};
  approve(subs, GUEST, { hours: 24 });
  check('active now', isActive(subs[GUEST]), true);

  // Push the expiry into the past.
  subs[GUEST].expiresAt = new Date(Date.now() - 60_000).toISOString();
  check('expired', isActive(subs[GUEST]), false);
  check('not a recipient', activeChatIds(subs), []);
  check('reports expired', remaining(subs[GUEST]), 'expired');

  const s = run(subs, GUEST, '/status');
  check('guest told they have none', s.replies[0].text.includes('do not have access'), true);
}

console.log('\ncustom duration, and re-approval extends');
{
  const subs = {};
  run(subs, OWNER, `/approve ${GUEST} 2`);
  const first = Date.parse(subs[GUEST].expiresAt);
  check('~2h', Math.round((first - Date.now()) / 3600000), 2);

  run(subs, OWNER, `/approve ${GUEST} 48`);
  check('extended to ~48h', Math.round((Date.parse(subs[GUEST].expiresAt) - Date.now()) / 3600000), 48);
}

console.log('\nrevoke');
{
  const subs = {};
  approve(subs, GUEST, { hours: 24 });
  const r = run(subs, OWNER, `/revoke ${GUEST}`);
  check('changed', r.changed, true);
  check('gone', activeChatIds(subs), []);

  const again = run(subs, OWNER, `/revoke ${GUEST}`);
  check('second revoke is a no-op', again.changed, false);
}

console.log('\nbad input is rejected, not crashed on');
{
  const subs = {};
  check('no id', run(subs, OWNER, '/approve').replies[0].text.includes('Usage'), true);
  check('bad hours', run(subs, OWNER, `/approve ${GUEST} abc`).replies[0].text.includes('not a valid'), true);
  check('nothing granted', Object.keys(subs), []);
  check('junk command survives', run(subs, GUEST, '/nonsense').replies.length, 1);
  check('plain text survives', run(subs, GUEST, 'hello').replies.length, 1);
}

console.log('\nold entries are pruned');
{
  const subs = {};
  approve(subs, GUEST, { hours: 24 });
  subs[GUEST].expiresAt = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
  approve(subs, '999', { hours: 24 });
  check('pruned the stale one', pruneExpired(subs), [GUEST]);
  check('kept the live one', Object.keys(subs), ['999']);
}

console.log('\nthe stored file is encrypted and round-trips');
{
  const subs = {};
  approve(subs, GUEST, { hours: 24 });
  await saveSubscribers(FILE, subs, KEY);

  const onDisk = await import('node:fs').then((fs) => fs.readFileSync(FILE, 'utf8'));
  check('chat id not in plaintext', onDisk.includes(GUEST), false);

  const back = await loadSubscribers(FILE, KEY);
  check('decrypts to the same list', Object.keys(back), [GUEST]);

  let threw = false;
  try { await loadSubscribers(FILE, 'the-wrong-key'); } catch { threw = true; }
  check('wrong key is an error, not an empty list', threw, true);

  await unlink(FILE);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} CHECK(S) FAILED.\n`);
process.exitCode = failures === 0 ? 0 : 1;
