// dev helper: pretend the N newest listings were never seen, so the next
// check treats them as brand new. Used to exercise the notification path.
import { loadState, saveState } from '../src/state.js';

const path = process.env.STATE_PATH || 'state.json';
const n = Number(process.argv[2] || 3);

const state = await loadState(path);
const dropped = state.seenIds.splice(-n, n);

// Pull the watermark back behind those listings too.
state.watermark = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

await saveState(path, state);
console.log(`Forgot ${dropped.length} listing id(s): ${dropped.join(', ')}`);
console.log(`Watermark rewound to ${state.watermark}`);
