// Hono app factory: the public HTTP API (docs/PLAN.md, Phase 3).
//
// Everything served here is a sanitized copy — raw TL JSON, real ids,
// accessHash/fileReference/dcId never leave the server (§2.6). Access gate:
// unknown or still-pending shares are indistinguishable (404), revoked
// shares answer 410 Gone.

import { Hono } from 'hono';

import type { TLJsonValue } from '@tbfb/tlbridge';

import type { StorageDatabase } from '../storage/database.js';
import { getShare, listMessages, listPeers, listShareMedia } from '../storage/repository.js';
import type { PeerKind, ShareRow } from '../storage/repository.js';
import { createShareSanitizer, sanitizeMediaKey } from './sanitize.js';

export interface ShareResponse {
  share: {
    id: string;
    createdAt: number;
    finalizedAt: number | null;
  };
  messages: Array<{
    seq: number;
    nestedForward: boolean;
    /** Sanitized TL JSON, ready for the tlbridge hydrator */
    message: TLJsonValue;
  }>;
  peers: Array<{
    /** Share-scoped fake id (matches sanitized Peer* ids in messages) */
    id: string;
    kind: PeerKind;
    displayName: string | null;
    username: string | null;
    /** `/media/:shareId/avatar_<fakePeerId>`; null → frontend letter fallback */
    avatarUrl: string | null;
  }>;
  /** Keyed by fake media key — the sanitized `id` of the Photo/Document in
   *  the message TL JSON. Avatar files are not listed here (they are served
   *  through peers[].avatarUrl). */
  media: Record<string, ShareMediaEntry>;
}

export interface ShareMediaEntry {
  mime: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  hosted: boolean;
  /** An unhosted file can be re-sent by the bot via its InputDocument
   *  reference (the `get_<shareId>_<seq>` deep link, §2.5) */
  retrievable: boolean;
  /** `/media/:shareId/:fakeKey`; null unless the file is hosted on disk */
  url: string | null;
  /** Thumbnail URL (`?thumb=1`); null when no thumbnail was extracted */
  thumbUrl: string | null;
}

export interface ServerAppDeps {
  db: StorageDatabase;
  sanitizeSecret: string;
}

/** Access gate shared by every share-scoped route: pending shares must not
 *  be distinguishable from unknown ones. */
export function checkShareAccess(
  db: StorageDatabase,
  shareId: string,
): ShareRow | 'not_found' | 'revoked' {
  const share = getShare(db, shareId);
  if (share === null || share.status === 'pending') return 'not_found';
  if (share.status === 'revoked') return 'revoked';
  return share;
}

function mediaUrl(shareId: string, fakeKey: string): string {
  return `/media/${shareId}/${fakeKey}`;
}

export function createServerApp(deps: ServerAppDeps): Hono {
  const app = new Hono();

  app.get('/api/shares/:id', (c) => {
    const shareId = c.req.param('id');
    const access = checkShareAccess(deps.db, shareId);
    if (access === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (access === 'revoked') return c.json({ error: 'revoked' }, 410);
    const share = access;

    const sanitizer = createShareSanitizer(deps.sanitizeSecret, shareId);

    const messages = listMessages(deps.db, shareId).map((row) => ({
      seq: row.seq,
      nestedForward: row.nestedForward,
      message: sanitizer.sanitize(JSON.parse(row.tlJson) as TLJsonValue),
    }));

    const peers = listPeers(deps.db, shareId).map((peer) => ({
      id: sanitizer.fakeId(peer.peerId),
      kind: peer.kind,
      displayName: peer.displayName,
      username: peer.username,
      avatarUrl:
        peer.avatarKey === null
          ? null
          : mediaUrl(shareId, sanitizeMediaKey(sanitizer, peer.avatarKey)),
    }));

    const media: Record<string, ShareMediaEntry> = {};
    for (const row of listShareMedia(deps.db, shareId)) {
      if (row.key.startsWith('avatar_')) continue; // served via peers[].avatarUrl
      const fakeKey = sanitizeMediaKey(sanitizer, row.key);
      const servable = row.hosted && row.path !== null;
      media[fakeKey] = {
        mime: row.mime,
        size: row.size,
        width: row.width,
        height: row.height,
        hosted: row.hosted,
        retrievable: row.reference !== null,
        url: servable ? mediaUrl(shareId, fakeKey) : null,
        thumbUrl:
          servable && row.thumbPath !== null ? `${mediaUrl(shareId, fakeKey)}?thumb=1` : null,
      };
    }

    const response: ShareResponse = {
      share: { id: share.id, createdAt: share.createdAt, finalizedAt: share.finalizedAt },
      messages,
      peers,
      media,
    };
    return c.json(response);
  });

  return app;
}
