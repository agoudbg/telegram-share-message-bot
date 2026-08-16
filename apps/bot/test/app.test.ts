// BotApp orchestration tests (Phase 2 Commits 5/7/9): command routing,
// batch → share finalization, /cancel, /delete and the oversized-file
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
    downloadMedia: () => Promise.resolve(),
    downloadThumb: () => Promise.resolve(false),
    resolvePeer: () => Promise.resolve(null),
    downloadAvatar: () => Promise.resolve(false),
  };
  return { ports, texts, docs };
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
): NormalizedMessage {
  return {
    chatId,
    messageId: id,
    text: '',
    isPrivate: true,
    isForward: true,
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

function oversizedDocument(docId: string): TLJsonObject {
  return {
    media: {
      className: 'MessageMediaDocument',
      document: {
        className: 'Document',
        id: { $long: docId },
        accessHash: { $long: '555' },
        fileReference: { $bytes: 'aGk=' },
        size: { $long: '5000' },
        mimeType: 'application/zip',
      },
    },
  };
}

const HOST_LIMIT = 1000;

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tbfb-app-'));
  const db = openDatabase(':memory:');
  const { ports, texts, docs } = fakePorts();
  let shareCounter = 0;
  const app = new BotApp({
    config: {
      publicOrigin: 'https://share.example.com',
      botUsername: 'mybot',
      miniAppShortName: 'view',
      batchSilenceMs: 2000,
      mediaHostLimitBytes: HOST_LIMIT,
      dataDir,
    },
    db,
    ports,
    createShareId: () => `share_${++shareCounter}`,
    sleep: () => Promise.resolve(),
  });
  return { app, db, texts, docs, dataDir };
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
    const { app, db, texts } = await trackedSetup();

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
  });

  it('ignores non-forward, non-command messages with a hint', async () => {
    const { app, texts } = await trackedSetup();
    await app.handleMessage(commandMessage('u1', 'hello there'));
    expect(texts.at(-1)!.text).toContain('Forward messages');
  });

  it('/cancel drops the in-progress batch and its pending share', async () => {
    const { app, db, texts } = await trackedSetup();
    await app.handleMessage(forwardMessage('u1', 1, 100));
    expect(getShare(db, 'share_1')?.status).toBe('pending');

    await app.handleMessage(commandMessage('u1', '/cancel'));
    expect(getShare(db, 'share_1')).toBeNull();
    expect(texts.at(-1)!.text).toContain('cancelled');

    await app.handleMessage(commandMessage('u1', '/cancel'));
    expect(texts.at(-1)!.text).toContain('No batch');
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

  it('delivers unhosted files via /start get_<shareId>_<seq> with rate limiting', async () => {
    const { app, db, texts, docs } = await trackedSetup();
    await app.handleMessage(forwardMessage('u1', 1, 100, oversizedDocument('doc1')));
    await app.handleDoneCallback('u1');

    const media = getMedia(db, 'doc1');
    expect(media?.hosted).toBe(false);
    expect(texts.at(-1)!.text).toContain('View in Telegram');

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

  it('refuses the fallback for revoked shares', async () => {
    const { app, db, texts } = await trackedSetup();
    await app.handleMessage(forwardMessage('u1', 1, 100, oversizedDocument('doc1')));
    await app.handleDoneCallback('u1');
    await app.handleMessage(commandMessage('u1', '/delete share_1'));
    expect(getShare(db, 'share_1')?.status).toBe('revoked');

    await app.handleMessage(commandMessage('viewer', '/start get_share_1_0'));
    expect(texts.at(-1)!.text).toContain('not available');
  });
});
