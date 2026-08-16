// Per-share sanitizer wiring for the HTTP API (docs/PLAN.md §2.6).
//
// The shareSecret combines the server-side SANITIZE_SECRET with the share id,
// so fake ids cannot be recomputed offline from a leaked share id. The API
// output never contains real peer/document/photo ids: message TL JSON is
// sanitized, and media keys (real document/photo ids) are exposed only
// through their share-scoped fake counterparts.

import { createSanitizer, hmacSha256 } from '@tbfb/tlbridge';
import type { TLSanitizer } from '@tbfb/tlbridge';

import type { StorageDatabase } from '../storage/database.js';
import { listShareMedia } from '../storage/repository.js';
import type { MediaRow } from '../storage/repository.js';

const FAKE_ID_BASE = 1n << 62n;
const FAKE_ID_SPAN = 1n << 62n;

/** Same fake-id scheme as tlbridge's default hashFn: HMAC-SHA256 reduced to
 *  a non-negative int64 in [2^62, 2^63). */
function hmacFakeId(keyMaterial: string, message: string): string {
  const encoder = new TextEncoder();
  const digest = hmacSha256(encoder.encode(keyMaterial), encoder.encode(message));
  const value = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getBigUint64(0);
  return (FAKE_ID_BASE + (value % FAKE_ID_SPAN)).toString();
}

/** Fresh sanitizer for one share (never reused across shares, §2.6). */
export function createShareSanitizer(sanitizeSecret: string, shareId: string): TLSanitizer {
  const shareSecret = `${sanitizeSecret}:${shareId}`;
  return createSanitizer({
    shareSecret,
    virtualChatPeerId: hmacFakeId(shareSecret, 'virtual-chat'),
  });
}

/** Public (fake) form of a media key. Document/photo keys are the real
 *  entity id and map through fakeId — matching the sanitized `id` the
 *  frontend sees on Photo/Document objects. Avatar keys embed the real peer
 *  id, so only the embedded id is remapped. */
export function sanitizeMediaKey(sanitizer: TLSanitizer, key: string): string {
  const AVATAR_PREFIX = 'avatar_';
  return key.startsWith(AVATAR_PREFIX)
    ? `${AVATAR_PREFIX}${sanitizer.fakeId(key.slice(AVATAR_PREFIX.length))}`
    : sanitizer.fakeId(key);
}

/** Resolve a fake media key back to the share's media row by recomputing the
 *  fake key of every media row linked to the share (a share references tens
 *  of media rows at most). Returns null when no row matches. */
export function resolveMediaKey(
  db: StorageDatabase,
  sanitizer: TLSanitizer,
  shareId: string,
  fakeKey: string,
): MediaRow | null {
  for (const media of listShareMedia(db, shareId)) {
    if (sanitizeMediaKey(sanitizer, media.key) === fakeKey) return media;
  }
  return null;
}
