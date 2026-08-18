// TL JSON → GramJs class instance hydrator (frontend side). See docs/PLAN.md §2.4.
//
// WebA's buildApiMessage discriminates entirely via instanceof, so prototypes
// must be restored by looking up the constructor table with className. We do
// NOT call constructors (their argument shapes vary); instead we use
// Object.create(prototype) + field assignment — the render path never invokes
// TL binary methods, so this is safe.
// Unknown constructors degrade to plain passthrough objects (className kept),
// without blocking the rendering of the remaining messages.

import { base64ToBytes } from './base64.js';
import type { TLJsonBytes, TLJsonLong, TLJsonObject, TLJsonValue } from './types.js';
import { isTLJsonBytes, isTLJsonLong } from './types.js';

export interface TLConstructorLike {
  // Only the prototype is needed; any class constructor qualifies
  prototype: object;
}

export type TLRegistry = Record<string, TLConstructorLike | undefined>;

export function hydrateTL(json: TLJsonValue, registry: TLRegistry = {}): unknown {
  if (json === null || typeof json !== 'object') return json;
  if (Array.isArray(json)) return json.map((item) => hydrateTL(item, registry));
  if (isTLJsonLong(json)) return BigInt((json as TLJsonLong).$long);
  if (isTLJsonBytes(json)) return base64ToBytes((json as TLJsonBytes).$bytes);

  const { className, ...fields } = json as TLJsonObject;
  const hydrated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    // Teleproto represents absent optional TL fields as null. GramJs builders
    // distinguish absent values with undefined, so restoring null would make
    // fields such as groupedId look present and trigger invalid render paths.
    if (value === undefined || (!value && typeof value === 'object')) continue;
    hydrated[key] = hydrateTL(value, registry);
  }

  const ctor = typeof className === 'string' ? registry[className] : undefined;
  if (ctor) {
    const obj = Object.assign(Object.create(ctor.prototype), hydrated);
    // If className is already provided by a prototype getter (as in some
    // gramjs classes), it works as-is and must not be assigned
    if (typeof className === 'string' && !('className' in obj)) obj.className = className;
    return obj;
  }
  return className === undefined ? hydrated : { className, ...hydrated };
}
