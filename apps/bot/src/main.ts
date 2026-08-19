// teleproto wiring: bot-token MTProto login, StringSession persistence,
// reconnect + FloodWait absorption (client-side), event handlers and the
// real BotPorts implementations. See docs/PLAN.md, Phase 2 Commit 5.

import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import bigInt from 'big-integer';
import { Api, TelegramClient, events, sessions } from 'teleproto';
import { serializeTL } from '@tbfb/tlbridge';
import type { TLJsonObject } from '@tbfb/tlbridge';
import { openDatabase, deleteStalePendingShares } from '@tbfb/server';

import { BotApp } from './app.js';
import { loadConfig } from './config.js';
import { createBotLogger } from './logging.js';
import { startMediaOrigin } from './mediaOrigin.js';
import type { BotPorts, InputDocumentRef, NormalizedMessage, ResolvedPeer } from './ports.js';
import { loadSessionValue, persistSessionValue } from './session.js';

/** Load the first .env found walking up from the cwd (no dependency;
 *  Node ≥ 20.6 built-in). */
function loadEnvFile(): void {
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

const STALE_PENDING_SHARE_SECONDS = 3600;

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const logsDir = path.join(config.dataDir, 'logs');
  await mkdir(logsDir, { recursive: true });

  // Unknown-constructor lines are the "time to upgrade teleproto" detector
  // (docs/PLAN.md §2.2): they go to a dedicated alert channel.
  const alertLogPath = path.join(logsDir, 'unknown-constructors.log');
  const logger = createBotLogger(
    (line) => console.log(line),
    (line) => {
      console.error(`[ALERT] ${line} — teleproto is missing a TL constructor; upgrade it`);
      void appendFile(alertLogPath, `${new Date().toISOString()} ${line}\n`).catch(() => undefined);
    },
  );

  const db = openDatabase(path.join(config.dataDir, 'tbfb.db'));

  // Crash cleanup: drop pending shares orphaned by an interrupted batch
  // (docs/PLAN.md §2.3) — they can never finalize after a restart
  const orphanShares = deleteStalePendingShares(db, STALE_PENDING_SHARE_SECONDS);
  if (orphanShares > 0) console.log(`Cleaned up ${orphanShares} orphan pending share(s).`);

  const initialSession = await loadSessionValue(config.session, config.sessionFile);
  const session = new sessions.StringSession(initialSession);
  const client = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 5,
    retryDelay: 1000,
    autoReconnect: true,
    // Telegram test DCs (TELEGRAM_TEST_SERVER=1): separate environment — use a
    // test-env bot token and a separate SESSION/DATA_DIR (see .env.example)
    testServers: config.testServer,
    // Absorb short FloodWaits inside the library; longer ones are retried by
    // withRetry at the call sites
    floodSleepThreshold: 60,
    baseLogger: logger,
  });

  await client.start({ botAuthToken: config.botToken });
  console.log(`Bot connected (${config.testServer ? 'Telegram TEST servers' : 'production'}).`);

  // Persist into the data volume when configured; local development can keep
  // using the printed `SESSION` value in `.env`.
  const savedSession = session.save();
  if (config.sessionFile !== undefined) {
    const wasPersisted = await persistSessionValue(config.sessionFile, savedSession);
    if (wasPersisted) console.log(`MTProto session persisted to ${config.sessionFile}.`);
  } else if (savedSession !== initialSession) {
    console.log('New MTProto session created. Persist it to avoid re-login:');
    console.log(`SESSION=${savedSession}`);
  }

  const ports = createTeleprotoPorts(client);
  const mediaOrigin = await startMediaOrigin({
    db,
    client,
    port: config.internalMediaPort,
    secret: config.internalMediaSecret,
    log: (line) => console.error(`[media-origin] ${line}`),
  });
  console.log(`Media origin listening on 127.0.0.1:${config.internalMediaPort}.`);
  const app = new BotApp({
    config,
    db,
    ports,
    log: (line) => console.log(`[bot] ${line}`),
  });

  client.addEventHandler(
    (event: events.NewMessageEvent) => {
      void app.handleMessage(normalizeMessage(event)).catch((error: unknown) => {
        console.error('[bot] message handler failed:', error);
      });
    },
    new events.NewMessage({ incoming: true }),
  );

  client.addEventHandler(
    (event: events.CallbackQueryEvent) => {
      void (async () => {
        const chatId = event.senderId?.toString();
        const done = chatId !== undefined ? await app.handleDoneCallback(chatId) : false;
        await event.answer({
          message: done ? undefined : 'No batch is being collected — forward messages first.',
        });
      })().catch((error: unknown) => {
        console.error('[bot] callback handler failed:', error);
      });
    },
    new events.CallbackQuery({ pattern: /^done$/ }),
  );

  const shutdown = (): void => {
    mediaOrigin.close(() => {
      void client.disconnect().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function createTeleprotoPorts(client: TelegramClient): BotPorts {
  return {
    async sendText(chatId, text, opts) {
      const buttons = buildButtons(opts);
      const sent = await client.sendMessage(chatId, {
        message: text,
        buttons,
        linkPreview: false,
      });
      return sent?.id;
    },

    async editText(chatId, messageId, text) {
      await client.editMessage(chatId, { message: messageId, text });
    },

    async deleteMessages(chatId, messageIds) {
      await client.deleteMessages(chatId, messageIds, { revoke: true });
    },

    async sendDocumentByRef(chatId, ref, caption) {
      // Re-send by reusing the InputDocument: a server-side copy inside
      // Telegram, nothing is downloaded or uploaded by us (§2.5)
      await client.sendFile(chatId, {
        file: new Api.InputMediaDocument({ id: inputDocumentFromRef(ref) }),
        caption,
        forceDocument: true,
      });
    },

    async resolvePeer(peerId) {
      let entity: unknown;
      try {
        entity = await client.getEntity(bigInt(peerId));
      } catch {
        return null; // unresolvable (e.g. a channel the bot is not in)
      }
      if (Array.isArray(entity)) return null;
      return resolvedPeerFromEntity(entity);
    },

  };
}

function resolvedPeerFromEntity(entity: unknown): ResolvedPeer | null {
  if (entity instanceof Api.User) {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
    return {
      kind: 'user',
      displayName: name !== '' ? name : (entity.username ?? 'User'),
      username: entity.username ?? undefined,
      hasAvatar: !(entity.photo instanceof Api.UserProfilePhotoEmpty) && entity.photo !== undefined,
    };
  }
  if (entity instanceof Api.Channel) {
    return {
      kind: 'channel',
      displayName: entity.title,
      username: entity.username ?? undefined,
      hasAvatar: !(entity.photo instanceof Api.ChatPhotoEmpty) && entity.photo !== undefined,
    };
  }
  if (entity instanceof Api.Chat) {
    return {
      kind: 'chat',
      displayName: entity.title,
      hasAvatar: !(entity.photo instanceof Api.ChatPhotoEmpty) && entity.photo !== undefined,
    };
  }
  return null;
}

function inputDocumentFromRef(ref: InputDocumentRef): Api.InputDocument {
  return new Api.InputDocument({
    id: bigInt(ref.id),
    accessHash: bigInt(ref.accessHash),
    fileReference: Buffer.from(ref.fileReference, 'base64'),
  });
}

type SendTextOptions = Parameters<BotPorts['sendText']>[2];

function buildButtons(opts: SendTextOptions): Api.ReplyInlineMarkup | undefined {
  const buttons: Api.TypeKeyboardButton[] = [];
  if (opts?.doneButton === true) {
    buttons.push(
      new Api.KeyboardButtonCallback({
        text: '✅ Done — generate link',
        data: Buffer.from('done'),
      }),
    );
  }
  if (opts?.webAppButton !== undefined) {
    buttons.push(
      new Api.KeyboardButtonWebView({
        text: opts.webAppButton.text,
        url: opts.webAppButton.url,
      }),
    );
  }
  if (buttons.length === 0) return undefined;
  return new Api.ReplyInlineMarkup({
    rows: [new Api.KeyboardButtonRow({ buttons })],
  });
}

function normalizeMessage(event: events.NewMessageEvent): NormalizedMessage {
  const message = event.message;
  const text = typeof message.message === 'string' ? message.message : '';
  return {
    chatId: message.senderId?.toString() ?? '',
    messageId: message.id,
    text,
    isPrivate: event.isPrivate === true,
    isForward: message.fwdFrom !== undefined && message.fwdFrom !== null,
    groupedId: message.groupedId?.toString(),
    tlJson: serializeTL(message) as TLJsonObject,
    raw: message,
  };
}

main().catch((error: unknown) => {
  console.error('Fatal bot error:', error);
  process.exit(1);
});
