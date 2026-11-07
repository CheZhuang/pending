// Scope matching and relevance: workspace/folder/file/task, multiple roots,
// cross-folder impact scopes and unrelated-knowledge filtering.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Knowledge, Scope } from '../../contracts/src/index.js';
import { matchScope, relevance, type Focus } from './index.js';

const file = (path: string, rootId = 'app'): Scope => ({ type: 'file', path, rootId });
const folder = (path: string, rootId = 'app'): Scope => ({ type: 'folder', path, rootId });
const focusOn = (...scopes: Scope[]): Focus => ({ sessionId: 's', entries: scopes.map((scope) => ({ scope, source: 'declared', weight: 1 })) });
const finding = (scope: Scope, impactScope?: Scope): Knowledge => ({ kind: 'finding', key: 'k', body: 'b', scope, ...(impactScope ? { impactScope } : {}) });

test('file, folder and root matching follows path segments', () => {
  assert.equal(matchScope(file('src/auth.ts'), file('src/auth.ts')), 'exact');
  assert.equal(matchScope(folder('src'), folder('src')), 'exact');
  assert.equal(matchScope(folder('src'), file('src/auth/login.ts')), 'ancestor');
  assert.equal(matchScope(file('src/auth/login.ts'), folder('src/auth')), 'descendant');
  assert.equal(matchScope(folder('.'), file('src/auth.ts')), 'root');
  assert.equal(matchScope(file('src/auth.ts'), file('src/api.ts')), undefined);
  // "src/auth" must not contain "src/authz/..."
  assert.equal(matchScope(folder('src/auth'), file('src/authz/policy.ts')), undefined);
  assert.equal(matchScope(file('src/authz/policy.ts'), folder('src/auth')), undefined);
});

test('different workspace roots are disjoint even for identical paths', () => {
  assert.equal(matchScope(file('index.ts', 'api'), file('index.ts', 'web')), undefined);
  assert.equal(matchScope(folder('.', 'api'), file('index.ts', 'web')), undefined);
  assert.equal(matchScope(file('index.ts', 'api'), file('index.ts', 'api')), 'exact');
});

test('workspace scopes match everything; tasks only match the same task', () => {
  assert.equal(matchScope({ type: 'workspace' }, file('a.ts')), 'workspace');
  assert.equal(matchScope(file('a.ts'), { type: 'workspace' }), 'workspace');
  assert.equal(matchScope({ type: 'task', taskId: 't1' }, { type: 'task', taskId: 't1' }), 'exact');
  assert.equal(matchScope({ type: 'task', taskId: 't1' }, { type: 'task', taskId: 't2' }), undefined);
  assert.equal(matchScope({ type: 'task', taskId: 't1' }, file('a.ts')), undefined);
});

test('impact scope makes knowledge located elsewhere relevant across folders', () => {
  const apiAgent = focusOn(folder('src/api'));
  // Found in auth, but changes what API handlers must do.
  const crossCutting = finding(file('src/auth/token.ts'), folder('src/api'));
  const r = relevance(crossCutting, apiAgent);
  assert.ok(r);
  assert.equal(r.via, 'impact');
  assert.equal(r.match, 'exact');
  // Same location without an impact scope is unrelated to the API agent.
  assert.equal(relevance(finding(file('src/auth/token.ts')), apiAgent), undefined);
});

test('location wins ties and closer scopes score higher', () => {
  const f = focusOn(file('src/api/users.ts'));
  const exact = relevance(finding(file('src/api/users.ts'), folder('src/api')), f)!;
  assert.equal(exact.via, 'location');
  assert.equal(exact.match, 'exact');
  const parent = relevance(finding(folder('src/api')), f)!;
  const everywhere = relevance(finding({ type: 'workspace' }), f)!;
  assert.ok(exact.score > parent.score && parent.score > everywhere.score);
});

test('unrelated knowledge is filtered out', () => {
  const f = focusOn(folder('src/api'), file('README.md'));
  assert.equal(relevance(finding(folder('docs')), f), undefined);
  assert.equal(relevance(finding(file('src/web/app.tsx')), f), undefined);
  assert.equal(relevance(finding(file('src/api/x.ts', 'other-root')), f), undefined);
});

test('a session without focus still receives workspace-wide knowledge only', () => {
  const empty: Focus = { sessionId: 's', entries: [] };
  assert.equal(relevance(finding({ type: 'workspace' }), empty), undefined);
  const rootOnly = focusOn(folder('.'));
  assert.equal(relevance(finding(file('anything.ts')), rootOnly)?.match, 'descendant');
});

test('an inferred root association only matches root-wide knowledge', () => {
  const touchedRoot: Focus = { sessionId: 's', entries: [{ scope: folder('.'), source: 'root', weight: 0.2 }] };
  assert.equal(relevance(finding(file('src/x.ts')), touchedRoot), undefined);
  assert.equal(relevance(finding(folder('.')), touchedRoot)?.match, 'exact');
  assert.equal(relevance(finding(folder('.', 'other')), touchedRoot), undefined);
});
