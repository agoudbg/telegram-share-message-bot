// Hono app factory: the public HTTP API (docs/PLAN.md, Phase 3).
//
// Everything served here is a sanitized copy — raw TL JSON, real ids,
// accessHash/fileReference/dcId never leave the server (§2.6). Access gate:
// unknown or still-pending shares are indistinguishable (404), revoked
// shares answer 410 Gone.

import { Hono } from 'hono';

import type { TLJsonValue } from '@tbfb/tlbridge';

import type { StorageDatabase } from '../storage/database.js';
import { listMediaSources, listMessages, listPeers, listShareMedia } from '../storage/repository.js';
import type { MediaCache } from '../mediaCache.js';
import type { PeerKind } from '../storage/repository.js';
import { checkShareAccess } from './gate.js';
import { registerMediaRoutes } from './media.js';
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
  /** Bot username (no @) for the unhosted-media deep link
   *  `https://t.me/<bot>?start=get_<shareId>_<seq>` (§2.5); null when the
   *  server is not configured with BOT_USERNAME */
  botUsername: string | null;
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
  /** Base directory holding media/ (media rows store paths relative to it) */
  dataDir: string;
  /** Bot username for unhosted-media deep links; omit to disable the button */
  botUsername?: string;
  mediaCache?: MediaCache;
}

function mediaUrl(shareId: string, fakeKey: string): string {
  return `/media/${shareId}/${fakeKey}`;
}

export function createServerApp(deps: ServerAppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

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
      const sources = listMediaSources(deps.db, row.key);
      const servable = row.hosted && (row.path !== null || sources.length > 0);
      const hasThumbnail =
        row.thumbPath !== null ||
        sources.some((source) => {
          if (source.reference === null) return false;
          try {
            return (JSON.parse(source.reference) as { hasThumbnail?: unknown }).hasThumbnail === true;
          } catch {
            return false;
          }
        });
      media[fakeKey] = {
        mime: row.mime,
        size: row.size,
        width: row.width,
        height: row.height,
        hosted: row.hosted,
        retrievable: row.reference !== null,
        url: servable ? mediaUrl(shareId, fakeKey) : null,
        thumbUrl:
          servable && hasThumbnail ? `${mediaUrl(shareId, fakeKey)}?thumb=1` : null,
      };
    }

    const response: ShareResponse = {
      share: { id: share.id, createdAt: share.createdAt, finalizedAt: share.finalizedAt },
      messages,
      peers,
      media,
      botUsername: deps.botUsername ?? null,
    };
    return c.json(response);
  });

  registerMediaRoutes(app, deps);

  return app;
}
