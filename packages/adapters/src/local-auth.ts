import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function localDatabasePath(): string {
  return join(process.env.AGENTREE_HOME || process.env.GATEWAY_DATA_DIR || join(homedir(), '.local', 'share', 'agentree'), 'gateway.sqlite');
}

/** Trusted OS-local capability, never supplied to a managed child or served over HTTP. */
export function readLocalHumanToken(databasePath = localDatabasePath()): string {
  if (process.env.HARNESS_SESSION_ID || process.env.HARNESS_SESSION_TOKEN)
    throw new Error('Managed sessions must use their session credential');
  return readToken(databasePath);
}

function readToken(databasePath: string): string {
  const fd = openSync(`${databasePath}.human-token`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('Gateway human capability must be an owner-only regular file');
    const token = readFileSync(fd, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local human capability file');
    return token;
  } finally { closeSync(fd); }
}

export function ensureLocalHumanToken(databasePath: string): string {
  let fd: number;
  try { fd = openSync(`${databasePath}.human-token`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readToken(databasePath); throw error; }
  try { writeFileSync(fd, randomBytes(32).toString('hex')); }
  finally { closeSync(fd); }
  return readToken(databasePath);
}

export function localHumanHeaders(gatewayUrl: string, databasePath?: string): { authorization: string } {
  const url = new URL(gatewayUrl);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password)
    throw new Error('Human capability requires a loopback HTTP Gateway');
  return { authorization: `Bearer ${readLocalHumanToken(databasePath)}` };
}
