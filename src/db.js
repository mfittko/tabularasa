import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DIR = process.env.TAB_ARCHIVE_DIR ?? path.join(os.homedir(), '.tab-archive');
export const DB_FILE = path.join(DIR, 'tabs.db');

// links: one row per URL. tabs: one row per tab per run (the inventory). runs: one row per run.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY,
  url        TEXT NOT NULL UNIQUE,
  title      TEXT,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  times_seen INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY,
  ran_at     TEXT NOT NULL,
  tabs_found INTEGER,
  new_links  INTEGER,
  closed     INTEGER
);
CREATE TABLE IF NOT EXISTS tabs (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  link_id      INTEGER NOT NULL REFERENCES links(id),
  window_id    INTEGER,
  window_index INTEGER,
  tab_index    INTEGER,
  is_current   INTEGER,
  title        TEXT,
  source       TEXT
);
CREATE INDEX IF NOT EXISTS tabs_run ON tabs(run_id);
CREATE INDEX IF NOT EXISTS tabs_link ON tabs(link_id);
`;

export function openDb(file = DB_FILE) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
