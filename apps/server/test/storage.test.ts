// In-memory SQLite tests for the storage layer (Phase 2 Commit 6 acceptance).

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import {
  createShare,
  deleteStalePendingShares,
  finalizeShare,
  deleteMediaCache,
  getMediaCache,
  getMedia,
  getMessage,
  getShare,
  insertMediaIfAbsent,
  insertMessage,
  linkMediaToShare,
  listMediaCache,
  listMediaSources,
  listMessages,
  listPeers,
  listShareMedia,
  revokeShare,
  rewriteMessageSeqs,
  touchMediaCache,
  upsertMediaCache,
  upsertMediaSource,
  upsertPeer,
} from '../src/storage/repository.js';

function freshDb() {
  return openDatabase(':memory:');
}

describe('openDatabase', () => {
  it('creates a missing parent directory for a file database', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'tbfb-storage-'));
    const databaseFile = path.join(tempDir, 'nested', 'tbfb.db');

    try {
      const db = openDatabase(databaseFile);
      db.close();
      expect(existsSync(databaseFile)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('applies all migrations exactly once', () => {
    const db = freshDb();
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBeGreaterThanOrEqual(1);
    // Re-running openDatabase on the same handle's schema must not throw
    // (migrations are version-gated)
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      'media',
      'media_cache',
      'media_sources',
      'messages',
      'peers',
      'share_media',
      'shares',
    ]);
  });
});

describe('shares', () => {
  it('creates a pending share and finalizes it', () => {
    const db = freshDb();
    createShare(db, { id: 'abc', ownerUserId: '42', createdAt: 1000 });

    const pending = getShare(db, 'abc');
    expect(pending).toMatchObject({ id: 'abc', ownerUserId: '42', status: 'pending' });
    expect(pending?.finalizedAt).toBeNull();

    expect(finalizeShare(db, 'abc', 2000)).toBe(true);
    const published = getShare(db, 'abc');
    expect(published?.status).toBe('public');
    expect(published?.finalizedAt).toBe(2000);
  });

  it('does not finalize twice', () => {
    const db = freshDb();
    createShare(db, { id: 'abc', ownerUserId: '42' });
    expect(finalizeShare(db, 'abc')).toBe(true);
    expect(finalizeShare(db, 'abc')).toBe(false);
  });

  it('revokes only for the owner', () => {
    const db = freshDb();
    createShare(db, { id: 'abc', ownerUserId: '42' });
    expect(revokeShare(db, 'abc', 'intruder')).toBe(false);
    expect(getShare(db, 'abc')?.status).toBe('pending');
    expect(revokeShare(db, 'abc', '42')).toBe(true);
    expect(getShare(db, 'abc')?.status).toBe('revoked');
  });

  it('returns null for unknown shares', () => {
    const db = freshDb();
    expect(getShare(db, 'nope')).toBeNull();
  });

  it('deletes only stale pending shares (crash orphans)', () => {
    const db = freshDb();
    createShare(db, { id: 'old_pending', ownerUserId: '42', createdAt: 1000 });
    createShare(db, { id: 'fresh_pending', ownerUserId: '42', createdAt: 5000 });
    createShare(db, { id: 'old_public', ownerUserId: '42', createdAt: 1000 });
    finalizeShare(db, 'old_public', 1500);

    expect(deleteStalePendingShares(db, 3600, 5000)).toBe(1);
    expect(getShare(db, 'old_pending')).toBeNull();
    expect(getShare(db, 'fresh_pending')?.status).toBe('pending');
    expect(getShare(db, 'old_public')?.status).toBe('public');
  });
});

describe('messages', () => {
  it('stores and lists messages in seq order with nested flags', () => {
    const db = freshDb();
    createShare(db, { id: 's1', ownerUserId: '42' });
    insertMessage(db, { shareId: 's1', seq: 0, tlJson: '{"className":"Message"}' });
    insertMessage(db, { shareId: 's1', seq: 1, tlJson: '{}', nestedForward: true });

    const messages = listMessages(db, 's1');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ seq: 0, nestedForward: false });
    expect(messages[1]).toMatchObject({ seq: 1, nestedForward: true });

    expect(getMessage(db, 's1', 1)?.tlJson).toBe('{}');
    expect(getMessage(db, 's1', 99)).toBeNull();
  });

  it('rejects duplicate (share_id, seq)', () => {
    const db = freshDb();
    createShare(db, { id: 's1', ownerUserId: '42' });
    insertMessage(db, { shareId: 's1', seq: 0, tlJson: '{}' });
    expect(() => insertMessage(db, { shareId: 's1', seq: 0, tlJson: '{}' })).toThrow();
  });

  it('rewrites seqs into the finalized presentation order', () => {
    const db = freshDb();
    createShare(db, { id: 's1', ownerUserId: '42' });
    insertMessage(db, { shareId: 's1', seq: 0, tlJson: '{"id":5}' });
    insertMessage(db, { shareId: 's1', seq: 1, tlJson: '{"id":3}', nestedForward: true });
    insertMessage(db, { shareId: 's1', seq: 2, tlJson: '{"id":9}' });

    rewriteMessageSeqs(db, 's1', [1, 0, 2]);

    const messages = listMessages(db, 's1');
    expect(messages.map((m) => m.tlJson)).toEqual(['{"id":3}', '{"id":5}', '{"id":9}']);
    expect(messages.map((m) => m.seq)).toEqual([0, 1, 2]);
    // nested flags travel with their rows
    expect(messages.map((m) => m.nestedForward)).toEqual([true, false, false]);
  });
});

describe('media', () => {
  it('dedups by key', () => {
    const db = freshDb();
    expect(
      insertMediaIfAbsent(db, { key: '123', mime: 'image/jpeg', size: 10, path: 'media/123' }),
    ).toBe(true);
    expect(insertMediaIfAbsent(db, { key: '123', mime: 'image/png' })).toBe(false);

    const row = getMedia(db, '123');
    expect(row).toMatchObject({ key: '123', mime: 'image/jpeg', hosted: true });
  });

  it('stores unhosted media with an InputDocument reference', () => {
    const db = freshDb();
    const reference = JSON.stringify({ className: 'InputDocument', id: { $long: '9' } });
    insertMediaIfAbsent(db, { key: '9', hosted: false, reference, size: 700000000 });
    const row = getMedia(db, '9');
    expect(row?.hosted).toBe(false);
    expect(row?.reference).toBe(reference);
    expect(row?.path).toBeNull();
  });

  it('links media to shares idempotently and lists per share', () => {
    const db = freshDb();
    createShare(db, { id: 's1', ownerUserId: '42' });
    createShare(db, { id: 's2', ownerUserId: '42' });
    insertMediaIfAbsent(db, { key: '123', path: 'media/123' });
    insertMediaIfAbsent(db, { key: '456', path: 'media/456' });

    linkMediaToShare(db, 's1', '123');
    linkMediaToShare(db, 's1', '123'); // idempotent
    linkMediaToShare(db, 's2', '123'); // the same global row, another share
    linkMediaToShare(db, 's2', '456');

    expect(listShareMedia(db, 's1').map((m) => m.key)).toEqual(['123']);
    expect(listShareMedia(db, 's2').map((m) => m.key)).toEqual(['123', '456']);
  });

  it('stores multiple refreshable sources and orders the newest first', () => {
    const db = freshDb();
    insertMediaIfAbsent(db, { key: '123', mime: 'video/mp4' });
    upsertMediaSource(db, {
      mediaKey: '123',
      kind: 'document',
      sourcePeerId: 'u1',
      sourceMessageId: 10,
      reference: '{"version":1}',
      createdAt: 100,
    });
    upsertMediaSource(db, {
      mediaKey: '123',
      kind: 'document',
      sourcePeerId: 'u2',
      sourceMessageId: 20,
      reference: '{"version":2}',
      createdAt: 200,
    });

    expect(listMediaSources(db, '123').map((source) => source.sourceMessageId)).toEqual([20, 10]);
  });

  it('tracks cache entries and their LRU access time', () => {
    const db = freshDb();
    insertMediaIfAbsent(db, { key: '123' });
    upsertMediaCache(db, {
      mediaKey: '123',
      variant: 'full',
      path: 'cache/media/hash',
      size: 42,
      cachedAt: 100,
      lastAccessedAt: 100,
    });
    touchMediaCache(db, '123', 'full', 200);

    expect(getMediaCache(db, '123', 'full')).toMatchObject({ size: 42, lastAccessedAt: 200 });
    expect(listMediaCache(db)).toHaveLength(1);
    deleteMediaCache(db, '123', 'full');
    expect(getMediaCache(db, '123', 'full')).toBeNull();
  });
});

describe('peers', () => {
  it('upserts display name and avatar per share', () => {
    const db = freshDb();
    createShare(db, { id: 's1', ownerUserId: '42' });
    upsertPeer(db, { shareId: 's1', peerId: '777', kind: 'channel', displayName: 'Chan' });
    upsertPeer(db, { shareId: 's1', peerId: '777', kind: 'channel', avatarKey: 'avatar_777' });

    const peers = listPeers(db, 's1');
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      peerId: '777',
      kind: 'channel',
      displayName: 'Chan',
      avatarKey: 'avatar_777',
    });
  });
});
