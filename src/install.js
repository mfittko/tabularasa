import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIR } from './db.js';

export const LABEL = 'local.tab-archive';
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const SKILL_SRC = fileURLToPath(new URL('../skills/tab-focus', import.meta.url));
const SKILL_DST = path.join(os.homedir(), '.claude/skills/tab-focus');
const domain = () => `gui/${os.userInfo().uid}`;
const launchctl = (...a) => execFileSync('launchctl', a, { stdio: 'inherit' });

export function plistXml({ close = false, reopen = false, group = false, ingest = false, bin, hour = 6 }) {
  const args = ['morning', ...(close ? ['--close'] : []), ...(reopen ? ['--reopen'] : []), ...(group ? ['--group'] : []), ...(ingest ? ['--ingest'] : [])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${[process.execPath, bin, ...args].map((s) => `<string>${s}</string>`).join('')}</array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${DIR}/tab-archive.log</string>
  <key>StandardErrorPath</key><string>${DIR}/tab-archive.log</string>
</dict>
</plist>
`;
}

/** LaunchAgent at 06:00 running `tabularasa morning [--close] [--reopen]`, plus the Claude Code skill. */
export function install({ close = false, reopen = false, group = false, ingest = false, bin, hour = 6 }) {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(PLIST, plistXml({ close, reopen, group, ingest, bin, hour }));
  try { launchctl('bootout', domain(), PLIST); } catch {}
  launchctl('bootstrap', domain(), PLIST);
  fs.rmSync(SKILL_DST, { recursive: true, force: true });
  fs.cpSync(SKILL_SRC, SKILL_DST, { recursive: true });
  console.log(`Installed ${LABEL} (daily ${String(hour).padStart(2, '0')}:00, close=${close}, reopen=${reopen}, group=${group}, ingest=${ingest}); skill at ${SKILL_DST}`);
  console.log(`Test it now:  launchctl kickstart ${domain()}/${LABEL} && tail ${DIR}/tab-archive.log`);
}

export const CLOSED_LABEL = 'local.tabularasa-closed';
const CLOSED_PLIST = path.join(os.homedir(), 'Library/LaunchAgents', `${CLOSED_LABEL}.plist`);
export const closedSyncInstalled = () => fs.existsSync(CLOSED_PLIST);
export const CLOSED_HELPER = path.join(DIR, 'bin/closed-sync');
const HELPER_SRC = fileURLToPath(new URL('../helper/closed-sync.c', import.meta.url));

/** One-time setup for the recently-closed scan: a 30-line C helper copies Safari's
 *  RecentlyClosedTabs.plist into the archive dir, run by launchd whenever that file changes.
 *  Only the helper needs Full Disk Access; neither Node nor the terminal ever reads ~/Library/Safari.
 *  Compiled once: TCC identifies an ad-hoc signed binary by hash, so a rebuild would drop the grant. */
export function installClosedSync() {
  fs.mkdirSync(path.dirname(CLOSED_HELPER), { recursive: true });
  const fresh = !fs.existsSync(CLOSED_HELPER);
  if (fresh) execFileSync('cc', ['-O2', '-Wall', '-o', CLOSED_HELPER, HELPER_SRC], { stdio: 'inherit' });
  fs.writeFileSync(CLOSED_PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${CLOSED_LABEL}</string>
  <key>ProgramArguments</key><array><string>${CLOSED_HELPER}</string></array>
  <key>EnvironmentVariables</key><dict><key>TAB_ARCHIVE_DIR</key><string>${DIR}</string></dict>
  <key>WatchPaths</key><array><string>${path.join(os.homedir(), 'Library/Safari/RecentlyClosedTabs.plist')}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${path.join(DIR, 'closed-sync.log')}</string>
</dict>
</plist>
`);
  try { execFileSync('launchctl', ['bootout', domain(), CLOSED_PLIST], { stdio: 'ignore' }); } catch {}
  launchctl('bootstrap', domain(), CLOSED_PLIST);
  console.log(`Installed ${CLOSED_LABEL}${fresh ? ` (compiled ${CLOSED_HELPER})` : ''}.`);
  console.log(`Grant it Full Disk Access once: System Settings → Privacy & Security → Full Disk Access → "+",\n  press Cmd+Shift+G and paste:  ${CLOSED_HELPER}\nThen run:  tabularasa dismissed`);
}

export function uninstall() {
  try { launchctl('bootout', domain(), CLOSED_PLIST); } catch {}
  try { fs.rmSync(CLOSED_PLIST); } catch {}
  try { launchctl('bootout', domain(), PLIST); } catch {}
  fs.rmSync(PLIST, { force: true });
  fs.rmSync(SKILL_DST, { recursive: true, force: true });
  console.log(`Removed ${LABEL} and the skill. The archive at ${DIR} is untouched.`);
}
