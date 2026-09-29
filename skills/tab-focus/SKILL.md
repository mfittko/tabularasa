---
name: tab-focus
description: Close all Safari tabs into the archive and/or reopen archived tabs relevant to current work or a given topic in a new Safari window. Use when asked to reopen work tabs, restore tabs, "close everything and open only what's relevant today", "open recent history items on topic X in a new window", or to prune the tab archive.
---

`tabularasa` (on PATH) keeps every Safari tab in `~/.tab-archive/tabs.db` and reopens the relevant
ones, judged by Jev against the calendar (`gws`), GitHub (`gh`), a topic, and a context file.

Steps:

1. Extra context, best effort, only from tools available in this session. Write one line per item
   to `~/.tab-archive/context.txt` (overwrite). Skip a source silently if its tool is missing or errors.
   - Slack: `slack_search_public_and_private` with filters `from:<@me> after:<2 days ago>` and
     `to:<@me> after:<2 days ago>`, concise, `include_context` false, limit 20 each. One line per
     message: text (first 300 chars) and permalink.
   - Artifacts: `Artifact` action `list`, limit 10. One line per artifact: title and description.
   - A topic given by the user goes to `--topic`, not into the file.
2. If the user asked to close tabs first: `tabularasa close`. Never close without it having logged
   `found=N` with N > 0.
3. `tabularasa focus [flags]` (the context file is picked up automatically):
   - a topic ("on topic X", "about X"): `--topic "X" --days 90`
   - "today" / "current work": no topic, default `--days 7`
   - the user wants them opened: `--open` (new Safari window). "What would you reopen" is a dry run.
   - more or fewer: `--limit N`; stricter: `--threshold 0.75`
4. Pruning requests ("drop closed github issues and PRs", "forget everything about X"): query first
   with `tabularasa search TERM` or `sqlite3 -column ~/.tab-archive/tabs.db "SELECT id, title, url FROM links WHERE ..."`.
   Decide per row; for GitHub state use `gh pr view URL --json state -q .state` /
   `gh issue view URL --json state -q .state` (CLOSED or MERGED = closed). Delete with
   `tabularasa forget TERM` for a simple term, or
   `sqlite3 ~/.tab-archive/tabs.db "DELETE FROM tabs WHERE link_id IN (...); DELETE FROM links WHERE id IN (...);"`.
   Report how many rows were deleted and list their titles.
5. Print the script output verbatim: one line per tab with probability, reason and title.
   If it printed `no matching tabs`, say so and suggest `--threshold 0.4` or a broader topic.
