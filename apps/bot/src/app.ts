// Bot application core: command routing, batch orchestration, share
// finalization and the document fallback (docs/PLAN.md, Phase 2
// Commits 5/7/9). teleproto-free by design — main.ts wires the real ports.

import type { StorageDatabase } from '@tbfb/server';
import {
  createShare,
  deleteShare,
  finalizeShare,
  getMedia,
  getMessage,
  getShare,
  insertMessage,
  revokeShare,
  rewriteMessageSeqs,
} from '@tbfb/server';

import type { Batch } from './batching.js';
import { BatchManager } from './batching.js';
import type { BotConfig } from './config.js';
import { MediaPipeline, extractMediaInfo, withRetry } from './media.js';
import type { BotPorts, InputDocumentRef, NormalizedMessage } from './ports.js';
import {
  RateLimiter,
  SendQueue,
  buildShareLinks,
  buildShareReply,
  createShareId,
  isValidShareId,
  parseGetPayload,
} from './shares.js';

const WELCOME_TEXT = [
  '👋 Forward me any set of messages and I will pack them into one shareable web page.',
  '',
  'Just forward multiple messages in a row — when you are done, wait ~10 seconds or tap "✅ Done".',
  'Commands: /help /privacy /cancel /delete',
].join('\n');

const HELP_TEXT = [
  'How it works:',
  '1. Forward messages to this chat (albums are kept in order).',
  '2. After ~10s of silence — or when you tap "✅ Done" — you get a public link.',
  '3. Anyone with the link can view the batch in a browser or Mini App.',
  '',
  '/cancel — drop the batch currently being collected',
  '/delete <shareId> — revoke a share (the page goes 404)',
].join('\n');

const PRIVACY_TEXT = [
  'Share pages are PUBLIC by design: anyone with the link can read the full message text and origin names.',
  'The link id is random and unguessable. Use /delete <shareId> to revoke a share at any time.',
  'Your identity as the forwarder is never exposed on the page.',
].join('\n');

const FALLBACK_RATE_LIMIT_MS = 3000;

export interface BotAppDeps {
  config: Pick<
    BotConfig,
    | 'publicOrigin'
    | 'botUsername'
    | 'miniAppShortName'
    | 'batchSilenceMs'
    | 'mediaCacheMaxBytes'
  >;
  db: StorageDatabase;
  ports: BotPorts;
  createShareId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export class BotApp {
  private readonly batches: BatchManager;
  private readonly fallbackLimiter = new RateLimiter(FALLBACK_RATE_LIMIT_MS);
  /** Per-user fallback queues: one user's FloodWait must not stall the file
   *  deliveries of everyone else */
  private readonly sendQueues = new Map<string, SendQueue>();
  private readonly shareIdFn: () => string;
  /** batchId → message id of the "Collecting your batch…" prompt (deleted
   *  once the share is ready or the batch is cancelled). Keyed by batch, not
   *  chat: a batch finalizing late must not delete the next batch's prompt. */
  private readonly collectingPrompts = new Map<string, number>();

  constructor(private readonly deps: BotAppDeps) {
    this.shareIdFn = deps.createShareId ?? createShareId;
    this.batches = new BatchManager({
      silenceMs: deps.config.batchSilenceMs,
      createBatchId: this.shareIdFn,
      callbacks: {
        onBatchStart: (batchId, chatId) => {
          createShare(deps.db, { id: batchId, ownerUserId: chatId });
        },
        onBatchMessage: (batchId, item) => {
          insertMessage(deps.db, {
            shareId: batchId,
            seq: item.seq,
            tlJson: JSON.stringify(item.message.tlJson),
            nestedForward: item.nestedForward,
          });
        },
        onBatchFinalize: async (batch) => {
          try {
            await this.finalizeBatch(batch);
          } catch (error) {
            // Never leave an orphan pending share behind: a share that
            // failed mid-finalize is dropped (a public one is kept)
            const share = getShare(deps.db, batch.id);
            if (share?.status === 'pending') deleteShare(deps.db, batch.id, batch.chatId);
            throw error;
          }
        },
        onError: (error, chatId) => {
          deps.log?.(`batch error for chat ${chatId}: ${String(error)}`);
          void deps.ports
            .sendText(
              chatId,
              '⚠️ Something went wrong while building your share. Please try again.',
            )
            .catch(() => undefined);
        },
      },
    });
  }

  /** Entry point for every incoming private message. */
  async handleMessage(msg: NormalizedMessage): Promise<void> {
    if (!msg.isPrivate) return;

    // Forwards are batch material first: Telegram preserves the original
    // text verbatim, so a forwarded "/cancel" must never hit command routing.
    if (msg.isForward) {
      const outcome = this.batches.handle(msg);
      if (outcome.started) {
        const promptId = await this.deps.ports.sendText(
          msg.chatId,
          '📥 Collecting your batch… Forward more messages, then wait a moment or tap the button.',
          { doneButton: true },
        );
        if (promptId !== undefined) this.collectingPrompts.set(outcome.batchId, promptId);
      }
      return;
    }

    const text = msg.text.trim();
    if (text.startsWith('/')) {
      await this.handleCommand(msg.chatId, text);
      return;
    }

    await this.deps.ports.sendText(
      msg.chatId,
      'Forward messages to me to build a share page. See /help.',
    );
  }

  /** "✅ Done" inline button callback. Returns false when no batch is active. */
  async handleDoneCallback(chatId: string): Promise<boolean> {
    return this.batches.finishNow(chatId);
  }

  private async handleCommand(chatId: string, text: string): Promise<void> {
    const [command = '', ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');

    switch (command.toLowerCase()) {
      case '/start': {
        const payload = parseGetPayload(arg);
        if (payload !== null) {
          await this.handleGetFallback(chatId, payload.shareId, payload.seq);
        } else if (arg.trim().startsWith('get_')) {
          await this.deps.ports.sendText(chatId, 'This media link is invalid or expired.');
        } else {
          await this.deps.ports.sendText(chatId, WELCOME_TEXT);
        }
        return;
      }
      case '/help':
        await this.deps.ports.sendText(chatId, HELP_TEXT);
        return;
      case '/privacy':
        await this.deps.ports.sendText(chatId, PRIVACY_TEXT);
        return;
      case '/cancel': {
        const batchId = this.batches.cancel(chatId);
        if (batchId !== null) {
          deleteShare(this.deps.db, batchId, chatId);
          await this.deleteCollectingPrompt(batchId, chatId);
          await this.deps.ports.sendText(chatId, '🚮 Batch cancelled.');
        } else {
          await this.deps.ports.sendText(chatId, 'No batch is being collected right now.');
        }
        return;
      }
      case '/delete': {
        if (!isValidShareId(arg)) {
          await this.deps.ports.sendText(chatId, 'Usage: /delete <shareId>');
          return;
        }
        try {
          const revoked = revokeShare(this.deps.db, arg, chatId);
          await this.deps.ports.sendText(
            chatId,
            revoked ? `🗑 Share ${arg} revoked.` : 'Share not found (or not yours).',
          );
        } catch (error) {
          this.deps.log?.(`share revoke failed for ${arg}: ${String(error)}`);
          await this.deps.ports
            .sendText(chatId, 'Could not revoke that share right now. Please try again later.')
            .catch(() => undefined);
        }
        return;
      }
      default:
        await this.deps.ports.sendText(chatId, 'Unknown command. See /help.');
    }
  }

  /** /start get_<shareId>_<seq>: re-send an unhosted file by reusing its
   *  InputDocument reference — a server-side copy inside Telegram, no
   *  download/upload on our side (§2.5). Rate limited + queued. */
  private async handleGetFallback(chatId: string, shareId: string, seq: number): Promise<void> {
    if (!this.fallbackLimiter.allow(chatId)) {
      await this.deps.ports.sendText(chatId, '⏳ Slow down — try again in a few seconds.');
      return;
    }

    try {
      const share = getShare(this.deps.db, shareId);
      if (share === null || share.status !== 'public') {
        await this.deps.ports.sendText(chatId, 'This share is not available.');
        return;
      }

      const row = getMessage(this.deps.db, shareId, seq);
      const info = row === null ? null : extractMediaInfo(JSON.parse(row.tlJson));
      if (info === null) {
        await this.deps.ports.sendText(chatId, 'That message has no file to deliver.');
        return;
      }

      const media = getMedia(this.deps.db, info.key);
      if (media === null) {
        await this.deps.ports.sendText(chatId, 'That file is not available.');
        return;
      }
      if (media.reference === null) {
        await this.deps.ports.sendText(
          chatId,
          'That file cannot be re-sent (Telegram provided no download reference). Open the share link instead.',
        );
        return;
      }

      const reference = parseInputDocumentRef(media.reference);
      await this.sendQueueFor(chatId).enqueue(() =>
        withRetry(
          () =>
            this.deps.ports.sendDocumentByRef(
              chatId,
              reference,
              `File from share ${shareId}, message #${seq + 1}`,
            ),
          { sleep: this.deps.sleep },
        ),
      );
    } catch (error) {
      this.deps.log?.(`media fallback failed for ${shareId}/${seq}: ${String(error)}`);
      await this.deps.ports
        .sendText(chatId, 'That file could not be delivered right now. Please try again later.')
        .catch(() => undefined);
    }
  }

  private sendQueueFor(chatId: string): SendQueue {
    let queue = this.sendQueues.get(chatId);
    if (queue === undefined) {
      queue = new SendQueue();
      this.sendQueues.set(chatId, queue);
    }
    return queue;
  }

  /** Batch finished: register media sources, resolve avatars, publish, reply. */
  private async finalizeBatch(batch: Batch): Promise<void> {
    const { ports, config } = this.deps;
    if (batch.items.length === 0) {
      deleteShare(this.deps.db, batch.id, batch.chatId);
      return;
    }

    // Persist the album re-ordering (docs/PLAN.md §2.4): rows were inserted
    // in arrival order, so make seq match the final presentation order —
    // otherwise the share page would still serve arrival order.
    const orderChanged = batch.items.some((item, index) => item.seq !== index);
    if (orderChanged) {
      rewriteMessageSeqs(
        this.deps.db,
        batch.id,
        batch.items.map((item) => item.seq),
      );
    }

    const statusId = await ports.sendText(
      batch.chatId,
      `⏳ Processing ${batch.items.length} message${batch.items.length === 1 ? '' : 's'}…`,
    );

    const pipeline = new MediaPipeline({
      db: this.deps.db,
      host: this.deps.ports,
      maxHostedMediaBytes: this.deps.config.mediaCacheMaxBytes,
      log: this.deps.log,
    });

    let lastEdit = 0;
    const media = await pipeline.processBatch(batch, (text) => {
      if (statusId === undefined) return;
      const now = Date.now();
      if (now - lastEdit < 1500) return; // throttle progress edits
      lastEdit = now;
      void ports.editText(batch.chatId, statusId, `⏳ ${text}`).catch(() => undefined);
    });

    finalizeShare(this.deps.db, batch.id);

    const links = buildShareLinks(config, batch.id);
    await ports.sendText(batch.chatId, buildShareReply(links, batch.items.length, media), {
      webAppButton: { text: 'Open share page', url: links.webUrl },
    });

    // The share is ready: remove the transient prompt/status messages
    const promptId = this.collectingPrompts.get(batch.id);
    this.collectingPrompts.delete(batch.id);
    const transientIds = [promptId, statusId].filter((id): id is number => id !== undefined);
    if (transientIds.length > 0) {
      await ports.deleteMessages(batch.chatId, transientIds).catch(() => undefined);
    }
  }

  /** Best-effort delete of the "Collecting your batch…" prompt. */
  private async deleteCollectingPrompt(batchId: string, chatId: string): Promise<void> {
    const promptId = this.collectingPrompts.get(batchId);
    if (promptId === undefined) return;
    this.collectingPrompts.delete(batchId);
    await this.deps.ports.deleteMessages(chatId, [promptId]).catch(() => undefined);
  }
}

function parseInputDocumentRef(json: string): InputDocumentRef {
  const value: unknown = JSON.parse(json);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid InputDocument reference');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    !/^\d{1,32}$/.test(candidate.id) ||
    typeof candidate.accessHash !== 'string' ||
    !/^-?\d{1,32}$/.test(candidate.accessHash) ||
    typeof candidate.fileReference !== 'string' ||
    candidate.fileReference.length === 0 ||
    candidate.fileReference.length > 8192 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(candidate.fileReference)
  ) {
    throw new Error('Invalid InputDocument reference');
  }
  return {
    id: candidate.id,
    accessHash: candidate.accessHash,
    fileReference: candidate.fileReference,
  };
}
