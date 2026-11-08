// The live client against stubbed fetch: it must not mistake an older Gateway's
// current-Main response for history or a historical preview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { live } from './live.js';

function respond(status, body) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const current = { workspaceId: 'w', revision: 7, entries: [], removedEntries: [] };

test('history and preview reject an older Gateway that answers with the current snapshot', async () => {
  respond(200, current);
  await assert.rejects(() => live.mainRevisions('w'), { code: 'UNSUPPORTED' });
  await assert.rejects(() => live.mainPreview('w', 3), { code: 'UNSUPPORTED' });
  respond(200, { ...current, revision: 3 });
  assert.equal((await live.mainPreview('w', 3)).revision, 3);
  respond(200, [{ revision: 1, entryIds: ['a'] }]);
  assert.equal((await live.mainRevisions('w')).length, 1);
});

test('restore on an older Gateway is reported as unsupported; real errors pass through with details', async () => {
  respond(400, { error: { code: 'BODY', message: 'Required' } });
  await assert.rejects(() => live.restoreMain('w', { revision: 1, expectedRevision: 7 }), { code: 'UNSUPPORTED' });
  respond(404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
  await assert.rejects(() => live.restoreMainEntry('w', 'e', { revision: 1, expectedRevision: 7 }), { code: 'UNSUPPORTED' });
  respond(404, { error: { code: 'NOT_FOUND', message: 'Main revision 99 does not exist' } });
  await assert.rejects(() => live.restoreMain('w', { revision: 99, expectedRevision: 7 }), { code: 'NOT_FOUND' });
  respond(409, { error: { code: 'STALE', message: 'Main changed', details: { expectedRevision: 6, currentRevision: 7 } } });
  await assert.rejects(() => live.restoreMain('w', { revision: 1, expectedRevision: 6 }), (e) => e.code === 'STALE' && e.details.currentRevision === 7);
});
