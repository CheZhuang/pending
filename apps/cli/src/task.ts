#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { localHumanHeaders } from '../../../packages/adapters/src/local-auth.js';

const help = `Submit and inspect tasks for a managed Agentree session.

Usage:
  npm run task -- submit --session <session-id> --instructions <text> [--include-main] [--request-id <id>]
  npm run task -- status <task-id>
  npm run task -- cancel <task-id>
  npm run task -- list [--session <session-id>]`;
const parsed = parseArgs({ args: process.argv.slice(2), options: {
  session: { type: 'string' }, instructions: { type: 'string' }, 'include-main': { type: 'boolean' }, 'request-id': { type: 'string' },
  gateway: { type: 'string' }, help: { type: 'boolean', short: 'h' },
}, strict: true, allowPositionals: true });
const [action, target] = parsed.positionals;
if (parsed.values.help || !action) { console.log(help); process.exit(parsed.values.help ? 0 : 2); }

const gateway = parsed.values.gateway ?? process.env.AGENTREE_GATEWAY_URL ?? 'http://127.0.0.1:8787';
const request = async (path: string, method = 'GET', body?: unknown) => {
  const response = await fetch(new URL(path, gateway), { method, redirect:'error', headers: { ...localHumanHeaders(gateway), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new Error(`Gateway returned HTTP ${response.status}: ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result, null, 2));
};

if (action === 'submit') {
  if (!parsed.values.session || !parsed.values.instructions) throw new Error('submit requires --session and --instructions');
  await request('/v1/tasks', 'POST', { sessionId: parsed.values.session, instructions: parsed.values.instructions, includeMain: parsed.values['include-main'] ?? false, requestId: parsed.values['request-id'] ?? randomUUID() });
} else if (action === 'status') {
  if (!target) throw new Error('status requires a task ID');
  await request(`/v1/tasks/${encodeURIComponent(target)}`);
} else if (action === 'cancel') {
  if (!target) throw new Error('cancel requires a task ID');
  await request(`/v1/tasks/${encodeURIComponent(target)}/cancel`, 'POST', {});
} else if (action === 'list') {
  const query = parsed.values.session ? `?sessionId=${encodeURIComponent(parsed.values.session)}` : '';
  await request(`/v1/tasks${query}`);
} else {
  throw new Error(`Unknown task action: ${action}\n\n${help}`);
}
