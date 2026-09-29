import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { now } from './db.js';

const READER = 'https://r.jina.ai/';
const RETRY_AFTER_DAYS = 7;

export function jinaKey() {
  if (process.env.JINA_API_KEY) return process.env.JINA_API_KEY;
  try {
    return fs.readFileSync(path.join(os.homedir(), '.config/jina'), 'utf8').match(/JINA_API_KEY=["']?([^"'\s]+)/)?.[1] ?? null;
  } catch { return null; }
}

/** Title, description and a short text excerpt of one page via the Jina reader. */
export async function fetchPage(url, key, fetchImpl = fetch) {
  const res = await fetchImpl(READER + url, { headers: { accept: 'application/json', authorization: `Bearer ${key}`, 'x-timeout': '20' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`jina ${res.status}`);
  const d = (await res.json()).data ?? {};
  const text = (d.content ?? '').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return { title: (d.title ?? '').trim(), description: (d.description ?? '').trim(), excerpt: text.slice(0, 800) };
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (let i; (i = next++) < items.length;) await fn(items[i]);
  }));
}

/** Fetch page content for archive links seen within `days` that have no page row yet (or failed > 7 days ago). */
export async function ingest(db, { days = 30, limit = 50, force = false, key = jinaKey(), fetchImpl = fetch, log = console.log } = {}) {
  if (!key) throw new Error('no JINA_API_KEY (env or ~/.config/jina)');
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const retry = new Date(Date.now() - RETRY_AFTER_DAYS * 864e5).toISOString();
  const links = db.prepare(`SELECT l.id, l.url FROM links l LEFT JOIN pages p ON p.link_id = l.id
    WHERE l.last_seen >= ? AND (p.link_id IS NULL ${force ? 'OR 1' : "OR (p.error IS NOT NULL AND p.fetched_at < ?)"})
    ORDER BY l.last_seen DESC LIMIT ?`).all(...(force ? [since, limit] : [since, retry, limit]));
  const up = db.prepare(`INSERT INTO pages (link_id, fetched_at, title, description, excerpt, error) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(link_id) DO UPDATE SET fetched_at = excluded.fetched_at, title = excluded.title, description = excluded.description,
      excerpt = excluded.excerpt, error = excluded.error`);
  let ok = 0, failed = 0;
  await pool(links, 4, async (l) => {
    try {
      const p = await fetchPage(l.url, key, fetchImpl);
      up.run(l.id, now(), p.title, p.description, p.excerpt, null); ok++;
    } catch (e) {
      up.run(l.id, now(), '', '', '', String(e.message).slice(0, 200)); failed++;
    }
  });
  log(`ingested ${ok} pages${failed ? `, ${failed} failed` : ''} (${links.length} attempted)`);
  return { ok, failed, attempted: links.length };
}
