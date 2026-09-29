import { now } from './db.js';

/** pins: URLs that always reopen. mutes: terms whose tabs never reopen and are skipped by cleanup. */
export function pin(db, target) {
  const url = /^https?:\/\//.test(target) ? target
    : db.prepare('SELECT url FROM links WHERE title LIKE ? OR url LIKE ? ORDER BY last_seen DESC LIMIT 1').get(`%${target}%`, `%${target}%`)?.url;
  if (!url) return null;
  db.prepare('INSERT OR IGNORE INTO pins (url, added_at) VALUES (?, ?)').run(url, now());
  return url;
}
export const unpin = (db, target) => db.prepare('DELETE FROM pins WHERE url = ? OR url LIKE ?').run(target, `%${target}%`).changes;
export const mute = (db, term) => db.prepare('INSERT OR IGNORE INTO mutes (term, added_at) VALUES (?, ?)').run(term, now()).changes;
export const unmute = (db, term) => db.prepare('DELETE FROM mutes WHERE term = ?').run(term).changes;
export const pins = (db) => db.prepare('SELECT url FROM pins ORDER BY added_at').all().map((r) => r.url);
export const mutes = (db) => db.prepare('SELECT term FROM mutes ORDER BY added_at').all().map((r) => r.term);

/** True when a link's title or url contains a muted term (case-insensitive). */
export function isMuted(link, terms) {
  const hay = `${link.title ?? ''}\n${link.url}`.toLowerCase();
  return terms.some((t) => hay.includes(t.toLowerCase()));
}

/** Pinned URLs first (score 1, reason pinned), then the picks minus anything already pinned. */
export function withPins(picks, pinnedUrls, titles = new Map()) {
  const set = new Set(pinnedUrls);
  const pinned = pinnedUrls.map((url) => ({ url, title: titles.get(url) ?? '', score: 1, reason: 'pinned', group: -1 }));
  return [...pinned, ...picks.filter((p) => !set.has(p.url))];
}
