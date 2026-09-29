import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupCandidates } from '../src/cleanup.js';
import { cached, openDb } from '../src/db.js';

test('cached: hit within ttl, miss after expiry, async fn supported', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const fn = async () => ({ n: ++calls });
  assert.deepEqual(await cached(db, 'k', 60, fn), { n: 1 });
  assert.deepEqual(await cached(db, 'k', 60, fn), { n: 1 }, 'served from cache');
  db.prepare("UPDATE cache SET expires_at = '2000-01-01T00:00:00Z' WHERE key = 'k'").run();
  assert.deepEqual(await cached(db, 'k', 60, fn), { n: 2 }, 'expired entry refetched');
  assert.equal(await cached(db, 'null', 60, () => null), null);
});

test('cleanup: GitHub states and Jev verdicts are cached across runs', async () => {
  const db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO links (url, title, first_seen, last_seen, times_seen) VALUES (?, ?, ?, ?, 1)');
  ins.run('https://github.com/o/r/pull/1', 'merged', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
  ins.run('https://github.com/o/r/pull/2', 'open', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
  ins.run('https://old.example/', 'Old', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
  let gh = 0, jev = 0;
  const run = async (_, args) => { gh++; return args[1].endsWith('/1') ? { state: 'closed', merged: 'x' } : { state: 'open', merged: null }; };
  const ask = async (_, q) => { jev++; return Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.9 }])); };

  const first = await cleanupCandidates(db, { ask, run });
  assert.deepEqual(first.map((l) => l.reason).sort(), ['merged PR', 'stale 0.90', 'stale 0.90'], 'the open but aged PR is judged by Jev too');
  assert.deepEqual([gh, jev], [2, 1]);

  const second = await cleanupCandidates(db, { ask, run });
  assert.deepEqual(second.map((l) => l.reason).sort(), ['merged PR', 'stale 0.90', 'stale 0.90']);
  assert.deepEqual([gh, jev], [2, 1], 'no new calls');

  db.prepare("UPDATE cache SET expires_at = '2000-01-01T00:00:00Z' WHERE key LIKE 'gh:%pulls/2'").run();
  await cleanupCandidates(db, { ask, run });
  assert.deepEqual([gh, jev], [3, 1], 'only the expired open PR is rechecked');

  db.prepare("UPDATE links SET last_seen = '2025-06-01T00:00:00Z' WHERE title = 'Old'").run();
  await cleanupCandidates(db, { ask, run });
  assert.equal(jev, 2, 'a link seen again gets a fresh verdict');
});
