import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureLocalHumanToken, localHumanHeaders, readLocalHumanToken } from './local-auth.js';

test('human capability is owner-only, persistent, and read without following symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentree-local-auth-'));
  const database = join(directory, 'gateway.sqlite');
  try {
    const first = ensureLocalHumanToken(database);
    const second = ensureLocalHumanToken(database);
    assert.equal(second, first);
    assert.equal((await stat(`${database}.human-token`)).mode & 0o777, 0o600);
    assert.equal(readLocalHumanToken(database), first);
    await chmod(`${database}.human-token`, 0o604);
    assert.throws(() => readLocalHumanToken(database), /owner-only/);
    await chmod(`${database}.human-token`, 0o600);
    await rm(`${database}.human-token`);
    await symlink(join(directory, 'target-token'), `${database}.human-token`);
    await assert.rejects(async () => readLocalHumanToken(database));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('managed session environment cannot read human capability; headers require loopback HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentree-local-auth-'));
  const database = join(directory, 'gateway.sqlite');
  const previousId = process.env.HARNESS_SESSION_ID;
  const previousToken = process.env.HARNESS_SESSION_TOKEN;
  try {
    ensureLocalHumanToken(database);
    process.env.HARNESS_SESSION_ID = 'managed';
    assert.throws(() => readLocalHumanToken(database), /Managed sessions/);
    delete process.env.HARNESS_SESSION_ID;
    process.env.HARNESS_SESSION_TOKEN = 'managed-token';
    assert.throws(() => readLocalHumanToken(database), /Managed sessions/);
    delete process.env.HARNESS_SESSION_TOKEN;
    assert.deepEqual(localHumanHeaders('http://127.0.0.1:8787', database), { authorization: `Bearer ${readLocalHumanToken(database)}` });
    for (const url of ['https://127.0.0.1:8787', 'http://example.com', 'http://localhost.example:8787'])
      assert.throws(() => localHumanHeaders(url, database), /loopback HTTP/);
  } finally {
    if (previousId === undefined) delete process.env.HARNESS_SESSION_ID; else process.env.HARNESS_SESSION_ID = previousId;
    if (previousToken === undefined) delete process.env.HARNESS_SESSION_TOKEN; else process.env.HARNESS_SESSION_TOKEN = previousToken;
    await rm(directory, { recursive: true, force: true });
  }
});
