import { openInNewWindow } from './focus.js';

/** Recent runs, newest first, with how many windows were recorded. */
export function listRuns(db, limit = 20) {
  return db.prepare(`SELECT r.id, r.ran_at, r.tabs_found, r.new_links, r.closed,
      (SELECT count(DISTINCT window_id) FROM tabs WHERE run_id = r.id) AS windows
    FROM runs r ORDER BY r.id DESC LIMIT ?`).all(limit);
}

/** The run whose closed windows an undo should bring back: the newest closing run. */
export const lastClosedRun = (db) => db.prepare('SELECT id, ran_at, tabs_found FROM runs WHERE closed = 1 ORDER BY id DESC LIMIT 1').get();

/** Tabs of one run in their recorded window and tab order. */
export function runTabs(db, runId) {
  return db.prepare(`SELECT t.window_id, t.window_index, t.tab_index, t.is_current, l.url, coalesce(nullif(t.title, ''), l.title) AS title
    FROM tabs t JOIN links l ON l.id = t.link_id WHERE t.run_id = ? ORDER BY t.window_index, t.tab_index`).all(runId);
}

/** Reopen tabs (all of a run, or a chosen subset), one Safari window per original window. */
export function restore(tabs, open = openInNewWindow) {
  const wins = [...Map.groupBy(tabs, (t) => t.window_id).values()];
  for (const w of wins) open(w.map((t) => t.url));
  return { tabs: tabs.length, windows: wins.length };
}

const local = (iso) => new Date(iso).toLocaleString('sv').slice(0, 16);
export const fmtRun = (r) => `#${String(r.id).padStart(4)}  ${local(r.ran_at)}  ${String(r.tabs_found).padStart(4)} tabs  ${String(r.windows).padStart(2)} win  ${r.closed ? 'closed' : '      '}  +${r.new_links} new`;
export const fmtTab = (t, w = process.stdout.columns || 120) => `w${t.window_index}${t.is_current ? '*' : ' '} ${(t.title || t.url).slice(0, Math.max(20, w - 12))}`;
