// Share creation helpers, deep-link payloads and send rate limiting
// (docs/PLAN.md, Phase 2 Commit 9; §2.5 document fallback).

import { randomBytes } from 'node:crypto';

const MAX_SHARE_ID_LENGTH = 32;
const MAX_DEEP_LINK_PAYLOAD_LENGTH = 64;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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
  const trimmed = payload.trim();
  if (trimmed.length > MAX_DEEP_LINK_PAYLOAD_LENGTH) return null;
  const match = /^get_(.+)_(\d+)$/.exec(trimmed);
  if (match === null) return null;
  const shareId = match[1]!;
  const seq = Number(match[2]);
  if (!isValidShareId(shareId) || !Number.isSafeInteger(seq) || seq < 0) return null;
  return { shareId, seq };
}

export function isValidShareId(shareId: string): boolean {
  return (
    shareId.length > 0 &&
    shareId.length <= MAX_SHARE_ID_LENGTH &&
    SHARE_ID_PATTERN.test(shareId)
  );
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
