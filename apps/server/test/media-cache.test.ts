import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { MediaCache } from '../src/mediaCache.js';
import type { MediaOriginClient } from '../src/mediaCache.js';
import { openDatabase } from '../src/storage/database.js';
import {
  getMediaCache,
  insertMediaIfAbsent,
  upsertMediaSource,
} from '../src/storage/repository.js';

const dirs: string[] = [];
const caches: MediaCache[] = [];

afterAll(async () => {
  for (const cache of caches) cache.close();
  await Promise.all(dirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('MediaCache', () => {
  it('coalesces concurrent misses and serves later reads from disk', async () => {
    const { cache, db, origin } = await setup({ 'm1:full': Buffer.from('hello world') });
    const media = insertMedia(db, 'm1', 11);

    const [first, second] = await Promise.all([
      read(cache, media),
      read(cache, media),
    ]);

    expect(first.toString()).toBe('hello world');
    expect(second.toString()).toBe('hello world');
    expect(origin.calls).toBe(1);
    expect(getMediaCache(db, 'm1', 'full')?.size).toBe(11);

    expect((await read(cache, media)).toString()).toBe('hello world');
    expect(origin.calls).toBe(1);
  });

  it('expires idle entries and evicts LRU entries before exceeding capacity', async () => {
    let now = 1_000_000;
    const { cache, db } = await setup(
      {
        'm1:full': Buffer.from('123456'),
        'm2:full': Buffer.from('abcdef'),
      },
      { maxBytes: 10, lowWatermarkBytes: 5, ttlSeconds: 10, now: () => now },
    );
    const first = insertMedia(db, 'm1', 6);
    const second = insertMedia(db, 'm2', 6);

    await read(cache, first);
    await read(cache, second);
    expect(getMediaCache(db, 'm1', 'full')).toBeNull();
    expect(getMediaCache(db, 'm2', 'full')).not.toBeNull();

    now += 11_000;
    await cache.sweep();
    expect(getMediaCache(db, 'm2', 'full')).toBeNull();
  });
});

async function setup(
  bodies: Record<string, Buffer>,
  overrides: Partial<{
    maxBytes: number;
    lowWatermarkBytes: number;
    ttlSeconds: number;
    now: () => number;
  }> = {},
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tbfb-cache-'));
  dirs.push(dataDir);
  const db = openDatabase(':memory:');
  const origin = new FakeOrigin(bodies);
  const cache = new MediaCache({
    db,
    dataDir,
    origin,
    maxBytes: overrides.maxBytes ?? 1024,
    lowWatermarkBytes: overrides.lowWatermarkBytes ?? 768,
    ttlSeconds: overrides.ttlSeconds ?? 86400,
    sweepIntervalSeconds: 3600,
    now: overrides.now,
  });
  caches.push(cache);
  return { cache, db, origin };
}

function insertMedia(db: ReturnType<typeof openDatabase>, key: string, size: number) {
  insertMediaIfAbsent(db, { key, hosted: true, mime: 'text/plain', size });
  upsertMediaSource(db, {
    mediaKey: key,
    kind: 'document',
    sourcePeerId: 'u1',
    sourceMessageId: 1,
    reference: '{}',
  });
  return { key, hosted: true, mime: 'text/plain', size, path: null, reference: null, width: null, height: null, thumbPath: null };
}

async function read(cache: MediaCache, media: ReturnType<typeof insertMedia>): Promise<Buffer> {
  const handle = await cache.open(media, 'full');
  const chunks: Buffer[] = [];
  for await (const chunk of handle.stream(0)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

class FakeOrigin implements MediaOriginClient {
  calls = 0;

  constructor(private readonly bodies: Record<string, Buffer>) {}

  fetch(mediaKey: string, variant: 'full' | 'thumb' | 'avatar'): Promise<Response> {
    this.calls += 1;
    const body = this.bodies[`${mediaKey}:${variant}`];
    return Promise.resolve(
      body === undefined
        ? new Response(null, { status: 404 })
        : new Response(body, {
            headers: { 'Content-Type': 'text/plain', 'Content-Length': String(body.length) },
          }),
    );
  }
}
