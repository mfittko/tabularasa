import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupCandidates } from '../src/cleanup.js';
import { openDb } from '../src/db.js';
import { focus, windows } from '../src/focus.js';
import { isMuted, mute, mutes, pin, pins, unmute, unpin, withPins } from '../src/prefs.js';

const seed = (db) => {
  const ins = db.prepare('INSERT INTO links (url, title, first_seen, last_seen) VALUES (?, ?, ?, ?)');
  const fresh = new Date().toISOString();
  ins.run('https://docs.example/kg', 'Knowledge Graph RFC', fresh, fresh);
  ins.run('https://dash.example/', 'Team dashboard', fresh, fresh);
  ins.run('https://news.example/cats', 'Cats daily', fresh, fresh);
  ins.run('https://old.example/', 'Old thing', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
};

test('pin by title fragment or URL, unpin, mute, unmute, listing', () => {
  const db = openDb(':memory:'); seed(db);
  assert.equal(pin(db, 'dashboard'), 'https://dash.example/');
  assert.equal(pin(db, 'https://elsewhere.example/'), 'https://elsewhere.example/', 'URLs pin even when not archived');
  assert.equal(pin(db, 'nope'), null);
  assert.deepEqual(pins(db), ['https://dash.example/', 'https://elsewhere.example/']);
  assert.equal(unpin(db, 'elsewhere'), 1);
  assert.equal(mute(db, 'cats'), 1);
  assert.equal(mute(db, 'cats'), 0, 'idempotent');
  assert.deepEqual(mutes(db), ['cats']);
  assert.ok(isMuted({ title: 'Cats daily', url: 'https://news.example/cats' }, ['CATS']));
  assert.ok(!isMuted({ title: 'Dogs', url: 'https://x/' }, ['cats']));
  assert.equal(unmute(db, 'cats'), 1);
});

test('withPins puts pinned first and dedupes; grouped windows give pins their own window', () => {
  const picks = [{ url: 'https://a/', title: 'A', score: 0.9, reason: 'jev', group: 0 }, { url: 'https://dash.example/', title: 'D', score: 0.7, reason: 'jev', group: 0 }];
  const out = withPins(picks, ['https://dash.example/'], new Map([['https://dash.example/', 'Team dashboard']]));
  assert.deepEqual(out.map((p) => [p.url, p.reason, p.title]), [['https://dash.example/', 'pinned', 'Team dashboard'], ['https://a/', 'jev', 'A']]);
  const w = windows([...out, { url: 'https://b/', group: 0 }, { url: 'https://c/', group: 1 }], true);
  assert.deepEqual(w.map((g) => g.map((p) => p.url)), [['https://dash.example/'], ['https://a/', 'https://b/'], ['https://c/']]);
});

test('focus honours pins and mutes; cleanup skips both', async () => {
  const db = openDb(':memory:'); seed(db);
  pin(db, 'dashboard'); mute(db, 'cats');
  const asked = [];
  const ask = async (_, q) => { Object.values(q).forEach((x) => asked.push(x.instructions)); return Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.9 }])); };
  const lines = [];
  const picks = await focus({ db, ask, topic: 'anything', calendar: false, github: false, reviews: false, log: (m) => lines.push(m) });
  assert.equal(picks[0].reason, 'pinned');
  assert.ok(!picks.some((p) => /cats/.test(p.url)), 'muted tab never reopens');
  assert.ok(!asked.some((s) => /Cats/.test(s)), 'muted tab is not even judged');
  assert.ok(lines.some((l) => /1 mute terms/.test(l)));
  assert.equal(picks.filter((p) => p.url === 'https://dash.example/').length, 1);

  db.prepare("UPDATE links SET last_seen = '2020-01-01T00:00:00Z'").run();
  const items = await cleanupCandidates(db, { ask: async (_, q) => Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.9 }])), run: async () => ({ state: 'open' }) });
  const urls = items.map((l) => l.url);
  assert.ok(!urls.includes('https://dash.example/') && !urls.includes('https://news.example/cats'));
  assert.ok(urls.includes('https://old.example/'));
});
