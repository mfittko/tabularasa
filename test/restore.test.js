import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { archive } from '../src/archive.js';
import { openDb } from '../src/db.js';
import { selectInteractive } from '../src/picker.js';
import { fmtRun, listRuns, restore, runTabs } from '../src/restore.js';

const tab = (w, i, url, title, cur = 0) => ({ window_id: w, window_index: w, tab_index: i, is_current: cur, url, title, source: 'safari' });

test('runs and restore: per-window layout comes back in order', () => {
  const db = openDb(':memory:');
  archive({ db, close: false, tabs: [tab(1, 1, 'https://a/', 'A', 1), tab(1, 2, 'https://b/', 'B'), tab(2, 1, 'https://c/', 'C', 1)] });
  archive({ db, close: true, closer: () => {}, running: () => true, tabs: [tab(5, 1, 'https://d/', 'D', 1)] });
  const runs = listRuns(db);
  assert.deepEqual(runs.map((r) => [r.id, r.tabs_found, r.windows, r.closed]), [[2, 1, 1, 1], [1, 3, 2, 0]]);
  assert.match(fmtRun(runs[0]), /^#   2  \d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+1 tabs\s+1 win  closed  \+1 new$/);

  const tabs = runTabs(db, 1);
  assert.deepEqual(tabs.map((t) => [t.window_id, t.url, t.is_current]), [[1, 'https://a/', 1], [1, 'https://b/', 0], [2, 'https://c/', 1]]);
  const opened = [];
  assert.deepEqual(restore(tabs, (urls) => opened.push(urls)), { tabs: 3, windows: 2 });
  assert.deepEqual(opened, [['https://a/', 'https://b/'], ['https://c/']]);
  assert.deepEqual(runTabs(db, 99), []);
});

function fakeTty() {
  const input = new EventEmitter();
  input.setRawMode = () => {}; input.resume = () => {}; input.pause = () => {};
  const output = { text: '', columns: 100, write(s) { this.text += s; } };
  return { input, output, key: (name, ctrl = false) => input.emit('keypress', undefined, { name, ctrl }) };
}

test('picker: single mode chooses the row under the cursor, preselect starts with all on', async () => {
  const items = ['a', 'b', 'c'];
  let t = fakeTty();
  let p = selectInteractive(items, { ...t, single: true });
  t.key('space'); t.key('down'); t.key('return');
  assert.deepEqual(await p, ['b']);
  assert.doesNotMatch(t.output.text, /\[ \]/, 'no checkboxes in single mode');

  t = fakeTty(); p = selectInteractive(items, { ...t, preselect: true });
  t.key('down'); t.key('space'); t.key('return');
  assert.deepEqual(await p, ['a', 'c']);

  t = fakeTty(); p = selectInteractive(items, { ...t, single: true });
  t.key('escape');
  assert.deepEqual(await p, []);
});
