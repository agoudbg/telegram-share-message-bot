import { describe, expect, it } from 'vitest';
import { createSanitizer, hmacSha256, sha256 } from '../src/sanitize.js';
import { serializeTL } from '../src/serialize.js';
import type { TLJsonObject } from '../src/types.js';

function makeForwardedMessage(): TLJsonObject {
  // Already in TL JSON shape (ids carry the $long marker)
  return {
    className: 'Message',
    id: 123,
    message: 'look at this',
    date: 1750000100,
    peerId: { className: 'PeerUser', userId: { $long: '111' } }, // forwarder's PM
    fromId: { className: 'PeerUser', userId: { $long: '111' } }, // forwarder
    fwdFrom: {
      className: 'MessageFwdHeader',
      date: 1749999000,
      fromId: { className: 'PeerUser', userId: { $long: '777' } }, // original sender
    },
    media: {
      className: 'MessageMediaDocument',
      document: {
        className: 'Document',
        id: { $long: '555000111' },
        accessHash: { $long: '999888777' },
        fileReference: { $bytes: 'AQID' },
        dcId: 2,
        mimeType: 'video/mp4',
        thumbs: [{ className: 'PhotoSize', w: 320, h: 240 }],
      },
    },
  };
}

describe('createSanitizer', () => {
  it('strips accessHash/fileReference/dcId (including nested)', () => {
    const s = createSanitizer({ shareSecret: 'share-a', virtualChatPeerId: '999' });
    const out = s.sanitize(makeForwardedMessage()) as any;
    const doc = out.media.document;
    expect(doc.accessHash).toBeUndefined();
    expect(doc.fileReference).toBeUndefined();
    expect(doc.dcId).toBeUndefined();
    expect(doc.mimeType).toBe('video/mp4');
  });

  it('erases forwarder identity: peerId/fromId become the virtual peer', () => {
    const s = createSanitizer({ shareSecret: 'share-a', virtualChatPeerId: '999' });
    const out = s.sanitize(makeForwardedMessage()) as any;
    expect(out.peerId).toEqual({ className: 'PeerUser', userId: { $long: '999' } });
    expect(out.fromId).toEqual({ className: 'PeerUser', userId: { $long: '999' } });
  });

  it('remaps fwdFrom sender ids: stable within a share, different across shares, never the real id', () => {
    const a = createSanitizer({ shareSecret: 'share-a', virtualChatPeerId: '999' });
    const b = createSanitizer({ shareSecret: 'share-b', virtualChatPeerId: '999' });

    const outA1 = a.sanitize(makeForwardedMessage()) as any;
    const outA2 = a.sanitize(makeForwardedMessage()) as any;
    const outB = b.sanitize(makeForwardedMessage()) as any;

    const idA1 = outA1.fwdFrom.fromId.userId.$long;
    expect(idA1).toBe(outA2.fwdFrom.fromId.userId.$long); // stable within share
    expect(idA1).not.toBe(outB.fwdFrom.fromId.userId.$long); // different across shares
    expect(idA1).not.toBe('777'); // not the real id
    expect(BigInt(idA1) > 0n).toBe(true); // valid positive int64
  });

  it('remaps Document/Photo ids consistently within a share; Message.id untouched', () => {
    const s = createSanitizer({ shareSecret: 'share-a', virtualChatPeerId: '999' });
    const out = s.sanitize(makeForwardedMessage()) as any;
    expect(out.media.document.id.$long).not.toBe('555000111');
    expect(out.media.document.id.$long).toBe(s.fakeId('555000111'));
    expect(out.id).toBe(123);
  });

  it('hidden origin users: fromName is preserved as-is', () => {
    const msg = makeForwardedMessage();
    delete (msg.fwdFrom as TLJsonObject).fromId;
    (msg.fwdFrom as TLJsonObject).fromName = 'John Doe';
    const s = createSanitizer({ shareSecret: 'share-a', virtualChatPeerId: '999' });
    const out = s.sanitize(msg) as any;
    expect(out.fwdFrom.fromName).toBe('John Doe');
    expect(out.fwdFrom.fromId).toBeUndefined();
  });

  it('chains after serializeTL: serialize → sanitize leaves no sensitive fields', () => {
    const raw = {
      className: 'User',
      id: 888n,
      accessHash: -5n,
      firstName: 'Alice',
      photo: { className: 'UserProfilePhoto', photoId: 42n, dcId: 4 },
    };
    const s = createSanitizer({ shareSecret: 'share-a', virtualChatPeerId: '999' });
    const out = s.sanitize(serializeTL(raw)) as any;
    expect(out.id.$long).toBe(s.fakeId('888'));
    expect(out.accessHash).toBeUndefined();
    expect(out.photo.dcId).toBeUndefined();
    expect(out.firstName).toBe('Alice');
  });

  it('sha256 matches the known empty-string vector', () => {
    const hex = [...sha256(new Uint8Array(0))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hmacSha256 matches RFC 4231 test case 1', () => {
    const key = new Uint8Array(20).fill(0x0b);
    const digest = hmacSha256(key, new TextEncoder().encode('Hi There'));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });
});
