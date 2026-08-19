// Media streaming endpoint tests (docs/PLAN.md, Phase 3 Commit 11
// acceptance): Range requests, Content-Type, caching headers, 404/410.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createServerApp } from '../src/api/app.js';
import { MediaCache } from '../src/mediaCache.js';
import { createShareSanitizer, sanitizeMediaKey } from '../src/api/sanitize.js';
import { openDatabase } from '../src/storage/database.js';
import {
  createShare,
  finalizeShare,
  insertMediaIfAbsent,
  linkMediaToShare,
  revokeShare,
  upsertMediaSource,
} from '../src/storage/repository.js';

const SECRET = 'test-secret';
const SHARE_ID = 'share-a';
const CONTENT = 'hello world'; // 11 bytes
/** JPEG magic + payload, so the thumb mime sniffing recognizes it */
const THUMB = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('thumb!')]);
const WEBP_THUMB = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP'),
  Buffer.from('sticker'),
]);

const dirs: string[] = [];
const caches: MediaCache[] = [];

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tbfb-server-'));
  dirs.push(dataDir);
  await mkdir(path.join(dataDir, 'media'));
  const db = openDatabase(':memory:');
  createShare(db, { id: SHARE_ID, ownerUserId: 'u1' });
  insertMediaIfAbsent(db, {
    key: '12345',
    hosted: true,
    path: 'media/12345',
    mime: 'text/plain',
    size: CONTENT.length,
    thumbPath: 'media/12345_thumb.jpg',
  });
  linkMediaToShare(db, SHARE_ID, '12345');
  await writeFile(path.join(dataDir, 'media', '12345'), CONTENT);
  await writeFile(path.join(dataDir, 'media', '12345_thumb.jpg'), THUMB);
  finalizeShare(db, SHARE_ID);

  const app = createServerApp({ db, sanitizeSecret: SECRET, dataDir });
  const fakeKey = sanitizeMediaKey(createShareSanitizer(SECRET, SHARE_ID), '12345');
  return { db, app, dataDir, fakeKey, url: `/media/${SHARE_ID}/${fakeKey}` };
}

afterAll(async () => {
  for (const cache of caches) cache.close();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('GET /media/:shareId/:key', () => {
  it('streams the full file with type, caching and range headers', async () => {
    const { app, url } = await setup();
    const res = await app.request(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    expect(res.headers.get('Content-Length')).toBe(String(CONTENT.length));
    expect(await res.text()).toBe(CONTENT);
  });

  it('serves bounded, open-ended and suffix ranges', async () => {
    const { app, url } = await setup();

    const bounded = await app.request(url, { headers: { Range: 'bytes=0-4' } });
    expect(bounded.status).toBe(206);
    expect(bounded.headers.get('Content-Range')).toBe(`bytes 0-4/${CONTENT.length}`);
    expect(bounded.headers.get('Content-Length')).toBe('5');
    expect(await bounded.text()).toBe('hello');

    const open = await app.request(url, { headers: { Range: 'bytes=6-' } });
    expect(open.status).toBe(206);
    expect(await open.text()).toBe('world');

    const suffix = await app.request(url, { headers: { Range: 'bytes=-5' } });
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe('world');

    // A suffix longer than the file yields the whole file (RFC 7233 §5.3.4)
    const hugeSuffix = await app.request(url, {
      headers: { Range: 'bytes=-99999999999999999999' },
    });
    expect(hugeSuffix.status).toBe(206);
    expect(hugeSuffix.headers.get('Content-Range')).toBe(`bytes 0-10/${CONTENT.length}`);
    expect(await hugeSuffix.text()).toBe(CONTENT);

    // End beyond the file clamps to the last byte
    const clamped = await app.request(url, { headers: { Range: 'bytes=9-100' } });
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get('Content-Range')).toBe(`bytes 9-10/${CONTENT.length}`);
    expect(await clamped.text()).toBe('ld');
  });

  it('streams a cold Telegram source into the cache and reuses it', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'tbfb-server-remote-'));
    dirs.push(dataDir);
    const db = openDatabase(':memory:');
    createShare(db, { id: SHARE_ID, ownerUserId: 'u1' });
    insertMediaIfAbsent(db, {
      key: 'remote',
      hosted: true,
      path: null,
      mime: 'text/plain',
      size: CONTENT.length,
    });
    upsertMediaSource(db, {
      mediaKey: 'remote',
      kind: 'document',
      sourcePeerId: 'u1',
      sourceMessageId: 7,
      reference: '{}',
    });
    linkMediaToShare(db, SHARE_ID, 'remote');
    finalizeShare(db, SHARE_ID);

    let fetches = 0;
    const cache = new MediaCache({
      db,
      dataDir,
      origin: {
        fetch: () => {
          fetches += 1;
          return Promise.resolve(
            new Response(CONTENT, {
              headers: { 'Content-Type': 'text/plain', 'Content-Length': String(CONTENT.length) },
            }),
          );
        },
      },
      maxBytes: 1024,
      lowWatermarkBytes: 768,
      ttlSeconds: 86400,
      sweepIntervalSeconds: 3600,
    });
    caches.push(cache);
    const app = createServerApp({ db, sanitizeSecret: SECRET, dataDir, mediaCache: cache });
    const fakeKey = sanitizeMediaKey(createShareSanitizer(SECRET, SHARE_ID), 'remote');
    const url = `/media/${SHARE_ID}/${fakeKey}`;

    const range = await app.request(url, { headers: { Range: 'bytes=6-' } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe('world');
    expect(await (await app.request(url)).text()).toBe(CONTENT);
    expect(fetches).toBe(1);
  });

  it('answers 416 for unsatisfiable ranges', async () => {
    const { app, url } = await setup();
    const res = await app.request(url, { headers: { Range: 'bytes=50-60' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe(`bytes */${CONTENT.length}`);
  });

  it('serves thumbnails via ?thumb=1 with the sniffed image type', async () => {
    const { db, app, dataDir, url } = await setup();

    const thumb = await app.request(`${url}?thumb=1`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('Content-Type')).toBe('image/jpeg');
    expect(Buffer.from(await thumb.arrayBuffer()).equals(THUMB)).toBe(true);

    // Sticker-style WebP thumbnails are detected too
    insertMediaIfAbsent(db, {
      key: '4242',
      hosted: true,
      path: 'media/12345',
      mime: 'image/webp',
      thumbPath: 'media/4242_thumb',
    });
    linkMediaToShare(db, SHARE_ID, '4242');
    await writeFile(path.join(dataDir, 'media', '4242_thumb'), WEBP_THUMB);
    const fake4242 = sanitizeMediaKey(createShareSanitizer(SECRET, SHARE_ID), '4242');
    const webp = await app.request(`/media/${SHARE_ID}/${fake4242}?thumb=1`);
    expect(webp.status).toBe(200);
    expect(webp.headers.get('Content-Type')).toBe('image/webp');
    expect(Buffer.from(await webp.arrayBuffer()).equals(WEBP_THUMB)).toBe(true);
  });

  it('404s ?thumb=1 when the media has no thumbnail', async () => {
    const { db, app } = await setup();
    insertMediaIfAbsent(db, { key: '999', hosted: true, path: 'media/12345', mime: 'text/plain' });
    linkMediaToShare(db, SHARE_ID, '999');
    const fake999 = sanitizeMediaKey(createShareSanitizer(SECRET, SHARE_ID), '999');
    const missing = await app.request(`/media/${SHARE_ID}/${fake999}?thumb=1`);
    expect(missing.status).toBe(404);
  });

  it('answers 404 for unknown keys, unlinked media and unhosted files', async () => {
    const { db, app } = await setup();
    const sanitizer = createShareSanitizer(SECRET, SHARE_ID);

    expect((await app.request(`/media/${SHARE_ID}/4611686018427387904`)).status).toBe(404);

    // In the media table but not linked to this share → not resolvable
    insertMediaIfAbsent(db, { key: '777', hosted: true, path: 'media/12345' });
    const fake777 = sanitizeMediaKey(sanitizer, '777');
    expect((await app.request(`/media/${SHARE_ID}/${fake777}`)).status).toBe(404);

    // Unhosted (oversized fallback): registered but no file to stream
    insertMediaIfAbsent(db, { key: '888', hosted: false, reference: null });
    linkMediaToShare(db, SHARE_ID, '888');
    const fake888 = sanitizeMediaKey(sanitizer, '888');
    expect((await app.request(`/media/${SHARE_ID}/${fake888}`)).status).toBe(404);
  });

  it('answers 404 for pending shares and 410 for revoked ones', async () => {
    const { db, app, fakeKey } = await setup();

    createShare(db, { id: 'share-pending', ownerUserId: 'u1' });
    expect((await app.request(`/media/share-pending/${fakeKey}`)).status).toBe(404);

    revokeShare(db, SHARE_ID, 'u1');
    const res = await app.request(`/media/${SHARE_ID}/${fakeKey}`);
    expect(res.status).toBe(410);
  });

  it('refuses stored paths escaping the media directory', async () => {
    const { db, app, dataDir } = await setup();
    await writeFile(path.join(dataDir, 'secret.txt'), 'nope');
    insertMediaIfAbsent(db, { key: '666', hosted: true, path: 'secret.txt' });
    linkMediaToShare(db, SHARE_ID, '666');
    const fake666 = sanitizeMediaKey(createShareSanitizer(SECRET, SHARE_ID), '666');
    expect((await app.request(`/media/${SHARE_ID}/${fake666}`)).status).toBe(404);
  });
});
