// Runs the full demo and checks the Task C acceptance criteria against it:
// relevant context delivered once, unrelated excluded, human-resolved conflict
// shared by both agents, and the gateway refusal recorded in the audit log.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { runDemo } from './two-agents.js';

test('two-agent demo satisfies the Task C acceptance criteria', async () => {
  const lines: string[] = [];
  const result = await runDemo({ out: (t) => lines.push(t) });
  const output = lines.join('\n');
  try {
    const keys = (agent: string) => result.deliveries[agent].flatMap((d) => d.items.map((i) => `${i.authority}:${i.key}`));

    // 2. native activity observed from both runtimes, in their native shapes
    assert.match(output, /Edit \/demo\/repo\/src\/auth\/session\.ts/);
    assert.match(output, /fileChange \/demo\/repo\/src\/api\/users\.ts/);
    // 4/5. scoped delivery: Codex gets the API finding once; the docs finding is filtered
    assert.equal(keys('codex').filter((k) => k === 'finding:users-token-check').length, 1);
    assert.ok(!keys('codex').some((k) => k.includes('docs-setup')));
    assert.ok(!keys('claude').some((k) => k.startsWith('finding:')), 'authors do not get their own findings back');
    assert.equal(result.deliveries.codex[0].stats.filtered, 1);
    // nothing is ever delivered twice
    for (const agent of ['claude', 'codex']) {
      const ids = result.deliveries[agent].flatMap((d) => d.items.map((i) => i.itemId));
      assert.equal(new Set(ids).size, ids.length, `${agent} received a duplicate`);
    }
    // 7. agent approval refused (exit 3) and recorded; human resolves the conflict
    assert.equal(result.denied, 3);
    assert.match(output, /agent:[0-9a-f]{8} review\.resolve → DENY/);
    assert.match(output, /approved by human:human-reviewer \(1 conflict choice/);
    // 8. the human decision reaches both agents as accepted context
    const final = (agent: string) => result.deliveries[agent].at(-1)!.items.map((i) => `${i.authority}:${i.body?.slice(0, 30)}`);
    assert.deepEqual(final('claude'), [
      'superseded-decision:Access tokens expire after 15 ',
      'accepted-decision:Access tokens expire after 60 ',
    ]);
    assert.deepEqual(final('codex'), ['accepted-decision:Access tokens expire after 60 ']);
    assert.match(output, /accepted-decision +[0-9a-f]{8} +decision +token-ttl/);
    // packages are labelled as data, never as instructions
    assert.match(result.deliveries.codex[0].notice, /not instructions/);
  } finally {
    rmSync(result.home, { recursive: true, force: true });
  }
});
