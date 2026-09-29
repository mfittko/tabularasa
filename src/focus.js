import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, now } from './db.js';
import { isMuted, mutes, pins, withPins } from './prefs.js';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const URL_RE = /https?:\/\/[^\s<>|"')\]]+/g;
const TRACKING = /^(utm_|fbclid$|gclid$|ref$|ref_src$|sk$)/;

export function jevKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    return fs.readFileSync(path.join(os.homedir(), '.config/typesafe'), 'utf8').match(/TYPESAFE_API_KEY=["']?([^"'\s]+)/)?.[1] ?? null;
  } catch { return null; }
}

export function normUrl(u) {
  try {
    const p = new URL(u.trim().replace(/[.,;:]+$/, ''));
    for (const k of [...p.searchParams.keys()]) if (TRACKING.test(k)) p.searchParams.delete(k);
    p.hash = '';
    p.hostname = p.hostname.replace(/^www\./, '');
    p.pathname = p.pathname.replace(/\/+$/, '') || '/';
    return p.toString();
  } catch { return u; }
}

const runJson = (cmd, args) => JSON.parse(execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }));
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

// ---- context sources -------------------------------------------------------

export function calendarTexts(daysBack = 1, daysAhead = 1, run = runJson) {
  const params = { calendarId: 'primary', singleEvents: true, maxResults: 100, orderBy: 'startTime',
    timeMin: `${day(-daysBack)}T00:00:00Z`, timeMax: `${day(daysAhead)}T23:59:59Z` };
  const data = run('gws', ['calendar', 'events', 'list', '--params', JSON.stringify(params)]);
  const texts = [];
  for (const ev of data.items ?? []) {
    if ((ev.eventType ?? 'default') !== 'default') continue;
    if (ev.attendees?.find((a) => a.self)?.responseStatus === 'declined') continue;
    const parts = [ev.summary, (ev.description ?? '').replace(/<[^>]+>/g, ' ').slice(0, 500), ev.location,
      ...(ev.attachments ?? []).map((a) => a.fileUrl)].filter(Boolean);
    texts.push('event: ' + parts.join(' | '));
  }
  return texts;
}

export function githubTexts(days, run = runJson) {
  const texts = [];
  for (const kind of ['prs', 'issues']) {
    const items = run('gh', ['search', kind, '--involves', '@me', '--updated', `>=${day(-days)}`, '--limit', '30', '--json', 'title,url']);
    texts.push(...items.map((i) => `${kind.slice(0, -1)}: ${i.title} ${i.url}`));
  }
  return texts;
}

/** Open PRs awaiting my review become archive links, so they compete as candidates like any tab. */
export function ingestReviews(db, run = runJson) {
  const items = run('gh', ['search', 'prs', '--review-requested', '@me', '--state', 'open', '--limit', '50', '--json', 'title,url']);
  const at = now();
  const up = db.prepare(`INSERT INTO links (url, title, first_seen, last_seen) VALUES (?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET last_seen = excluded.last_seen, title = excluded.title`);
  for (const i of items) up.run(i.url, i.title, at, at);
  return items.length;
}

// ---- Jev -------------------------------------------------------------------

/** One Jev request: state + named questions, returns { name: answer }. */
export async function askJev(key, state, questions) {
  const res = await fetch(JEV_URL, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state, questions }) });
  if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).answers;
}

async function relevance(ask, state, tabs, batch = 40) {
  const scores = [];
  for (let i = 0; i < tabs.length; i += batch) {
    const chunk = tabs.slice(i, i + batch);
    const questions = Object.fromEntries(chunk.map((t, j) => [`t${j}`, { type: 'noul',
      instructions: `Is this browser tab relevant to the work or topic described in the state? Tab title: "${t.title}" URL: ${t.url}`
        + (t.summary ? ` Page summary: ${t.summary.slice(0, 300)}` : '') }]));
    const answers = await ask(state, questions);
    scores.push(...chunk.map((_, j) => answers[`t${j}`].noul));
  }
  return scores;
}

const DUP_Q = 'Do these two browser tabs show the same underlying content (the same document, artifact, board or resource, possibly in a different view, session or share link), so that opening both would be redundant? Identical or near-identical titles are strong evidence of the same content. ';
const SIM_Q = 'Are these two browser tabs about the same topic or piece of work? ';

/** Pairwise: drop duplicates (lower-scored one), then chain nearest neighbours so related tabs sit together. */
async function order(ask, picks, dupThreshold = 0.4, groupCut = 0.5) { // ponytail: 0.4 measured against control pairs (<= 0.19)
  const n = picks.length;
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  const sim = new Map(), dups = new Set();
  for (let k = 0; k < pairs.length; k += 50) {
    const chunk = pairs.slice(k, k + 50), questions = {};
    for (const [i, j] of chunk) {
      const ab = `A: "${picks[i].title}" ${picks[i].url}  B: "${picks[j].title}" ${picks[j].url}`;
      questions[`s${i}_${j}`] = { type: 'noul', instructions: SIM_Q + ab };
      questions[`d${i}_${j}`] = { type: 'noul', instructions: DUP_Q + ab };
    }
    const answers = await ask('Judge similarity of browser tabs.', questions);
    for (const [i, j] of chunk) {
      sim.set(`${i},${j}`, answers[`s${i}_${j}`].noul); sim.set(`${j},${i}`, answers[`s${i}_${j}`].noul);
      if (answers[`d${i}_${j}`].noul >= dupThreshold) dups.add(j); // picks are sorted by score, j is the lower one
    }
  }
  const keep = [...Array(n).keys()].filter((i) => !dups.has(i));
  const out = keep.slice(0, 1), left = new Set(keep.slice(1));
  while (left.size) {
    const last = out[out.length - 1];
    const next = [...left].sort((a, b) => (sim.get(`${last},${b}`) - sim.get(`${last},${a}`)) || (picks[b].score - picks[a].score))[0];
    out.push(next); left.delete(next);
  }
  // groups: cut the chain where neighbours stop being about the same work
  let group = 0;
  return out.map((i, k) => {
    if (k > 0 && sim.get(`${out[k - 1]},${i}`) < groupCut) group++;
    return { ...picks[i], group };
  });
}

/** Rank candidate tabs against context texts. `ask(state, questions)` answers Jev questions. */
export async function pick(tabs, texts, ask, { threshold = 0.6, limit = 15 } = {}) {
  const blob = texts.join('\n').slice(0, 20000); // ponytail: hard cap; trim context if Jev rejects the size
  const ctxUrls = new Set((blob.match(URL_RE) ?? []).map(normUrl));
  const linked = tabs.filter((t) => ctxUrls.has(normUrl(t.url))).map((t) => ({ ...t, score: 1, reason: 'linked' }));
  const rest = tabs.filter((t) => !ctxUrls.has(normUrl(t.url)));
  const scores = await relevance(ask, blob, rest);
  const judged = rest.map((t, i) => ({ ...t, score: scores[i], reason: 'jev' })).filter((t) => t.score >= threshold);
  const picks = [], seen = new Set();
  for (const p of [...linked, ...judged].sort((a, b) => b.score - a.score)) { // exact dupes (share params); Jev handles the rest
    if (picks.length < limit && !seen.has(normUrl(p.url))) { seen.add(normUrl(p.url)); picks.push(p); }
  }
  return picks.length > 2 ? order(ask, picks) : picks.map((p) => ({ ...p, group: 0 }));
}

/** Split ordered picks into windows: one per group when grouping (singletons share one trailing
 *  window), otherwise a single window. */
export function windows(picks, group) {
  if (!group) return picks.length ? [picks] : [];
  const groups = [...Map.groupBy(picks, (p) => p.group).values()];
  const pinnedWin = groups.filter((g) => g[0].group === -1); // pinned tabs share a window of their own
  const rest = groups.filter((g) => g[0].group !== -1);
  const singles = rest.filter((g) => g.length === 1).flat();
  return [...pinnedWin, ...rest.filter((g) => g.length > 1), ...(singles.length ? [singles] : [])];
}

export function openInNewWindow(urls) {
  const q = (u) => JSON.stringify(u);
  const script = ['tell application "Safari"', 'activate', `make new document with properties {URL:${q(urls[0])}}`,
    ...urls.slice(1).map((u) => `tell window 1 to make new tab with properties {URL:${q(u)}}`), 'end tell'].join('\n');
  execFileSync('osascript', ['-e', script]);
}

/** Context lines from topic, context file, calendar and GitHub, each source best effort. */
export function gatherContext({ topic, context, days = 7, calendar = true, github = true, log = console.log } = {}) {
  const texts = [];
  if (topic) texts.push('topic: ' + topic);
  if (context) texts.push(...fs.readFileSync(context, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
  for (const [name, fn, on] of [['calendar', () => calendarTexts(1, 1), calendar], ['github', () => githubTexts(days), github]]) {
    if (!on) continue;
    try { const t = fn(); texts.push(...t); log(`${name}: ${t.length} items`); } catch (e) { console.error(`${name}: skipped (${String(e.message).slice(0, 120)})`); }
  }
  return texts;
}

/** The configured Jev asker, or the injected one. */
export function asker(ask) {
  if (ask) return ask;
  const key = jevKey();
  if (!key) throw new Error('no TYPESAFE_API_KEY (env or ~/.config/typesafe)');
  return (state, questions) => askJev(key, state, questions);
}

/** Why a tab is or isn't picked: candidate status, linked/Jev score, and the context lines that share words with it. */
export async function explain(term, { threshold = 0.6, days = 7, db = openDb(), ask, log = console.log, ...ctx } = {}) {
  const link = db.prepare(`SELECT l.url, l.title, l.last_seen, l.times_seen, nullif(trim(coalesce(p.description, '') || ' ' || coalesce(p.excerpt, '')), '') AS summary
    FROM links l LEFT JOIN pages p ON p.link_id = l.id WHERE l.url = ? OR l.title LIKE ? OR l.url LIKE ? ORDER BY l.last_seen DESC LIMIT 1`)
    .get(term, `%${term}%`, `%${term}%`);
  if (!link) { log(`not in the archive: ${term}`); return null; }
  const texts = gatherContext({ days, log, ...ctx });
  log(`\n${link.title || link.url}\n${link.url}\nlast seen ${link.last_seen.slice(0, 16)}, in ${link.times_seen} runs`);
  if (link.summary) log(`page: ${link.summary.slice(0, 200)}`);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const candidate = link.last_seen >= since;
  log(candidate ? `candidate: yes (seen within ${days} days)` : `candidate: no (not seen within ${days} days; raise --days)`);
  if (!texts.length) { log('context: none'); return { link, candidate, score: null }; }
  const blob = texts.join('\n').slice(0, 20000);
  const linked = new Set((blob.match(URL_RE) ?? []).map(normUrl)).has(normUrl(link.url));
  const score = linked ? 1 : (await relevance(asker(ask), blob, [link]))[0];
  const verdict = linked ? 'linked: a context line contains this URL' : `jev: ${score.toFixed(2)} ${score >= threshold ? '>=' : '<'} threshold ${threshold}`;
  log(`${verdict}\n${!candidate ? 'not a candidate, so ' : ''}${linked || score >= threshold ? 'would be picked' : 'would not be picked'}`);
  const words = new Set((link.title || '').toLowerCase().match(/[\p{L}\d][\p{L}\d_.-]{3,}/gu) ?? []);
  const evidence = texts.map((t) => [t, [...new Set(t.toLowerCase().match(/[\p{L}\d][\p{L}\d_.-]{3,}/gu) ?? [])].filter((w) => words.has(w))])
    .filter(([, shared]) => shared.length).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  log(evidence.length ? `\ncontext lines sharing words with the title:` : '\nno context line shares a word with the title');
  for (const [t, shared] of evidence) log(`  [${shared.join(', ')}] ${t.slice(0, 110)}`);
  return { link, candidate, linked, score };
}

/** The whole focus flow. Returns the picks; prints progress to stderr-ish lines via `log`. */
export async function focus({ topic, context, days = 7, limit = 15, threshold = 0.6, calendar = true, github = true, reviews = true,
  open = false, group = false, db = openDb(), ask, log = console.log } = {}) {
  const texts = gatherContext({ topic, context, days, calendar, github, log });
  if (!texts.length) { log('no context available, nothing to reopen'); return []; }
  ask = asker(ask);

  if (reviews) {
    try { log(`reviews: ${ingestReviews(db)} PRs ingested`); } catch (e) { console.error(`reviews: skipped (${String(e.message).slice(0, 120)})`); }
  }
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const muted = mutes(db);
  const tabs = db.prepare(`SELECT l.url, l.title, nullif(trim(coalesce(p.description, '') || ' ' || coalesce(p.excerpt, '')), '') AS summary
    FROM links l LEFT JOIN pages p ON p.link_id = l.id WHERE l.last_seen >= ? ORDER BY l.last_seen DESC LIMIT 400`).all(since)
    .filter((t) => !isMuted(t, muted));
  const withPages = tabs.filter((t) => t.summary).length;
  log(`candidates: ${tabs.length}${withPages ? ` (${withPages} with page content)` : ''}${muted.length ? ` (${muted.length} mute terms)` : ''}`);

  const pinned = pins(db);
  const titles = new Map(db.prepare('SELECT url, title FROM links WHERE url IN (SELECT url FROM pins)').all().map((r) => [r.url, r.title]));
  const picks = withPins(await pick(tabs, texts, ask, { threshold, limit }), pinned, titles);
  const wins = windows(picks, group);
  wins.forEach((w, i) => {
    if (group) log(`${i ? '\n' : ''}window ${i + 1}`);
    for (const p of w) log(`${p.score.toFixed(2)}  ${p.reason.padEnd(6)}  ${p.title || p.url}`);
  });
  if (!picks.length) log('no matching tabs');
  else if (open) {
    for (const w of wins) openInNewWindow(w.map((p) => p.url));
    log(`opened ${picks.length} tabs in ${wins.length} window${wins.length > 1 ? 's' : ''}`);
  }
  return picks;
}
