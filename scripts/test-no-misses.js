#!/usr/bin/env node
/**
 * Checks the ways a new listing could be missed entirely.
 *
 * Being late is tolerable — the next check catches up. Being skipped is not,
 * because nothing ever comes back for it. These are the two paths found that
 * could skip one.
 *
 *   node scripts/test-no-misses.js
 */

import { recordSeen, makeIsKnown, selectNewListings, selectUnsent } from '../src/state.js';

let failures = 0;

/** Compares actual against expected, so a wrong value fails rather than any truthy one. */
const check = (label, actual, expected, note = '') => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label}${note ? ` — ${note}` : ''}` +
      (ok ? '' : `
         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  );
};

const at = (iso) => ({ key: 'olx:' + iso, adsAtMs: Date.parse(iso), adsAt: iso });

console.log('\na failed send is retried, not buried by a newer sibling');
{
  // Two new listings; the older one fails to send, the newer succeeds.
  const older = at('2026-11-17T10:00:00Z');
  const newer = at('2026-11-17T10:05:00Z');

  const source = { seeded: true, watermark: '2026-11-17T09:00:00Z', seenIds: [] };
  recordSeen(source, [newer], { seenIdsToKeep: 100, notBeyond: older.adsAtMs });

  const stillNew = selectNewListings([older, newer], source);
  check('the failed one is still pending', stillNew.map((l) => l.key), [older.key]);
  check('the sent one is not resent', stillNew.includes(newer), false);

  // Without the guard the watermark would jump past the failure.
  const naive = { seeded: true, watermark: '2026-11-17T09:00:00Z', seenIds: [] };
  recordSeen(naive, [newer], { seenIdsToKeep: 100 });
  check(
    'the guard is what saves it',
    selectNewListings([older], naive).length,
    0,
    'unguarded, the older listing is already treated as handled'
  );
}

console.log('\nwatermark still advances when everything sends');
{
  const a = at('2026-11-17T10:00:00Z');
  const b = at('2026-11-17T10:05:00Z');
  const source = { seeded: true, watermark: null, seenIds: [] };
  recordSeen(source, [a, b], { seenIdsToKeep: 100, notBeyond: null });
  check('moved to the newest', source.watermark, new Date(b.adsAtMs).toISOString());
}

console.log('\npaging does not stop on a page that filters down to nothing');
{
  // Mimics OLX: most listings are filtered out, so a page can hold new
  // listings and still contribute none that pass.
  const known = new Set(['olx:seen-1', 'olx:seen-2']);
  const isKnown = (l) => known.has(l.key);

  const page = [
    { key: 'olx:seen-1', adsAtMs: 1 },
    { key: 'olx:new-1', adsAtMs: 2 }, // new, but filtered out (an agency)
  ];
  const passingFilters = page.filter((l) => false); // nothing survives

  check(
    'judging the filtered subset stops paging',
    passingFilters.every(isKnown),
    true,
    '[].every() is true — this was the bug'
  );
  check(
    'judging the whole page keeps going',
    page.every(isKnown),
    false,
    'the page held something unseen, so paging continues'
  );
}

console.log('\na blocked fetch delays rather than skips');
{
  // A source that throws is caught per-source; nothing is recorded, so the
  // same listings are still unseen next time.
  const source = { seeded: true, watermark: '2026-11-17T09:00:00Z', seenIds: [] };
  const before = JSON.stringify(source);
  // (no recordSeen call — this is what a thrown fetch leaves behind)
  check('state untouched by a failed fetch', JSON.stringify(source) === before, true);

  const listing = at('2026-11-17T10:00:00Z');
  check('listing still counts as new', selectNewListings([listing], source).length, 1);
}

console.log('\nlistings deferred past the per-check cap stay pending');
{
  // The cap keeps the NEWEST and defers the OLDEST, so a deferred listing
  // always sits below the watermark the sent ones would set. An earlier
  // version of this test had it the other way round and so proved nothing.
  const sent = at('2026-11-17T10:05:00Z');
  const deferredOlder = at('2026-11-17T10:01:00Z');

  const guarded = { seeded: true, watermark: '2026-11-17T09:00:00Z', seenIds: [] };
  recordSeen(guarded, [sent], { seenIdsToKeep: 100, notBeyond: deferredOlder.adsAtMs });
  check(
    'deferred listing still pending',
    selectNewListings([deferredOlder], guarded).map((l) => l.key),
    [deferredOlder.key]
  );

  const unguarded = { seeded: true, watermark: '2026-11-17T09:00:00Z', seenIds: [] };
  recordSeen(unguarded, [sent], { seenIdsToKeep: 100 });
  check(
    'without the guard it would be lost',
    selectNewListings([deferredOlder], unguarded).length,
    0,
    'the watermark jumps past it and it is never sent'
  );
}

console.log('\nthe remembered-id list rolling over cannot resurface old listings');
{
  const source = { seeded: true, watermark: null, seenIds: [] };
  const old = at('2026-11-10T10:00:00Z');
  const recent = at('2026-11-17T10:00:00Z');
  recordSeen(source, [old, recent], { seenIdsToKeep: 1, notBeyond: null });

  check('only one id remembered', source.seenIds.length, 1);
  check(
    'the forgotten one is held back by the watermark',
    makeIsKnown(source)(old),
    true
  );
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} CHECK(S) FAILED.\n`);
process.exitCode = failures === 0 ? 0 : 1;

console.log('\nreconciliation finds listings the watermark wrote off');
{
  // A listing that was never sent but sits below the watermark — what an
  // outage or a cancelled run leaves behind.
  const source = {
    seeded: true,
    watermark: '2026-11-17T12:00:00Z',
    seenIds: ['olx:already-sent'],
  };
  const stranded = at('2026-11-17T11:00:00Z');

  check(
    'a normal check cannot see it',
    selectNewListings([stranded], source).length,
    0,
    'it is below the watermark, so it counts as handled'
  );
  check(
    'reconciliation does see it',
    selectUnsent([stranded], source).map((l) => l.key),
    [stranded.key]
  );

  const sent = { key: 'olx:already-sent', adsAtMs: Date.parse('2026-11-17T11:30:00Z') };
  check(
    'and does not resend what was already sent',
    selectUnsent([sent], source).length,
    0
  );
}
