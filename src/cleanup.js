import { execFile } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
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

/** Merged or closed GitHub PRs and issues, whatever their age. */
async function githubClosed(links, run) {
  const gh = links.map((l) => [l, l.url.match(GH_RE)]).filter(([, m]) => m);
  const results = await pool(gh, 8, async ([l, [, owner, repo, kind, n]]) => {
    try {
      const r = await run('gh', ['api', `repos/${owner}/${repo}/${kind === 'pull' ? 'pulls' : 'issues'}/${n}`, '--jq', '{state: .state, merged: .merged_at}']);
      if (r.state === 'closed') return { ...l, reason: r.merged ? 'merged PR' : kind === 'pull' ? 'closed PR' : 'closed issue' };
    } catch { /* deleted repo, no access: leave it alone */ }
    return null;
  });
  return results.filter(Boolean);
}

/** Links unseen for a while that Jev judges outdated, given title, url and how often they came back. */
async function jevStale(links, ask, threshold, batch = 40) {
  const today = new Date().toISOString().slice(0, 10);
  const chunks = [];
  for (let i = 0; i < links.length; i += batch) chunks.push(links.slice(i, i + batch));
  const results = await Promise.all(chunks.map(async (chunk) => {
    const questions = Object.fromEntries(chunk.map((l, j) => [`t${j}`, { type: 'noul', instructions:
      `Is this archived browser tab likely outdated, finished or no longer useful to keep, rather than a lasting reference? Title: "${l.title}" URL: ${l.url} last opened ${l.last_seen.slice(0, 10)}, opened in ${l.times_seen} archive runs.` }]));
    const answers = await ask(`Today is ${today}. Judge whether archived browser tabs are outdated.`, questions);
    return chunk.map((l, j) => ({ l, p: answers[`t${j}`].noul }));
  }));
  return results.flat().filter(({ p }) => p >= threshold).map(({ l, p }) => ({ ...l, reason: `stale ${p.toFixed(2)}` }));
}

/** Candidates for deletion: closed GitHub items, then Jev-judged stale links older than `olderDays`. */
export async function cleanupCandidates(db, { olderDays = 30, threshold = 0.6, ask, run = runJson, limit = 200 } = {}) {
  const all = db.prepare('SELECT id, url, title, last_seen, times_seen FROM links ORDER BY last_seen').all();
  const closed = await githubClosed(all, run);
  const taken = new Set(closed.map((l) => l.id));
  const since = new Date(Date.now() - olderDays * 864e5).toISOString();
  const aged = all.filter((l) => l.last_seen < since && !taken.has(l.id)).slice(0, limit);
  const stale = ask ? await jevStale(aged, ask, threshold) : [];
  return [...closed, ...stale];
}

export function deleteLinks(db, ids) {
  if (!ids.length) return 0;
  const q = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM tabs WHERE link_id IN (${q})`).run(...ids);
  return db.prepare(`DELETE FROM links WHERE id IN (${q})`).run(...ids).changes;
}

export const fmt = (l, w = process.stdout.columns || 120) => `${l.reason.padEnd(13)} ${l.last_seen.slice(0, 10)}  ${(l.title || l.url).slice(0, Math.max(20, w - 30))}`;

/** Terminal picker: ↑↓/jk move, space toggles, a toggles all, enter confirms, q quits. Resolves to selected items. */
export function selectInteractive(items, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    let cursor = 0;
    const on = new Set();
    const draw = () => {
      readline.cursorTo(output, 0, 0); readline.clearScreenDown(output);
      output.write(`${items.length} candidates. space: toggle  a: all  enter: delete selected  q: quit\n\n`);
      items.forEach((l, i) => output.write(`${i === cursor ? '>' : ' '} [${on.has(i) ? 'x' : ' '}] ${fmt(l)}\n`));
    };
    const done = (result) => { input.setRawMode(false); input.pause(); input.off('keypress', onKey); output.write('\n'); resolve(result); };
    const onKey = (_, k) => {
      if (k.name === 'q' || (k.ctrl && k.name === 'c')) return done([]);
      if (k.name === 'return') return done(items.filter((_, i) => on.has(i)));
      if (k.name === 'up' || k.name === 'k') cursor = (cursor + items.length - 1) % items.length;
      if (k.name === 'down' || k.name === 'j') cursor = (cursor + 1) % items.length;
      if (k.name === 'space') on.has(cursor) ? on.delete(cursor) : on.add(cursor);
      if (k.name === 'a') items.forEach((_, i) => (on.size === items.length ? on.delete(i) : on.add(i)));
      draw();
    };
    readline.emitKeypressEvents(input);
    input.setRawMode(true); input.resume(); input.on('keypress', onKey);
    draw();
  });
}
