import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archive, parseExport } from '../src/archive.js';
import { openDb } from '../src/db.js';

const US = '\x1f', RS = '\x1e';
const rec = (wid, wi, ti, cur, url, title) => [wid, wi, ti, cur, url, title].join(US) + RS;
const tab = (url, title, i = 1) => ({ window_id: 1, window_index: 1, tab_index: i, is_current: i === 1 ? 1 : 0, url, title, source: 'safari' });

test('parseExport: separators, special characters, non-http tabs and trailing newline', () => {
  const out = rec(18968, 1, 1, 1, 'https://a.example/x?q=1', 'Ä, "quoted"\ttitle 🎉')
    + rec(18968, 1, 2, 0, 'favorites://', 'Favorites')
    + rec(18970, 2, 1, 1, 'http://b.example/', '') + '\n';
  const tabs = parseExport(out);
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs[0], { window_id: 18968, window_index: 1, tab_index: 1, is_current: 1, url: 'https://a.example/x?q=1', title: 'Ä, "quoted"\ttitle 🎉', source: 'safari' });
  assert.deepEqual(tabs[1], { window_id: 18970, window_index: 2, tab_index: 1, is_current: 1, url: 'http://b.example/', title: '', source: 'safari' });
  assert.deepEqual(parseExport('\n'), []);
});

test('archive: dedupes links per URL, keeps a per-run inventory, bumps times_seen once per run', () => {
  const db = openDb(':memory:');
  const tabs = [tab('https://a.example/x', 'first title'), tab('https://a.example/x', 'same url again', 2), tab('https://b.example/', 'B', 3)];
  const r1 = archive({ db, tabs, close: false });
  const r2 = archive({ db, tabs: [tab('https://a.example/x', '')], close: false });
  assert.deepEqual([r1.found, r1.newLinks, r1.closed], [3, 2, 0]);
  assert.deepEqual([r2.found, r2.newLinks], [1, 0]);
  assert.equal(db.prepare('SELECT count(*) n FROM links').get().n, 2);
  const a = db.prepare('SELECT title, times_seen FROM links WHERE url = ?').get('https://a.example/x');
  assert.equal(a.times_seen, 2, 'two runs, not three tabs');
  assert.equal(a.title, 'first title', 'an empty title never overwrites a known one');
  assert.equal(db.prepare('SELECT count(*) n FROM tabs').get().n, 4);
  assert.equal(db.prepare('SELECT sum(is_current) n FROM tabs WHERE run_id = 1').get().n, 1);
  assert.deepEqual(db.prepare('SELECT tabs_found, new_links, closed FROM runs ORDER BY id').all().map(Object.values), [[3, 2, 0], [1, 0, 0]]);
});

test('archive: closes only after the write committed', () => {
  const db = openDb(':memory:');
  let closed = 0;
  const closer = () => closed++;
  const r = archive({ db, tabs: [tab('https://a.example/', 'A')], close: true, closer, running: () => true });
  assert.deepEqual([r.closed, closed], [1, 1]);
  assert.equal(db.prepare('SELECT closed FROM runs').get().closed, 1);

  archive({ db, tabs: [], close: true, closer, running: () => true });
  assert.equal(closed, 1, 'nothing found, nothing closed');

  archive({ db, tabs: [tab('https://a.example/', 'A')], close: true, closer, running: () => false });
  assert.equal(closed, 1, 'Safari not running, nothing closed');

  db.exec('PRAGMA query_only = 1');
  assert.throws(() => archive({ db, tabs: [tab('https://a.example/', 'A')], close: true, closer, running: () => true }), /readonly|query_only|attempt to write/i);
  assert.equal(closed, 1, 'failed write, nothing closed');
});
