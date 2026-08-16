// Media and avatar download pipeline (docs/PLAN.md, Phase 2 Commit 8).
//
// - Media is downloaded chunked to <mediaDir>/<docOrPhotoId> with dedup
//   (the media table key is the document/photo id)
// - Files above the host limit are registered hosted:false with their
//   InputDocument reference (re-sent server-side on demand, §2.5)
// - Thumbnails, mime and dimensions are persisted alongside
// - Avatars: resolved via the host port; unresolvable origins (channels the
//   bot is not in) are skipped — the frontend falls back to letter avatars;
//   hidden users never reach this pipeline (they only have a name string)

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { StorageDatabase } from '@tbfb/server';
import { getMedia, insertMediaIfAbsent, upsertPeer } from '@tbfb/server';
import type { TLJsonObject, TLJsonValue } from '@tbfb/tlbridge';
import { isTLJsonLong } from '@tbfb/tlbridge';

import type { Batch } from './batching.js';
import type { BotPorts, InputDocumentRef } from './ports.js';

export interface MediaInfo {
  kind: 'photo' | 'document';
  /** Document/photo id as a decimal string; also the media table key */
  key: string;
  size?: number;
  mime?: string;
  width?: number;
  height?: number;
  /** Present for documents: everything needed for the hosted:false fallback */
  documentRef?: InputDocumentRef;
}

function asObject(value: TLJsonValue | undefined): TLJsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as TLJsonObject)
    : undefined;
}

function idToString(value: TLJsonValue | undefined): string | undefined {
  if (isTLJsonLong(value as TLJsonValue)) return (value as { $long: string }).$long;
  if (typeof value === 'number') return value.toString();
  return undefined;
}

function longToNumber(value: TLJsonValue | undefined): number | undefined {
  const asString = idToString(value);
  return asString === undefined ? undefined : Number(asString);
}

/** Extract download-relevant media info from a serialized TL JSON message. */
export function extractMediaInfo(tlJson: TLJsonObject): MediaInfo | null {
  const media = asObject(tlJson.media);
  if (media === undefined) return null;

  if (media.className === 'MessageMediaPhoto') {
    const photo = asObject(media.photo);
    if (photo?.className !== 'Photo') return null;
    const key = idToString(photo.id);
    return key === undefined ? null : { kind: 'photo', key, mime: 'image/jpeg' };
  }

  if (media.className === 'MessageMediaDocument') {
    const doc = asObject(media.document);
    if (doc?.className !== 'Document') return null;
    const key = idToString(doc.id);
    if (key === undefined) return null;

    const info: MediaInfo = {
      kind: 'document',
      key,
      size: longToNumber(doc.size),
      mime: typeof doc.mimeType === 'string' ? doc.mimeType : undefined,
    };

    const attributes = Array.isArray(doc.attributes) ? doc.attributes : [];
    for (const attribute of attributes) {
      const attr = asObject(attribute);
      if (
        (attr?.className === 'DocumentAttributeVideo' ||
          attr?.className === 'DocumentAttributeImageSize') &&
        typeof attr.w === 'number' &&
        typeof attr.h === 'number'
      ) {
        info.width = attr.w;
        info.height = attr.h;
        break;
      }
    }

    const accessHash = idToString(doc.accessHash);
    const fileReference = asObject(doc.fileReference);
    if (accessHash !== undefined && typeof fileReference?.$bytes === 'string') {
      info.documentRef = { id: key, accessHash, fileReference: fileReference.$bytes };
    }
    return info;
  }

  return null;
}

/** Extract the forward-origin peer (for avatar resolution) from a TL JSON
 *  message; null for non-forwards and hidden users (name-only origins). */
export function extractForwardPeer(
  tlJson: TLJsonObject,
): { peerId: string; kind: 'user' | 'chat' | 'channel' } | null {
  const fwd = asObject(tlJson.fwdFrom);
  const fromId = asObject(fwd?.fromId);
  if (fromId === undefined) return null;
  const pairs = [
    ['PeerUser', 'userId', 'user'],
    ['PeerChat', 'chatId', 'chat'],
    ['PeerChannel', 'channelId', 'channel'],
  ] as const;
  for (const [className, field, kind] of pairs) {
    if (fromId.className === className) {
      const peerId = idToString(fromId[field]);
      return peerId === undefined ? null : { peerId, kind };
    }
  }
  return null;
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  /** Injectable for tests */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry with FloodWait absorption (docs/PLAN.md §6 "Bot PM flood limits"):
 *  an error carrying a numeric `seconds` sleeps exactly that long; anything
 *  else backs off exponentially. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      const seconds = (error as { seconds?: unknown })?.seconds;
      const delayMs =
        typeof seconds === 'number' && seconds > 0
          ? Math.min(seconds, 60) * 1000
          : baseDelayMs * 2 ** attempt;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export interface MediaPipelineDeps {
  db: StorageDatabase;
  /** Absolute directory for media files (created on demand) */
  mediaDir: string;
  hostLimitBytes: number;
  host: Pick<BotPorts, 'downloadMedia' | 'downloadThumb' | 'resolvePeer' | 'downloadAvatar'>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface MediaProcessResult {
  hosted: number;
  unhosted: number;
  deduped: number;
  failed: number;
  avatars: number;
}

export class MediaPipeline {
  constructor(private readonly deps: MediaPipelineDeps) {}

  /** Download/register media for every batch item, then resolve origin
   *  avatars. Individual failures never abort the batch. */
  async processBatch(
    batch: Batch,
    onProgress?: (text: string) => void,
  ): Promise<MediaProcessResult> {
    await mkdir(this.deps.mediaDir, { recursive: true });
    const result: MediaProcessResult = {
      hosted: 0,
      unhosted: 0,
      deduped: 0,
      failed: 0,
      avatars: 0,
    };

    let index = 0;
    for (const item of batch.items) {
      index += 1;
      const info = extractMediaInfo(item.message.tlJson);
      if (info === null) continue;
      onProgress?.(`Media ${index}/${batch.items.length}…`);
      try {
        const outcome = await this.processOne(info, item.message.raw);
        result[outcome] += 1;
      } catch (error) {
        result.failed += 1;
        this.deps.log?.(`media download failed for key ${info.key}: ${String(error)}`);
      }
    }

    result.avatars = await this.processAvatars(batch);
    return result;
  }

  private async processOne(
    info: MediaInfo,
    raw: unknown,
  ): Promise<'hosted' | 'unhosted' | 'deduped'> {
    const { db, hostLimitBytes } = this.deps;

    // Oversized: register hosted:false + InputDocument reference, no
    // download. Without a reference the file cannot be re-sent — the row is
    // still registered (reference: null) so the fallback can say so
    // explicitly instead of misreporting the file as hosted.
    if (info.kind === 'document' && info.size !== undefined && info.size > hostLimitBytes) {
      insertMediaIfAbsent(db, {
        key: info.key,
        hosted: false,
        reference: info.documentRef === undefined ? null : JSON.stringify(info.documentRef),
        size: info.size,
        mime: info.mime ?? null,
        width: info.width ?? null,
        height: info.height ?? null,
      });
      return 'unhosted';
    }

    if (getMedia(db, info.key) !== null) return 'deduped';

    const relPath = path.join('media', info.key);
    const absPath = path.join(this.deps.mediaDir, info.key);
    await withRetry(() => this.deps.host.downloadMedia(raw, absPath), { sleep: this.deps.sleep });

    let thumbPath: string | null = null;
    try {
      const thumbRel = path.join('media', `${info.key}_thumb.jpg`);
      if (
        await this.deps.host.downloadThumb(
          raw,
          path.join(this.deps.mediaDir, `${info.key}_thumb.jpg`),
        )
      ) {
        thumbPath = thumbRel;
      }
    } catch (error) {
      this.deps.log?.(`thumbnail download failed for key ${info.key}: ${String(error)}`);
    }

    insertMediaIfAbsent(db, {
      key: info.key,
      hosted: true,
      path: relPath,
      mime: info.mime ?? null,
      size: info.size ?? null,
      width: info.width ?? null,
      height: info.height ?? null,
      thumbPath,
    });
    return 'hosted';
  }

  private async processAvatars(batch: Batch): Promise<number> {
    const seen = new Map<string, 'user' | 'chat' | 'channel'>();
    for (const item of batch.items) {
      const peer = extractForwardPeer(item.message.tlJson);
      if (peer !== null && !seen.has(peer.peerId)) seen.set(peer.peerId, peer.kind);
    }

    let count = 0;
    for (const [peerId, kind] of seen) {
      try {
        const resolved = await this.deps.host.resolvePeer(peerId);
        if (resolved === null) continue; // unresolvable → frontend letter fallback

        let avatarKey: string | null = null;
        const key = `avatar_${peerId}`;
        if (getMedia(this.deps.db, key) !== null) {
          avatarKey = key;
        } else {
          const absPath = path.join(this.deps.mediaDir, key);
          if (await this.deps.host.downloadAvatar(peerId, absPath)) {
            insertMediaIfAbsent(this.deps.db, {
              key,
              hosted: true,
              path: path.join('media', key),
              mime: 'image/jpeg',
            });
            avatarKey = key;
          }
        }

        upsertPeer(this.deps.db, {
          shareId: batch.id,
          peerId,
          kind: resolved.kind ?? kind,
          displayName: resolved.displayName,
          username: resolved.username ?? null,
          avatarKey,
        });
        count += 1;
      } catch (error) {
        this.deps.log?.(`avatar resolution failed for peer ${peerId}: ${String(error)}`);
      }
    }
    return count;
  }
}
