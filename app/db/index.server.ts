import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

const dbPath = resolve(process.cwd(), "data", "app.db");
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New chat',
    model TEXT NOT NULL,
    thinking_level TEXT NOT NULL DEFAULT 'off',
    session_file TEXT,
    tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS chats_updated_at_idx ON chats(updated_at DESC);
`);

const existing = new Set(
  (sqlite.prepare("PRAGMA table_info(chats)").all() as { name: string }[]).map(
    (r) => r.name,
  ),
);
const additions: [string, string][] = [
  ["tokens_input", "INTEGER NOT NULL DEFAULT 0"],
  ["tokens_output", "INTEGER NOT NULL DEFAULT 0"],
  ["cache_read", "INTEGER NOT NULL DEFAULT 0"],
  ["cache_write", "INTEGER NOT NULL DEFAULT 0"],
  ["cost_usd", "REAL NOT NULL DEFAULT 0"],
];
for (const [name, def] of additions) {
  if (!existing.has(name)) {
    sqlite.exec(`ALTER TABLE chats ADD COLUMN ${name} ${def}`);
  }
}

if (existing.has("workspace")) {
  try {
    sqlite.exec("ALTER TABLE chats DROP COLUMN workspace");
  } catch {
    // older sqlite without DROP COLUMN; leave it as a dead column
  }
}

if (existing.has("session_file")) {
  const rows = sqlite
    .prepare(
      "SELECT id, session_file FROM chats WHERE session_file IS NOT NULL AND instr(session_file, '/') > 0",
    )
    .all() as { id: string; session_file: string }[];
  if (rows.length > 0) {
    const update = sqlite.prepare(
      "UPDATE chats SET session_file = ? WHERE id = ?",
    );
    for (const r of rows) {
      const base = r.session_file.split("/").pop() ?? r.session_file;
      update.run(base, r.id);
    }
  }
}

export const db = drizzle(sqlite, { schema });
export { schema };
