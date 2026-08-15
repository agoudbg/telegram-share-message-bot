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

/** SHA-256, pure TS isomorphic implementation (the package is shared with the
 *  frontend, so node:crypto is not available here). */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0],
      b = h[1],
      c = h[2],
      d = h[3],
      e = h[4],
      f = h[5],
      g = h[6],
      hh = h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

/** HMAC-SHA256 (RFC 2104), pure TS isomorphic implementation. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha256(key) : key);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

export interface SanitizerOptions {
  /** Share-scope secret used as the HMAC key; must differ per share (the share
   *  id itself works). Combine it with a server-side secret so fake ids cannot
   *  be recomputed offline from a leaked share id. */
  shareSecret: string;
  /** Fake peer id of the virtual chat (decimal string). The forwarder's
   *  peerId/fromId are replaced with it. */
  virtualChatPeerId: string;
  /** Optional custom hash (receives the real id, decimal string; must return
   *  a non-negative bigint). Defaults to HMAC-SHA256 keyed with shareSecret. */
  hashFn?: (realId: string) => bigint;
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

/** HMAC-SHA256 keyed with shareSecret, reduced to a non-negative 64-bit int
 *  (first 8 bytes of the digest, big-endian). */
function defaultHashFn(shareSecret: string, realId: string): bigint {
  const encoder = new TextEncoder();
  const digest = hmacSha256(encoder.encode(shareSecret), encoder.encode(realId));
  return new DataView(digest.buffer).getBigUint64(0);
}

/** Create a sanitizer for ONE share. Never reuse an instance across shares:
 *  the internal id map is share-scoped state, and reusing it would give two
 *  shares identical real→fake id mappings, silently breaking cross-share
 *  isolation. The server layer must create a fresh instance per share. */
export function createSanitizer(options: SanitizerOptions): TLSanitizer {
  const hashFn = options.hashFn ?? ((realId: string) => defaultHashFn(options.shareSecret, realId));
  const idMap = new Map<string, string>();
  const virtualPeer: TLJsonObject = {
    className: 'PeerUser',
    userId: { $long: options.virtualChatPeerId },
  };

  function fakeId(realId: string): string {
    let fake = idMap.get(realId);
    if (fake === undefined) {
      fake = (FAKE_ID_BASE + (hashFn(realId) % FAKE_ID_SPAN)).toString();
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
