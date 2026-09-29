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
CREATE TABLE IF NOT EXISTS pages (
  link_id     INTEGER PRIMARY KEY REFERENCES links(id),
  fetched_at  TEXT NOT NULL,
  title       TEXT,
  description TEXT,
  excerpt     TEXT,
  error       TEXT
);
CREATE TABLE IF NOT EXISTS pins  (url  TEXT PRIMARY KEY, added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mutes (term TEXT PRIMARY KEY, added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

/** Memoize `fn()` (sync or async, JSON-serialisable result) under `key` for `ttl` seconds. */
export async function cached(db, key, ttl, fn) {
  const hit = db.prepare('SELECT value FROM cache WHERE key = ? AND expires_at > ?').get(key, now());
  if (hit) return JSON.parse(hit.value);
  const value = await fn();
  const expires = new Date(Date.now() + ttl * 1000).toISOString();
  db.prepare('INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at')
    .run(key, JSON.stringify(value ?? null), expires);
  return value;
}

export function openDb(file = DB_FILE) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // migrations: columns added after the first release
  const cols = new Set(db.prepare('PRAGMA table_info(links)').all().map((c) => c.name));
  if (!cols.has('dismissed_at')) db.exec('ALTER TABLE links ADD COLUMN dismissed_at TEXT');
  return db;
}

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
