// Share helpers tests (Phase 2 Commit 9): ids, links, deep-link payloads,
// rate limiting and the send queue.

import { describe, expect, it } from 'vitest';

import {
  RateLimiter,
  SendQueue,
  buildShareLinks,
  buildShareReply,
  createShareId,
  parseGetPayload,
} from '../src/shares.js';

describe('createShareId', () => {
  it('is URL-safe, unique and unguessable-length', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createShareId()));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    }
  });
});

describe('buildShareLinks / buildShareReply', () => {
  const config = {
    publicOrigin: 'https://share.example.com',
    botUsername: 'mybot',
    miniAppShortName: 'view',
  };

  it('builds the HTTPS page link and the Mini App direct link', () => {
    const links = buildShareLinks(config, 'abc123');
    expect(links.webUrl).toBe('https://share.example.com/s/abc123');
    expect(links.directLink).toBe('https://t.me/mybot/view?startapp=abc123');
  });

  it('omits the direct link when no Mini App short name is configured', () => {
    const links = buildShareLinks({ ...config, miniAppShortName: undefined }, 'abc123');
    expect(links.directLink).toBeNull();
  });

  it('does not describe on-demand media as unhosted', () => {
    const reply = buildShareReply(buildShareLinks(config, 'x'), 3, {
      hosted: 3,
      unhosted: 0,
      failed: 0,
    });
    expect(reply).toContain('https://share.example.com/s/x');
    expect(reply).not.toContain('View in Telegram');
    expect(reply).toContain('3 messages');
  });
});

describe('parseGetPayload', () => {
  it('parses get_<shareId>_<seq>', () => {
    expect(parseGetPayload('get_abc-D_e42_7')).toEqual({ shareId: 'abc-D_e42', seq: 7 });
  });

  it('rejects malformed payloads', () => {
    expect(parseGetPayload('')).toBeNull();
    expect(parseGetPayload('abc')).toBeNull();
    expect(parseGetPayload('get_abc')).toBeNull();
    expect(parseGetPayload('get_abc_x')).toBeNull();
    expect(parseGetPayload('get__1')).toBeNull();
  });
});

describe('RateLimiter', () => {
  it('allows one action per interval per key', () => {
    let now = 1000;
    const limiter = new RateLimiter(3000, () => now);

    expect(limiter.allow('u1')).toBe(true);
    expect(limiter.allow('u1')).toBe(false);
    expect(limiter.allow('u2')).toBe(true);

    now += 3000;
    expect(limiter.allow('u1')).toBe(true);
  });
});

describe('SendQueue', () => {
  it('serializes jobs even when one fails', async () => {
    const queue = new SendQueue();
    const order: string[] = [];
    const job =
      (name: string, fail = false) =>
      () =>
        new Promise<string>((resolve, reject) => {
          setTimeout(() => {
            order.push(name);
            if (fail) reject(new Error(name));
            else resolve(name);
          }, 5);
        });

    const first = queue.enqueue(job('a'));
    const second = queue.enqueue(job('b', true));
    const third = queue.enqueue(job('c'));

    await expect(first).resolves.toBe('a');
    await expect(second).rejects.toThrow('b');
    await expect(third).resolves.toBe('c');
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
