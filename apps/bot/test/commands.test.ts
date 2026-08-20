import { describe, expect, it, vi } from 'vitest';

import { BOT_COMMANDS, registerBotCommands } from '../src/commands.js';

describe('bot commands', () => {
  it('registers every supported command with Telegram', async () => {
    const setBotCommands = vi.fn().mockResolvedValue(true);

    await registerBotCommands({ setBotCommands });

    expect(setBotCommands).toHaveBeenCalledOnce();
    expect(setBotCommands).toHaveBeenCalledWith([
      { command: 'start', description: 'Create a share or retrieve a file' },
      { command: 'help', description: 'Show usage instructions' },
      { command: 'privacy', description: 'Explain share privacy' },
      { command: 'cancel', description: 'Cancel the current batch' },
      { command: 'delete', description: 'Revoke one of your shares' },
    ]);
    expect(BOT_COMMANDS.every(({ command }) => !command.startsWith('/'))).toBe(true);
  });

  it('fails startup registration when Telegram returns false', async () => {
    const setBotCommands = vi.fn().mockResolvedValue(false);

    await expect(registerBotCommands({ setBotCommands })).rejects.toThrow(
      'Telegram rejected bot command registration',
    );
  });
});
