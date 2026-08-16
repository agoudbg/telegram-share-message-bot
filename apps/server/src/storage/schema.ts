// SQLite schema migrations (better-sqlite3, WAL). See docs/PLAN.md §3 and
// Phase 2 Commit 6.
//
// Migrations are applied in order; the current position is tracked with the
// built-in `user_version` pragma. Each entry must be idempotent-free: it runs
// exactly once inside a transaction.

export interface Migration {
  /** Monotonic version, starting at 1 (applied when user_version < version) */
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE shares (
        id TEXT PRIMARY KEY,              -- random unguessable share id
        owner_user_id TEXT NOT NULL,      -- Telegram user id of the creator
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'public', 'revoked')),
        created_at INTEGER NOT NULL,      -- unix seconds
        finalized_at INTEGER
      );

      CREATE TABLE messages (
        share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,             -- arrival order inside the batch
        tl_json TEXT NOT NULL,            -- raw serialized TL JSON (unsanitized)
        nested_forward INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (share_id, seq)
      );

      CREATE TABLE media (
        key TEXT PRIMARY KEY,             -- document/photo id, or avatar_<peerId>
        mime TEXT,
        size INTEGER,                     -- bytes
        path TEXT,                        -- file path relative to DATA_DIR
        hosted INTEGER NOT NULL DEFAULT 1,
        reference TEXT,                   -- InputDocumentRef JSON ({id, accessHash, fileReference}) when hosted = 0; null when the file cannot be re-sent
        width INTEGER,
        height INTEGER,
        thumb_path TEXT                   -- thumbnail relative to DATA_DIR
      );

      CREATE TABLE peers (
        share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
        peer_id TEXT NOT NULL,            -- real peer id; fake remap at serve time
        kind TEXT NOT NULL CHECK (kind IN ('user', 'chat', 'channel')),
        display_name TEXT,
        username TEXT,
        avatar_key TEXT,                  -- media.key of the avatar file
        PRIMARY KEY (share_id, peer_id)
      );
    `,
  },
];
