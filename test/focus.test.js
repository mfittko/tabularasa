import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { calendarTexts, focus, githubTexts, ingestReviews, normUrl, pick, windows } from '../src/focus.js';

test('normUrl strips tracking params, share keys, www, fragment and trailing slash', () => {
  assert.equal(normUrl('https://www.Example.com/a/b/?utm_source=x&sk=y&q=1#frag'), 'https://example.com/a/b?q=1');
  assert.equal(normUrl('https://claude.ai/artifact/ID?sk=abc'), 'https://claude.ai/artifact/ID');
  assert.equal(normUrl('https://example.com/'), 'https://example.com/');
  assert.equal(normUrl('not a url'), 'not a url');
});

test('calendarTexts: window, declined and non-default events skipped, HTML stripped, attachments included', () => {
  let called;
  const run = (cmd, args) => {
    called = { cmd, params: JSON.parse(args[args.indexOf('--params') + 1]) };
    return { items: [
      { summary: 'KG sync', description: '<p>Agenda:<br>graph</p>', location: 'Room 1', attachments: [{ fileUrl: 'https://docs.example/d/1' }] },
      { summary: 'Declined', attendees: [{ self: true, responseStatus: 'declined' }] },
      { summary: 'Accepted', attendees: [{ self: true, responseStatus: 'accepted' }] },
      { summary: 'Home office', eventType: 'workingLocation' },
    ] };
  };
  const texts = calendarTexts(1, 1, run);
  assert.equal(called.cmd, 'gws');
  assert.equal(called.params.singleEvents, true);
  assert.match(called.params.timeMin, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  assert.deepEqual(texts, ['event: KG sync |  Agenda: graph  | Room 1 | https://docs.example/d/1', 'event: Accepted']);
});

test('githubTexts: PRs and issues involving me, one line each', () => {
  const run = (cmd, args) => {
    assert.equal(cmd, 'gh');
    assert.ok(args.includes('@me') && args.some((a) => /^>=\d{4}-\d{2}-\d{2}$/.test(a)));
    return [{ title: `T ${args[1]}`, url: `https://github.com/o/r/${args[1]}/1` }];
  };
  assert.deepEqual(githubTexts(7, run), ['pr: T prs https://github.com/o/r/prs/1', 'issue: T issues https://github.com/o/r/issues/1']);
});

test('ingestReviews: upserts review requests as fresh archive links', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO links (url, title, first_seen, last_seen) VALUES ('https://github.com/o/r/pull/1', 'old', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run();
  const run = () => [{ title: 'new title', url: 'https://github.com/o/r/pull/1' }, { title: 'PR 2', url: 'https://github.com/o/r/pull/2' }];
  assert.equal(ingestReviews(db, run), 2);
  const rows = db.prepare('SELECT url, title, first_seen, last_seen FROM links ORDER BY url').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'new title');
  assert.equal(rows[0].first_seen, '2020-01-01T00:00:00Z');
  assert.ok(rows[0].last_seen > '2026', 'last_seen bumped so it becomes a candidate');
});

/** Jev stand-in: relevance by title keyword, duplicates by title equality, similarity by shared first word. */
function fakeJev({ relevant = /./, calls = [] } = {}) {
  return async (state, questions) => {
    calls.push(Object.keys(questions).length);
    return Object.fromEntries(Object.entries(questions).map(([k, q]) => {
      const [, a, b] = q.instructions.match(/A: "([^"]*)".*B: "([^"]*)"/) ?? [];
      if (k.startsWith('t')) return [k, { noul: relevant.test(q.instructions.match(/Tab title: "([^"]*)"/)[1]) ? 0.8 : 0.1 }];
      if (k.startsWith('d')) return [k, { noul: a === b ? 0.9 : 0.1 }];
      return [k, { noul: a.split(' ')[0] === b.split(' ')[0] ? 0.9 : 0.2 }];
    }));
  };
}

test('pick: linked first, threshold, exact and Jev duplicates dropped, similar tabs adjacent, limit', async () => {
  const tabs = [
    { url: 'https://docs.example/kg', title: 'Knowledge Graph RFC' },
    { url: 'https://news.example/cats', title: 'Cats' },
    { url: 'https://docs.example/kg-tech', title: 'Knowledge Graph Tech' },
    { url: 'https://github.com/o/r/pull/1', title: 'PR 1' },
    { url: 'https://boards.example/3', title: 'Kanban' },
    { url: 'https://boards.example/3/views/2', title: 'Kanban' },
    { url: 'https://claude.ai/artifact/X?sk=1', title: 'Audit' },
    { url: 'https://claude.ai/artifact/X', title: 'Audit' },
  ];
  const texts = ['event: Knowledge graph sync https://github.com/o/r/pull/1'];
  const calls = [];
  const picks = await pick(tabs, texts, fakeJev({ relevant: /Knowledge|Kanban|Audit|PR/, calls }), { limit: 10 });
  assert.equal(picks[0].reason, 'linked');
  assert.equal(picks[0].score, 1);
  assert.ok(!picks.some((p) => p.title === 'Cats'), 'below threshold');
  assert.equal(picks.filter((p) => p.title === 'Audit').length, 1, 'share-key duplicate removed locally');
  assert.equal(picks.filter((p) => p.title === 'Kanban').length, 1, 'Jev duplicate removed');
  const titles = picks.map((p) => p.title);
  const i = titles.findIndex((t) => t.startsWith('Knowledge'));
  assert.ok(titles[i + 1].startsWith('Knowledge'), `knowledge graph tabs adjacent: ${titles}`);
  assert.equal(calls[0], 7, 'one relevance question per non-linked candidate');
  const kgGroups = new Set(picks.filter((p) => p.title.startsWith('Knowledge')).map((p) => p.group));
  assert.equal(kgGroups.size, 1, 'knowledge graph tabs share a group');
  assert.ok(new Set(picks.map((p) => p.group)).size > 1, 'unrelated tabs get their own group');
  assert.deepEqual(windows(picks, false).length, 1);
  assert.ok(windows(picks, true).length > 1 && windows(picks, true).length <= new Set(picks.map((p) => p.group)).size);
  assert.deepEqual(windows([], true), []);
  const w = windows([{ group: 0, t: 'a' }, { group: 0, t: 'b' }, { group: 1, t: 'c' }, { group: 2, t: 'd' }], true);
  assert.deepEqual(w.map((x) => x.map((p) => p.t)), [['a', 'b'], ['c', 'd']], 'singletons share one trailing window');

  const limited = await pick(tabs, texts, fakeJev({ relevant: /./ }), { limit: 2 });
  assert.equal(limited.length, 2);
});

test('pick: relevance is batched in 40s and pairs in 50s', async () => {
  const tabs = Array.from({ length: 45 }, (_, i) => ({ url: `https://x.example/${i}`, title: `T ${i}` }));
  const calls = [];
  const picks = await pick(tabs, ['topic: x'], fakeJev({ calls }), { limit: 12 });
  assert.equal(picks.length, 12);
  assert.deepEqual(calls.slice(0, 2), [40, 5]);
  assert.equal(calls.slice(2).reduce((a, b) => a + b, 0), 66 * 2, '66 pairs, two questions each');
  assert.ok(calls.slice(2).every((n) => n <= 100));
});

test('focus: no context means nothing to reopen and no Jev call', async () => {
  const db = openDb(':memory:');
  const lines = [];
  const picks = await focus({ db, calendar: false, github: false, reviews: false, ask: () => assert.fail('must not ask'), log: (m) => lines.push(m) });
  assert.deepEqual(picks, []);
  assert.deepEqual(lines, ['no context available, nothing to reopen']);
});

test('focus: topic + archive candidates within --days, output format', async () => {
  const db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO links (url, title, first_seen, last_seen) VALUES (?, ?, ?, ?)');
  const fresh = new Date().toISOString();
  ins.run('https://a.example/kg', 'Knowledge Graph RFC', fresh, fresh);
  ins.run('https://a.example/old', 'Knowledge Graph old', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
  const lines = [];
  const picks = await focus({ db, topic: 'knowledge graph', calendar: false, github: false, reviews: false, ask: fakeJev(), log: (m) => lines.push(m) });
  assert.equal(picks.length, 1, 'stale link is not a candidate');
  assert.deepEqual(lines, ['candidates: 1', '0.80  jev     Knowledge Graph RFC']);
});
