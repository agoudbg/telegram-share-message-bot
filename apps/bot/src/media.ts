// On-demand media registration pipeline.
//
// Binary data is never downloaded while a share is finalized. The database
// stores a known incoming message id plus the current MTProto reference; the
// media endpoint fetches and caches bytes only when a viewer requests them.

import type { StorageDatabase } from '@tbfb/server';
import {
  insertMediaIfAbsent,
  linkMediaToShare,
  upsertMediaSource,
  upsertPeer,
} from '@tbfb/server';
import type { TLJsonObject, TLJsonValue } from '@tbfb/tlbridge';
import { collectReferencedPeers, isTLJsonLong } from '@tbfb/tlbridge';

import type { Batch } from './batching.js';
import type { BotPorts, InputDocumentRef, InputPhotoRef } from './ports.js';

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
  photoRef?: InputPhotoRef;
  hasThumbnail: boolean;
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
    if (key === undefined) return null;
    const accessHash = idToString(photo.accessHash);
    const fileReference = asObject(photo.fileReference);
    const sizes = Array.isArray(photo.sizes) ? photo.sizes : [];
    const largest = sizes.at(-1);
    const largestSize = asObject(largest);
    return {
      kind: 'photo',
      key,
      mime: 'image/jpeg',
      size: typeof largestSize?.size === 'number' ? largestSize.size : undefined,
      photoRef:
        accessHash !== undefined && typeof fileReference?.$bytes === 'string'
          ? { id: key, accessHash, fileReference: fileReference.$bytes }
          : undefined,
      hasThumbnail: sizes.length >= 2,
    };
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
      hasThumbnail: Array.isArray(doc.thumbs) && doc.thumbs.length > 0,
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

/** Extract only the first-hop forward origin. Retained as a narrow public
 *  helper; share finalization uses `collectReferencedPeers` for the complete
 *  dependency graph. */
export function extractForwardPeer(
  tlJson: TLJsonObject,
): { peerId: string; kind: 'user' | 'chat' | 'channel' } | null {
  const fwdFrom = asObject(tlJson.fwdFrom);
  return fwdFrom === undefined ? null : collectReferencedPeers(fwdFrom)[0] || null;
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
 *  an error carrying a numeric `seconds` sleeps exactly that long; a numeric
 *  `code` below 500 is a permanent client error (e.g. 400) and is rethrown
 *  immediately; anything else backs off exponentially. */
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
      if (typeof seconds === 'number' && seconds > 0) {
        await sleep(Math.min(seconds, 60) * 1000);
        continue;
      }
      const code = (error as { code?: unknown })?.code;
      if (typeof code === 'number' && code < 500) break; // permanent client error
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

export interface MediaPipelineDeps {
  db: StorageDatabase;
  host: Pick<BotPorts, 'resolvePeer'>;
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

  /** Register media locators for every batch item, then resolve origins. */
  async processBatch(
    batch: Batch,
    onProgress?: (text: string) => void,
  ): Promise<MediaProcessResult> {
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
        const outcome = this.processOne(info, item.message.chatId, item.message.messageId);
        // Link regardless of outcome: deduped rows still need the per-share
        // link so the API can enumerate this share's media
        linkMediaToShare(this.deps.db, batch.id, info.key);
        result[outcome] += 1;
      } catch (error) {
        result.failed += 1;
        this.deps.log?.(`media registration failed for key ${info.key}: ${String(error)}`);
      }
    }

    result.avatars = await this.processAvatars(batch);
    return result;
  }

  private processOne(
    info: MediaInfo,
    sourcePeerId: string,
    sourceMessageId: number,
  ): 'hosted' | 'unhosted' | 'deduped' {
    const reference = info.documentRef ?? info.photoRef ?? null;
    const inserted = insertMediaIfAbsent(this.deps.db, {
      key: info.key,
      hosted: true,
      path: null,
      reference: info.documentRef === undefined ? null : JSON.stringify(info.documentRef),
      mime: info.mime ?? null,
      size: info.size ?? null,
      width: info.width ?? null,
      height: info.height ?? null,
    });
    upsertMediaSource(this.deps.db, {
      mediaKey: info.key,
      kind: info.kind,
      sourcePeerId,
      sourceMessageId,
      reference:
        reference === null
          ? JSON.stringify({ hasThumbnail: info.hasThumbnail })
          : JSON.stringify({ ...reference, hasThumbnail: info.hasThumbnail }),
    });
    return inserted ? 'hosted' : 'deduped';
  }

  private async processAvatars(batch: Batch): Promise<number> {
    const seen = new Map<string, 'user' | 'chat' | 'channel'>();
    for (const item of batch.items) {
      collectReferencedPeers(item.message.tlJson).forEach(({ peerId, kind }) => {
        if (!seen.has(peerId)) seen.set(peerId, kind);
      });
    }

    let count = 0;
    for (const [peerId, kind] of seen) {
      try {
        const resolved = await this.deps.host.resolvePeer(peerId);
        if (resolved === null) continue; // unresolvable → frontend letter fallback

        let avatarKey: string | null = null;
        const key = `avatar_${peerId}`;
        if (resolved.hasAvatar) {
          insertMediaIfAbsent(this.deps.db, {
            key,
            hosted: true,
            path: null,
            reference: JSON.stringify({ peerId }),
            mime: 'image/jpeg',
          });
          upsertMediaSource(this.deps.db, {
            mediaKey: key,
            kind: 'avatar',
            sourcePeerId: peerId,
            sourceMessageId: 0,
            reference: JSON.stringify({ peerId }),
          });
          avatarKey = key;
        }

        upsertPeer(this.deps.db, {
          shareId: batch.id,
          peerId,
          kind: resolved.kind ?? kind,
          displayName: resolved.displayName,
          username: resolved.username ?? null,
          avatarKey,
        });
        if (avatarKey !== null) linkMediaToShare(this.deps.db, batch.id, avatarKey);
        count += 1;
      } catch (error) {
        this.deps.log?.(`avatar resolution failed for peer ${peerId}: ${String(error)}`);
      }
    }
    return count;
  }
}
