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

/** LaunchAgent at 06:00 running `tabularasa morning [--close] [--reopen]`, plus the Claude Code skill. */
export function install({ close = false, reopen = false, bin, hour = 6 }) {
  const args = ['morning', ...(close ? ['--close'] : []), ...(reopen ? ['--reopen'] : [])];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
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
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(PLIST, xml);
  try { launchctl('bootout', domain(), PLIST); } catch {}
  launchctl('bootstrap', domain(), PLIST);
  fs.rmSync(SKILL_DST, { recursive: true, force: true });
  fs.cpSync(SKILL_SRC, SKILL_DST, { recursive: true });
  console.log(`Installed ${LABEL} (daily ${String(hour).padStart(2, '0')}:00, close=${close}, reopen=${reopen}); skill at ${SKILL_DST}`);
  console.log(`Test it now:  launchctl kickstart ${domain()}/${LABEL} && tail ${DIR}/tab-archive.log`);
}

export function uninstall() {
  try { launchctl('bootout', domain(), PLIST); } catch {}
  fs.rmSync(PLIST, { force: true });
  fs.rmSync(SKILL_DST, { recursive: true, force: true });
  console.log(`Removed ${LABEL} and the skill. The archive at ${DIR} is untouched.`);
}
