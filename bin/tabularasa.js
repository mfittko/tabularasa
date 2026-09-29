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
import { cleanupCandidates, deleteLinks, fmt, selectInteractive } from '../src/cleanup.js';
import { askJev, focus, jevKey } from '../src/focus.js';
import { install, uninstall } from '../src/install.js';

const USAGE = `tabularasa — archive, close and refocus Safari tabs

  tabularasa                   archive + close all tabs, reopen the relevant ones in a new window
  tabularasa archive           archive only (never closes)
  tabularasa close             archive + close, reopen nothing
  tabularasa focus [flags]     dry run of the picker; --open opens them, --group one window per topic cluster
                               --topic "X" --days N --limit N --threshold P --context FILE
                               --no-calendar --no-github --no-reviews
  tabularasa topic "X" [--new] archive + close everything, then open archived tabs about X (last 90 days)
                               in a new window; X is the only context. --new keeps current windows open
  tabularasa search TERM       find archived tabs by title or url
  tabularasa forget TERM       delete archived tabs whose title or url contains TERM
  tabularasa cleanup [--older 30] [--threshold 0.6] [--yes]
                               find outdated tabs (closed GitHub items, Jev-judged stale links unseen
                               for --older days) and pick which to delete; --yes deletes all without asking
  tabularasa install [--close] [--reopen] [--group] [--hour 6]   LaunchAgent (daily) + Claude Code skill
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

async function doFocus(argv, extra = {}) {
  const { values } = parseArgs({ args: argv, options: {
    open: { type: 'boolean' }, group: { type: 'boolean' }, topic: { type: 'string' }, context: { type: 'string' }, days: { type: 'string' },
    limit: { type: 'string' }, threshold: { type: 'string' }, 'no-calendar': { type: 'boolean' },
    'no-github': { type: 'boolean' }, 'no-reviews': { type: 'boolean' } } });
  const num = (v, d) => (v == null ? d : Number(v));
  return focus({ open: values.open, group: values.group, topic: values.topic, context: values.context ?? (freshContext() ? CTX : undefined),
    days: num(values.days, 7), limit: num(values.limit, 15), threshold: num(values.threshold, 0.6),
    calendar: !values['no-calendar'], github: !values['no-github'], reviews: !values['no-reviews'], ...extra });
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case undefined: doArchive(true).closed && await doFocus(rest, { open: true }); break;
  case 'morning': { // what the LaunchAgent runs
    const close = rest.includes('--close'), reopen = rest.includes('--reopen'), group = rest.includes('--group');
    const r = doArchive(close);
    if (reopen && r.closed) await doFocus([], { open: true, group }).catch((e) => log(`warn: focus failed: ${e.message}`));
    break;
  }
  case 'archive': doArchive(false); break;
  case 'close': doArchive(true); break;
  case 'focus': await doFocus(rest); break;
  case 'topic': { // the topic is the whole context: no calendar, GitHub or session context mixed in
    const keep = rest.includes('--new'); // --new: leave current windows alone, just add a window
    const words = rest.filter((w) => w !== '--new');
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
      chosen = await selectInteractive(items);
    }
    chosen.forEach((l) => console.log(`deleted  ${fmt(l)}`));
    console.log(`deleted ${deleteLinks(db, chosen.map((l) => l.id))} of ${items.length} candidates`);
    break;
  }
  case 'install': {
    const { values } = parseArgs({ args: rest, options: { close: { type: 'boolean' }, reopen: { type: 'boolean' }, group: { type: 'boolean' }, hour: { type: 'string' } } });
    install({ close: values.close, reopen: values.reopen, group: values.group, hour: Number(values.hour ?? 6), bin: BIN });
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
