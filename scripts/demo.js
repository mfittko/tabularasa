#!/usr/bin/env node
// Generates docs/demo.svg: an animated terminal walkthrough for the README. No dependencies.
// Usage: node scripts/demo.js  (then commit docs/demo.svg)
import fs from 'node:fs';

// [text, class, delayAfterInSeconds]; commands get typed, output appears line by line.
const script = [
  ['$ tabularasa', 'cmd', 1.2],
  ['2026-09-30 06:00:01 found=164 new=3 closed=1 db=~/.tab-archive/tabs.db', 'dim', 0.8],
  ['calendar: 17 items', 'dim', 0.2],
  ['github: 60 items', 'dim', 0.2],
  ['reviews: 22 PRs ingested', 'dim', 0.2],
  ['candidates: 134', 'dim', 0.6],
  ['0.90  jev     Knowledge graph data import and display in admin', 'out', 0.15],
  ['0.85  jev     RFC: Knowledge Graph in the monolith - Google Docs', 'out', 0.15],
  ['0.89  jev     Knowledge Graph Tech', 'out', 0.15],
  ['1.00  linked  feat(gate): verdict post takes the act list · PR #2573', 'hi', 0.15],
  ['0.88  jev     Pull requests · dev-loops', 'out', 0.15],
  ['0.87  jev     AI Tech Lab', 'out', 0.15],
  ['0.86  jev     Flashcards Area UI Review', 'out', 0.15],
  ['0.83  jev     feat(flashcards): toolbar subject and class filters · PR #21440', 'out', 0.15],
  ['0.88  jev     Sept Drop Code Audit', 'out', 0.15],
  ['0.86  jev     Adaptive Content Audit', 'out', 0.4],
  ['opened 10 tabs in a new window', 'ok', 2.5],
  ['', 'dim', 0],
  ['$ tabularasa topic "knowledge graph"', 'cmd', 1.2],
  ['candidates: 133', 'dim', 0.5],
  ['0.93  jev     Knowledge graph data import and display in admin', 'out', 0.15],
  ['0.91  jev     RFC: Knowledge Graph in the monolith - Google Docs', 'out', 0.15],
  ['0.91  jev     Knowledge Graph Tech', 'out', 0.15],
  ['0.84  jev     Shaping the Knowledge Graph', 'out', 0.3],
  ['opened 4 tabs in a new window', 'ok', 2.5],
  ['', 'dim', 0],
  ['$ tabularasa cleanup', 'cmd', 1.2],
  ['5 candidates. space: toggle  a: all  enter: delete selected  q: quit', 'dim', 0.6],
  ['> [x] merged PR     2026-09-01  fix(gate): verdict post takes the act list · PR #2573', 'hi', 0.5],
  ['  [x] closed issue  2026-08-20  Bound coordinator context growth · Issue #2269', 'out', 0.4],
  ['  [ ] stale 0.83    2026-08-12  Conference talk schedule (draft)', 'out', 0.4],
  ['  [x] stale 0.71    2026-07-30  Q2 release notes - Google Docs', 'out', 0.4],
  ['  [ ] stale 0.62    2026-07-28  Vite build: missing index.html', 'out', 1.2],
  ['deleted 3 of 5 candidates', 'ok', 4],
];

const W = 900, LINE = 20, PAD = 16, CHAR = 8.4; // 14px monospace
const H = PAD * 2 + 28 + script.length * LINE;
let t = 0.6;
const items = script.map(([text, cls, after]) => {
  const start = t;
  const typing = cls === 'cmd' ? text.length * 0.05 : 0;
  t += typing + after;
  return { text, cls, start, typing };
});
const total = t + 1;
const pct = (s) => ((s / total) * 100).toFixed(3);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const css = items.map((it, i) => {
  const rules = [`.l${i}{animation:l${i} ${total}s linear infinite}`];
  if (it.typing) {
    // typewriter: reveal via a clip rect growing in character steps
    rules.push(`@keyframes l${i}{0%,${pct(it.start)}%{opacity:0}${pct(it.start + 0.01)}%,100%{opacity:1}}`);
    rules.push(`.c${i}{animation:c${i} ${total}s steps(${it.text.length},end) infinite}`);
    rules.push(`@keyframes c${i}{0%,${pct(it.start)}%{width:0}${pct(it.start + it.typing)}%,100%{width:${(it.text.length * CHAR).toFixed(1)}px}}`);
  } else {
    rules.push(`@keyframes l${i}{0%,${pct(it.start)}%{opacity:0}${pct(it.start + 0.01)}%,100%{opacity:1}}`);
  }
  return rules.join('\n');
}).join('\n');

const body = items.map((it, i) => {
  const y = PAD + 28 + (i + 1) * LINE - 6;
  if (it.typing) {
    return `<clipPath id="k${i}"><rect class="c${i}" x="${PAD}" y="${y - 15}" height="${LINE}" width="0"/></clipPath>` +
      `<text class="${it.cls} l${i}" clip-path="url(#k${i})" x="${PAD}" y="${y}">${esc(it.text)}</text>`;
  }
  return `<text class="${it.cls} l${i}" x="${PAD}" y="${y}">${esc(it.text)}</text>`;
}).join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="SFMono-Regular,Menlo,Consolas,monospace" font-size="14">
<style>
text{white-space:pre;fill:#d4d4d4}.cmd{fill:#ffffff;font-weight:600}.dim{fill:#8b949e}.out{fill:#d4d4d4}.hi{fill:#7ee787}.ok{fill:#79c0ff}
${css}
</style>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<circle cx="22" cy="20" r="6" fill="#ff5f56"/><circle cx="42" cy="20" r="6" fill="#ffbd2e"/><circle cx="62" cy="20" r="6" fill="#27c93f"/>
<text x="${W / 2}" y="25" text-anchor="middle" class="dim">tabularasa</text>
${body}
</svg>
`;
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/demo.svg', svg);
console.log(`docs/demo.svg: ${script.length} lines, ${total.toFixed(1)}s loop, ${(svg.length / 1024).toFixed(1)} KB`);
