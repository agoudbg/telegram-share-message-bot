// Media streaming endpoint (docs/PLAN.md, Phase 3 Commit 11):
// GET /media/:shareId/:key — Range support, correct Content-Type, strong
// caching, 404/410.
//
// :key is the share-scoped fake media key from the share API's media map
// (real document/photo ids never appear in URLs); it is resolved back to the
// media row by recomputing fake keys of the share's linked media. `?thumb=1`
// serves the extracted thumbnail instead of the file itself.

import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { Context, Hono } from 'hono';

import type { StorageDatabase } from '../storage/database.js';
import { MediaFetchError } from '../mediaCache.js';
import type { MediaCache } from '../mediaCache.js';
import type { MediaRequestGovernor } from '../mediaGovernor.js';
import { checkShareAccess } from './gate.js';
import { createShareSanitizer, resolveMediaKey } from './sanitize.js';

export interface MediaRouteDeps {
  db: StorageDatabase;
  sanitizeSecret: string;
  /** Base directory holding media/ (media rows store paths relative to it) */
  dataDir: string;
  mediaCache?: MediaCache;
  maxHostedMediaBytes?: number;
  mediaGovernor?: MediaRequestGovernor;
  trustProxy?: boolean;
}

/** Media keys are content-stable (document/photo ids), so responses are
 *  immutable and cacheable forever. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const AVATAR_CACHE_CONTROL = 'public, max-age=3600';

interface ByteRange {
  start: number;
  end: number;
}

/** Parse a single-range `Range: bytes=…` header. Returns null when there is
 *  no (single bytes) range — the full file is served; 'invalid' for ranges
 *  that cannot be satisfied (→ 416). */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): ByteRange | 'invalid' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null; // not a single bytes range; serve the full file
  const [, startRaw, endRaw] = match as unknown as [string, string, string];
  if (startRaw === '' && endRaw === '') return 'invalid';

  if (startRaw === '') {
    // Suffix range: the last N bytes. When N exceeds the representation
    // length the entire representation is used (RFC 7233 §5.3.4)
    const suffix = Number(endRaw);
    if (suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - Math.min(suffix, size)), end: size - 1 };
  }

  const start = Number(startRaw);
  const end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1);
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

export function registerMediaRoutes(app: Hono, deps: MediaRouteDeps): void {
  app.get('/media/:shareId/:key', async (c) => {
    const { shareId, key } = c.req.param();

    const access = checkShareAccess(deps.db, shareId);
    if (access === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (access === 'revoked') return c.json({ error: 'revoked' }, 410);
    const clientId = getClientId(c, deps.trustProxy === true);
    if (deps.mediaGovernor !== undefined && !deps.mediaGovernor.allowRequest(shareId, clientId)) {
      return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '1' });
    }

    const sanitizer = createShareSanitizer(deps.sanitizeSecret, shareId);
    const media = resolveMediaKey(deps.db, sanitizer, shareId, key);
    if (media === null) return c.json({ error: 'not_found' }, 404);

    const thumb = c.req.query('thumb') === '1';
    const relPath = thumb ? media.thumbPath : media.path;
    if (!media.hosted || !isMediaWithinHostingLimit(media.size, deps.maxHostedMediaBytes)) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (relPath === null && deps.mediaCache !== undefined) {
      try {
        const variant = media.key.startsWith('avatar_') ? 'avatar' : thumb ? 'thumb' : 'full';
        const cached = await deps.mediaCache.open(media, variant, c.req.raw.signal);
        return streamHandle(
          c,
          cached,
          c.req.header('range'),
          media.key.startsWith('avatar_') ? AVATAR_CACHE_CONTROL : CACHE_CONTROL,
          deps.mediaGovernor,
          shareId,
          clientId,
        );
      } catch (error) {
        if (error instanceof MediaFetchError) {
          const headers = error.retryAfter === undefined ? undefined : { 'Retry-After': error.retryAfter };
          return c.json(
            { error: error.status === 404 ? 'not_found' : 'media_unavailable' },
            error.status === 404 ? 404 : 503,
            headers,
          );
        }
        return c.json({ error: 'media_unavailable' }, 503, { 'Retry-After': '5' });
      }
    }
    if (relPath === null) return c.json({ error: 'not_found' }, 404);

    // Stored paths are server-written, but never trust them blindly
    const mediaRoot = path.resolve(deps.dataDir, 'media');
    const absPath = path.resolve(deps.dataDir, relPath);
    if (!absPath.startsWith(mediaRoot + path.sep)) {
      return c.json({ error: 'not_found' }, 404);
    }

    let size: number;
    try {
      size = (await stat(absPath)).size;
    } catch {
      return c.json({ error: 'not_found' }, 404); // registered but missing on disk
    }

    // Thumbnails have no stored mime; document thumbs can be WebP (stickers)
    // rather than JPEG, so sniff the magic bytes instead of hardcoding
    const contentType = thumb
      ? ((await sniffImageMime(absPath)) ?? 'application/octet-stream')
      : (media.mime ?? 'application/octet-stream');

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': media.key.startsWith('avatar_') ? AVATAR_CACHE_CONTROL : CACHE_CONTROL,
    };

    if (size === 0) {
      headers['Content-Length'] = '0';
      return c.body(null, 200, headers);
    }

    const range = parseRangeHeader(c.req.header('range'), size);
    if (range === 'invalid') {
      return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${size}` });
    }

    const { start, end } = range ?? { start: 0, end: size - 1 };
    headers['Content-Length'] = String(end - start + 1);
    const status = range === null ? 200 : 206;
    if (range !== null) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

    const source = createReadStream(absPath, { start, end, signal: c.req.raw.signal });
    const stream = toWebStream(
      source,
      deps.mediaGovernor,
      shareId,
      clientId,
      c.req.raw.signal,
    );
    return c.body(stream, status, headers);
  });
}

export function isMediaWithinHostingLimit(
  size: number | null,
  maxHostedMediaBytes: number | undefined,
): boolean {
  return size === null || maxHostedMediaBytes === undefined || size <= maxHostedMediaBytes;
}

function streamHandle(
  c: Context,
  handle: Awaited<ReturnType<MediaCache['open']>>,
  rangeHeader: string | undefined,
  cacheControl: string,
  governor: MediaRequestGovernor | undefined,
  shareId: string,
  clientId: string,
) {
  const headers: Record<string, string> = {
    'Content-Type': handle.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
  };
  if (handle.size === null) {
    return c.body(
      toWebStream(handle.stream(0, undefined, c.req.raw.signal), governor, shareId, clientId, c.req.raw.signal),
      200,
      headers,
    );
  }
  if (handle.size === 0) {
    headers['Content-Length'] = '0';
    return c.body(null, 200, headers);
  }
  const range = parseRangeHeader(rangeHeader, handle.size);
  if (range === 'invalid') {
    return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${handle.size}` });
  }
  const { start, end } = range ?? { start: 0, end: handle.size - 1 };
  headers['Content-Length'] = String(end - start + 1);
  const status = range === null ? 200 : 206;
  if (range !== null) headers['Content-Range'] = `bytes ${start}-${end}/${handle.size}`;
  return c.body(
    toWebStream(
      handle.stream(start, end, c.req.raw.signal),
      governor,
      shareId,
      clientId,
      c.req.raw.signal,
    ),
    status,
    headers,
  );
}

interface ClientAddressInput {
  remoteAddress?: string;
  forwardedFor?: string;
}

interface NodeRequestBindings {
  incoming?: {
    socket?: {
      remoteAddress?: unknown;
    };
  };
  server?: NodeRequestBindings;
}

export function resolveMediaClientId(input: ClientAddressInput, trustProxy: boolean): string {
  if (trustProxy) {
    const forwardedAddress = input.forwardedFor?.split(',')[0]?.trim();
    if (forwardedAddress !== undefined && isIP(forwardedAddress) !== 0) {
      return forwardedAddress;
    }
  }
  const remoteAddress = input.remoteAddress?.trim();
  return remoteAddress !== undefined && isIP(remoteAddress) !== 0 ? remoteAddress : 'unknown';
}

function getClientId(c: Context, trustProxy: boolean): string {
  const environment = (c.env ?? {}) as NodeRequestBindings;
  const bindings = environment.server ?? environment;
  const remoteAddress = bindings.incoming?.socket?.remoteAddress;
  return resolveMediaClientId(
    {
      remoteAddress: typeof remoteAddress === 'string' ? remoteAddress : undefined,
      forwardedFor: c.req.header('x-forwarded-for'),
    },
    trustProxy,
  );
}

function toWebStream(
  source: Readable,
  governor: MediaRequestGovernor | undefined,
  shareId: string,
  clientId: string,
  signal: AbortSignal,
): ReadableStream {
  if (governor === undefined) return Readable.toWeb(source) as ReadableStream;
  const throttled = Readable.from(
    (async function* () {
      for await (const chunk of source) {
        const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
        await governor.throttle(shareId, clientId, bytes, signal);
        yield chunk;
      }
    })(),
    { signal },
  );
  return Readable.toWeb(throttled) as ReadableStream;
}

/** Detect the image type of a thumbnail from its magic bytes; null when
 *  unrecognized (caller falls back to application/octet-stream). */
async function sniffImageMime(file: string): Promise<string | null> {
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return 'image/jpeg';
    }
    if (
      bytesRead >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return 'image/webp';
    }
    if (bytesRead >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
    if (bytesRead >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
    return null;
  } finally {
    await handle.close();
  }
}
