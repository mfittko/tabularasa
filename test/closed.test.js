import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupCandidates } from '../src/cleanup.js';
import { dismissClosed, dismissed, parsePlistXml, undismiss } from '../src/closed.js';
import { openDb } from '../src/db.js';
import { focus } from '../src/focus.js';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ClosedTabOrWindowPersistentStates</key>
  <array>
    <dict>
      <key>PersistentState</key>
      <dict>
        <key>DateClosed</key><date>2026-09-29T18:40:00Z</date>
        <key>IsPrivate</key><false/>
        <key>TabTitle</key><string>Tom &amp; Jerry &lt;3</string>
        <key>TabURL</key><string>https://a.example/?x=1&amp;y=2</string>
        <key>SessionState</key><data>AAEC</data>
      </dict>
    </dict>
    <dict>
      <key>DateClosed</key><date>2026-09-29T18:30:00Z</date>
      <key>PersistentState</key>
      <dict>
        <key>TabStates</key>
        <array>
          <dict><key>TabURL</key><string>https://b.example/</string><key>TabTitle</key><string>B</string></dict>
          <dict><key>TabURL</key><string>favorites://</string></dict>
          <dict><key>TabURL</key><string>https://c.example/</string><key>TabTitle</key><string>C</string><key>Index</key><integer>2</integer></dict>
        </array>
        <key>Empty</key><array/>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;

test('parsePlistXml handles nested dicts, arrays, dates, entities and empty containers', () => {
  const d = parsePlistXml(XML);
  const [tab, win] = d.ClosedTabOrWindowPersistentStates;
  assert.equal(tab.PersistentState.TabTitle, 'Tom & Jerry <3');
  assert.equal(tab.PersistentState.TabURL, 'https://a.example/?x=1&y=2');
  assert.equal(tab.PersistentState.IsPrivate, false);
  assert.ok(tab.PersistentState.DateClosed instanceof Date);
  assert.equal(win.PersistentState.TabStates.length, 3);
  assert.equal(win.PersistentState.TabStates[2].Index, 2);
  assert.deepEqual(win.PersistentState.Empty, []);
});

test('dismissClosed: skips our own closes, stale closes and reopened links; focus and cleanup honour it', async () => {
  const db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO links (url, title, first_seen, last_seen) VALUES (?, ?, ?, ?)');
  ins.run('https://a.example/', 'A', '2026-09-29T10:00:00Z', '2026-09-29T10:00:00Z');
  ins.run('https://b.example/', 'B', '2026-09-29T10:00:00Z', '2026-09-29T10:00:00Z');
  ins.run('https://c.example/', 'C', '2026-09-29T10:00:00Z', '2026-09-29T19:00:00Z');
  db.prepare("INSERT INTO runs (ran_at, tabs_found, new_links, closed) VALUES ('2026-09-29T12:00:00Z', 3, 0, 1)").run();
  const n = dismissClosed(db, [
    { url: 'https://a.example/', closedAt: '2026-09-29T18:40:00Z' },   // closed by hand -> dismissed
    { url: 'https://b.example/', closedAt: '2026-09-29T12:00:30Z' },   // our own closing run -> ignored
    { url: 'https://c.example/', closedAt: '2026-09-29T18:00:00Z' },   // seen open again at 19:00 -> ignored
    { url: 'https://a.example/', closedAt: '2026-09-29T09:00:00Z' },   // older than last sighting -> ignored
    { url: 'https://zzz.example/', closedAt: '2026-09-29T18:00:00Z' }, // not archived
    { url: 'https://b.example/', closedAt: null },
  ]);
  assert.equal(n, 1);
  assert.deepEqual(dismissed(db).map((l) => l.url), ['https://a.example/']);

  const now = new Date().toISOString();
  db.prepare('UPDATE links SET last_seen = ? WHERE url != ?').run(now, 'https://a.example/');
  db.prepare("UPDATE links SET last_seen = '2026-09-29T10:00:00Z' WHERE url = 'https://a.example/'").run();
  db.prepare("UPDATE links SET first_seen = ?, last_seen = ? WHERE url = 'https://a.example/'").run(now, now);
  db.prepare("UPDATE links SET dismissed_at = ? WHERE url = 'https://a.example/'").run(new Date(Date.now() + 1000).toISOString());
  const ask = async (_, q) => Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.9 }]));
  const picks = await focus({ db, ask, topic: 'x', calendar: false, github: false, reviews: false, log: () => {} });
  assert.ok(!picks.some((p) => p.url === 'https://a.example/'), 'dismissed tab does not reopen');
  assert.ok(picks.some((p) => p.url === 'https://b.example/'));

  const items = await cleanupCandidates(db, { run: async () => ({ state: 'open' }) });
  assert.deepEqual(items.map((l) => [l.url, l.reason.slice(0, 13)]), [['https://a.example/', 'closed by you']]);

  assert.equal(undismiss(db, 'a.example'), 1);
  assert.deepEqual(dismissed(db), []);
});
