import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { ensureLocalHumanToken, localHumanHeaders, readLocalHumanToken } from './local-auth.js';

test('human capability is owner-only, persistent, and read without following symlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentree-local-auth-'));
  const database = join(directory, 'gateway.sqlite');
  try {
    const first = ensureLocalHumanToken(database);
    const second = ensureLocalHumanToken(database);
    assert.equal(second, first);
    if (process.platform !== 'win32') assert.equal((await stat(`${database}.human-token`)).mode & 0o777, 0o600);
    assert.equal(readLocalHumanToken(database), first);
    if (process.platform !== 'win32') {
      await chmod(`${database}.human-token`, 0o604);
      assert.throws(() => readLocalHumanToken(database), /owner-only/);
      await chmod(`${database}.human-token`, 0o600);
    }
    await rm(`${database}.human-token`);
    await writeFile(join(directory, 'target-token'), first, {mode:0o600});
    try { await symlink(join(directory, 'target-token'), `${database}.human-token`); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        t.diagnostic('Windows account cannot create symlinks; token creation and persistence checks passed');
        return;
      }
      throw error;
    }
    assert.throws(() => readLocalHumanToken(database), /owner-only/);
    assert.throws(() => ensureLocalHumanToken(database), /owner-only/);
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


test('Windows capability ACL is private and rejects a grant to Everyone', {skip:process.platform !== 'win32'}, async () => {
  const directory=await mkdtemp(join(tmpdir(),"agentree-acl-quoted-'[path]-"));
  const database=join(directory,'gateway.sqlite');
  try {
    const token=ensureLocalHumanToken(database);
    assert.match(token,/^[a-f0-9]{64}$/);
    assert.equal(readLocalHumanToken(database),token);
    execFileSync(join(process.env.SystemRoot!, 'System32','WindowsPowerShell','v1.0','powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-Command', `
$ErrorActionPreference = 'Stop'
# Exercise ACL tampering without requiring PowerShell security-module autoload.
$PSModuleAutoLoadingPreference = 'None'
$path = $env:AGENTREE_TEST_CAPABILITY_PATH
$stream = [System.IO.FileStream]::new($path, [System.IO.FileMode]::Open,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None)
try {
  $acl = $stream.GetAccessControl()
  $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', 'Allow')
  $acl.AddAccessRule($rule)
  $stream.SetAccessControl($acl)
  $rules = $stream.GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  if ($rules.IdentityReference.Value -notcontains 'S-1-1-0') { throw 'Everyone grant was not applied' }
} finally { $stream.Dispose() }
`], {env:{...process.env,AGENTREE_TEST_CAPABILITY_PATH:`${database}.human-token`},timeout:30_000,windowsHide:true,stdio:'pipe'});
    assert.throws(()=>readLocalHumanToken(database),/Windows ACL validation failed/);
    assert.throws(()=>ensureLocalHumanToken(database),/Windows ACL validation failed/);
  } finally {await rm(directory,{recursive:true,force:true});}
});


test('malformed capability content is refused without replacing the file', async () => {
  const directory=await mkdtemp(join(tmpdir(),'agentree-invalid-capability-'));
  const database=join(directory,'gateway.sqlite');
  try {
    ensureLocalHumanToken(database);
    await writeFile(`${database}.human-token`,'not-a-token');
    assert.throws(()=>readLocalHumanToken(database),/Invalid local human capability/);
    assert.throws(()=>ensureLocalHumanToken(database),/Invalid local human capability/);
  } finally {await rm(directory,{recursive:true,force:true});}
});
