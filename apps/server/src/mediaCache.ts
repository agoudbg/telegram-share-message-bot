// Bounded read-through cache for Telegram media. Cache misses are fetched
// from the loopback bot origin while public responses tail the growing file.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { StorageDatabase } from './storage/database.js';
import {
  deleteMediaCache,
  getMediaCache,
  listMediaCache,
  touchMediaCache,
  upsertMediaCache,
} from './storage/repository.js';
import type { MediaCacheVariant, MediaRow } from './storage/repository.js';

export interface MediaOriginClient {
  fetch(mediaKey: string, variant: MediaCacheVariant): Promise<Response>;
}

export interface MediaCacheOptions {
  db: StorageDatabase;
  dataDir: string;
  origin: MediaOriginClient;
  maxBytes: number;
  lowWatermarkBytes: number;
  ttlSeconds: number;
  sweepIntervalSeconds: number;
  maxConcurrentFetches?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface CachedMediaHandle {
  contentType: string;
  size: number | null;
  stream(start: number, end?: number): Readable;
}

interface FetchTask {
  key: string;
  variant: MediaCacheVariant;
  finalPath: string;
  relativeFinalPath: string;
  bytesWritten: number;
  contentType: string;
  totalSize: number | null;
  complete: boolean;
  error: unknown;
  reservedBytes: number;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: unknown) => void;
  listeners: Set<() => void>;
}

export class MediaFetchError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: string,
  ) {
    super(`Media origin returned ${status}`);
  }
}

export class MediaCache {
  private readonly cacheRoot: string;
  private readonly tasks = new Map<string, FetchTask>();
  private readonly starts = new Map<string, Promise<FetchTask>>();
  private reservedBytes = 0;
  private capacityTail: Promise<void> = Promise.resolve();
  private activeFetches = 0;
  private readonly fetchWaiters: Array<() => void> = [];
  private readonly initPromise: Promise<void>;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: MediaCacheOptions) {
    this.cacheRoot = path.join(options.dataDir, 'cache', 'media');
    this.initPromise = this.initialize();
    this.timer = setInterval(
      () => void this.sweep().catch((error) => options.log?.(`cache sweep failed: ${String(error)}`)),
      options.sweepIntervalSeconds * 1000,
    );
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  async open(media: MediaRow, variant: MediaCacheVariant): Promise<CachedMediaHandle> {
    await this.initPromise;
    const cached = getMediaCache(this.options.db, media.key, variant);
    if (cached !== null) {
      const absolute = this.resolveCachePath(cached.path);
      try {
        const file = await stat(absolute);
        const now = this.nowSeconds();
        touchMediaCache(this.options.db, media.key, variant, now);
        return {
          contentType: variant === 'full' ? (media.mime ?? 'application/octet-stream') : await sniffImageMime(absolute),
          size: file.size,
          stream: (start, end) => createReadStream(absolute, { start, end }),
        };
      } catch {
        deleteMediaCache(this.options.db, media.key, variant);
      }
    }

    const taskKey = `${media.key}:${variant}`;
    let task = this.tasks.get(taskKey);
    if (task === undefined) {
      let starting = this.starts.get(taskKey);
      if (starting === undefined) {
        starting = (async () => {
          const expectedBytes = variant === 'full' ? (media.size ?? 0) : 0;
          const reservedBytes = await this.reserve(expectedBytes);
          const created = this.createTask(media, variant);
          created.reservedBytes = reservedBytes;
          this.tasks.set(taskKey, created);
          void this.runTask(media, created).finally(() => {
            this.reservedBytes -= created.reservedBytes;
            this.tasks.delete(taskKey);
            void this.evictTo(this.options.maxBytes);
          });
          return created;
        })();
        this.starts.set(taskKey, starting);
        void starting.then(
          () => this.starts.delete(taskKey),
          () => this.starts.delete(taskKey),
        );
      }
      task = await starting;
    }
    await task.ready;
    return {
      contentType: task.contentType,
      size: task.totalSize ?? media.size,
      stream: (start, end) => growingFileStream(task!, start, end),
    };
  }

  async sweep(): Promise<void> {
    await this.initPromise;
    const cutoff = this.nowSeconds() - this.options.ttlSeconds;
    for (const entry of listMediaCache(this.options.db)) {
      if (entry.lastAccessedAt >= cutoff) continue;
      await this.evict(entry.mediaKey, entry.variant, entry.path);
    }
    await this.evictTo(this.options.maxBytes);
  }

  private async initialize(): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true });
    const indexedPaths = new Set(
      listMediaCache(this.options.db).map((entry) => this.resolveCachePath(entry.path)),
    );
    for (const name of await readdir(this.cacheRoot)) {
      const candidate = path.join(this.cacheRoot, name);
      if (!indexedPaths.has(candidate)) await unlink(candidate).catch(() => undefined);
    }
    for (const entry of listMediaCache(this.options.db)) {
      try {
        await stat(this.resolveCachePath(entry.path));
      } catch {
        deleteMediaCache(this.options.db, entry.mediaKey, entry.variant);
      }
    }
  }

  private createTask(media: MediaRow, variant: MediaCacheVariant): FetchTask {
    const digest = createHash('sha256').update(`${media.key}:${variant}`).digest('hex');
    const relativeFinalPath = path.join('cache', 'media', `${digest}.cache.${randomUUID()}`);
    const finalPath = this.resolveCachePath(relativeFinalPath);
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    return {
      key: media.key,
      variant,
      finalPath,
      relativeFinalPath,
      bytesWritten: 0,
      contentType: variant === 'full' ? (media.mime ?? 'application/octet-stream') : 'application/octet-stream',
      totalSize: variant === 'full' ? media.size : null,
      complete: false,
      error: null,
      reservedBytes: 0,
      ready,
      resolveReady,
      rejectReady,
      listeners: new Set(),
    };
  }

  private async runTask(media: MediaRow, task: FetchTask): Promise<void> {
    await this.acquireFetchSlot();
    let file: Awaited<ReturnType<typeof open>> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      file = await open(task.finalPath, 'w');
      const response = await this.options.origin.fetch(task.key, task.variant);
      if (!response.ok || response.body === null) {
        throw new MediaFetchError(response.status, response.headers.get('Retry-After') ?? undefined);
      }
      task.contentType = response.headers.get('Content-Type') ?? task.contentType;
      reader = response.body.getReader();
      const contentLengthHeader = response.headers.get('Content-Length');
      const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
      if (contentLength !== null && Number.isSafeInteger(contentLength) && contentLength >= 0) {
        await this.expandReservation(task, contentLength);
        task.totalSize = contentLength;
      }
      task.resolveReady();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await this.expandReservation(task, task.bytesWritten + value.byteLength);
        await file.write(value, 0, value.byteLength, task.bytesWritten);
        task.bytesWritten += value.byteLength;
        notify(task);
      }
      await file.sync();
      await file.close();
      if (task.totalSize !== null && task.bytesWritten !== task.totalSize) {
        throw new Error(`Telegram media size mismatch: expected ${task.totalSize}, got ${task.bytesWritten}`);
      }
      const now = this.nowSeconds();
      this.reservedBytes -= task.reservedBytes;
      task.reservedBytes = 0;
      upsertMediaCache(this.options.db, {
        mediaKey: task.key,
        variant: task.variant,
        path: task.relativeFinalPath,
        size: task.bytesWritten,
        cachedAt: now,
        lastAccessedAt: now,
      });
      task.complete = true;
      notify(task);
      await this.evictTo(this.options.maxBytes);
    } catch (error) {
      task.error = error;
      await reader?.cancel(error).catch(() => undefined);
      await file?.close().catch(() => undefined);
      await unlink(task.finalPath).catch(() => undefined);
      task.rejectReady(error);
      notify(task);
    } finally {
      this.releaseFetchSlot();
    }
  }

  private async acquireFetchSlot(): Promise<void> {
    const limit = this.options.maxConcurrentFetches ?? 2;
    if (this.activeFetches < limit) {
      this.activeFetches += 1;
      return;
    }
    await new Promise<void>((resolve) => this.fetchWaiters.push(resolve));
  }

  private releaseFetchSlot(): void {
    const waiter = this.fetchWaiters.shift();
    if (waiter !== undefined) {
      waiter();
      return;
    }
    this.activeFetches -= 1;
  }

  private async reserve(expectedBytes: number): Promise<number> {
    if (expectedBytes > this.options.maxBytes) throw new MediaFetchError(507);
    await this.withCapacityLock(async () => {
      await this.ensureCapacity(expectedBytes);
      this.reservedBytes += expectedBytes;
    });
    return expectedBytes;
  }

  private async expandReservation(task: FetchTask, requiredBytes: number): Promise<void> {
    if (requiredBytes <= task.reservedBytes) return;
    if (requiredBytes > this.options.maxBytes) throw new MediaFetchError(507);
    await this.withCapacityLock(async () => {
      const additionalBytes = requiredBytes - task.reservedBytes;
      await this.ensureCapacity(additionalBytes);
      this.reservedBytes += additionalBytes;
      task.reservedBytes = requiredBytes;
    });
  }

  private async ensureCapacity(additionalBytes: number): Promise<void> {
    const current = listMediaCache(this.options.db).reduce((sum, entry) => sum + entry.size, 0);
    if (current + this.reservedBytes + additionalBytes > this.options.maxBytes) {
      await this.evictTo(
        Math.max(0, this.options.lowWatermarkBytes - this.reservedBytes - additionalBytes),
      );
    }
    const afterEviction = listMediaCache(this.options.db).reduce(
      (sum, entry) => sum + entry.size,
      0,
    );
    if (afterEviction + this.reservedBytes + additionalBytes > this.options.maxBytes) {
      throw new MediaFetchError(503, '5');
    }
  }

  private async withCapacityLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.capacityTail;
    let release!: () => void;
    this.capacityTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async evictTo(targetBytes: number): Promise<void> {
    const entries = listMediaCache(this.options.db);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= targetBytes) break;
      if (this.tasks.has(`${entry.mediaKey}:${entry.variant}`)) continue;
      await this.evict(entry.mediaKey, entry.variant, entry.path);
      total -= entry.size;
    }
  }

  private async evict(mediaKey: string, variant: MediaCacheVariant, relativePath: string): Promise<void> {
    if (this.tasks.has(`${mediaKey}:${variant}`)) return;
    await unlink(this.resolveCachePath(relativePath)).catch(() => undefined);
    deleteMediaCache(this.options.db, mediaKey, variant);
  }

  private resolveCachePath(relativePath: string): string {
    const absolute = path.resolve(this.options.dataDir, relativePath);
    if (!absolute.startsWith(path.resolve(this.cacheRoot) + path.sep) && absolute !== path.resolve(this.cacheRoot)) {
      throw new Error('Invalid media cache path');
    }
    return absolute;
  }

  private nowSeconds(): number {
    return Math.floor((this.options.now ?? Date.now)() / 1000);
  }
}

export class HttpMediaOriginClient implements MediaOriginClient {
  constructor(
    private readonly port: number,
    private readonly secret: string,
  ) {}

  fetch(mediaKey: string, variant: MediaCacheVariant): Promise<Response> {
    return fetch(
      `http://127.0.0.1:${this.port}/internal/media/${encodeURIComponent(mediaKey)}?variant=${variant}`,
      { headers: { Authorization: `Bearer ${this.secret}` } },
    );
  }
}

function growingFileStream(task: FetchTask, start: number, end?: number): Readable {
  return Readable.from(
    (async function* () {
      let position = start;
      const limit = end ?? Number.POSITIVE_INFINITY;
      for (;;) {
          if (position <= limit && position < task.bytesWritten) {
            const available = Math.min(task.bytesWritten - position, limit - position + 1, 256 * 1024);
            const handle = await open(task.finalPath, 'r');
            try {
              const buffer = Buffer.allocUnsafe(available);
              const { bytesRead } = await handle.read(buffer, 0, available, position);
              if (bytesRead > 0) {
                position += bytesRead;
                yield buffer.subarray(0, bytesRead);
                continue;
              }
            } finally {
              await handle.close();
            }
          }
          if (task.error !== null) throw task.error;
          if (task.complete || position > limit) return;
          await waitForProgress(task);
      }
    })(),
  );
}

function waitForProgress(task: FetchTask): Promise<void> {
  return new Promise((resolve) => task.listeners.add(resolve));
}

function notify(task: FetchTask): void {
  const listeners = [...task.listeners];
  task.listeners.clear();
  for (const listener of listeners) listener();
}

async function sniffImageMime(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (bytesRead >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (bytesRead >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'image/png';
    if (bytesRead >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
    return 'application/octet-stream';
  } finally {
    await handle.close();
  }
}
