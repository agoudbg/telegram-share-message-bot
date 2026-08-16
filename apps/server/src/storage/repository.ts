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
  /** InputDocument TL JSON (only for hosted = false) */
  reference: string | null;
  width: number | null;
  height: number | null;
  thumbPath: string | null;
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
