import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createWindowsCapability, readWindowsCapability } from './windows-file-security.js';

export function localDatabasePath(): string {
  return join(process.env.PENDINGTREE_HOME || process.env.GATEWAY_DATA_DIR || join(homedir(), '.local', 'share', 'pendingtree'), 'gateway.sqlite');
}

/** Trusted OS-local capability, never supplied to a managed child or served over HTTP. */
export function readLocalHumanToken(databasePath = localDatabasePath()): string {
  if (process.env.HARNESS_SESSION_ID || process.env.HARNESS_SESSION_TOKEN)
    throw new Error('Managed sessions must use their session credential');
  return readToken(databasePath);
}

function readToken(databasePath: string): string {
  const path = `${databasePath}.human-token`;
  // O_NOFOLLOW is not available on Windows; explicitly reject links there too.
  if (!lstatSync(path).isFile()) throw new Error('Gateway human capability must be an owner-only regular file');
  if (process.platform === 'win32') return validToken(readWindowsCapability(path));
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('Gateway human capability must be an owner-only regular file');
    return validToken(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

function validToken(token: string): string {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local human capability file');
  return token;
}

export function ensureLocalHumanToken(databasePath: string): string {
  if (process.platform === 'win32') {
    try { lstatSync(`${databasePath}.human-token`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      createWindowsCapability(`${databasePath}.human-token`,randomBytes(32).toString('hex'));
    }
    return readToken(databasePath);
  }
  let fd: number;
  try { fd = openSync(`${databasePath}.human-token`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
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
