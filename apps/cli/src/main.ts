#!/usr/bin/env -S node --import tsx
// Process entry for the `agentree` CLI: wires real stdout/stderr/env into run().
import { run } from './cli.js';

process.exitCode = run(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  env: process.env,
  cwd: process.cwd(),
});
