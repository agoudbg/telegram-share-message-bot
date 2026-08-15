// TL JSON value types. See docs/PLAN.md §2.4.
//
// Rules:
// - int64 (native bigint or big-integer instance) → { $long: "decimal string" }
// - bytes (Uint8Array/Buffer) → { $bytes: "base64" }
// - TL class instances → plain objects, keeping className as the constructor
//   marker; underscore-prefixed runtime fields are stripped
// - other primitives and arrays → passthrough, recursively

export type TLJsonPrimitive = string | number | boolean | null;

export interface TLJsonLong {
  $long: string;
}

export interface TLJsonBytes {
  $bytes: string;
}

export type TLJsonValue = TLJsonPrimitive | TLJsonLong | TLJsonBytes | TLJsonValue[] | TLJsonObject;

export interface TLJsonObject {
  [key: string]: TLJsonValue | undefined;
  className?: string;
}

export function isTLJsonLong(value: TLJsonValue): value is TLJsonLong {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as TLJsonLong).$long === 'string'
  );
}

export function isTLJsonBytes(value: TLJsonValue): value is TLJsonBytes {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as TLJsonBytes).$bytes === 'string'
  );
}
