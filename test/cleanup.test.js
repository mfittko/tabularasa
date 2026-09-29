import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { cleanupCandidates, deleteLinks, selectInteractive } from '../src/cleanup.js';
import { openDb } from '../src/db.js';

const OLD = '2025-01-01T00:00:00Z', NEW = new Date().toISOString();

function seed(db, rows) {
  const ins = db.prepare('INSERT INTO links (url, title, first_seen, last_seen, times_seen) VALUES (?, ?, ?, ?, ?)');
  for (const [url, title, seen, n = 1] of rows) ins.run(url, title, seen, seen, n);
}

test('cleanupCandidates: closed GitHub items regardless of age, Jev-stale only for aged links', async () => {
  const db = openDb(':memory:');
  seed(db, [
    ['https://github.com/o/r/pull/1', 'merged PR', NEW],
    ['https://github.com/o/r/pull/2', 'open PR', OLD],
    ['https://github.com/o/r/issues/3', 'closed issue', OLD],
    ['https://github.com/o/gone/pull/4', 'deleted repo', OLD],
    ['https://docs.example/ref', 'Lasting reference', OLD, 9],
    ['https://news.example/old', 'Old news', OLD],
    ['https://news.example/today', 'Fresh news', NEW],
  ]);
  const run = (cmd, args) => {
    assert.equal(cmd, 'gh');
    const path = args[1];
    if (path.includes('gone')) throw new Error('404');
    if (path.endsWith('pulls/1')) return { state: 'closed', merged: '2026-09-01T00:00:00Z' };
    if (path.endsWith('issues/3')) return { state: 'closed', merged: null };
    return { state: 'open', merged: null };
  };
  const asked = [];
  const ask = async (state, questions) => {
    assert.match(state, /Today is \d{4}-\d{2}-\d{2}/);
    return Object.fromEntries(Object.entries(questions).map(([k, q]) => {
      asked.push(q.instructions.match(/Title: "([^"]*)"/)[1]);
      return [k, { noul: /Old news/.test(q.instructions) ? 0.9 : 0.1 }];
    }));
  };
  const items = await cleanupCandidates(db, { olderDays: 30, ask, run });
  assert.deepEqual(items.map((l) => [l.title, l.reason]).sort(), [['Old news', 'stale 0.90'], ['closed issue', 'closed issue'], ['merged PR', 'merged PR']]);
  assert.deepEqual(asked.sort(), ['Lasting reference', 'Old news', 'deleted repo', 'open PR'], 'fresh and already-closed links are not sent to Jev');

  const ids = items.map((l) => l.id);
  db.prepare('INSERT INTO runs (ran_at, tabs_found, new_links, closed) VALUES (?, 1, 0, 0)').run(NEW);
  db.prepare('INSERT INTO tabs (run_id, link_id, title) VALUES (1, ?, ?)').run(ids[0], 'x');
  assert.equal(deleteLinks(db, ids), 3);
  assert.equal(db.prepare('SELECT count(*) n FROM links').get().n, 4);
  assert.equal(db.prepare('SELECT count(*) n FROM tabs').get().n, 0);
  assert.equal(deleteLinks(db, []), 0);
});

test('cleanupCandidates without Jev only reports closed GitHub items', async () => {
  const db = openDb(':memory:');
  seed(db, [['https://github.com/o/r/pull/1', 'PR', OLD], ['https://x.example/', 'X', OLD]]);
  const items = await cleanupCandidates(db, { run: () => ({ state: 'closed', merged: null }) });
  assert.deepEqual(items.map((l) => l.reason), ['closed PR']);
});

/** Fake TTY: emits keypress events, records output. */
function fakeTty() {
  const input = new EventEmitter();
  input.setRawMode = () => {}; input.resume = () => {}; input.pause = () => {};
  const output = { text: '', columns: 100, write(s) { this.text += s; } };
  return { input, output, key: (name, ctrl = false) => input.emit('keypress', undefined, { name, ctrl }) };
}

test('selectInteractive: toggle, move, select all, confirm and quit', async () => {
  const items = [{ id: 1, title: 'A', reason: 'r', last_seen: OLD }, { id: 2, title: 'B', reason: 'r', last_seen: OLD }, { id: 3, title: 'C', reason: 'r', last_seen: OLD }];
  let t = fakeTty();
  let p = selectInteractive(items, t);
  t.key('space'); t.key('down'); t.key('j'); t.key('space'); t.key('return');
  assert.deepEqual((await p).map((l) => l.id), [1, 3]);
  assert.match(t.output.text, /> \[x\]/);

  t = fakeTty(); p = selectInteractive(items, t);
  t.key('a'); t.key('up'); t.key('space'); t.key('return');
  assert.deepEqual((await p).map((l) => l.id), [1, 2], 'all, then the last one (wrapped) toggled off');

  t = fakeTty(); p = selectInteractive(items, t);
  t.key('a'); t.key('q');
  assert.deepEqual(await p, [], 'quit selects nothing');
});
