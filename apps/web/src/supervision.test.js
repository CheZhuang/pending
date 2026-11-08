import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceWarningsOf, openConflictsFor } from './supervision.js';

const conflicts = [
  { id: 'open', status: 'potential', branchIds: ['b'] },
  { id: 'confirmed', status: 'confirmed', branchIds: ['b', 'c'] },
  { id: 'done', status: 'resolved', branchIds: ['b'] },
  { id: 'other', status: 'potential', branchIds: ['c'] },
];

test('open conflicts are potential or confirmed ones on the branch', () => {
  assert.deepEqual(openConflictsFor(conflicts, 'b').map((c) => c.id), ['open', 'confirmed']);
  assert.deepEqual(openConflictsFor(undefined, 'b'), []);
});

test('Gateway acceptance warnings win; older Gateways fall back to open branch conflicts', () => {
  const reported = acceptanceWarningsOf({ branchId: 'b', acceptanceWarnings: { unresolvedConflictIds: ['open'], overlappingMainEntryIds: ['m1'] } }, conflicts);
  assert.deepEqual(reported, { unresolvedConflictIds: ['open'], overlappingMainEntryIds: ['m1'], fromGateway: true });
  const none = acceptanceWarningsOf({ branchId: 'b', acceptanceWarnings: { unresolvedConflictIds: [], overlappingMainEntryIds: [] } }, conflicts);
  assert.deepEqual(none.unresolvedConflictIds, [], 'an empty Gateway report is not second-guessed');
  const fallback = acceptanceWarningsOf({ branchId: 'b' }, conflicts);
  assert.deepEqual(fallback, { unresolvedConflictIds: ['open', 'confirmed'], overlappingMainEntryIds: [], fromGateway: false });
});
