// Forward batching engine (docs/PLAN.md, Phase 2 Commit 7).
//
// Consecutive forwards from one user are grouped into one batch:
// - a sliding silence window (default ~2s) finishes the batch
// - the "Done" button / finishNow() finishes it immediately
// - /cancel drops it
// - groupedId albums keep their message-id order
// - every message is serialized + nested-forward marked + persisted by the
//   callbacks as it arrives (crash-safe in-progress batch)

import { extractForwardOrigin } from '@tbfb/tlbridge';
import type { ForwardOriginInfo, TLJsonObject } from '@tbfb/tlbridge';
import type { NormalizedMessage } from './ports.js';

export interface BatchItem {
  message: NormalizedMessage;
  seq: number;
  nestedForward: boolean;
}

export interface Batch {
  id: string;
  chatId: string;
  items: BatchItem[];
  startedAt: number;
}

export interface BatchCallbacks {
  /** A fresh batch started; persist the pending share row */
  onBatchStart(batchId: string, chatId: string): void | Promise<void>;
  /** A message joined the batch; persist it with its nested flag */
  onBatchMessage(batchId: string, item: BatchItem): void | Promise<void>;
  /** The batch is finished; run media/share finalization */
  onBatchFinalize(batch: Batch): void | Promise<void>;
  onError?(error: unknown, chatId: string): void;
}

export interface BatchManagerOptions {
  silenceMs: number;
  callbacks: BatchCallbacks;
  createBatchId?: () => string;
  now?: () => number;
}

/** Online equivalent of tlbridge markNestedForwards: mark a message as a
 *  suspected nested forward when its fwdFrom.date is strictly earlier than
 *  the previous forwarded message's (docs/PLAN.md §2.7; equality never
 *  counts). */
export function createForwardTracker(): { next(tlJson: TLJsonObject): boolean } {
  let prev: ForwardOriginInfo | null = null;
  return {
    next(tlJson: TLJsonObject): boolean {
      const cur = extractForwardOrigin(tlJson);
      const nested = cur !== null && prev !== null && cur.date < prev.date;
      if (cur) prev = cur;
      return nested;
    },
  };
}

interface ActiveBatch extends Batch {
  tracker: ReturnType<typeof createForwardTracker>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Stable order within an album: consecutive items sharing a groupedId are
 *  sorted by message id; everything else keeps arrival order. */
export function sortAlbumItems(items: BatchItem[]): BatchItem[] {
  const out = items.slice();
  let runStart = 0;
  const flush = (end: number) => {
    if (end - runStart > 1) {
      out.splice(
        runStart,
        end - runStart,
        ...out.slice(runStart, end).sort((a, b) => a.message.messageId - b.message.messageId),
      );
    }
    runStart = end;
  };
  for (let i = 1; i <= out.length; i++) {
    const sameGroup =
      i < out.length &&
      out[i]!.message.groupedId !== undefined &&
      out[i]!.message.groupedId === out[runStart]!.message.groupedId;
    if (!sameGroup) flush(i);
  }
  return out;
}

export class BatchManager {
  private readonly active = new Map<string, ActiveBatch>();

  constructor(private readonly options: BatchManagerOptions) {}

  hasActive(chatId: string): boolean {
    return this.active.has(chatId);
  }

  /** Add a forwarded message; 'started' when this opened a new batch. */
  handle(msg: NormalizedMessage): 'started' | 'added' {
    const { callbacks } = this.options;
    let batch = this.active.get(msg.chatId);
    const started = batch === undefined;
    if (batch === undefined) {
      batch = {
        id: (this.options.createBatchId ?? defaultBatchId)(),
        chatId: msg.chatId,
        items: [],
        startedAt: (this.options.now ?? Date.now)(),
        tracker: createForwardTracker(),
        timer: null,
      };
      this.active.set(msg.chatId, batch);
      void Promise.resolve(callbacks.onBatchStart(batch.id, msg.chatId)).catch((error: unknown) =>
        callbacks.onError?.(error, msg.chatId),
      );
    }

    const item: BatchItem = {
      message: msg,
      seq: batch.items.length,
      nestedForward: batch.tracker.next(msg.tlJson),
    };
    batch.items.push(item);
    void Promise.resolve(callbacks.onBatchMessage(batch.id, item)).catch((error: unknown) =>
      callbacks.onError?.(error, msg.chatId),
    );

    this.resetTimer(batch);
    return started ? 'started' : 'added';
  }

  /** Finish the active batch immediately (the "Done" button). */
  async finishNow(chatId: string): Promise<boolean> {
    if (!this.active.has(chatId)) return false;
    await this.finalize(chatId);
    return true;
  }

  /** Drop the active batch; returns the dropped batch id, if any. */
  cancel(chatId: string): string | null {
    const batch = this.active.get(chatId);
    if (batch === undefined) return null;
    if (batch.timer !== null) clearTimeout(batch.timer);
    this.active.delete(chatId);
    return batch.id;
  }

  private resetTimer(batch: ActiveBatch): void {
    if (batch.timer !== null) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      void this.finalize(batch.chatId);
    }, this.options.silenceMs);
    // Do not keep the process alive just for a pending batch window
    (batch.timer as { unref?: () => void }).unref?.();
  }

  private async finalize(chatId: string): Promise<void> {
    const batch = this.active.get(chatId);
    if (batch === undefined) return;
    if (batch.timer !== null) clearTimeout(batch.timer);
    this.active.delete(chatId);
    const finished: Batch = {
      id: batch.id,
      chatId: batch.chatId,
      items: sortAlbumItems(batch.items),
      startedAt: batch.startedAt,
    };
    try {
      await this.options.callbacks.onBatchFinalize(finished);
    } catch (error) {
      this.options.callbacks.onError?.(error, chatId);
    }
  }
}

function defaultBatchId(): string {
  return `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
