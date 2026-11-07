import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError, type Scope, type WorkspaceRoot } from '../../contracts/src/index.js';
import { decisionIdentity, normalizeScope, scopesOverlap } from './scope.js';

const roots: WorkspaceRoot[] = [{ id: 'src', path: '/repo/src' }, { id: 'docs', path: '/repo/docs' }];

function scopeError(fn: () => unknown): void {
  assert.throws(fn, (error) => error instanceof DomainError && error.code === 'SCOPE');
}

test('normalizes root-relative paths and infers a sole root', () => {
  assert.deepEqual(normalizeScope({ type: 'folder', path: 'src\\./lib//' }, [{ id: 'one', path: '/repo' }]), {
    type: 'folder', path: 'src/lib', rootId: 'one',
  });
  assert.deepEqual(normalizeScope({ type: 'folder', path: './' }, []), { type: 'folder', path: '.' });
  assert.deepEqual(normalizeScope({ type: 'file', path: 'src\\main.ts' }, []), { type: 'file', path: 'src/main.ts' });
  assert.deepEqual(normalizeScope({ type: 'file', path: 'main.ts', rootId: 'src' }, roots), {
    type: 'file', path: 'main.ts', rootId: 'src',
  });
});

test('requires and validates roots where applicable', () => {
  scopeError(() => normalizeScope({ type: 'file', path: 'a.ts' }, roots));
  scopeError(() => normalizeScope({ type: 'file', path: 'a.ts', rootId: 'missing' }, roots));
  scopeError(() => normalizeScope({ type: 'file', path: 'a.ts', rootId: 'extra' }, []));
  scopeError(() => normalizeScope({ type: 'file', path: 'a.ts', rootId: 'wrong' }, [{ id: 'one', path: '/repo' }]));
  assert.deepEqual(normalizeScope({ type: 'task', taskId: 't1' }, roots), { type: 'task', taskId: 't1' });
});

test('rejects absolute, traversing and empty file paths', () => {
  for (const path of ['/etc/passwd', '\\\\server\\share', '\\rooted', 'C:\\repo\\file', '../secret', 'a/../../secret']) {
    scopeError(() => normalizeScope({ type: 'folder', path }, []));
  }
  for (const path of ['', '.', './', 'a/..']) scopeError(() => normalizeScope({ type: 'file', path }, []));
  scopeError(() => normalizeScope({ type: 'folder', path: '' }, []));
});

test('scope overlap uses roots and path segments, with conservative task behavior', () => {
  const file: Scope = { type: 'file', path: 'src/a.ts', rootId: 'src' };
  assert.equal(scopesOverlap({ type: 'workspace' }, file), true);
  assert.equal(scopesOverlap({ type: 'folder', path: 'src', rootId: 'src' }, file), true);
  assert.equal(scopesOverlap({ type: 'folder', path: 'src/a', rootId: 'src' }, file), false);
  assert.equal(scopesOverlap({ type: 'folder', path: 'sr', rootId: 'src' }, file), false);
  assert.equal(scopesOverlap({ type: 'file', path: 'src/a.ts', rootId: 'docs' }, file), false);
  assert.equal(scopesOverlap({ type: 'file', path: 'src/a.ts', rootId: 'src' }, { type: 'file', path: 'src/b.ts', rootId: 'src' }), false);
  assert.equal(scopesOverlap({ type: 'task', taskId: 'a' }, { type: 'task', taskId: 'b' }), false);
  assert.equal(scopesOverlap({ type: 'task', taskId: 'a' }, file), true);
});

test('decision identity is canonical and independent of object property order', () => {
  const one: Scope = { type: 'file', path: 'src\\./main.ts', rootId: 'src' };
  const two: Scope = { rootId: 'src', path: 'src/main.ts', type: 'file' };
  assert.equal(decisionIdentity('api', one), decisionIdentity('api', two));
  assert.notEqual(decisionIdentity('api', one), decisionIdentity('other', two));
  assert.notEqual(decisionIdentity('api', one), decisionIdentity('api', { type: 'file', path: 'src/main.ts', rootId: 'docs' }));
  assert.notEqual(decisionIdentity('api', { type: 'task', taskId: 't1' }), decisionIdentity('api', { type: 'task', taskId: 't2' }));
});
