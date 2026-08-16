// teleproto wiring: bot-token MTProto login, StringSession persistence,
// reconnect + FloodWait absorption (client-side), basic commands.
// See docs/PLAN.md, Phase 2 Commit 5.

import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { TelegramClient, events, sessions } from 'teleproto';

import { loadConfig } from './config.js';
import { createBotLogger } from './logging.js';

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

async function main(): Promise<void> {
  // Load .env when present (no dependency; Node ≥ 20.6 built-in)
  if (existsSync('.env')) process.loadEnvFile('.env');
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

  const session = new sessions.StringSession(config.session);
  const client = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 5,
    retryDelay: 1000,
    autoReconnect: true,
    // Absorb short FloodWaits inside the library; longer ones are retried at
    // the call sites
    floodSleepThreshold: 60,
    baseLogger: logger,
  });

  await client.start({ botAuthToken: config.botToken });
  console.log('Bot connected.');

  // StringSession persistence: the session only changes on first login —
  // print it once so the operator can store it in SESSION (.env.example)
  const savedSession = session.save();
  if (savedSession !== config.session) {
    console.log('New MTProto session created. Persist it to avoid re-login:');
    console.log(`SESSION=${savedSession}`);
  }

  client.addEventHandler(
    (event: events.NewMessageEvent) => {
      void (async () => {
        if (event.isPrivate !== true) return;
        const message = event.message;
        const chatId = message.senderId?.toString();
        if (chatId === undefined) return;
        const text = typeof message.message === 'string' ? message.message.trim() : '';

        switch (text.split(/\s+/)[0]?.toLowerCase()) {
          case '/start':
            await client.sendMessage(chatId, { message: WELCOME_TEXT });
            return;
          case '/help':
            await client.sendMessage(chatId, { message: HELP_TEXT });
            return;
          case '/privacy':
            await client.sendMessage(chatId, { message: PRIVACY_TEXT });
            return;
          default:
            await client.sendMessage(chatId, {
              message: 'Forward messages to me to build a share page. See /help.',
            });
        }
      })().catch((error: unknown) => {
        console.error('[bot] message handler failed:', error);
      });
    },
    new events.NewMessage({ incoming: true }),
  );

  const shutdown = (): void => {
    void client.disconnect().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('Fatal bot error:', error);
  process.exit(1);
});
