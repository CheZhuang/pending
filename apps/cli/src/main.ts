#!/usr/bin/env node
// Process entry for the `pendingtree` CLI: wires real stdout/stderr/env into run().
import { run } from './cli.js';

import { startLocal } from './start.js';

if (process.argv.length === 2) {
  try { console.log(await startLocal()); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
} else process.exitCode = run(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  env: process.env,
  cwd: process.cwd(),
});
