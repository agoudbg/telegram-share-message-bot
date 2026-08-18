import { describe, expect, it } from 'vitest';
import { serializeTL, serializeTLToString } from '../src/serialize.js';
import { bytesToBase64 } from '../src/base64.js';
import { makeMessage, SmallInteger } from './fixtures.js';

describe('serializeTL', () => {
  it('serializes messages with circular refs; runtime fields are stripped', () => {
    const msg = makeMessage();
    const jsonText = serializeTLToString(msg); // must not throw on circular refs
    const json = JSON.parse(jsonText);

    expect(json.className).toBe('Message');
    expect(json.id).toEqual({ $long: '123' });
    expect(json.message).toBe('hello');
    expect(json._client).toBeUndefined();
    expect(json._entities).toBeUndefined();
  });

  it('backfills className provided only by a prototype getter', () => {
    const json = serializeTL(makeMessage()) as Record<string, any>;
    expect(json.fwdFrom.className).toBe('MessageFwdHeader');
    expect(json.fwdFrom.fromId.className).toBe('PeerUser');
    expect(json.fwdFrom.fromId.userId).toEqual({ $long: '777000' });
  });

  it('recurses into objects inside arrays', () => {
    const json = serializeTL(makeMessage()) as Record<string, any>;
    expect(json.entities).toEqual([{ className: 'MessageEntityBold', offset: 0, length: 5 }]);
  });

  it('bytes → $bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect(serializeTL({ className: 'X', data: bytes })).toEqual({
      className: 'X',
      data: { $bytes: bytesToBase64(bytes) },
    });
  });

  it('big-integer-style instances → $long', () => {
    expect(serializeTL(new SmallInteger('9007199254740993'))).toEqual({
      $long: '9007199254740993',
    });
    expect(serializeTL(new SmallInteger('-42'))).toEqual({ $long: '-42' });
  });

  it('native bigint → $long; null/undefined/function fields are dropped', () => {
    const json = serializeTL({
      className: 'Y',
      a: 5n,
      b: undefined,
      c: () => 1,
      d: 'keep',
      e: null,
    }) as Record<string, any>;
    expect(json.a).toEqual({ $long: '5' });
    expect('b' in json).toBe(false);
    expect('c' in json).toBe(false);
    expect(json.d).toBe('keep');
    expect('e' in json).toBe(false);
  });

  it('primitives and null pass through', () => {
    expect(serializeTL(null)).toBeNull();
    expect(serializeTL(undefined)).toBeNull();
    expect(serializeTL('s')).toBe('s');
    expect(serializeTL(3.14)).toBe(3.14);
    expect(serializeTL(true)).toBe(true);
  });
});
