// TL object → TL JSON serializer (backend side). See docs/PLAN.md §2.4.
//
// Input: TL class instances deserialized by teleproto/gramjs. Key points:
// - Strip underscore-prefixed runtime fields (_client/_entities etc., which
//   contain circular references and would break JSON.stringify)
// - Recognize both int64 representations: native bigint (WebA fork style)
//   and big-integer instances (teleproto style)
// - className may live on a prototype getter rather than as an own enumerable
//   property, so it must be backfilled explicitly

import { bytesToBase64 } from './base64.js';
import type { TLJsonObject, TLJsonValue } from './types.js';

const INTEGER_CTOR_NAMES = new Set(['Integer', 'SmallInteger', 'BigInteger']);

function isBigIntegerInstance(value: object): boolean {
  // big-integer instances have constructor name SmallInteger/BigInteger; rely
  // on the constructor name only — duck-typing on toJSON() would misclassify
  // any object whose toJSON happens to return a decimal string
  const ctorName: unknown = value.constructor?.name;
  return typeof ctorName === 'string' && INTEGER_CTOR_NAMES.has(ctorName);
}

export function serializeTL(value: unknown): TLJsonValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'number':
      return value;
    case 'bigint':
      return { $long: value.toString() };
    case 'object':
      break;
    default:
      // function/symbol must not appear in TL data; return null instead of
      // throwing so any input stays serializable
      return null;
  }

  if (value instanceof Uint8Array) return { $bytes: bytesToBase64(value) };
  if (Array.isArray(value)) return value.map(serializeTL);
  if (isBigIntegerInstance(value)) return { $long: value.toString() };

  const out: TLJsonObject = {};
  for (const [key, field] of Object.entries(value)) {
    if (key.startsWith('_')) continue;
    if (field === undefined || typeof field === 'function') continue;
    out[key] = serializeTL(field);
  }
  const className: unknown = (value as { className?: unknown }).className;
  if (typeof className === 'string' && out.className === undefined) out.className = className;
  return out;
}

export function serializeTLToString(value: unknown): string {
  return JSON.stringify(serializeTL(value));
}
