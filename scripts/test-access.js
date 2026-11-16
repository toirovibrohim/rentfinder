#!/usr/bin/env node
/**
 * Exercises access control without touching Telegram or the live state.
 *
 *   node scripts/test-access.js
 */

import { unlink } from 'node:fs/promises';
import { handleMessage } from '../src/commands.js';
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

console.log('\nstranger sending /start is told their id, and the owner is notified');
{
  const subs = {};
  const r = run(subs, GUEST, '/start');
  check('two replies', r.replies.length, 2);
  check('guest told their id', r.replies[0].text.includes(GUEST), true);
  check('owner notified', r.replies[1].to, OWNER);
  check('owner gets a ready command', r.replies[1].text.includes(`/approve ${GUEST}`), true);
  check('still not approved', activeChatIds(subs), []);
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
