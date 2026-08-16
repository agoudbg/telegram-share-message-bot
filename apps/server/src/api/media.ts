// Media streaming endpoint (docs/PLAN.md, Phase 3 Commit 11):
// GET /media/:shareId/:key — Range support, correct Content-Type, strong
// caching, 404/410.
//
// :key is the share-scoped fake media key from the share API's media map
// (real document/photo ids never appear in URLs); it is resolved back to the
// media row by recomputing fake keys of the share's linked media. `?thumb=1`
// serves the extracted thumbnail instead of the file itself.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { Hono } from 'hono';

import type { StorageDatabase } from '../storage/database.js';
import { checkShareAccess } from './gate.js';
import { createShareSanitizer, resolveMediaKey } from './sanitize.js';

export interface MediaRouteDeps {
  db: StorageDatabase;
  sanitizeSecret: string;
  /** Base directory holding media/ (media rows store paths relative to it) */
  dataDir: string;
}

/** Media keys are content-stable (document/photo ids), so responses are
 *  immutable and cacheable forever. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

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
    // Suffix range: the last N bytes
    const suffix = Number(endRaw);
    if (suffix <= 0 || suffix > Number.MAX_SAFE_INTEGER) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
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

    const sanitizer = createShareSanitizer(deps.sanitizeSecret, shareId);
    const media = resolveMediaKey(deps.db, sanitizer, shareId, key);
    if (media === null) return c.json({ error: 'not_found' }, 404);

    const thumb = c.req.query('thumb') === '1';
    const relPath = thumb ? media.thumbPath : media.path;
    if (!media.hosted || relPath === null) return c.json({ error: 'not_found' }, 404);

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

    const headers: Record<string, string> = {
      'Content-Type': thumb ? 'image/jpeg' : (media.mime ?? 'application/octet-stream'),
      'Accept-Ranges': 'bytes',
      'Cache-Control': CACHE_CONTROL,
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

    const stream = Readable.toWeb(createReadStream(absPath, { start, end })) as ReadableStream;
    return c.body(stream, status, headers);
  });
}
