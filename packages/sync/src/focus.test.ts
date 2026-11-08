import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedEvent, WorkspaceRoot } from '../../contracts/src/index.js';
import { extractTouches } from './index.js';

const roots: WorkspaceRoot[] = [{ id: 'app', path: '/repo' }, { id: 'docs', path: '/repo/docs' }];
const event = (payload: unknown, type = 'tool.call'): NormalizedEvent => ({ id: 'e', workspaceId: 'w', source: 'test', nativeId: 'n', sessionId: 's', type, mode: 'observed', payload, occurredAt: '2026-01-01T00:00:00Z' });

test('extracts rooted Claude and Codex activity and resolves longest workspace root', () => {
  assert.deepEqual(extractTouches(event({ tool_name: 'Edit', tool_input: { file_path: '/repo/docs/setup.md' } }), roots), [{ rootId: 'docs', path: 'setup.md', access: 'write' }]);
  assert.deepEqual(extractTouches(event({ params: { item: { changes: [{ path: '/repo/src/main.ts' }] } } }), roots), [{ rootId: 'app', path: 'src/main.ts', access: 'write' }]);
});

test('deduplicates touches, upgrades read to write, and drops outside/unknown-root/ambiguous paths', () => {
  const touched = extractTouches(event({ touches: [
    { rootId: 'app', path: 'src/a.ts', access: 'read' }, { rootId: 'app', path: 'src/a.ts', access: 'write' },
    { rootId: 'missing', path: 'secret.ts', access: 'write' }, { path: '/outside/secret.ts', access: 'read' },
  ] }), roots);
  assert.deepEqual(touched, [{ rootId: 'app', path: 'src/a.ts', access: 'write' }]);
  assert.deepEqual(extractTouches(event({ input: { path: 'relative.ts' } }), []), []);
});
