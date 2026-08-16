// Media pipeline tests (Phase 2 Commit 8): extraction from TL JSON, host
// limit registration, dedup, thumbnails, avatar fallback and retries.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '@tbfb/server';
import type { TLJsonObject } from '@tbfb/tlbridge';

import type { Batch } from '../src/batching.js';
import { MediaPipeline, extractForwardPeer, extractMediaInfo, withRetry } from '../src/media.js';
import type { BotPorts, ResolvedPeer } from '../src/ports.js';
import { getMedia, listPeers, createShare } from '@tbfb/server';

function photoMessage(photoId: string): TLJsonObject {
  return {
    className: 'Message',
    media: {
      className: 'MessageMediaPhoto',
      photo: { className: 'Photo', id: { $long: photoId } },
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

describe('extractForwardPeer', () => {
  it('extracts user/chat/channel origins', () => {
    const base = { className: 'Message' };
    expect(
      extractForwardPeer({
        ...base,
        fwdFrom: {
          className: 'MessageFwdHeader',
          fromId: { className: 'PeerUser', userId: { $long: '1' } },
        },
      }),
    ).toEqual({ peerId: '1', kind: 'user' });
    expect(
      extractForwardPeer({
        ...base,
        fwdFrom: {
          className: 'MessageFwdHeader',
          fromId: { className: 'PeerChannel', channelId: { $long: '2' } },
        },
      }),
    ).toEqual({ peerId: '2', kind: 'channel' });
  });

  it('returns null for hidden users and non-forwards', () => {
    expect(
      extractForwardPeer({
        className: 'Message',
        fwdFrom: { className: 'MessageFwdHeader', fromName: 'Hidden' },
      }),
    ).toBeNull();
    expect(extractForwardPeer({ className: 'Message' })).toBeNull();
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
});

describe('MediaPipeline', () => {
  const dirs: string[] = [];

  async function setup(hostLimitBytes: number) {
    const mediaDir = await mkdtemp(path.join(tmpdir(), 'tbfb-media-'));
    dirs.push(mediaDir);
    const db = openDatabase(':memory:');
    const downloads: string[] = [];
    const host: Pick<
      BotPorts,
      'downloadMedia' | 'downloadThumb' | 'resolvePeer' | 'downloadAvatar'
    > = {
      downloadMedia: (_raw, dest) => {
        downloads.push(path.basename(dest));
        return Promise.resolve();
      },
      downloadThumb: () => Promise.resolve(true),
      resolvePeer: (peerId): Promise<ResolvedPeer | null> =>
        Promise.resolve(
          peerId === 'unresolvable' ? null : { kind: 'channel', displayName: `Channel ${peerId}` },
        ),
      downloadAvatar: (peerId) => Promise.resolve(peerId !== 'noavatar'),
    };
    const pipeline = new MediaPipeline({ db, mediaDir, hostLimitBytes, host });
    return { db, downloads, pipeline, mediaDir };
  }

  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

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

  it('downloads hosted media with thumbnails and registers unhosted oversized files', async () => {
    const { db, downloads, pipeline } = await setup(1000);
    const result = await pipeline.processBatch(
      batch([
        { tlJson: photoMessage('p1') },
        { tlJson: documentMessage('d1', 500) },
        { tlJson: documentMessage('big1', 5000) },
        { tlJson: { className: 'Message', message: 'text only' } },
      ]),
    );

    expect(result).toMatchObject({ hosted: 2, unhosted: 1, failed: 0 });
    expect(downloads.sort()).toEqual(['d1', 'p1']);

    const hostedDoc = getMedia(db, 'd1');
    expect(hostedDoc).toMatchObject({
      hosted: true,
      mime: 'video/mp4',
      width: 640,
      height: 360,
      thumbPath: path.join('media', 'd1_thumb.jpg'),
    });

    const big = getMedia(db, 'big1');
    expect(big?.hosted).toBe(false);
    expect(big?.path).toBeNull();
    expect(JSON.parse(big!.reference!)).toEqual({
      id: 'big1',
      accessHash: '999',
      fileReference: 'aGk=',
    });
  });

  it('dedups repeated media keys without re-downloading', async () => {
    const { db, downloads, pipeline } = await setup(1000);
    const b = batch([{ tlJson: photoMessage('p1') }, { tlJson: photoMessage('p1') }]);
    const result = await pipeline.processBatch(b);
    expect(result).toMatchObject({ hosted: 1, deduped: 1 });
    expect(downloads).toEqual(['p1']);
    expect(getMedia(db, 'p1')).not.toBeNull();
  });

  it('resolves origin avatars and skips unresolvable peers', async () => {
    const { db, pipeline } = await setup(1000);
    createShare(db, { id: 'share1', ownerUserId: 'u1' }); // peers reference the share row
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

  it('continues the batch when a single download fails', async () => {
    const { db, mediaDir } = await setup(1000);
    const failing = new MediaPipeline({
      db,
      mediaDir,
      hostLimitBytes: 1000,
      sleep: () => Promise.resolve(),
      host: {
        downloadMedia: (_raw, dest) =>
          dest.endsWith('bad') ? Promise.reject(new Error('io error')) : Promise.resolve(),
        downloadThumb: () => Promise.resolve(false),
        resolvePeer: () => Promise.resolve(null),
        downloadAvatar: () => Promise.resolve(false),
      },
    });
    const result = await failing.processBatch(
      batch([{ tlJson: photoMessage('bad') }, { tlJson: photoMessage('good') }]),
    );
    expect(result.failed).toBe(1);
    expect(getMedia(db, 'good')).not.toBeNull();
  });
});
