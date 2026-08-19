// Repository layer over the SQLite schema. All access from the bot and the
// (Phase 3) HTTP API goes through these functions. See docs/PLAN.md §3.

import type { StorageDatabase } from './database.js';

export type ShareStatus = 'pending' | 'public' | 'revoked';

export interface ShareRow {
  id: string;
  ownerUserId: string;
  status: ShareStatus;
  createdAt: number;
  finalizedAt: number | null;
}

export interface MessageRow {
  shareId: string;
  seq: number;
  tlJson: string;
  nestedForward: boolean;
}

export interface MediaRow {
  key: string;
  mime: string | null;
  size: number | null;
  path: string | null;
  hosted: boolean;
  /** InputDocumentRef JSON ({id, accessHash, fileReference}); null when the
   *  file is unhosted but cannot be re-sent (no reference from Telegram) */
  reference: string | null;
  width: number | null;
  height: number | null;
  thumbPath: string | null;
}

export type MediaSourceKind = 'document' | 'photo' | 'avatar';
export type MediaCacheVariant = 'full' | 'thumb' | 'avatar';

export interface MediaSourceRow {
  mediaKey: string;
  kind: MediaSourceKind;
  sourcePeerId: string;
  sourceMessageId: number;
  reference: string | null;
  createdAt: number;
}

export interface MediaCacheRow {
  mediaKey: string;
  variant: MediaCacheVariant;
  path: string;
  size: number;
  cachedAt: number;
  lastAccessedAt: number;
}

export type PeerKind = 'user' | 'chat' | 'channel';

export interface PeerRow {
  shareId: string;
  peerId: string;
  kind: PeerKind;
  displayName: string | null;
  username: string | null;
  avatarKey: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ShareDbRow {
  id: string;
  owner_user_id: string;
  status: ShareStatus;
  created_at: number;
  finalized_at: number | null;
}

function toShare(row: ShareDbRow): ShareRow {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    createdAt: row.created_at,
    finalizedAt: row.finalized_at,
  };
}

export function createShare(
  db: StorageDatabase,
  share: { id: string; ownerUserId: string; createdAt?: number },
): void {
  db.prepare(
    `INSERT INTO shares (id, owner_user_id, status, created_at)
     VALUES (?, ?, 'pending', ?)`,
  ).run(share.id, share.ownerUserId, share.createdAt ?? Math.floor(Date.now() / 1000));
}

export function getShare(db: StorageDatabase, id: string): ShareRow | null {
  const row = db.prepare(`SELECT * FROM shares WHERE id = ?`).get(id) as ShareDbRow | undefined;
  return row === undefined ? null : toShare(row);
}

/** pending → public. Returns false when the share does not exist. */
export function finalizeShare(db: StorageDatabase, id: string, finalizedAt?: number): boolean {
  const result = db
    .prepare(
      `UPDATE shares SET status = 'public', finalized_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(finalizedAt ?? Math.floor(Date.now() / 1000), id);
  return result.changes > 0;
}

/** Any status → revoked, owner-checked. Returns false when the share does not
 *  exist or belongs to someone else. */
export function revokeShare(db: StorageDatabase, id: string, ownerUserId: string): boolean {
  const result = db
    .prepare(`UPDATE shares SET status = 'revoked' WHERE id = ? AND owner_user_id = ?`)
    .run(id, ownerUserId);
  return result.changes > 0;
}

/** Hard-delete a share (cascades to messages/peers). Used by /cancel to drop
 *  an in-progress batch. Returns false when the share does not exist or
 *  belongs to someone else. */
export function deleteShare(db: StorageDatabase, id: string, ownerUserId: string): boolean {
  const result = db
    .prepare(`DELETE FROM shares WHERE id = ? AND owner_user_id = ?`)
    .run(id, ownerUserId);
  return result.changes > 0;
}

/** Hard-delete pending shares created more than `olderThanSeconds` ago —
 *  orphans left behind by a crash or a failed finalization (docs/PLAN.md
 *  §2.3). Returns the number of deleted shares. */
export function deleteStalePendingShares(
  db: StorageDatabase,
  olderThanSeconds: number,
  now?: number,
): number {
  const cutoff = (now ?? Math.floor(Date.now() / 1000)) - olderThanSeconds;
  const result = db
    .prepare(`DELETE FROM shares WHERE status = 'pending' AND created_at < ?`)
    .run(cutoff);
  return result.changes;
}

export function insertMessage(
  db: StorageDatabase,
  message: { shareId: string; seq: number; tlJson: string; nestedForward?: boolean },
): void {
  db.prepare(
    `INSERT INTO messages (share_id, seq, tl_json, nested_forward)
     VALUES (?, ?, ?, ?)`,
  ).run(message.shareId, message.seq, message.tlJson, message.nestedForward ? 1 : 0);
}

export function getMessage(db: StorageDatabase, shareId: string, seq: number): MessageRow | null {
  const row = db
    .prepare(`SELECT * FROM messages WHERE share_id = ? AND seq = ?`)
    .get(shareId, seq) as any;
  return row === undefined ? null : toMessage(row);
}

export function listMessages(db: StorageDatabase, shareId: string): MessageRow[] {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE share_id = ? ORDER BY seq ASC`)
    .all(shareId) as any[];
  return rows.map(toMessage);
}

function toMessage(row: any): MessageRow {
  return {
    shareId: row.share_id,
    seq: row.seq,
    tlJson: row.tl_json,
    nestedForward: row.nested_forward === 1,
  };
}

/** Rewrite the seqs of a share's messages to 0..n-1 following the given
 *  order of the *current* seqs. Rows are inserted in arrival order, but
 *  albums are re-sorted by message id at finalize (docs/PLAN.md §2.4) —
 *  this persists that final presentation order so `ORDER BY seq` serves it.
 *  Runs in one transaction; seqs are shifted out of the way first to avoid
 *  primary-key collisions. */
export function rewriteMessageSeqs(
  db: StorageDatabase,
  shareId: string,
  oldSeqsInNewOrder: number[],
): void {
  const SHIFT = 1_000_000_000;
  db.transaction(() => {
    db.prepare(`UPDATE messages SET seq = seq + ? WHERE share_id = ?`).run(SHIFT, shareId);
    const stmt = db.prepare(`UPDATE messages SET seq = ? WHERE share_id = ? AND seq = ?`);
    oldSeqsInNewOrder.forEach((oldSeq, newSeq) => {
      stmt.run(newSeq, shareId, oldSeq + SHIFT);
    });
  })();
}

/** Insert only when the key is new (dedup): returns true when inserted. */
export function insertMediaIfAbsent(
  db: StorageDatabase,
  media: Partial<MediaRow> & { key: string },
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO media
         (key, mime, size, path, hosted, reference, width, height, thumb_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      media.key,
      media.mime ?? null,
      media.size ?? null,
      media.path ?? null,
      media.hosted === false ? 0 : 1,
      media.reference ?? null,
      media.width ?? null,
      media.height ?? null,
      media.thumbPath ?? null,
    );
  return result.changes > 0;
}

export function getMedia(db: StorageDatabase, key: string): MediaRow | null {
  const row = db.prepare(`SELECT * FROM media WHERE key = ?`).get(key) as any;
  return row === undefined ? null : toMediaRow(row);
}

/** Record another message capable of refreshing a Telegram media reference. */
export function upsertMediaSource(
  db: StorageDatabase,
  source: Omit<MediaSourceRow, 'createdAt'> & { createdAt?: number },
): void {
  db.prepare(
    `INSERT INTO media_sources
       (media_key, kind, source_peer_id, source_message_id, reference, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (media_key, kind, source_peer_id, source_message_id) DO UPDATE SET
       reference = COALESCE(excluded.reference, media_sources.reference),
       created_at = excluded.created_at`,
  ).run(
    source.mediaKey,
    source.kind,
    source.sourcePeerId,
    source.sourceMessageId,
    source.reference,
    source.createdAt ?? Math.floor(Date.now() / 1000),
  );
}

/** Newest sources are tried first; older duplicates provide deletion fallback. */
export function listMediaSources(db: StorageDatabase, mediaKey: string): MediaSourceRow[] {
  const rows = db
    .prepare(`SELECT * FROM media_sources WHERE media_key = ? ORDER BY created_at DESC`)
    .all(mediaKey) as any[];
  return rows.map((row) => ({
    mediaKey: row.media_key,
    kind: row.kind,
    sourcePeerId: row.source_peer_id,
    sourceMessageId: row.source_message_id,
    reference: row.reference,
    createdAt: row.created_at,
  }));
}

export function upsertMediaCache(db: StorageDatabase, cache: MediaCacheRow): void {
  db.prepare(
    `INSERT INTO media_cache
       (media_key, variant, path, size, cached_at, last_accessed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (media_key, variant) DO UPDATE SET
       path = excluded.path,
       size = excluded.size,
       cached_at = excluded.cached_at,
       last_accessed_at = excluded.last_accessed_at`,
  ).run(
    cache.mediaKey,
    cache.variant,
    cache.path,
    cache.size,
    cache.cachedAt,
    cache.lastAccessedAt,
  );
}

export function getMediaCache(
  db: StorageDatabase,
  mediaKey: string,
  variant: MediaCacheVariant,
): MediaCacheRow | null {
  const row = db
    .prepare(`SELECT * FROM media_cache WHERE media_key = ? AND variant = ?`)
    .get(mediaKey, variant) as any;
  return row === undefined ? null : toMediaCacheRow(row);
}

export function listMediaCache(db: StorageDatabase): MediaCacheRow[] {
  return (db.prepare(`SELECT * FROM media_cache ORDER BY last_accessed_at ASC`).all() as any[]).map(
    toMediaCacheRow,
  );
}

export function touchMediaCache(
  db: StorageDatabase,
  mediaKey: string,
  variant: MediaCacheVariant,
  lastAccessedAt = Math.floor(Date.now() / 1000),
): void {
  db.prepare(
    `UPDATE media_cache SET last_accessed_at = ? WHERE media_key = ? AND variant = ?`,
  ).run(lastAccessedAt, mediaKey, variant);
}

export function deleteMediaCache(
  db: StorageDatabase,
  mediaKey: string,
  variant: MediaCacheVariant,
): void {
  db.prepare(`DELETE FROM media_cache WHERE media_key = ? AND variant = ?`).run(
    mediaKey,
    variant,
  );
}

function toMediaCacheRow(row: any): MediaCacheRow {
  return {
    mediaKey: row.media_key,
    variant: row.variant,
    path: row.path,
    size: row.size,
    cachedAt: row.cached_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

/** Record that a share references a media row (idempotent). Media rows are
 *  global and deduped by key; the link table is what lets the API enumerate
 *  one share's media. */
export function linkMediaToShare(db: StorageDatabase, shareId: string, mediaKey: string): void {
  db.prepare(`INSERT OR IGNORE INTO share_media (share_id, media_key) VALUES (?, ?)`).run(
    shareId,
    mediaKey,
  );
}

/** All media rows referenced by a share (insertion order). */
export function listShareMedia(db: StorageDatabase, shareId: string): MediaRow[] {
  const rows = db
    .prepare(
      `SELECT m.* FROM media m
       JOIN share_media sm ON sm.media_key = m.key
       WHERE sm.share_id = ?`,
    )
    .all(shareId) as any[];
  return rows.map(toMediaRow);
}

function toMediaRow(row: any): MediaRow {
  return {
    key: row.key,
    mime: row.mime,
    size: row.size,
    path: row.path,
    hosted: row.hosted === 1,
    reference: row.reference,
    width: row.width,
    height: row.height,
    thumbPath: row.thumb_path,
  };
}

export function upsertPeer(
  db: StorageDatabase,
  peer: { shareId: string; peerId: string; kind: PeerKind } & Partial<PeerRow>,
): void {
  db.prepare(
    `INSERT INTO peers (share_id, peer_id, kind, display_name, username, avatar_key)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (share_id, peer_id) DO UPDATE SET
       display_name = COALESCE(excluded.display_name, peers.display_name),
       username = COALESCE(excluded.username, peers.username),
       avatar_key = COALESCE(excluded.avatar_key, peers.avatar_key)`,
  ).run(
    peer.shareId,
    peer.peerId,
    peer.kind,
    peer.displayName ?? null,
    peer.username ?? null,
    peer.avatarKey ?? null,
  );
}

export function listPeers(db: StorageDatabase, shareId: string): PeerRow[] {
  const rows = db.prepare(`SELECT * FROM peers WHERE share_id = ?`).all(shareId) as any[];
  return rows.map((row) => ({
    shareId: row.share_id,
    peerId: row.peer_id,
    kind: row.kind,
    displayName: row.display_name,
    username: row.username,
    avatarKey: row.avatar_key,
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */
