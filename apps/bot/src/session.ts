import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SESSION_FILE_MODE = 0o600;

export async function loadSessionValue(session: string, sessionFile?: string): Promise<string> {
  if (session !== '') return session;
  if (sessionFile === undefined) return '';

  return readSessionFile(sessionFile);
}

export async function persistSessionValue(sessionFile: string, session: string): Promise<boolean> {
  const existingSession = await readSessionFile(sessionFile);
  if (existingSession === session) return false;

  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, `${session}\n`, { encoding: 'utf8', mode: SESSION_FILE_MODE });
  await chmod(sessionFile, SESSION_FILE_MODE);
  return true;
}

async function readSessionFile(sessionFile: string): Promise<string> {
  try {
    return (await readFile(sessionFile, 'utf8')).trim();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error(`Failed to read MTProto session file ${sessionFile}`, { cause: error });
  }
}
