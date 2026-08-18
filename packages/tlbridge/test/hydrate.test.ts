import { describe, expect, it } from 'vitest';
import { hydrateTL, type TLRegistry } from '../src/hydrate.js';
import { serializeTL, serializeTLToString } from '../src/serialize.js';
import { Message, MessageFwdHeader, PeerUser, makeMessage } from './fixtures.js';

const registry: TLRegistry = {
  Message,
  MessageFwdHeader,
  PeerUser,
};

describe('hydrateTL', () => {
  it('round-trip: restores prototypes, bigints and nested instances', () => {
    const original = makeMessage();
    const hydrated = hydrateTL(JSON.parse(serializeTLToString(original)), registry) as Message;

    expect(hydrated).toBeInstanceOf(Message);
    expect(hydrated.className).toBe('Message');
    expect(hydrated.id).toBe(123n);
    expect(hydrated.fwdFrom).toBeInstanceOf(MessageFwdHeader);
    expect(hydrated.fwdFrom!.date).toBe(1749999000);
    expect(hydrated.fwdFrom!.fromId).toBeInstanceOf(PeerUser);
    expect(hydrated.fwdFrom!.fromId!.userId).toBe(777000n);
    expect(Array.isArray(hydrated.entities)).toBe(true);
    // underscore-prefixed fields are never restored
    expect((hydrated as any)._client).toBeUndefined();
  });

  it('revives bytes as Uint8Array', () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const hydrated = hydrateTL(serializeTL({ className: 'Doc', data: bytes }), registry) as any;
    expect(hydrated.data).toBeInstanceOf(Uint8Array);
    expect([...hydrated.data]).toEqual([9, 8, 7]);
  });

  it('degrades unknown constructors to plain objects, keeping className', () => {
    const json = serializeTL({ className: 'MessageEntityFuture2077', offset: 0, length: 1 });
    const hydrated = hydrateTL(json, registry) as any;
    expect(hydrated.className).toBe('MessageEntityFuture2077');
    expect(hydrated.offset).toBe(0);
    expect(Object.getPrototypeOf(hydrated)).toBe(Object.prototype);
  });

  it('plain objects without className stay plain objects', () => {
    const hydrated = hydrateTL(serializeTL({ a: 1, b: [{ c: 2n }] }), registry) as any;
    expect(hydrated).toEqual({ a: 1, b: [{ c: 2n }] });
    expect(Object.getPrototypeOf(hydrated)).toBe(Object.prototype);
  });

  it('restores null optional object fields as absent', () => {
    const hydrated = hydrateTL({
      className: 'Message',
      id: 123,
      groupedId: null,
      media: null,
    }, registry) as Message;

    expect(hydrated).toBeInstanceOf(Message);
    expect(hydrated.groupedId).toBeUndefined();
    expect(hydrated.media).toBeUndefined();
  });

  it('primitives pass through', () => {
    expect(hydrateTL(null, registry)).toBeNull();
    expect(hydrateTL('x', registry)).toBe('x');
    expect(hydrateTL(1.5, registry)).toBe(1.5);
  });
});
