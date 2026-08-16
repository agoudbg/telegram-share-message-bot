// Media streaming endpoint tests (docs/PLAN.md, Phase 3 Commit 11
// acceptance): Range requests, Content-Type, caching headers, 404/410.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createServerApp } from '../src/api/app.js';
import { createShareSanitizer, sanitizeMediaKey } from '../src/api/sanitize.js';
import { openDatabase } from '../src/storage/database.js';
import {
  createShare,
  finalizeShare,
  insertMediaIfAbsent,
  linkMediaToShare,
  revokeShare,
} from '../src/storage/repository.js';

const SECRET = 'test-secret';
const SHARE_ID = 'share-a';
const CONTENT = 'hello world'; // 11 bytes

const dirs: string[] = [];

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
  await writeFile(path.join(dataDir, 'media', '12345_thumb.jpg'), 'thumb!');
  finalizeShare(db, SHARE_ID);

  const app = createServerApp({ db, sanitizeSecret: SECRET, dataDir });
  const fakeKey = sanitizeMediaKey(createShareSanitizer(SECRET, SHARE_ID), '12345');
  return { db, app, dataDir, fakeKey, url: `/media/${SHARE_ID}/${fakeKey}` };
}

afterAll(async () => {
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

    // End beyond the file clamps to the last byte
    const clamped = await app.request(url, { headers: { Range: 'bytes=9-100' } });
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get('Content-Range')).toBe(`bytes 9-10/${CONTENT.length}`);
    expect(await clamped.text()).toBe('ld');
  });

  it('answers 416 for unsatisfiable ranges', async () => {
    const { app, url } = await setup();
    const res = await app.request(url, { headers: { Range: 'bytes=50-60' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe(`bytes */${CONTENT.length}`);
  });

  it('serves thumbnails via ?thumb=1 and 404s when there is none', async () => {
    const { db, app, url } = await setup();

    const thumb = await app.request(`${url}?thumb=1`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('Content-Type')).toBe('image/jpeg');
    expect(await thumb.text()).toBe('thumb!');

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
