import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadSessionValue, persistSessionValue } from '../src/session.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function createSessionFile(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tbfb-session-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'nested', 'session.txt');
}

describe('StringSession file persistence', () => {
  it('prefers SESSION and falls back to SESSION_FILE', async () => {
    const sessionFile = await createSessionFile();
    await persistSessionValue(sessionFile, 'file-session');

    await expect(loadSessionValue('env-session', sessionFile)).resolves.toBe('env-session');
    await expect(loadSessionValue('', sessionFile)).resolves.toBe('file-session');
  });

  it('creates the parent directory and skips unchanged writes', async () => {
    const sessionFile = await createSessionFile();

    await expect(persistSessionValue(sessionFile, 'new-session')).resolves.toBe(true);
    await expect(readFile(sessionFile, 'utf8')).resolves.toBe('new-session\n');
    await expect(persistSessionValue(sessionFile, 'new-session')).resolves.toBe(false);
  });
});
