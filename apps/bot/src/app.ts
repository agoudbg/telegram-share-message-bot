// Bot application core: command routing, batch orchestration, share
// finalization and the oversized-file fallback (docs/PLAN.md, Phase 2
// Commits 5/7/9). teleproto-free by design — main.ts wires the real ports.

import path from 'node:path';

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
  parseGetPayload,
} from './shares.js';

const WELCOME_TEXT = [
  '👋 Forward me any set of messages and I will pack them into one shareable web page.',
  '',
  'Just forward multiple messages in a row — when you are done, wait a couple of seconds or tap "✅ Done".',
  'Commands: /help /privacy /cancel /delete',
].join('\n');

const HELP_TEXT = [
  'How it works:',
  '1. Forward messages to this chat (albums are kept in order).',
  '2. After ~2s of silence — or when you tap "✅ Done" — you get a public link.',
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
    | 'mediaHostLimitBytes'
    | 'dataDir'
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
  private readonly sendQueue = new SendQueue();
  private readonly shareIdFn: () => string;
  /** chatId → message id of the "Collecting your batch…" prompt (deleted
   *  once the share is ready or the batch is cancelled) */
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
        onBatchFinalize: (batch) => this.finalizeBatch(batch),
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

    const text = msg.text.trim();
    if (text.startsWith('/')) {
      await this.handleCommand(msg.chatId, text);
      return;
    }

    if (msg.isForward) {
      const outcome = this.batches.handle(msg);
      if (outcome === 'started') {
        const promptId = await this.deps.ports.sendText(
          msg.chatId,
          '📥 Collecting your batch… Forward more messages, then wait a moment or tap the button.',
          { doneButton: true },
        );
        if (promptId !== undefined) this.collectingPrompts.set(msg.chatId, promptId);
      }
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
          await this.deleteCollectingPrompt(chatId);
          await this.deps.ports.sendText(chatId, '🚮 Batch cancelled.');
        } else {
          await this.deps.ports.sendText(chatId, 'No batch is being collected right now.');
        }
        return;
      }
      case '/delete': {
        if (arg === '') {
          await this.deps.ports.sendText(chatId, 'Usage: /delete <shareId>');
          return;
        }
        const revoked = revokeShare(this.deps.db, arg, chatId);
        await this.deps.ports.sendText(
          chatId,
          revoked ? `🗑 Share ${arg} revoked.` : 'Share not found (or not yours).',
        );
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
    if (media === null || media.hosted || media.reference === null) {
      await this.deps.ports.sendText(chatId, 'That file is hosted — open the share link instead.');
      return;
    }

    const reference = JSON.parse(media.reference) as InputDocumentRef;
    await this.sendQueue.enqueue(() =>
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
  }

  /** Batch finished: download media, resolve avatars, publish, reply. */
  private async finalizeBatch(batch: Batch): Promise<void> {
    const { ports, config } = this.deps;
    if (batch.items.length === 0) {
      deleteShare(this.deps.db, batch.id, batch.chatId);
      return;
    }

    const statusId = await ports.sendText(
      batch.chatId,
      `⏳ Processing ${batch.items.length} message${batch.items.length === 1 ? '' : 's'}…`,
    );

    const pipeline = new MediaPipeline({
      db: this.deps.db,
      mediaDir: path.join(config.dataDir, 'media'),
      hostLimitBytes: config.mediaHostLimitBytes,
      host: this.deps.ports,
      sleep: this.deps.sleep,
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
    const promptId = this.collectingPrompts.get(batch.chatId);
    this.collectingPrompts.delete(batch.chatId);
    const transientIds = [promptId, statusId].filter((id): id is number => id !== undefined);
    if (transientIds.length > 0) {
      await ports.deleteMessages(batch.chatId, transientIds).catch(() => undefined);
    }
  }

  /** Best-effort delete of the "Collecting your batch…" prompt. */
  private async deleteCollectingPrompt(chatId: string): Promise<void> {
    const promptId = this.collectingPrompts.get(chatId);
    if (promptId === undefined) return;
    this.collectingPrompts.delete(chatId);
    await this.deps.ports.deleteMessages(chatId, [promptId]).catch(() => undefined);
  }
}
