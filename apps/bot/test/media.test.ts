// On-demand media registration, source locator, avatar and retry tests.

import { describe, expect, it } from 'vitest';
import { openDatabase } from '@tbfb/server';
import type { TLJsonObject } from '@tbfb/tlbridge';

import type { Batch } from '../src/batching.js';
import { MediaPipeline, extractMediaInfo, withRetry } from '../src/media.js';
import type { BotPorts, ResolvedPeer } from '../src/ports.js';
import { createShare, getMedia, listMediaSources, listPeers } from '@tbfb/server';

function photoMessage(photoId: string): TLJsonObject {
  return {
    className: 'Message',
    media: {
      className: 'MessageMediaPhoto',
      photo: {
        className: 'Photo',
        id: { $long: photoId },
        accessHash: { $long: '888' },
        fileReference: { $bytes: 'cGhvdG8=' },
        sizes: [
          { className: 'PhotoSize', type: 's', w: 90, h: 90, size: 100 },
          { className: 'PhotoSize', type: 'x', w: 800, h: 600, size: 5000 },
        ],
      },
    },
  };
}

function documentMessage(docId: string, size: number, withRef = true): TLJsonObject {
  return {
    className: 'Message',
    media: {
      className: 'MessageMediaDocument',
      document: {
        className: 'Document',
        id: { $long: docId },
        accessHash: withRef ? { $long: '999' } : undefined,
        fileReference: withRef ? { $bytes: 'aGk=' } : undefined,
        size: { $long: size.toString() },
        mimeType: 'video/mp4',
        attributes: [{ className: 'DocumentAttributeVideo', w: 640, h: 360, duration: 12 }],
      },
    },
  };
}

describe('extractMediaInfo', () => {
  it('extracts photos', () => {
    expect(extractMediaInfo(photoMessage('555'))).toEqual({
      kind: 'photo',
      key: '555',
      mime: 'image/jpeg',
      size: 5000,
      photoRef: { id: '555', accessHash: '888', fileReference: 'cGhvdG8=' },
      hasThumbnail: true,
    });
  });

  it('extracts documents with size, mime, dimensions and the InputDocument ref', () => {
    const info = extractMediaInfo(documentMessage('777', 12345));
    expect(info).toMatchObject({
      kind: 'document',
      key: '777',
      size: 12345,
      mime: 'video/mp4',
      width: 640,
      height: 360,
      documentRef: { id: '777', accessHash: '999', fileReference: 'aGk=' },
      hasThumbnail: false,
    });
  });

  it('returns null for text-only messages and empty media', () => {
    expect(extractMediaInfo({ className: 'Message', message: 'hi' })).toBeNull();
    expect(
      extractMediaInfo({
        className: 'Message',
        media: { className: 'MessageMediaPhoto', photo: { className: 'PhotoEmpty' } },
      }),
    ).toBeNull();
  });
});

describe('withRetry', () => {
  const noSleep = () => Promise.resolve();

  it('returns on first success', async () => {
    let calls = 0;
    const value = await withRetry(
      () => {
        calls += 1;
        return Promise.resolve(42);
      },
      { sleep: noSleep },
    );
    expect(value).toBe(42);
    expect(calls).toBe(1);
  });

  it('sleeps exactly the FloodWait seconds', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await withRetry(
      () => {
        calls += 1;
        if (calls < 2) return Promise.reject(Object.assign(new Error('flood'), { seconds: 7 }));
        return Promise.resolve('ok');
      },
      { sleep: (ms) => (sleeps.push(ms), Promise.resolve()) },
    );
    expect(calls).toBe(2);
    expect(sleeps).toEqual([7000]);
  });

  it('gives up after the retry budget', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error('boom'));
        },
        { retries: 2, sleep: noSleep },
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(3);
  });

  it('does not retry permanent client errors (code < 500)', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(Object.assign(new Error('bad request'), { code: 400 }));
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow('bad request');
    expect(calls).toBe(1);
  });
});

describe('MediaPipeline', () => {
  async function setup() {
    const db = openDatabase(':memory:');
    const host: Pick<BotPorts, 'resolvePeer'> = {
      resolvePeer: (peerId): Promise<ResolvedPeer | null> =>
        Promise.resolve(
          peerId === 'unresolvable'
            ? null
            : {
                kind: 'channel',
                displayName: `Channel ${peerId}`,
                hasAvatar: peerId !== 'noavatar',
              },
        ),
    };
    const pipeline = new MediaPipeline({ db, host });
    // Batches always have a share row in production (created at batch start);
    // the share_media links written by the pipeline reference it
    createShare(db, { id: 'share1', ownerUserId: 'u1' });
    return { db, pipeline };
  }

  function batch(items: Array<{ tlJson: TLJsonObject }>): Batch {
    return {
      id: 'share1',
      chatId: 'u1',
      startedAt: 0,
      items: items.map((item, seq) => ({
        seq,
        nestedForward: false,
        message: {
          chatId: 'u1',
          messageId: seq + 1,
          text: '',
          isPrivate: true,
          isForward: true,
          tlJson: item.tlJson,
          raw: { fake: seq },
        },
      })),
    };
  }

  it('registers media locators without downloading bytes', async () => {
    const { db, pipeline } = await setup();
    const result = await pipeline.processBatch(
      batch([
        { tlJson: photoMessage('p1') },
        { tlJson: documentMessage('d1', 500) },
        { tlJson: documentMessage('big1', 5000) },
        { tlJson: { className: 'Message', message: 'text only' } },
      ]),
    );

    expect(result).toMatchObject({ hosted: 3, unhosted: 0, failed: 0 });

    const hostedDoc = getMedia(db, 'd1');
    expect(hostedDoc).toMatchObject({
      hosted: true,
      path: null,
      mime: 'video/mp4',
      width: 640,
      height: 360,
      thumbPath: null,
    });

    const big = getMedia(db, 'big1');
    expect(big?.hosted).toBe(true);
    expect(big?.path).toBeNull();
    expect(JSON.parse(big!.reference!)).toEqual({
      id: 'big1',
      accessHash: '999',
      fileReference: 'aGk=',
    });
    expect(listMediaSources(db, 'big1')[0]).toMatchObject({
      kind: 'document',
      sourcePeerId: 'u1',
      sourceMessageId: 3,
    });
  });

  it('registers a source message even when the current reference is missing', async () => {
    const { db, pipeline } = await setup();
    const result = await pipeline.processBatch(
      batch([{ tlJson: documentMessage('noref', 5000, false) }]),
    );
    expect(result).toMatchObject({ hosted: 1, failed: 0 });

    const row = getMedia(db, 'noref');
    expect(row?.hosted).toBe(true);
    expect(row?.path).toBeNull();
    expect(row?.reference).toBeNull();
    expect(listMediaSources(db, 'noref')).toHaveLength(1);
  });

  it('dedups repeated media keys without re-downloading', async () => {
    const { db, pipeline } = await setup();
    const b = batch([{ tlJson: photoMessage('p1') }, { tlJson: photoMessage('p1') }]);
    const result = await pipeline.processBatch(b);
    expect(result).toMatchObject({ hosted: 1, deduped: 1 });
    expect(getMedia(db, 'p1')).not.toBeNull();
    expect(listMediaSources(db, 'p1')).toHaveLength(2);
  });

  it('resolves origin avatars and skips unresolvable peers', async () => {
    const { db, pipeline } = await setup();
    const fwd = (peerId: string): TLJsonObject => ({
      className: 'Message',
      fwdFrom: {
        className: 'MessageFwdHeader',
        date: 100,
        fromId: { className: 'PeerChannel', channelId: { $long: peerId } },
      },
    });
    const result = await pipeline.processBatch(
      batch([{ tlJson: fwd('10') }, { tlJson: fwd('10') }, { tlJson: fwd('unresolvable') }]),
    );

    expect(result.avatars).toBe(1);
    const peers = listPeers(db, 'share1');
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      peerId: '10',
      displayName: 'Channel 10',
      avatarKey: 'avatar_10',
    });
    expect(getMedia(db, 'avatar_10')).toMatchObject({ hosted: true, mime: 'image/jpeg' });
  });

  it('resolves all peers referenced by special-message payloads', async () => {
    const { db, pipeline } = await setup();
    const result = await pipeline.processBatch(batch([{
      tlJson: {
        className: 'Message',
        peerId: { className: 'PeerUser', userId: { $long: 'forwarder' } },
        media: {
          className: 'MessageMediaGiveawayResults',
          channelId: { $long: '20' },
          winners: [{ $long: '30' }, { $long: '31' }],
        },
      },
    }]));

    expect(result.avatars).toBe(3);
    expect(listPeers(db, 'share1').map((peer) => peer.peerId)).toEqual(['20', '30', '31']);
  });

});
