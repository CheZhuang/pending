// Path mapping and automatic focus derived from observed native activity.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedEvent, WorkspaceRoot } from '../../contracts/src/index.js';
import { deriveFocus, extractTouches, toRootedPath, type Focus } from './index.js';

const roots: WorkspaceRoot[] = [
  { id: 'app', path: '/repo' },
  { id: 'lib', path: '/repo/packages/lib' },
  { id: 'docs', path: '/docs' },
];

let n = 0;
function ev(sessionId: string, payload: unknown, type = 'tool.use'): NormalizedEvent {
  n += 1;
  return { id: `e${n}`, workspaceId: 'w', source: 'test', nativeId: `n${n}`, sessionId, type, mode: 'observed', payload, occurredAt: new Date(n * 1000).toISOString() };
}
const claude = (sessionId: string, tool: string, file_path: string) => ev(sessionId, { tool_name: tool, tool_input: { file_path } });
const summary = (f: Focus) => f.entries.map((e) => `${e.source}:${e.scope.type === 'file' || e.scope.type === 'folder' ? `${e.scope.rootId}/${e.scope.path}` : e.scope.type}@${e.weight}`);

test('native paths map to the longest matching root', () => {
  assert.deepEqual(toRootedPath('/repo/src/a.ts', roots), { rootId: 'app', path: 'src/a.ts' });
  assert.deepEqual(toRootedPath('/repo/packages/lib/index.ts', roots), { rootId: 'lib', path: 'index.ts' });
  assert.deepEqual(toRootedPath('guide.md', roots, '/docs'), { rootId: 'docs', path: 'guide.md' });
  assert.equal(toRootedPath('/elsewhere/x.ts', roots), undefined);
  assert.equal(toRootedPath('/repo', roots), undefined);
  assert.equal(toRootedPath('src/a.ts', roots), undefined, 'bare relative path is ambiguous with many roots');
  assert.deepEqual(toRootedPath('./src//a.ts', [roots[0]]), { rootId: 'app', path: 'src/a.ts' });
  assert.equal(toRootedPath('../secret', [roots[0]]), undefined);
});

test('touches are extracted from Claude Code, Codex and explicit adapter payloads', () => {
  assert.deepEqual(extractTouches(claude('s', 'Edit', '/repo/src/a.ts'), roots), [{ rootId: 'app', path: 'src/a.ts', access: 'write' }]);
  assert.deepEqual(extractTouches(claude('s', 'Read', '/docs/x.md'), roots), [{ rootId: 'docs', path: 'x.md', access: 'read' }]);
  assert.deepEqual(extractTouches(ev('s', { item: { changes: [{ path: '/repo/b.ts' }] } }), roots), [{ rootId: 'app', path: 'b.ts', access: 'write' }]);
  assert.deepEqual(extractTouches(ev('s', { touches: [{ path: 'c.ts', rootId: 'lib', access: 'write' }] }), roots), [{ rootId: 'lib', path: 'c.ts', access: 'write' }]);
  assert.deepEqual(extractTouches(ev('s', { touches: [{ path: 'c.ts', rootId: 'nope' }] }), roots), []);
  assert.deepEqual(extractTouches(ev('s', { path: '/repo/d.ts' }, 'file.read'), roots), [], 'unknown payload shapes yield nothing');
  assert.deepEqual(extractTouches(ev('s', { tool_input: { path: '/repo/e.ts' } }, 'file.write'), roots), [{ rootId: 'app', path: 'e.ts', access: 'write' }]);
});

test("touches are extracted from B's adapter record shapes", () => {
  // packages/adapters fixtures / MockAgentAdapter: { tool, input }
  assert.deepEqual(extractTouches(ev('s', { tool: 'Read', input: { file_path: 'src/x.ts' } }, 'tool.call'), [roots[0]]), [{ rootId: 'app', path: 'src/x.ts', access: 'read' }]);
  assert.deepEqual(extractTouches(ev('s', { tool: 'shell', command: 'cat src/x.ts' }, 'tool.call'), roots), []);
  // CodexAppServerAdapter: { method, params: { item: { type: 'fileChange', changes } } }
  const codex = ev('s', { method: 'item/completed', params: { item: { type: 'fileChange', changes: [{ path: '/repo/src/api/users.ts', kind: 'update' }] } } }, 'item/completed');
  assert.deepEqual(extractTouches(codex, roots), [{ rootId: 'app', path: 'src/api/users.ts', access: 'write' }]);
  const relative = ev('s', { method: 'item/completed', params: { cwd: '/repo', item: { changes: [{ path: 'src/b.ts' }] } } }, 'item/completed');
  assert.deepEqual(extractTouches(relative, roots), [{ rootId: 'app', path: 'src/b.ts', access: 'write' }]);
});

test('focus prefers recent and modified files, and ignores other sessions', () => {
  const events = [
    claude('alice', 'Read', '/repo/src/old.ts'),
    claude('bob', 'Edit', '/repo/src/bob-only.ts'),
    claude('alice', 'Edit', '/repo/src/api/users.ts'),
    claude('alice', 'Read', '/repo/src/api/users.ts'),
    claude('alice', 'Read', '/docs/api.md'),
  ];
  const focus = deriveFocus({ sessionId: 'alice', events, roots });
  assert.deepEqual(summary(focus), [
    'read:docs/api.md@0.6',
    'modified:app/src/api/users.ts@0.675',
    'read:app/src/old.ts@0.3',
    'folder:app/src/api@0.3',
    'root:docs/.@0.2',
    'root:app/.@0.2',
  ]);
  assert.ok(!summary(focus).some((s) => s.includes('bob-only')));
});

test('focus keeps only the most recent distinct files', () => {
  const events = ['a', 'b', 'c', 'd'].map((f) => claude('s', 'Read', `/repo/${f}.ts`));
  const files = deriveFocus({ sessionId: 's', events, roots, options: { maxFiles: 2 } }).entries.filter((e) => e.source === 'read');
  assert.deepEqual(files.map((e) => (e.scope as { path: string }).path), ['d.ts', 'c.ts']);
});

test('explicit declarations extend or override inferred focus', () => {
  const events = [claude('s', 'Edit', '/repo/src/a.ts')];
  const extended = deriveFocus({ sessionId: 's', events, roots, declaration: { scopes: [{ type: 'task', taskId: 'login' }] } });
  assert.equal(extended.entries[0].source, 'declared');
  assert.ok(extended.entries.some((e) => e.source === 'modified'));

  const overridden = deriveFocus({
    sessionId: 's', events, roots,
    declaration: { mode: 'override', scopes: [{ type: 'folder', path: 'docs//api/', rootId: 'docs' }] },
  });
  assert.deepEqual(overridden.entries, [{ scope: { type: 'folder', path: 'docs/api', rootId: 'docs' }, source: 'declared', weight: 1 }]);
});

test('a resumed session derives the same focus from the same event history', () => {
  const events = [claude('s', 'Edit', '/repo/src/a.ts'), claude('s', 'Read', '/repo/src/b.ts')];
  assert.deepEqual(deriveFocus({ sessionId: 's', events, roots }), deriveFocus({ sessionId: 's', events: [...events], roots }));
});
