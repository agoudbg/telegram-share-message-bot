import type { Server } from 'node:http';
import type { Writable } from 'node:stream';

import bigInt from 'big-integer';
import { Api, TelegramClient } from 'teleproto';
import { afterAll, describe, expect, it } from 'vitest';

import { insertMediaIfAbsent, openDatabase, upsertMediaSource } from '@tbfb/server';

import { startMediaOrigin } from '../src/mediaOrigin.js';

const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('media origin', () => {
  it('retrieves the exact known message id before downloading media', async () => {
    const db = openDatabase(':memory:');
    insertMediaIfAbsent(db, { key: '123', hosted: true, mime: 'text/plain', size: 999 });
    upsertMediaSource(db, {
      mediaKey: '123',
      kind: 'document',
      sourcePeerId: '42',
      sourceMessageId: 77,
      reference: '{}',
    });

    const message = new Api.Message({
      id: 77,
      peerId: new Api.PeerUser({ userId: bigInt(42) }),
      date: 1,
      message: '',
      media: new Api.MessageMediaDocument({
        document: new Api.Document({
          id: bigInt(123),
          accessHash: bigInt(456),
          fileReference: Buffer.from('reference'),
          date: 1,
          mimeType: 'text/plain',
          size: bigInt(5),
          dcId: 2,
          attributes: [],
        }),
      }),
    });
    let requestedId: number | null = null;
    const client = {
      invoke(request: Api.messages.GetMessages) {
        const input = request.id[0];
        if (input instanceof Api.InputMessageID) requestedId = input.id;
        return Promise.resolve(
          new Api.messages.Messages({ messages: [message], chats: [], users: [] }),
        );
      },
      downloadMedia(_message: Api.Message, options: { outputFile: Writable }) {
        options.outputFile.write(Buffer.from('hello'));
        return Promise.resolve(undefined);
      },
    } as unknown as TelegramClient;

    const server = await startMediaOrigin({
      db,
      client,
      port: 0,
      secret: 'test-secret',
    });
    servers.push(server);
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');

    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/media/123?variant=full`,
      { headers: { Authorization: 'Bearer test-secret' } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBeNull();
    expect(await response.text()).toBe('hello');
    expect(requestedId).toBe(77);
  });

  it('rejects unauthenticated requests before querying Telegram', async () => {
    const db = openDatabase(':memory:');
    const server = await startMediaOrigin({
      db,
      client: {} as TelegramClient,
      port: 0,
      secret: 'test-secret',
    });
    servers.push(server);
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');

    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/media/123?variant=full`,
    );
    expect(response.status).toBe(401);
  });
});
