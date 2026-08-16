// Batching engine tests (Phase 2 Commit 7 acceptance: fake-timer integration
// tests for the sliding silence window, Done button, /cancel, album order
// and the online nested-forward marking).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TLJsonObject } from '@tbfb/tlbridge';

import type { Batch, BatchCallbacks } from '../src/batching.js';
import { BatchManager, createForwardTracker, sortAlbumItems } from '../src/batching.js';
import type { NormalizedMessage } from '../src/ports.js';

const SILENCE_MS = 2000;

function msg(chatId: string, id: number, fwdDate?: number, groupedId?: string): NormalizedMessage {
  const tlJson: TLJsonObject = { className: 'Message', id };
  if (fwdDate !== undefined) {
    tlJson.fwdFrom = {
      className: 'MessageFwdHeader',
      date: fwdDate,
      fromId: { className: 'PeerUser', userId: { $long: '123' } },
    };
  }
  return {
    chatId,
    messageId: id,
    text: '',
    isPrivate: true,
    isForward: fwdDate !== undefined,
    groupedId,
    tlJson,
    raw: undefined,
  };
}

interface Recorder {
  callbacks: BatchCallbacks;
  started: string[];
  items: Array<{ batchId: string; seq: number; nested: boolean }>;
  finalized: Batch[];
}

function recorder(): Recorder {
  const rec: Recorder = {
    started: [],
    items: [],
    finalized: [],
    callbacks: {
      onBatchStart: (batchId) => {
        rec.started.push(batchId);
      },
      onBatchMessage: (batchId, item) => {
        rec.items.push({ batchId, seq: item.seq, nested: item.nestedForward });
      },
      onBatchFinalize: (batch) => {
        rec.finalized.push(batch);
      },
    },
  };
  return rec;
}

describe('BatchManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('finalizes after the sliding silence window', async () => {
    const rec = recorder();
    const manager = new BatchManager({ silenceMs: SILENCE_MS, callbacks: rec.callbacks });

    expect(manager.handle(msg('u1', 1, 100))).toMatchObject({ started: true });
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1);
    expect(rec.finalized).toHaveLength(0);

    // A new message resets the window
    expect(manager.handle(msg('u1', 2, 100))).toMatchObject({ started: false });
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1);
    expect(rec.finalized).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(rec.finalized).toHaveLength(1);
    expect(rec.finalized[0]!.items).toHaveLength(2);
  });

  it('finishNow finalizes immediately and only once', async () => {
    const rec = recorder();
    const manager = new BatchManager({ silenceMs: SILENCE_MS, callbacks: rec.callbacks });

    manager.handle(msg('u1', 1, 100));
    expect(await manager.finishNow('u1')).toBe(true);
    expect(rec.finalized).toHaveLength(1);

    expect(await manager.finishNow('u1')).toBe(false);
    await vi.advanceTimersByTimeAsync(SILENCE_MS * 2);
    expect(rec.finalized).toHaveLength(1);
  });

  it('cancel drops the batch without finalizing', async () => {
    const rec = recorder();
    const manager = new BatchManager({ silenceMs: SILENCE_MS, callbacks: rec.callbacks });

    manager.handle(msg('u1', 1, 100));
    expect(manager.cancel('u1')).not.toBeNull();
    expect(manager.cancel('u1')).toBeNull();
    await vi.advanceTimersByTimeAsync(SILENCE_MS * 2);
    expect(rec.finalized).toHaveLength(0);
  });

  it('keeps batches per user isolated', async () => {
    const rec = recorder();
    const manager = new BatchManager({ silenceMs: SILENCE_MS, callbacks: rec.callbacks });

    manager.handle(msg('u1', 1, 100));
    manager.handle(msg('u2', 9, 100));
    expect(rec.started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(rec.finalized.map((b) => b.chatId).sort()).toEqual(['u1', 'u2']);
  });

  it('marks nested forwards online (strictly earlier only)', () => {
    const rec = recorder();
    const manager = new BatchManager({ silenceMs: SILENCE_MS, callbacks: rec.callbacks });

    manager.handle(msg('u1', 1, 100));
    manager.handle(msg('u1', 2, 100)); // same second: never nested
    manager.handle(msg('u1', 3, 50)); // strictly earlier: nested
    manager.handle(msg('u1', 4, 80)); // later again: not nested

    expect(rec.items.map((i) => i.nested)).toEqual([false, false, true, false]);
  });
});

describe('createForwardTracker', () => {
  it('matches markNestedForwards semantics, including same-second adjacency', () => {
    const tracker = createForwardTracker();
    const dates = [100, 100, 99, 99, 100, 42];
    const marks = dates.map((d) =>
      tracker.next({
        className: 'Message',
        fwdFrom: { className: 'MessageFwdHeader', date: d },
      }),
    );
    expect(marks).toEqual([false, false, true, false, false, true]);
  });

  it('ignores messages without fwdFrom without resetting the baseline', () => {
    const tracker = createForwardTracker();
    expect(tracker.next({ className: 'Message', fwdFrom: { date: 100 } })).toBe(false);
    expect(tracker.next({ className: 'Message' })).toBe(false);
    expect(tracker.next({ className: 'Message', fwdFrom: { date: 50 } })).toBe(true);
  });
});

describe('sortAlbumItems', () => {
  it('sorts consecutive album items by message id, keeping everything else', () => {
    const items = [
      { message: msg('u', 5), seq: 0, nestedForward: false },
      { message: msg('u', 8, undefined, 'g1'), seq: 1, nestedForward: false },
      { message: msg('u', 6, undefined, 'g1'), seq: 2, nestedForward: false },
      { message: msg('u', 7, undefined, 'g1'), seq: 3, nestedForward: false },
      { message: msg('u', 9), seq: 4, nestedForward: false },
      { message: msg('u', 3, undefined, 'g2'), seq: 5, nestedForward: false },
      { message: msg('u', 2, undefined, 'g2'), seq: 6, nestedForward: false },
    ];
    const sorted = sortAlbumItems(items);
    expect(sorted.map((i) => i.message.messageId)).toEqual([5, 6, 7, 8, 9, 2, 3]);
  });
});
