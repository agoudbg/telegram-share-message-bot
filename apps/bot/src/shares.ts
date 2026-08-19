// Share creation helpers, deep-link payloads and send rate limiting
// (docs/PLAN.md, Phase 2 Commit 9; §2.5 oversized-file fallback).

import { randomBytes } from 'node:crypto';

/** Random unguessable share id (§2.8: share pages are public by default, so
 *  the id is the capability). 72 bits of entropy, URL-safe. */
export function createShareId(): string {
  return randomBytes(9).toString('base64url');
}

export interface ShareLinks {
  /** Public HTTPS page served by apps/web */
  webUrl: string;
  /** t.me direct link opening the Mini App (when configured) */
  directLink: string | null;
}

export function buildShareLinks(
  config: { publicOrigin: string; botUsername: string; miniAppShortName?: string },
  shareId: string,
): ShareLinks {
  return {
    webUrl: `${config.publicOrigin}/s/${shareId}`,
    directLink:
      config.miniAppShortName !== undefined
        ? `https://t.me/${config.botUsername}/${config.miniAppShortName}?startapp=${shareId}`
        : null,
  };
}

export function buildShareReply(
  links: ShareLinks,
  messageCount: number,
  media: { hosted: number; unhosted: number; failed: number },
): string {
  const lines = [
    `✅ Batch ready — ${messageCount} message${messageCount === 1 ? '' : 's'}.`,
    ``,
    `🔗 ${links.webUrl}`,
  ];
  if (links.directLink !== null) lines.push(`📱 ${links.directLink}`);
  if (media.failed > 0) {
    lines.push(`⚠️ ${media.failed} media registration${media.failed === 1 ? '' : 's'} failed.`);
  }
  return lines.join('\n');
}

/** Parse a `/start get_<shareId>_<seq>` deep-link payload (§2.5). */
export function parseGetPayload(payload: string): { shareId: string; seq: number } | null {
  const match = /^get_([A-Za-z0-9_-]+)_(\d+)$/.exec(payload.trim());
  if (match === null) return null;
  return { shareId: match[1]!, seq: Number(match[2]) };
}

/** Per-key fixed-interval rate limiter (one action per interval per key). */
export class RateLimiter {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const previous = this.last.get(key);
    const current = this.now();
    if (previous !== undefined && current - previous < this.intervalMs) return false;
    this.last.set(key, current);
    return true;
  }
}

/** FIFO queue serializing outbound sends so FloodWait absorption in one send
 *  does not interleave with the next (docs/PLAN.md §6). */
export class SendQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
