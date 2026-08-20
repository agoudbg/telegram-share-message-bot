import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

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

  it('aborts an unknown-size response before it can exceed the hard limit', async () => {
    const origin = new ChunkedOrigin([Buffer.from('12345678'), Buffer.from('overflow')]);
    const { cache, db, dataDir } = await setupWithOrigin(origin, {
      maxBytes: 10,
      lowWatermarkBytes: 8,
    });
    const media = insertMedia(db, 'unknown', null);

    await expect(read(cache, media)).rejects.toThrow('Media origin returned 507');
    expect(origin.cancelled).toBe(true);
    expect(getMediaCache(db, 'unknown', 'full')).toBeNull();
    expect(await cacheFiles(dataDir)).toEqual([]);
  });

  it('aborts a response larger than the database-declared size', async () => {
    const origin = new ChunkedOrigin(
      [Buffer.from('12345678'), Buffer.from('overflow')],
      16,
    );
    const { cache, db, dataDir } = await setupWithOrigin(origin, {
      maxBytes: 10,
      lowWatermarkBytes: 8,
    });
    const media = insertMedia(db, 'stale-size', 8);

    await expect(read(cache, media)).rejects.toThrow('Media origin returned 507');
    expect(origin.cancelled).toBe(true);
    expect(getMediaCache(db, 'stale-size', 'full')).toBeNull();
    expect(await cacheFiles(dataDir)).toEqual([]);
  });

  it('times out a Telegram origin fetch and removes the temporary file', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const origin: MediaOriginClient = {
      fetch: (_mediaKey, _variant, signal) => {
        upstreamSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    };
    const { cache, db, dataDir } = await setupWithOrigin(origin, { downloadTimeoutMs: 10 });
    const media = insertMedia(db, 'timeout', null);

    await expect(cache.open(media, 'full')).rejects.toThrow('Media origin returned 504');
    expect(upstreamSignal?.aborted).toBe(true);
    expect(await cacheFiles(dataDir)).toEqual([]);
  });

  it('cancels an origin fetch when the request disconnects before headers arrive', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const origin: MediaOriginClient = {
      fetch: (_mediaKey, _variant, signal) => {
        upstreamSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    };
    const { cache, db, dataDir } = await setupWithOrigin(origin);
    const media = insertMedia(db, 'early-disconnect', null);
    const client = new AbortController();
    const opening = cache.open(media, 'full', client.signal);

    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    client.abort(new Error('client disconnected'));
    await expect(opening).rejects.toThrow('client disconnected');
    expect(upstreamSignal?.aborted).toBe(true);
    expect(await cacheFiles(dataDir)).toEqual([]);
  });

  it('cancels Telegram when the last connected consumer disconnects', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const origin: MediaOriginClient = {
      fetch: (_mediaKey, _variant, signal) => {
        upstreamSignal = signal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('first'));
            signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        });
        return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/plain' } }));
      },
    };
    const { cache, db, dataDir } = await setupWithOrigin(origin);
    const media = insertMedia(db, 'disconnect', null);
    const handle = await cache.open(media, 'full');
    const client = new AbortController();
    const iterator = handle.stream(0, undefined, client.signal)[Symbol.asyncIterator]();

    expect(Buffer.from((await iterator.next()).value).toString()).toBe('first');
    client.abort(new Error('client disconnected'));
    await expect(iterator.next()).rejects.toThrow();
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
    await vi.waitFor(async () => expect(await cacheFiles(dataDir)).toEqual([]));
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
  return setupWithOrigin(new FakeOrigin(bodies), overrides);
}

async function setupWithOrigin(
  origin: MediaOriginClient,
  overrides: Partial<{
    maxBytes: number;
    lowWatermarkBytes: number;
    ttlSeconds: number;
    now: () => number;
    downloadTimeoutMs: number;
  }> = {},
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tbfb-cache-'));
  dirs.push(dataDir);
  const db = openDatabase(':memory:');
  const cache = new MediaCache({
    db,
    dataDir,
    origin,
    maxBytes: overrides.maxBytes ?? 1024,
    lowWatermarkBytes: overrides.lowWatermarkBytes ?? 768,
    ttlSeconds: overrides.ttlSeconds ?? 86400,
    sweepIntervalSeconds: 3600,
    now: overrides.now,
    downloadTimeoutMs: overrides.downloadTimeoutMs,
  });
  caches.push(cache);
  return { cache, db, dataDir, origin };
}

function insertMedia(db: ReturnType<typeof openDatabase>, key: string, size: number | null) {
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

class ChunkedOrigin implements MediaOriginClient {
  cancelled = false;

  constructor(
    private readonly chunks: Buffer[],
    private readonly contentLength?: number,
  ) {}

  fetch(): Promise<Response> {
    const chunks = [...this.chunks];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk !== undefined) controller.enqueue(chunk);
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
    const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
    if (this.contentLength !== undefined) headers['Content-Length'] = String(this.contentLength);
    return Promise.resolve(new Response(stream, { headers }));
  }
}

async function cacheFiles(dataDir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return readdir(path.join(dataDir, 'cache', 'media'));
}
