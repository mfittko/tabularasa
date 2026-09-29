import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archive } from '../src/archive.js';
import { openDb } from '../src/db.js';
import { normUrl, pick } from '../src/focus.js';

const tab = (url, title, i = 1) => ({ window_id: 1, window_index: 1, tab_index: i, is_current: i === 1 ? 1 : 0, url, title, source: 'safari' });

test('archive dedupes links per URL and keeps a per-run inventory', () => {
  const db = openDb(':memory:');
  const tabs = [tab('https://a.example/x', 'Ä, "quoted"\ttitle 🎉'), tab('https://a.example/x', 'same url again', 2), tab('https://b.example/', 'B', 3)];
  const r1 = archive({ db, tabs, close: false });
  const r2 = archive({ db, tabs, close: false });
  assert.deepEqual([r1.found, r1.newLinks, r2.newLinks], [3, 2, 0]);
  assert.equal(db.prepare('SELECT count(*) n FROM links').get().n, 2);
  assert.equal(db.prepare('SELECT times_seen FROM links WHERE url = ?').get('https://a.example/x').times_seen, 2);
  assert.equal(db.prepare('SELECT title FROM links WHERE url = ?').get('https://a.example/x').title, 'Ä, "quoted"\ttitle 🎉');
  assert.equal(db.prepare('SELECT count(*) n FROM tabs').get().n, 6);
  assert.equal(db.prepare('SELECT count(*) n FROM runs WHERE closed = 0').get().n, 2);
});

test('normUrl strips tracking params, www and trailing slash', () => {
  assert.equal(normUrl('https://www.Example.com/a/b/?utm_source=x&sk=y&q=1#frag'), 'https://example.com/a/b?q=1');
  assert.equal(normUrl('https://claude.ai/artifact/ID?sk=abc'), 'https://claude.ai/artifact/ID');
});

test('pick: linked first, Jev threshold, duplicates dropped, similar tabs adjacent', async () => {
  const tabs = [
    { url: 'https://docs.example/kg', title: 'Knowledge Graph RFC' },
    { url: 'https://docs.example/kg-tech', title: 'Knowledge Graph Tech' },
    { url: 'https://github.com/o/r/pull/1', title: 'PR 1' },
    { url: 'https://boards.example/3', title: 'Kanban' },
    { url: 'https://boards.example/3/views/2', title: 'Kanban' },
    { url: 'https://news.example/cats', title: 'Cats' },
  ];
  const texts = ['event: Knowledge graph sync https://github.com/o/r/pull/1'];
  const ask = async (state, questions) => Object.fromEntries(Object.entries(questions).map(([k, q]) => {
    if (k.startsWith('t')) return [k, { noul: /Cats/.test(q.instructions) ? 0.1 : 0.8 }];
    if (k.startsWith('d')) return [k, { noul: /Kanban.*Kanban/.test(q.instructions) ? 0.9 : 0.1 }];
    return [k, { noul: /Knowledge.*Knowledge/.test(q.instructions) ? 0.9 : 0.2 }];
  }));
  const picks = await pick(tabs, texts, ask, { limit: 10 });
  assert.equal(picks[0].reason, 'linked');
  assert.ok(!picks.some((p) => p.title === 'Cats'));
  assert.equal(picks.filter((p) => p.title === 'Kanban').length, 1);
  const kg = picks.map((p) => p.title).filter((t) => t.startsWith('Knowledge'));
  const idx = picks.findIndex((p) => p.title === kg[0]);
  assert.equal(picks[idx + 1].title, kg[1]);
});
