import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { pick } from '../src/focus.js';
import { fetchPage, ingest } from '../src/ingest.js';

const fakeFetch = (pages) => async (url, opts) => {
  assert.equal(opts.headers.authorization, 'Bearer k');
  const target = url.replace('https://r.jina.ai/', '');
  const p = pages[target];
  if (!p) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => ({ data: p }) };
};

test('fetchPage: title, description, excerpt without images or extra whitespace', async () => {
  const f = fakeFetch({ 'https://a/': { title: ' A ', description: 'desc', content: 'Hello\n\n![img](x.png)   world  ' + 'x'.repeat(900) } });
  const p = await fetchPage('https://a/', 'k', f);
  assert.deepEqual([p.title, p.description, p.excerpt.slice(0, 11), p.excerpt.length], ['A', 'desc', 'Hello world', 800]);
  await assert.rejects(fetchPage('https://missing/', 'k', f), /jina 404/);
});

test('ingest: fetches only recent links without a page, records failures, retries failures after 7 days', async () => {
  const db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO links (url, title, first_seen, last_seen) VALUES (?, ?, ?, ?)');
  const fresh = new Date().toISOString();
  ins.run('https://a/', 'A', fresh, fresh);
  ins.run('https://missing/', 'M', fresh, fresh);
  ins.run('https://old/', 'O', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
  const f = fakeFetch({ 'https://a/': { title: 'A', description: 'about a', content: 'body' } });
  const lines = [];
  assert.deepEqual(await ingest(db, { key: 'k', fetchImpl: f, log: (m) => lines.push(m) }), { ok: 1, failed: 1, attempted: 2 });
  assert.deepEqual(lines, ['ingested 1 pages, 1 failed (2 attempted)']);
  assert.deepEqual(await ingest(db, { key: 'k', fetchImpl: f, log: () => {} }), { ok: 0, failed: 0, attempted: 0 }, 'nothing left to fetch');
  db.prepare("UPDATE pages SET fetched_at = '2020-01-01T00:00:00Z' WHERE error IS NOT NULL").run();
  assert.deepEqual(await ingest(db, { key: 'k', fetchImpl: f, log: () => {} }), { ok: 0, failed: 1, attempted: 1 }, 'old failure retried');
  assert.deepEqual(await ingest(db, { key: 'k', fetchImpl: f, log: () => {}, force: true }), { ok: 1, failed: 1, attempted: 2 });
  await assert.rejects(ingest(db, { key: null }), /JINA_API_KEY/);
});

test('pick: page summaries reach the Jev question', async () => {
  const seen = [];
  const ask = async (_, q) => { Object.values(q).forEach((x) => seen.push(x.instructions)); return Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.9 }])); };
  await pick([{ url: 'https://a/', title: 'A', summary: 'about knowledge graphs' }, { url: 'https://b/', title: 'B' }], ['topic: x'], ask, {});
  assert.ok(seen.some((s) => /Page summary: about knowledge graphs/.test(s)));
  assert.ok(seen.some((s) => /Tab title: "B" URL: https:\/\/b\/$/.test(s)), 'no summary suffix without a page');
});
