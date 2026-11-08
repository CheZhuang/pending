#!/usr/bin/env node
// Launch a real Claude Code session under the local gateway, from the project
// directory you want Claude to work in. Thin wrapper around B's runManagedClaude:
// registers the session, installs the PreToolUse hook for this run only, and stops
// Claude when a human presses Stop. Requires `npm run build` and Node 24+.
//
//   cd ~/pendingtree-playground
//   node /path/to/pending/demo/managed-claude.mjs --label "Claude A" [-- <claude args>]

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const own = split === -1 ? argv : argv.slice(0, split);
const claudeArgs = split === -1 ? [] : argv.slice(split + 1);
const flag = (name, fallback) => {
  const i = own.indexOf(`--${name}`);
  return i === -1 ? fallback : own[i + 1];
};

let runManagedClaude;
try {
  ({ runManagedClaude } = await import('../dist/packages/adapters/src/claude-launcher.js'));
} catch {
  console.error('Build the repository first: npm ci && npm run build (in the PendingTree repo).');
  process.exit(2);
}

process.exitCode = await runManagedClaude({
  label: flag('label', 'Claude'),
  gatewayUrl: flag('gateway', process.env.HARNESS_GATEWAY_URL || 'http://127.0.0.1:8787'),
  cwd: process.cwd(),
  ...(flag('command') ? { command: flag('command') } : {}),
  args: claudeArgs,
});
