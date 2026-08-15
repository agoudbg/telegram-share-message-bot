// TL JSON sanitizer (server side; the public API only ever serves sanitized
// copies). See docs/PLAN.md §2.6.
//
// Rules:
// - Recursively strip accessHash / fileReference / dcId (media is hosted by
//   us and the frontend uses blobUrl, so real file references are unneeded;
//   these fields would leak session capability and real entity relations)
// - Remap real peer ids to deterministic fake ids per share scope: within one
//   share the same entity maps to the same fake id (so avatar/name references
//   stay consistent), while different shares cannot be correlated
// - Erase the forwarder's identity: peerId/fromId/savedPeerId on
//   Message/MessageService are replaced with the virtual-chat fake peer
// - Keep fwdFrom.fromName (hidden origin users) — it is only a name string
//
// Operates on serialized TL JSON (ids carry the {$long} marker), decoupled
// from hydrate.

import type { TLJsonObject, TLJsonValue } from './types.js';
import { isTLJsonLong } from './types.js';

/** FNV-1a 64bit, pure TS isomorphic implementation. Fake ids need no
 *  cryptographic strength (the real defense is the unguessable share id). */
export function fnv1a64(input: string): bigint {
  const bytes = new TextEncoder().encode(input);
  let hash = 0xcbf29ce484222325n;
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

export interface SanitizerOptions {
  /** Share-scope secret; must differ per share (the share id itself works) */
  shareSecret: string;
  /** Fake peer id of the virtual chat (decimal string). The forwarder's
   *  peerId/fromId are replaced with it. */
  virtualChatPeerId: string;
  /** Optional custom hash (e.g. HMAC); defaults to FNV-1a 64 */
  hashFn?: (input: string) => bigint;
}

const STRIPPED_KEYS = new Set(['accessHash', 'fileReference', 'dcId']);

/** The id field name inside Peer* wrapper objects */
const PEER_ID_FIELDS: Record<string, string> = {
  PeerUser: 'userId',
  PeerChat: 'chatId',
  PeerChannel: 'channelId',
};

/** Entities whose id is bound to a real identity and must be remapped */
const ENTITY_CLASSES = new Set(['User', 'Chat', 'Channel', 'Photo', 'Document']);

/** Message classes: peerId/fromId/savedPeerId are replaced with the virtual
 *  peer (forwarder erasure) */
const MESSAGE_CLASSES = new Set(['Message', 'MessageService']);

/** Bare int64 peer id fields that can appear anywhere (not Peer*-wrapped) */
const BARE_ID_KEYS = new Set(['userId', 'chatId', 'channelId', 'viaBotId', 'viaBusinessBotId']);

const FAKE_ID_BASE = 1n << 62n;
const FAKE_ID_SPAN = 1n << 62n;

export interface TLSanitizer {
  /** Sanitize any TL JSON (messages, User/Chat/Channel, …) */
  sanitize: (value: TLJsonValue) => TLJsonValue;
  /** Internal real id (decimal string) → this share's fake id */
  fakeId: (realId: string) => string;
}

export function createSanitizer(options: SanitizerOptions): TLSanitizer {
  const hashFn = options.hashFn ?? fnv1a64;
  const idMap = new Map<string, string>();
  const virtualPeer: TLJsonObject = {
    className: 'PeerUser',
    userId: { $long: options.virtualChatPeerId },
  };

  function fakeId(realId: string): string {
    let fake = idMap.get(realId);
    if (fake === undefined) {
      fake = (
        FAKE_ID_BASE +
        (hashFn(`${options.shareSecret}:${realId}`) % FAKE_ID_SPAN)
      ).toString();
      idMap.set(realId, fake);
    }
    return fake;
  }

  function remapIdValue(value: TLJsonValue): TLJsonValue {
    if (isTLJsonLong(value)) return { $long: fakeId(value.$long) };
    if (typeof value === 'number') return { $long: fakeId(value.toString()) };
    return value;
  }

  function sanitizeObject(obj: TLJsonObject): TLJsonObject {
    const className = obj.className;

    // Peer* wrapper: remap its inner id field
    const peerIdField = className !== undefined ? PEER_ID_FIELDS[className] : undefined;
    if (peerIdField !== undefined) {
      const out: TLJsonObject = { className };
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'className' || value === undefined) continue;
        out[key] = key === peerIdField ? remapIdValue(value) : sanitizeValue(value);
      }
      return out;
    }

    const isEntity = className !== undefined && ENTITY_CLASSES.has(className);
    const isMessage = className !== undefined && MESSAGE_CLASSES.has(className);

    const out: TLJsonObject = {};
    if (className !== undefined) out.className = className;
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || key === 'className') continue;
      if (STRIPPED_KEYS.has(key)) continue;
      if (isEntity && key === 'id') {
        out[key] = remapIdValue(value);
        continue;
      }
      if (isMessage && (key === 'peerId' || key === 'fromId' || key === 'savedPeerId')) {
        out[key] = virtualPeer;
        continue;
      }
      if (BARE_ID_KEYS.has(key) && (isTLJsonLong(value) || typeof value === 'number')) {
        out[key] = remapIdValue(value);
        continue;
      }
      out[key] = sanitizeValue(value);
    }
    return out;
  }

  function sanitizeValue(value: TLJsonValue): TLJsonValue {
    if (Array.isArray(value)) return value.map(sanitizeValue);
    if (typeof value === 'object' && value !== null && !isTLJsonLong(value)) {
      if ('$bytes' in value) return value;
      return sanitizeObject(value as TLJsonObject);
    }
    return value;
  }

  return { sanitize: sanitizeValue, fakeId };
}
