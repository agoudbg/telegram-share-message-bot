// Database open + migration runner. See docs/PLAN.md §3 (SQLite,
// better-sqlite3, WAL; the repository layer is isolated so Postgres can
// replace it later).

import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema.js';

export type StorageDatabase = Database.Database;

/** Open (or create) the database at `file` and apply pending migrations.
 *  Use ':memory:' for tests. */
export function openDatabase(file: string): StorageDatabase {
  const db = new Database(file);
  // WAL is silently ignored for in-memory databases (journal_mode stays
  // 'memory'), so tests can share this code path.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: StorageDatabase): void {
  const row = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.filter((m) => m.version > row).sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
