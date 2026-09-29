import { execFileSync, spawnSync } from 'node:child_process';
import { openDb, now } from './db.js';

// Fields: window_id, window_index, tab_index, is_current, url, title. ASCII 31/30 as separators,
// so titles with commas, quotes or tabs survive. Windows without tabs are skipped by the try block.
const EXPORT = `
set US to character id 31
set RS to character id 30
set out to ""
tell application "Safari"
  repeat with w in windows
    try
      set wid to id of w
      set wi to index of w
      set ci to index of current tab of w
      repeat with t in tabs of w
        set u to URL of t
        if u is not missing value then
          set n to name of t
          if n is missing value then set n to ""
          set ti to index of t
          set cur to 0
          if ti is ci then set cur to 1
          set out to out & wid & US & wi & US & ti & US & cur & US & u & US & n & RS
        end if
      end repeat
    end try
  end repeat
end tell
return out`;

export const safariRunning = () => spawnSync('pgrep', ['-xq', 'Safari']).status === 0;

/** Records from the AppleScript output; only http(s) tabs, trailing newline ignored. */
export function parseExport(out) {
  return out.replace(/\n/g, '').split('\x1e').filter(Boolean).map((r) => {
    const [wid, wi, ti, cur, url, title] = r.split('\x1f');
    return { window_id: +wid, window_index: +wi, tab_index: +ti, is_current: +cur, url, title: title ?? '', source: 'safari' };
  }).filter((t) => /^https?:/.test(t.url));
}

/** Every open http(s) tab, or [] when Safari isn't running (never launches it). */
export function exportTabs() {
  if (!safariRunning()) return [];
  return parseExport(execFileSync('osascript', ['-e', EXPORT], { encoding: 'utf8', maxBuffer: 64 << 20 }));
}

export const closeWindows = () => execFileSync('osascript', ['-e', 'tell application "Safari" to close every window']);

/** Archive tabs into the inventory; close Safari windows only after the write committed. */
export function archive({ close = false, db = openDb(), tabs = exportTabs(), closer = closeWindows, running = safariRunning } = {}) {
  const at = now();
  db.exec('BEGIN');
  let runId, newLinks = 0;
  try {
    runId = db.prepare('INSERT INTO runs (ran_at, tabs_found, new_links, closed) VALUES (?, ?, 0, 0)').run(at, tabs.length).lastInsertRowid;
    const exists = db.prepare('SELECT id FROM links WHERE url = ?');
    const upsert = db.prepare(`INSERT INTO links (url, title, first_seen, last_seen) VALUES (?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET last_seen = excluded.last_seen, times_seen = links.times_seen + 1,
        title = coalesce(nullif(excluded.title, ''), links.title) RETURNING id`);
    const insTab = db.prepare(`INSERT INTO tabs (run_id, link_id, window_id, window_index, tab_index, is_current, title, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const ids = new Map(); // one links upsert per URL per run, so times_seen counts runs, not duplicate tabs
    for (const t of tabs) {
      let id = ids.get(t.url);
      if (id == null) {
        if (!exists.get(t.url)) newLinks++;
        id = upsert.get(t.url, t.title, at, at).id;
        ids.set(t.url, id);
      }
      insTab.run(runId, id, t.window_id, t.window_index, t.tab_index, t.is_current, t.title, t.source);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  let closed = 0;
  if (close && tabs.length && running()) {
    closer();
    closed = 1;
  }
  db.prepare('UPDATE runs SET new_links = ?, closed = ? WHERE id = ?').run(newLinks, closed, runId);
  return { found: tabs.length, newLinks, closed };
}
