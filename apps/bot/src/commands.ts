import type { TelegramClient } from 'teleproto';

/** Commands accepted by the bot and shown in Telegram's command menu. */
export const BOT_COMMANDS: Parameters<TelegramClient['setBotCommands']>[0] = [
  { command: 'start', description: 'Create a share or retrieve a file' },
  { command: 'help', description: 'Show usage instructions' },
  { command: 'privacy', description: 'Explain share privacy' },
  { command: 'cancel', description: 'Cancel the current batch' },
  { command: 'delete', description: 'Revoke one of your shares' },
];

/** Register the bot command menu after the MTProto session is connected. */
export async function registerBotCommands(
  client: Pick<TelegramClient, 'setBotCommands'>,
): Promise<void> {
  const registered = await client.setBotCommands(BOT_COMMANDS);
  if (!registered) {
    throw new Error('Telegram rejected bot command registration');
  }
}
