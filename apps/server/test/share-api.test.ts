// Share data API tests (docs/PLAN.md, Phase 3 Commit 10): response shape and
// the sanitization guarantees of §2.6 — no sensitive fields, no real ids,
// share-scoped fake-id consistency.

import { describe, expect, it } from 'vitest';

import { createServerApp } from '../src/api/app.js';
import type { ShareResponse } from '../src/api/app.js';
import { openDatabase } from '../src/storage/database.js';
import type { StorageDatabase } from '../src/storage/database.js';
import {
  createShare,
  finalizeShare,
  insertMediaIfAbsent,
  insertMessage,
  linkMediaToShare,
  revokeShare,
  upsertPeer,
} from '../src/storage/repository.js';

const SECRET = 'test-secret';
const SHARE_ID = 'share-a';
/** Real ids that must never appear in the API output */
const REAL = {
  forwarder: '777000',
  channel: '1234567890',
  document: '555444333222',
  accessHash: '999888777',
} as const;

function documentMessage(): unknown {
  return {
    className: 'Message',
    id: 42,
    peerId: { className: 'PeerUser', userId: { $long: REAL.forwarder } },
    fromId: { className: 'PeerUser', userId: { $long: REAL.forwarder } },
    message: 'hello',
    date: 1700000000,
    fwdFrom: {
      className: 'MessageFwdHeader',
      date: 1699999990,
      fromId: { className: 'PeerChannel', channelId: { $long: REAL.channel } },
      channelPost: 99,
    },
    media: {
      className: 'MessageMediaDocument',
      document: {
        className: 'Document',
        id: { $long: REAL.document },
        accessHash: { $long: REAL.accessHash },
        fileReference: { $bytes: 'AAEC' },
        dcId: 4,
        size: { $long: '2048' },
        mimeType: 'video/mp4',
        attributes: [],
      },
    },
  };
}

function hiddenForwardMessage(): unknown {
  return {
    className: 'Message',
    id: 43,
    peerId: { className: 'PeerUser', userId: { $long: REAL.forwarder } },
    message: 'second',
    date: 1700000001,
    fwdFrom: {
      className: 'MessageFwdHeader',
      date: 1699999000,
      fromName: 'Hidden User',
    },
  };
}

function seedShare(db: StorageDatabase, shareId: string): void {
  createShare(db, { id: shareId, ownerUserId: 'u1' });
  insertMessage(db, { shareId, seq: 0, tlJson: JSON.stringify(documentMessage()) });
  insertMessage(db, {
    shareId,
    seq: 1,
    tlJson: JSON.stringify(hiddenForwardMessage()),
    nestedForward: true,
  });
  insertMediaIfAbsent(db, {
    key: REAL.document,
    hosted: true,
    path: `media/${REAL.document}`,
    mime: 'video/mp4',
    size: 2048,
    width: 640,
    height: 480,
    thumbPath: `media/${REAL.document}_thumb.jpg`,
  });
  linkMediaToShare(db, shareId, REAL.document);
  insertMediaIfAbsent(db, {
    key: '666777888999',
    hosted: false,
    reference: JSON.stringify({ id: '666777888999', accessHash: '1', fileReference: 'AA==' }),
    mime: 'application/zip',
    size: 900000000,
  });
  linkMediaToShare(db, shareId, '666777888999');
  insertMediaIfAbsent(db, {
    key: `avatar_${REAL.channel}`,
    hosted: true,
    path: `media/avatar_${REAL.channel}`,
    mime: 'image/jpeg',
  });
  linkMediaToShare(db, shareId, `avatar_${REAL.channel}`);
  upsertPeer(db, {
    shareId,
    peerId: REAL.channel,
    kind: 'channel',
    displayName: 'Some Channel',
    username: 'somechannel',
    avatarKey: `avatar_${REAL.channel}`,
  });
  finalizeShare(db, shareId);
}

function setup() {
  const db = openDatabase(':memory:');
  seedShare(db, SHARE_ID);
  const app = createServerApp({ db, sanitizeSecret: SECRET, dataDir: '/nonexistent' });
  return { db, app };
}

async function fetchShare(app: ReturnType<typeof createServerApp>, id: string) {
  const res = await app.request(`/api/shares/${id}`);
  return { status: res.status, body: (await res.json()) as ShareResponse & { error?: string } };
}

describe('GET /healthz', () => {
  it('reports server readiness without accessing share data', async () => {
    const { app } = setup();
    const response = await app.request('/healthz');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});

describe('GET /api/shares/:id', () => {
  it('serves sanitized messages, peers and the media map for a public share', async () => {
    const { app } = setup();
    const { status, body } = await fetchShare(app, SHARE_ID);

    expect(status).toBe(200);
    expect(body.share).toMatchObject({ id: SHARE_ID });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({ seq: 0, nestedForward: false });
    expect(body.messages[1]).toMatchObject({ seq: 1, nestedForward: true });

    // No sensitive fields and no real ids anywhere in the output (§2.6)
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/accessHash|fileReference|dcId/);
    for (const realId of Object.values(REAL)) expect(raw).not.toContain(realId);

    // Forwarder erased: peerId/fromId replaced with the virtual-chat peer
    const first = body.messages[0]!.message as any;
    expect(first.peerId.className).toBe('PeerUser');
    expect(first.fromId).toEqual(first.peerId);

    // The origin channel id is remapped consistently between the message's
    // fwdFrom and the peers list
    const fwdChannelId = first.fwdFrom.fromId.channelId.$long as string;
    expect(body.peers).toHaveLength(1);
    expect(body.peers[0]).toMatchObject({
      id: fwdChannelId,
      kind: 'channel',
      displayName: 'Some Channel',
      username: 'somechannel',
    });
    expect(body.peers[0]!.avatarUrl).toBe(`/media/${SHARE_ID}/avatar_${fwdChannelId}`);

    // The media map is keyed by the sanitized document id, so the frontend
    // can join it with the hydrated message
    const fakeDocId = first.media.document.id.$long as string;
    const entry = body.media[fakeDocId];
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      hosted: true,
      retrievable: false,
      mime: 'video/mp4',
      size: 2048,
      width: 640,
      height: 480,
      url: `/media/${SHARE_ID}/${fakeDocId}`,
      thumbUrl: `/media/${SHARE_ID}/${fakeDocId}?thumb=1`,
    });
    // Avatar files are served through peers[].avatarUrl, not the media map
    expect(Object.keys(body.media)).toHaveLength(2);
  });

  it('flags unhosted media without a URL but with retrievability', async () => {
    const { app } = setup();
    const { body } = await fetchShare(app, SHARE_ID);
    const unhosted = Object.values(body.media).find((entry) => !entry.hosted);
    expect(unhosted).toMatchObject({
      hosted: false,
      retrievable: true,
      url: null,
      thumbUrl: null,
      mime: 'application/zip',
    });
  });

  it('exposes the configured bot username for unhosted-media deep links', async () => {
    const db = openDatabase(':memory:');
    seedShare(db, SHARE_ID);
    const app = createServerApp({
      db, sanitizeSecret: SECRET, dataDir: '/nonexistent', botUsername: 'examplebot',
    });

    const { body } = await fetchShare(app, SHARE_ID);
    expect(body.botUsername).toBe('examplebot');

    const withoutBot = await fetchShare(setup().app, SHARE_ID);
    expect(withoutBot.body.botUsername).toBeNull();
  });

  it('keeps fwdFrom.fromName for hidden origin users', async () => {
    const { app } = setup();
    const { body } = await fetchShare(app, SHARE_ID);
    const second = body.messages[1]!.message as any;
    expect(second.fwdFrom.fromName).toBe('Hidden User');
  });

  it('answers 404 for unknown and pending shares, 410 for revoked ones', async () => {
    const { db, app } = setup();

    expect((await fetchShare(app, 'no-such-share')).status).toBe(404);

    createShare(db, { id: 'share-pending', ownerUserId: 'u1' });
    const pending = await fetchShare(app, 'share-pending');
    expect(pending.status).toBe(404);
    expect(pending.body.error).toBe('not_found');

    revokeShare(db, SHARE_ID, 'u1');
    const revoked = await fetchShare(app, SHARE_ID);
    expect(revoked.status).toBe(410);
    expect(revoked.body.error).toBe('revoked');
  });

  it('maps the same real id to different fake ids across shares', async () => {
    const db = openDatabase(':memory:');
    seedShare(db, 'share-one');
    seedShare(db, 'share-two');
    const app = createServerApp({ db, sanitizeSecret: SECRET, dataDir: '/nonexistent' });

    const one = (await fetchShare(app, 'share-one')).body;
    const two = (await fetchShare(app, 'share-two')).body;
    expect(one.peers[0]!.id).not.toBe(two.peers[0]!.id);
    expect(Object.keys(one.media)).not.toEqual(Object.keys(two.media));
  });
});
