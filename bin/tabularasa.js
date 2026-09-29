#!/usr/bin/env node
// tabularasa — archive, close and refocus Safari tabs.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { archive, safariRunning } from '../src/archive.js';
import { DB_FILE, openDb } from '../src/db.js';
import { cleanupCandidates, deleteLinks, fmt } from '../src/cleanup.js';
import { selectInteractive } from '../src/picker.js';
import { mute, mutes, pin, pins, unmute, unpin } from '../src/prefs.js';
import { fmtRun, fmtTab, listRuns, restore, runTabs } from '../src/restore.js';
import { askJev, explain, focus, jevKey } from '../src/focus.js';
import { ingest } from '../src/ingest.js';
import { install, uninstall } from '../src/install.js';

const USAGE = `tabularasa — archive, close and refocus Safari tabs

  tabularasa [--group] [focus flags]   archive + close all tabs, reopen the relevant ones in a new window
  tabularasa archive           archive only (never closes)
  tabularasa close             archive + close, reopen nothing
  tabularasa focus [flags]     dry run of the picker; --open opens them, --group one window per topic cluster
                               --topic "X" --days N --limit N --threshold P --context FILE
                               --no-calendar --no-github --no-reviews
  tabularasa topic "X" [--new] archive + close everything, then open archived tabs about X (last 90 days)
                               in a new window; X is the only context. --new keeps current windows open
  tabularasa search TERM       find archived tabs by title or url
  tabularasa forget TERM       delete archived tabs whose title or url contains TERM
  tabularasa pin URL|TERM      always reopen this tab (own window when grouping); unpin URL|TERM
  tabularasa mute TERM         never reopen tabs matching TERM, cleanup leaves them alone; unmute TERM
  tabularasa pins              list pins and mutes
  tabularasa why URL|TERM [focus flags]   explain why a tab would or wouldn't be reopened right now
  tabularasa runs [N]          list the last N archive runs (default 20)
  tabularasa restore [ID] [--pick]   reopen every tab of a run, one window per original window;
                               no ID: choose the run interactively; --pick: choose tabs too
  tabularasa ingest [--days 30] [--limit 50] [--force]   opt-in: fetch page text via r.jina.ai for recent
                               links without one; summaries then feed the Jev relevance question
  tabularasa cleanup [--older 30] [--threshold 0.6] [--yes]
                               find outdated tabs (closed GitHub items, Jev-judged stale links unseen
                               for --older days) and pick which to delete; --yes deletes all without asking
  tabularasa install [--close] [--reopen] [--group] [--ingest] [--hour 6]   LaunchAgent (daily) + Claude Code skill
  tabularasa uninstall
  tabularasa "free text"       anything else, e.g. "drop closed github issues and PRs", via Claude + the tab-focus skill

Archive: ${DB_FILE}`;

const CTX = path.join(path.dirname(DB_FILE), 'context.txt');
const BIN = fileURLToPath(import.meta.url);
const stamp = () => new Date().toLocaleString('sv').replace('T', ' ');
// context.txt is written by the tab-focus skill in a Claude session; ignore it once it is a day old
const freshContext = () => existsSync(CTX) && Date.now() - statSync(CTX).mtimeMs < 864e5;
const log = (m) => console.log(`${stamp()} ${m}`);

function doArchive(close) {
  const r = archive({ close });
  log(`found=${r.found} new=${r.newLinks} closed=${r.closed} db=${DB_FILE}`);
  return r;
}

// parsed up front so a typo in a flag fails before anything is archived or closed
const focusFlags = (argv) => parseArgs({ args: argv, options: {
  open: { type: 'boolean' }, group: { type: 'boolean' }, topic: { type: 'string' }, context: { type: 'string' }, days: { type: 'string' },
  limit: { type: 'string' }, threshold: { type: 'string' }, 'no-calendar': { type: 'boolean' },
  'no-github': { type: 'boolean' }, 'no-reviews': { type: 'boolean' } } }).values;

async function doFocus(argv, extra = {}) {
  const values = focusFlags(argv);
  const num = (v, d) => (v == null ? d : Number(v));
  return focus({ open: values.open, group: values.group, topic: values.topic, context: values.context ?? (freshContext() ? CTX : undefined),
    days: num(values.days, 7), limit: num(values.limit, 15), threshold: num(values.threshold, 0.6),
    calendar: !values['no-calendar'], github: !values['no-github'], reviews: !values['no-reviews'], ...extra });
}

let [cmd, ...rest] = process.argv.slice(2);
if (cmd?.startsWith('--')) { rest.unshift(cmd); cmd = undefined; } // `tabularasa --group` = default command with flags
switch (cmd) {
  case undefined: focusFlags(rest); doArchive(true).closed && await doFocus(rest, { open: true }); break;
  case 'morning': { // what the LaunchAgent runs
    const close = rest.includes('--close'), reopen = rest.includes('--reopen'), group = rest.includes('--group'), doIngest = rest.includes('--ingest');
    const unknown = rest.filter((f) => !['--close', '--reopen', '--group', '--ingest'].includes(f));
    if (unknown.length) { console.error(`morning: unknown flag ${unknown[0]}`); process.exit(2); }
    const r = doArchive(close);
    if (doIngest) await ingest(openDb(), { limit: 30, log }).catch((e) => log(`warn: ingest failed: ${e.message}`));
    if (reopen && r.closed) await doFocus([], { open: true, group }).catch((e) => log(`warn: focus failed: ${e.message}`));
    break;
  }
  case 'archive': doArchive(false); break;
  case 'close': doArchive(true); break;
  case 'focus': await doFocus(rest); break;
  case 'topic': { // the topic is the whole context: no calendar, GitHub or session context mixed in
    const keep = rest.includes('--new'); // --new: leave current windows alone, just add a window
    const words = rest.filter((w) => w !== '--new');
    const bad = words.find((w) => w.startsWith('--'));
    if (bad) { console.error(`topic: unknown flag ${bad}`); process.exit(2); }
    if (!keep && !doArchive(true).closed && safariRunning()) break; // Safari has tabs but nothing was archived: don't pile on
    await doFocus(['--topic', words.join(' '), '--days', '90', '--open', '--no-calendar', '--no-github', '--no-reviews'], { context: undefined });
    break;
  }
  case 'search': {
    const like = `%${rest.join(' ')}%`;
    for (const r of openDb().prepare('SELECT last_seen, times_seen, title, url FROM links WHERE title LIKE ? OR url LIKE ? ORDER BY last_seen DESC LIMIT 50').all(like, like))
      console.log(`${r.last_seen}  ${String(r.times_seen).padStart(3)}  ${r.title}\n${' '.repeat(27)}${r.url}`);
    break;
  }
  case 'forget': {
    const like = `%${rest.join(' ')}%`, db = openDb();
    db.prepare('DELETE FROM tabs WHERE link_id IN (SELECT id FROM links WHERE title LIKE ? OR url LIKE ?)').run(like, like);
    console.log(`deleted ${db.prepare('DELETE FROM links WHERE title LIKE ? OR url LIKE ?').run(like, like).changes} links`);
    break;
  }
  case 'why': {
    const term = rest.find((a) => !a.startsWith('--'));
    if (!term) { console.error('why: pass a URL or a title fragment'); process.exit(2); }
    const v = focusFlags(rest.filter((a) => a !== term));
    const num = (x, d) => (x == null ? d : Number(x));
    await explain(term, { topic: v.topic, context: v.context ?? (freshContext() ? CTX : undefined), days: num(v.days, 7),
      threshold: num(v.threshold, 0.6), calendar: !v['no-calendar'], github: !v['no-github'] });
    break;
  }
  case 'runs': listRuns(openDb(), Number(rest[0] ?? 20)).forEach((r) => console.log(fmtRun(r))); break;
  case 'restore': {
    const pickTabs = rest.includes('--pick');
    let id = rest.find((a) => /^\d+$/.test(a));
    const db = openDb();
    if (!id) {
      if (!process.stdin.isTTY) { console.error('restore: pass a run id (see `tabularasa runs`)'); process.exit(2); }
      const runs = listRuns(db, 20);
      const [chosen] = await selectInteractive(runs, { single: true, format: fmtRun, title: 'Which run?' });
      if (!chosen) break;
      id = chosen.id;
    }
    let tabs = runTabs(db, Number(id));
    if (!tabs.length) { console.log(`run #${id} has no tabs`); break; }
    if (pickTabs && process.stdin.isTTY) tabs = await selectInteractive(tabs, { preselect: true, format: fmtTab, title: `run #${id}: ${tabs.length} tabs` });
    if (!tabs.length) break;
    const r = restore(tabs);
    console.log(`restored ${r.tabs} tabs in ${r.windows} window${r.windows > 1 ? 's' : ''} from run #${id}`);
    break;
  }
  case 'ingest': {
    const { values } = parseArgs({ args: rest, options: { days: { type: 'string' }, limit: { type: 'string' }, force: { type: 'boolean' } } });
    await ingest(openDb(), { days: Number(values.days ?? 30), limit: Number(values.limit ?? 50), force: values.force });
    break;
  }
  case 'pin': { const u = pin(openDb(), rest.join(' ')); console.log(u ? `pinned ${u}` : 'no archived tab matches'); break; }
  case 'unpin': console.log(`unpinned ${unpin(openDb(), rest.join(' '))}`); break;
  case 'mute': mute(openDb(), rest.join(' ')); console.log(`muted "${rest.join(' ')}"`); break;
  case 'unmute': console.log(`unmuted ${unmute(openDb(), rest.join(' '))}`); break;
  case 'pins': { const db = openDb(); pins(db).forEach((u) => console.log(`pin   ${u}`)); mutes(db).forEach((t) => console.log(`mute  ${t}`)); break; }
  case 'cleanup': {
    const { values } = parseArgs({ args: rest, options: { older: { type: 'string' }, threshold: { type: 'string' }, yes: { type: 'boolean' } } });
    const key = jevKey();
    const db = openDb();
    const items = await cleanupCandidates(db, { olderDays: Number(values.older ?? 30), threshold: Number(values.threshold ?? 0.6),
      ask: key ? (s, q) => askJev(key, s, q) : undefined });
    if (!items.length) { console.log('nothing looks outdated'); break; }
    let chosen = items;
    if (!values.yes) {
      if (!process.stdin.isTTY) { items.forEach((l) => console.log(fmt(l))); console.log(`\n${items.length} candidates; rerun with --yes to delete them`); break; }
      chosen = await selectInteractive(items, { format: fmt, title: `${items.length} candidates` });
    }
    chosen.forEach((l) => console.log(`deleted  ${fmt(l)}`));
    console.log(`deleted ${deleteLinks(db, chosen.map((l) => l.id))} of ${items.length} candidates`);
    break;
  }
  case 'install': {
    const { values } = parseArgs({ args: rest, options: { close: { type: 'boolean' }, reopen: { type: 'boolean' }, group: { type: 'boolean' }, ingest: { type: 'boolean' }, hour: { type: 'string' } } });
    install({ close: values.close, reopen: values.reopen, group: values.group, ingest: values.ingest, hour: Number(values.hour ?? 6), bin: BIN });
    break;
  }
  case 'uninstall': uninstall(); break;
  case '-h': case '--help': case 'help': console.log(USAGE); break;
  default: { // free text: hand it to Claude Code with the tab-focus skill
    const claude = path.join(os.homedir(), '.local/bin/claude');
    const r = spawnSync(claude, ['-p', `/tab-focus ${[cmd, ...rest].join(' ')}`, '--output-format', 'text',
      '--allowedTools', 'Skill,Bash(tabularasa:*),Bash(sqlite3:*),Bash(gh:*)'], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
}
