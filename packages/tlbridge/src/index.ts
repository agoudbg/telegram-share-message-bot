// packages/tlbridge — TL JSON serialize/hydrate, sanitizer, forward heuristic
// (shared between frontend and backend). See docs/PLAN.md §2.4 / §2.6 / §2.7

export type { TLJsonBytes, TLJsonLong, TLJsonObject, TLJsonPrimitive, TLJsonValue } from './types.js';
export { isTLJsonBytes, isTLJsonLong } from './types.js';
export { base64ToBytes, bytesToBase64 } from './base64.js';
export { serializeTL, serializeTLToString } from './serialize.js';
export { createSanitizer, fnv1a64 } from './sanitize.js';
export type { SanitizerOptions, TLSanitizer } from './sanitize.js';
export { hydrateTL } from './hydrate.js';
export type { TLConstructorLike, TLRegistry } from './hydrate.js';
