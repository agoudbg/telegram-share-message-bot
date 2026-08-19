// BotApp orchestration tests (Phase 2 Commits 5/7/9): command routing,
// batch → share finalization, /cancel, /delete and the document
// fallback — with fake ports and an in-memory database.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { getMedia, getShare, listMessages, openDatabase } from '@tbfb/server';
import type { TLJsonObject } from '@tbfb/tlbridge';

import { BotApp } from '../src/app.js';
import type {
  BotPorts,
  InputDocumentRef,
  NormalizedMessage,
  SendTextOptions,
} from '../src/ports.js';

interface SentText {
  chatId: string;
  text: string;
  opts?: SendTextOptions;
}

interface SentDoc {
  chatId: string;
  ref: InputDocumentRef;
  caption?: string;
}

function fakePorts() {
  const texts: SentText[] = [];
  const docs: SentDoc[] = [];
  const deleted: Array<{ chatId: string; messageIds: number[] }> = [];
  let nextId = 1;
  const ports: BotPorts = {
    sendText: (chatId, text, opts) => {
      texts.push({ chatId, text, opts });
      return Promise.resolve(nextId++);
    },
    editText: () => Promise.resolve(),
    sendDocumentByRef: (chatId, ref, caption) => {
      docs.push({ chatId, ref, caption });
      return Promise.resolve();
    },
    deleteMessages: (chatId, messageIds) => {
      deleted.push({ chatId, messageIds });
      return Promise.resolve();
    },
    resolvePeer: () => Promise.resolve(null),
  };
  return { ports, texts, docs, deleted };
}

function commandMessage(chatId: string, text: string): NormalizedMessage {
  return {
    chatId,
    messageId: 1,
    text,
    isPrivate: true,
    isForward: false,
    tlJson: { className: 'Message' },
    raw: undefined,
  };
}

function forwardMessage(
  chatId: string,
  id: number,
  fwdDate: number,
  tlExtra?: TLJsonObject,
  text = '',
  groupedId?: string,
): NormalizedMessage {
  return {
    chatId,
    messageId: id,
    text,
    isPrivate: true,
    isForward: true,
    groupedId,
    tlJson: {
      className: 'Message',
      id,
      fwdFrom: {
        className: 'MessageFwdHeader',
        date: fwdDate,
        fromId: { className: 'PeerUser', userId: { $long: '999' } },
      },
      ...tlExtra,
    },
    raw: undefined,
  };
}

function largeDocument(docId: string, withRef = true): TLJsonObject {
  return {
    media: {
      className: 'MessageMediaDocument',
      document: {
        className: 'Document',
        id: { $long: docId },
        accessHash: withRef ? { $long: '555' } : undefined,
        fileReference: withRef ? { $bytes: 'aGk=' } : undefined,
        size: { $long: '5000' },
        mimeType: 'application/zip',
      },
    },
  };
}


async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tbfb-app-'));
  const db = openDatabase(':memory:');
  const { ports, texts, docs, deleted } = fakePorts();
  let shareCounter = 0;
  const app = new BotApp({
    config: {
      publicOrigin: 'https://share.example.com',
      botUsername: 'mybot',
      miniAppShortName: 'view',
      batchSilenceMs: 2000,
      dataDir,
    },
    db,
    ports,
    createShareId: () => `share_${++shareCounter}`,
    sleep: () => Promise.resolve(),
  });
  return { app, db, texts, docs, deleted, dataDir };
}

describe('BotApp', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function trackedSetup() {
    const ctx = await setup();
    dirs.push(ctx.dataDir);
    return ctx;
  }

  it('answers /start, /help and /privacy', async () => {
    const { app, texts } = await trackedSetup();
    await app.handleMessage(commandMessage('u1', '/start'));
    await app.handleMessage(commandMessage('u1', '/help'));
    await app.handleMessage(commandMessage('u1', '/privacy'));
    expect(texts).toHaveLength(3);
    expect(texts[0]!.text).toContain('Forward me');
    expect(texts[2]!.text).toContain('PUBLIC');
  });

  it('collects a batch, finalizes it into a public share and replies with links', async () => {
    const { app, db, texts, deleted } = await trackedSetup();

    await app.handleMessage(forwardMessage('u1', 1, 100));
    await app.handleMessage(forwardMessage('u1', 2, 50)); // strictly earlier → nested
    expect(texts[0]!.opts?.doneButton).toBe(true);

    expect(await app.handleDoneCallback('u1')).toBe(true);

    const share = getShare(db, 'share_1');
    expect(share).toMatchObject({ ownerUserId: 'u1', status: 'public' });

    const messages = listMessages(db, 'share_1');
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.nestedForward)).toEqual([false, true]);

    const reply = texts.at(-1)!;
    expect(reply.text).toContain('https://share.example.com/s/share_1');
    expect(reply.text).toContain('https://t.me/mybot/view?startapp=share_1');
    expect(reply.opts?.webAppButton?.url).toBe('https://share.example.com/s/share_1');

    // The collecting prompt (id 1) and the processing status (id 2) are
    // deleted once the share is ready
    expect(deleted).toEqual([{ chatId: 'u1', messageIds: [1, 2] }]);
  });

  it('treats forwarded text starting with / as batch material, not commands', async () => {
    const { app, db, texts } = await trackedSetup();
    // A forwarded "/cancel" must not cancel the batch it just started…
    await app.handleMessage(forwardMessage('u1', 1, 100, undefined, '/cancel'));
    // …and a forwarded deep link must not trigger the file fallback.
    await app.handleMessage(forwardMessage('u1', 2, 100, undefined, '/start get_x_y'));

    const share = getShare(db, 'share_1');
    expect(share?.status).toBe('pending');
    expect(listMessages(db, 'share_1')).toHaveLength(2);
    // Only the collecting prompt was sent — no command replies at all.
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toContain('Collecting');
  });

  it('persists album ordering so the share serves message-id order', async () => {
    const { app, db } = await trackedSetup();
    // Album arriving out of order: message id 5 before message id 3
    await app.handleMessage(forwardMessage('u1', 5, 100, undefined, '', 'g1'));
    await app.handleMessage(forwardMessage('u1', 3, 100, undefined, '', 'g1'));
    await app.handleDoneCallback('u1');

    const messages = listMessages(db, 'share_1');
    const ids = messages.map((m) => (JSON.parse(m.tlJson) as { id: number }).id);
    expect(ids).toEqual([3, 5]);
    expect(messages.map((m) => m.seq)).toEqual([0, 1]);
  });

  it('ignores non-forward, non-command messages with a hint', async () => {
    const { app, texts } = await trackedSetup();
    await app.handleMessage(commandMessage('u1', 'hello there'));
    expect(texts.at(-1)!.text).toContain('Forward messages');
  });

  it('/cancel drops the in-progress batch and its pending share', async () => {
    const { app, db, texts, deleted } = await trackedSetup();
    await app.handleMessage(forwardMessage('u1', 1, 100));
    expect(getShare(db, 'share_1')?.status).toBe('pending');

    await app.handleMessage(commandMessage('u1', '/cancel'));
    expect(getShare(db, 'share_1')).toBeNull();
    expect(texts.at(-1)!.text).toContain('cancelled');
    // The collecting prompt is removed as well
    expect(deleted).toEqual([{ chatId: 'u1', messageIds: [1] }]);

    await app.handleMessage(commandMessage('u1', '/cancel'));
    expect(texts.at(-1)!.text).toContain('No batch');
  });

  it("a late-finalizing batch never deletes the next batch's prompt", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'tbfb-app-'));
    dirs.push(dataDir);
    const db = openDatabase(':memory:');
    const { ports, deleted } = fakePorts();

    // Hang the "⏳ Processing…" status message so batch 1 is still
    // finalizing while batch 2 opens
    const realSend = ports.sendText;
    let releaseProcessing: (() => void) | null = null;
    ports.sendText = (chatId, text, opts) => {
      if (text.startsWith('⏳')) {
        return new Promise<number | undefined>((resolve) => {
          void realSend(chatId, text, opts);
          releaseProcessing = () => resolve(undefined);
        });
      }
      return realSend(chatId, text, opts);
    };

    let n = 0;
    const app = new BotApp({
      config: {
        publicOrigin: 'https://share.example.com',
        botUsername: 'mybot',
        miniAppShortName: 'view',
        batchSilenceMs: 2000,
        dataDir,
      },
      db,
      ports,
      createShareId: () => `share_${++n}`,
      sleep: () => Promise.resolve(),
    });

    await app.handleMessage(forwardMessage('u1', 1, 100)); // prompt id 1
    const done = app.handleDoneCallback('u1'); // finalize hangs on the status
    await app.handleMessage(forwardMessage('u1', 2, 100)); // batch 2, prompt id 3
    releaseProcessing!();
    await done;

    // Batch 1 cleaned up only its own prompt (id 1), never batch 2's (id 3)
    const deletedIds = deleted.flatMap((d) => d.messageIds);
    expect(deletedIds).toContain(1);
    expect(deletedIds).not.toContain(3);
    expect(getShare(db, 'share_2')?.status).toBe('pending');
  });

  it('drops the pending share when finalization fails', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'tbfb-app-'));
    dirs.push(dataDir);
    const db = openDatabase(':memory:');
    const { ports, texts } = fakePorts();

    // Make the "⏳ Processing…" status message fail mid-finalize
    const realSend = ports.sendText;
    ports.sendText = (chatId, text, opts) =>
      text.startsWith('⏳') ? Promise.reject(new Error('boom')) : realSend(chatId, text, opts);

    let n = 0;
    const app = new BotApp({
      config: {
        publicOrigin: 'https://share.example.com',
        botUsername: 'mybot',
        miniAppShortName: 'view',
        batchSilenceMs: 2000,
        dataDir,
      },
      db,
      ports,
      createShareId: () => `share_${++n}`,
      sleep: () => Promise.resolve(),
    });

    await app.handleMessage(forwardMessage('u1', 1, 100));
    await app.handleDoneCallback('u1');

    // No orphan pending share, and the user heard about the failure
    expect(getShare(db, 'share_1')).toBeNull();
    expect(texts.at(-1)!.text).toContain('went wrong');
  });

  it("/delete revokes only the owner's share", async () => {
    const { app, db, texts } = await trackedSetup();
    await app.handleMessage(forwardMessage('u1', 1, 100));
    await app.handleDoneCallback('u1');

    await app.handleMessage(commandMessage('intruder', '/delete share_1'));
    expect(getShare(db, 'share_1')?.status).toBe('public');
    expect(texts.at(-1)!.text).toContain('not found');

    await app.handleMessage(commandMessage('u1', '/delete share_1'));
    expect(getShare(db, 'share_1')?.status).toBe('revoked');
  });

  it('delivers registered files via /start get_<shareId>_<seq> with rate limiting', async () => {
    const { app, db, texts, docs } = await trackedSetup();
    await app.handleMessage(forwardMessage('u1', 1, 100, largeDocument('doc1')));
    await app.handleDoneCallback('u1');

    const media = getMedia(db, 'doc1');
    expect(media?.hosted).toBe(true);
    expect(media?.path).toBeNull();

    // A viewer lands in the PM via the deep link
    await app.handleMessage(commandMessage('viewer', '/start get_share_1_0'));
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      chatId: 'viewer',
      ref: { id: 'doc1', accessHash: '555', fileReference: 'aGk=' },
    });

    // Immediate retry is rate limited
    await app.handleMessage(commandMessage('viewer', '/start get_share_1_0'));
    expect(docs).toHaveLength(1);
    expect(texts.at(-1)!.text).toContain('Slow down');
  });

  it('reports registered files without a reference as unresendable', async () => {
    const { app, db, texts, docs } = await trackedSetup();
    await app.handleMessage(forwardMessage('u1', 1, 100, largeDocument('noref', false)));
    await app.handleDoneCallback('u1');

    const media = getMedia(db, 'noref');
    expect(media?.hosted).toBe(true);
    expect(media?.reference).toBeNull();

    await app.handleMessage(commandMessage('viewer', '/start get_share_1_0'));
    expect(docs).toHaveLength(0);
    expect(texts.at(-1)!.text).toContain('cannot be re-sent');
  });

  it('refuses the fallback for revoked shares', async () => {
    const { app, db, texts } = await trackedSetup();
    await app.handleMessage(forwardMessage('u1', 1, 100, largeDocument('doc1')));
    await app.handleDoneCallback('u1');
    await app.handleMessage(commandMessage('u1', '/delete share_1'));
    expect(getShare(db, 'share_1')?.status).toBe('revoked');

    await app.handleMessage(commandMessage('viewer', '/start get_share_1_0'));
    expect(texts.at(-1)!.text).toContain('not available');
  });
});
