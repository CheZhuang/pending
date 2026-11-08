#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { ManagedCodex } from '../../../packages/adapters/src/codex-managed.js';

const help = `Start a Codex App Server session managed by Agentree.

Usage: npm run codex:managed -- [--cwd <project>] [--label <name>]

Requires a running Agentree Gateway and an authenticated local Codex CLI.
Press Ctrl+C to end the managed session.`;
const parsed = parseArgs({ args: process.argv.slice(2), options: {
  cwd: { type: 'string' }, label: { type: 'string' }, gateway: { type: 'string' }, help: { type: 'boolean', short: 'h' },
}, strict: true, allowPositionals: false });
if (parsed.values.help) { console.log(help); process.exit(0); }

const dataDirectory = process.env.GATEWAY_DATA_DIR ?? join(homedir(), '.local', 'share', 'agentree');
const adminToken = process.env.HARNESS_ADMIN_TOKEN ?? readFileSync(join(dataDirectory, 'admin-token'), 'utf8').trim();
const native = await ManagedCodex.open({
  gatewayUrl: parsed.values.gateway ?? process.env.AGENTREE_GATEWAY_URL ?? 'http://127.0.0.1:8787',
  databasePath: join(dataDirectory, 'gateway.sqlite'),
  cwd: resolve(parsed.values.cwd ?? process.cwd()),
  label: parsed.values.label ?? 'Codex',
  adminToken,
});

console.log(`Agentree Codex session ready\nSession ID: ${native.gateway.session.id}\nBranch ID: ${native.gateway.session.branchId}\nWorking directory: ${resolve(parsed.values.cwd ?? process.cwd())}\nPress Ctrl+C to stop.`);
let closing: Promise<void> | undefined;
const shutdown = () => {
  closing ??= native.close();
  void closing.catch((error) => { console.error(error); process.exitCode = 1; });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await new Promise<void>((resolve) => {
  const check = setInterval(() => {
    if (closing) { clearInterval(check); void closing.finally(resolve); }
  }, 100);
});
