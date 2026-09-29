import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const RECENTLY_CLOSED = path.join(os.homedir(), 'Library/Safari/RecentlyClosedTabs.plist');

/** Minimal XML plist reader (dict, array, string, date, integer, real, true, false, data). */
export function parsePlistXml(xml) {
  const tokens = [...xml.matchAll(/<(\/?)([a-z]+)([^>]*?)(\/?)>([^<]*)/g)];
  let i = 0;
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const node = () => {
    const [, close, tag, , selfClose, text] = tokens[i++];
    if (close) return undefined;
    if (selfClose) return tag === 'true' ? true : tag === 'false' ? false : tag === 'array' ? [] : tag === 'dict' ? {} : null;
    if (tag === 'dict') {
      const out = {};
      while (tokens[i] && !(tokens[i][1] && tokens[i][2] === 'dict')) {
        const [, , ktag, , , ktext] = tokens[i++];
        if (ktag !== 'key') continue;
        if (tokens[i]?.[1] && tokens[i][2] === 'key') i++; // </key>
        out[unesc(ktext)] = node();
      }
      i++;
      return out;
    }
    if (tag === 'array') {
      const out = [];
      while (tokens[i] && !(tokens[i][1] && tokens[i][2] === 'array')) out.push(node());
      i++;
      return out;
    }
    const v = unesc(text.trim());
    i++; // closing tag
    if (tag === 'integer' || tag === 'real') return Number(v);
    if (tag === 'date') return new Date(v);
    return v; // string, data (base64)
  };
  while (tokens[i] && tokens[i][2] !== 'plist') i++;
  i++;
  return node();
}

/** Tabs Safari lists as recently closed: { url, title, closedAt }, newest first. */
export function readRecentlyClosed(file = RECENTLY_CLOSED) {
  const xml = execFileSync('plutil', ['-convert', 'xml1', '-o', '-', file], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const entries = parsePlistXml(xml)?.ClosedTabOrWindowPersistentStates ?? [];
  const out = [];
  for (const e of entries) {
    const ps = e.PersistentState ?? {};
    const closedAt = e.DateClosed ?? ps.DateClosed;
    const tabs = ps.TabStates ?? (ps.TabURL ? [ps] : []);
    for (const t of tabs) if (t.TabURL && /^https?:/.test(t.TabURL)) out.push({ url: t.TabURL, title: t.TabTitle ?? '', closedAt: closedAt instanceof Date ? closedAt.toISOString() : null });
  }
  return out.sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
}

/** Mark archive links the user closed by hand as dismissed. Ignores closes within 2 minutes of our own
 *  closing runs, closes older than the link's last sighting, and untimed entries. */
export function dismissClosed(db, closed) {
  const ourCloses = db.prepare('SELECT ran_at FROM runs WHERE closed = 1').all().map((r) => Date.parse(r.ran_at));
  const link = db.prepare('SELECT id, last_seen, dismissed_at FROM links WHERE url = ?');
  const set = db.prepare('UPDATE links SET dismissed_at = ? WHERE id = ?');
  let n = 0;
  for (const c of closed) {
    if (!c.closedAt) continue;
    const t = Date.parse(c.closedAt);
    if (ourCloses.some((r) => t >= r - 5000 && t <= r + 120000)) continue;
    const l = link.get(c.url);
    if (!l || c.closedAt < l.last_seen || (l.dismissed_at && l.dismissed_at >= c.closedAt)) continue;
    set.run(c.closedAt, l.id); n++;
  }
  return n;
}

/** Scan Safari's list and apply it; returns a one-line summary. Never throws (permission problems are common). */
export function scanClosed(db) {
  try {
    return `dismissed: ${dismissClosed(db, readRecentlyClosed())} newly closed by you`;
  } catch (e) {
    const perm = /permission|not permitted|EPERM/i.test(e.message);
    return `dismissed: skipped (${perm ? `no Full Disk Access for ${process.execPath}; see README` : e.message.split('\n')[0].slice(0, 120)})`;
  }
}

export const dismissed = (db) => db.prepare('SELECT url, title, dismissed_at FROM links WHERE dismissed_at IS NOT NULL AND dismissed_at >= last_seen ORDER BY dismissed_at DESC').all();
export const undismiss = (db, term) => db.prepare('UPDATE links SET dismissed_at = NULL WHERE url = ? OR title LIKE ? OR url LIKE ?').run(term, `%${term}%`, `%${term}%`).changes;
