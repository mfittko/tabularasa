import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cached } from './db.js';
export { selectInteractive } from './picker.js';

const execFileP = promisify(execFile);
const H = 3600, D = 86400;
const runJson = async (cmd, args) => JSON.parse((await execFileP(cmd, args, { encoding: 'utf8', timeout: 60000 })).stdout);
const GH_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/;

/** Run `fn` over `items` with at most `n` in flight; results in input order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (let i; (i = next++) < items.length;) out[i] = await fn(items[i], i);
  }));
  return out;
}

/** Merged or closed GitHub PRs and issues, whatever their age. Closed is final: cached 30 days; open: 6 hours. */
async function githubClosed(db, links, run) {
  const gh = links.map((l) => [l, l.url.match(GH_RE)]).filter(([, m]) => m);
  const results = await pool(gh, 8, async ([l, [, owner, repo, kind, n]]) => {
    const path = `repos/${owner}/${repo}/${kind === 'pull' ? 'pulls' : 'issues'}/${n}`;
    let r = db.prepare('SELECT value FROM cache WHERE key = ? AND expires_at > ?').get(`gh:${path}`, new Date().toISOString());
    if (r) r = JSON.parse(r.value);
    else {
      try { r = await run('gh', ['api', path, '--jq', '{state: .state, merged: .merged_at}']); } catch { return null; /* deleted repo, no access: leave it alone */ }
      await cached(db, `gh:${path}`, r.state === 'closed' ? 30 * D : 6 * H, () => r);
    }
    return r.state === 'closed' ? { ...l, reason: r.merged ? 'merged PR' : kind === 'pull' ? 'closed PR' : 'closed issue' } : null;
  });
  return results.filter(Boolean);
}

/** Links unseen for a while that Jev judges outdated. Verdicts cached 7 days per link and last_seen. */
async function jevStale(db, links, ask, threshold, batch = 40) {
  const today = new Date().toISOString().slice(0, 10);
  const key = (l) => `stale:${l.id}:${l.last_seen}`;
  const fresh = links.filter((l) => !db.prepare('SELECT 1 FROM cache WHERE key = ? AND expires_at > ?').get(key(l), new Date().toISOString()));
  const chunks = [];
  for (let i = 0; i < fresh.length; i += batch) chunks.push(fresh.slice(i, i + batch));
  await Promise.all(chunks.map(async (chunk) => {
    const questions = Object.fromEntries(chunk.map((l, j) => [`t${j}`, { type: 'noul', instructions:
      `Is this archived browser tab likely outdated, finished or no longer useful to keep, rather than a lasting reference? Title: "${l.title}" URL: ${l.url} last opened ${l.last_seen.slice(0, 10)}, opened in ${l.times_seen} archive runs.` }]));
    const answers = await ask(`Today is ${today}. Judge whether archived browser tabs are outdated.`, questions);
    for (const [j, l] of chunk.entries()) await cached(db, key(l), 7 * D, () => answers[`t${j}`].noul);
  }));
  const out = [];
  for (const l of links) {
    const p = await cached(db, key(l), 7 * D, () => null);
    if (p != null && p >= threshold) out.push({ ...l, reason: `stale ${p.toFixed(2)}` });
  }
  return out;
}

/** Candidates for deletion: closed GitHub items, then Jev-judged stale links older than `olderDays`. */
export async function cleanupCandidates(db, { olderDays = 30, threshold = 0.6, ask, run = runJson, limit = 200 } = {}) {
  const all = db.prepare('SELECT id, url, title, last_seen, times_seen FROM links ORDER BY last_seen').all();
  const closed = await githubClosed(db, all, run);
  const taken = new Set(closed.map((l) => l.id));
  const since = new Date(Date.now() - olderDays * 864e5).toISOString();
  const aged = all.filter((l) => l.last_seen < since && !taken.has(l.id)).slice(0, limit);
  const stale = ask ? await jevStale(db, aged, ask, threshold) : [];
  return [...closed, ...stale];
}

export function deleteLinks(db, ids) {
  if (!ids.length) return 0;
  const q = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM tabs WHERE link_id IN (${q})`).run(...ids);
  return db.prepare(`DELETE FROM links WHERE id IN (${q})`).run(...ids).changes;
}

export const fmt = (l, w = process.stdout.columns || 120) => `${l.reason.padEnd(13)} ${l.last_seen.slice(0, 10)}  ${(l.title || l.url).slice(0, Math.max(20, w - 30))}`;
