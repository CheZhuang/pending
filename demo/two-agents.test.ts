import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { runDemo } from './two-agents.js';

test('two MCP sessions retrieve Main, sibling work, a human correction, and accepted updates', async () => {
  const lines: string[] = []; const demo = await runDemo({ out: t => lines.push(t) }); const out = lines.join('\n');
  try {
    assert.match(out, /observed 2 native records/);
    assert.match(out, /correction retrieval: 1 correction/);
    assert.equal(demo.denied, 3, 'agent Main edit must be denied');
    const kinds = (agent: string) => demo.deliveries[agent]!.flatMap(d => d.items.map(i => i.kind));
    assert.ok(kinds('claude').includes('main')); assert.ok(kinds('codex').includes('correction'));
    assert.ok(kinds('codex').includes('work')); assert.ok(kinds('codex').includes('conflict'));
    const accepted = demo.deliveries.codex.at(-1)!.items.find(i => i.kind === 'main')?.value as { entries: Array<{ sourceWorkId?: string }> };
    assert.ok(accepted.entries.some(e => e.sourceWorkId));
    assert.match(out, /explicitly flags incompatibility|recorded Main header requirement/);
    assert.match(out, /Agent Main edit exit code: 3/);
  } finally { rmSync(demo.home, { recursive: true, force: true }); }
});
