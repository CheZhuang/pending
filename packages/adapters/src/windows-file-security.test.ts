import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test, mock } from 'node:test';
import { createWindowsCapability, readWindowsCapability } from './windows-file-security.js';

test('Windows capability tooling allows bounded cold startup and never exposes raw child errors', () => {
  const previousRoot = process.env.SystemRoot;
  process.env.SystemRoot ??= 'C:\\Windows';
  const calls: unknown[][] = [];
  const child = mock.method(childProcess, 'execFileSync', (...args: unknown[]) => {
    calls.push(args);
    return '';
  });
  syncBuiltinESMExports();
  const secret = 'private-capability-test-value';
  try {
    createWindowsCapability('quoted-[path].human-token', secret);
    const options = calls[0]![2] as { timeout: number; input: string };
    assert.equal(options.timeout, 30_000);
    assert.equal(options.input, secret);
    assert.equal((calls[0]![1] as string[]).join(' ').includes(secret), false);
    child.mock.mockImplementation(() => {
      throw Object.assign(new Error(secret), { code: 'ETIMEDOUT', stderr: secret, input: secret });
    });
    for (const invoke of [() => createWindowsCapability('token', secret), () => readWindowsCapability('token')]) {
      assert.throws(invoke, error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /timed out after 30000 ms/);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
    child.mock.mockImplementation(() => { throw Object.assign(new Error(secret), { status: 1 }); });
    assert.throws(() => createWindowsCapability('token', secret), /ACL validation failed/);
    child.mock.mockImplementation(() => { throw Object.assign(new Error(secret), { status: 3 }); });
    assert.doesNotThrow(() => createWindowsCapability('token', secret), 'a concurrent creator is still validated by the caller');
  } finally {
    child.mock.restore();
    syncBuiltinESMExports();
    if (previousRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousRoot;
  }
});
