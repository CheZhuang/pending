import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createGateway } from './gateway.js';

const adminToken = 'test-admin-token-for-main-history-routes-long-enough';
let directory: string;
let gateway: ReturnType<typeof createGateway>;
let baseUrl: string;
let database: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pendingtree-main-history-'));
  database = join(directory, 'gateway.sqlite');
  gateway = createGateway({ database });
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  const address = gateway.server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await gateway.close();
  await rm(directory, { recursive: true, force: true });
});

async function request(path: string, token: string, method = 'GET', data?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token === adminToken ? (await readFile(`${database}.human-token`, 'utf8')).trim() : token}`, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

async function workspaceAndSession() {
  const created = await request('/v1/sessions', adminToken, 'POST', { runtime: 'test', cwd: join(directory, randomUUID()), label: 'Main history test' });
  assert.equal(created.status, 201);
  return await created.json() as { workspaceId: string; sessionId: string; sessionToken: string };
}

test('Main REST history, preview, entry restore and whole restore use authenticated revisioned routes', async () => {
  const session = await workspaceAndSession();
  const otherSession = await workspaceAndSession();
  const base = `/v1/workspaces/${session.workspaceId}/main`;
  const initial = await (await request(base, adminToken)).json() as { revision: number };
  assert.equal(initial.revision, 0);

  assert.equal((await request(`${base}/history`, session.sessionToken)).status, 200);
  assert.equal((await request(`${base}/preview?revision=0`, session.sessionToken)).status, 200);
  assert.equal((await request(`${base}/history`, otherSession.sessionToken)).status, 403);
  assert.equal((await request(`${base}/preview?revision=0`, otherSession.sessionToken)).status, 403);
  assert.equal((await request(`${base}/restore`, session.sessionToken, 'POST', { revision: 0, expectedRevision: 0 })).status, 403);
  assert.equal((await request(`${base}/history`, adminToken, 'POST', {})).status, 404, 'reserved paths are never interpreted as entry IDs');

  const created = await request(base, adminToken, 'POST', {
    body: 'First guidance', files: [{ rootId: 'root', path: 'src/a.ts' }], expectedRevision: 0,
  });
  assert.equal(created.status, 201);
  const entry = await created.json() as { id: string; revision: number; files: unknown[] };
  const updated = await request(`${base}/${entry.id}`, adminToken, 'POST', { body: 'Second guidance', expectedRevision: 1 });
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json() as { files: unknown[] }).files, entry.files, 'omitted files preserve existing references');
  assert.equal((await request(`${base}/${entry.id}/history`, session.sessionToken)).status, 200);
  assert.equal((await request(`${base}/${entry.id}/restore`, session.sessionToken, 'POST', { revision: 1, expectedRevision: 2 })).status, 403);
  assert.equal((await request(`${base}/${entry.id}/remove`, session.sessionToken, 'POST', { expectedRevision: 2 })).status, 403);

  const preview = await request(`${base}/preview?revision=1`, session.sessionToken);
  assert.equal(preview.status, 200);
  assert.equal(((await preview.json()) as { entries: Array<{ body: string }> }).entries[0]?.body, 'First guidance');
  const history = await request(`${base}/history`, adminToken);
  assert.equal(history.status, 200);
  assert.ok(Array.isArray(await history.json()));

  const staleEntryRestore = await request(`${base}/${entry.id}/restore`, adminToken, 'POST', { revision: 1, expectedRevision: 1 });
  assert.equal(staleEntryRestore.status, 409);
  const staleEntryPayload = await staleEntryRestore.json() as { error: { details?: { expectedRevision: number; currentRevision: number } } };
  assert.deepEqual(staleEntryPayload.error.details, { expectedRevision: 1, currentRevision: 2 });
  const restored = await request(`${base}/${entry.id}/restore`, adminToken, 'POST', { revision: 1, expectedRevision: 2 });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json() as { body: string }).body, 'First guidance');
  const removed = await request(`${base}/${entry.id}/remove`, adminToken, 'POST', { expectedRevision: 3 });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json() as { removed: boolean }).removed, true);

  const staleWholeRestore = await request(`${base}/restore`, adminToken, 'POST', { revision: 1, expectedRevision: 3 });
  assert.equal(staleWholeRestore.status, 409);
  const staleWholePayload = await staleWholeRestore.json() as { error: { details?: { expectedRevision: number; currentRevision: number } } };
  assert.deepEqual(staleWholePayload.error.details, { expectedRevision: 3, currentRevision: 4 });
  const restoredSnapshot = await request(`${base}/restore`, adminToken, 'POST', { revision: 1, expectedRevision: 4 });
  assert.equal(restoredSnapshot.status, 200);
  assert.equal(((await restoredSnapshot.json()) as { entries: Array<{ body: string }> }).entries[0]?.body, 'First guidance');
  assert.equal((await request(`${base}/preview?revision=999`, session.sessionToken)).status, 404);
  assert.equal((await request(`${base}/preview?revision=1.5`, session.sessionToken)).status, 400);
  assert.equal((await request(`${base}/preview?revision=9007199254740992`, session.sessionToken)).status, 400);
});

test('Main REST edits preserve remove compatibility and report stale revision details', async () => {
  const session = await workspaceAndSession();
  const base = `/v1/workspaces/${session.workspaceId}/main`;
  const add = await request(base, adminToken, 'POST', { body: 'Keep this', files: [], expectedRevision: 0 });
  const entry = await add.json() as { id: string };
  const agentEdit = await request(`${base}/${entry.id}`, session.sessionToken, 'POST', { body: 'No', expectedRevision: 1 });
  assert.equal(agentEdit.status, 403);
  const removed = await request(`${base}/${entry.id}`, adminToken, 'POST', { body: 'Keep this', expectedRevision: 1, remove: true });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json() as { removed: boolean }).removed, true);

  const stale = await request(base, adminToken, 'POST', { body: 'Stale', expectedRevision: 1 });
  assert.equal(stale.status, 409);
  const payload = await stale.json() as { error: { code: string; details?: { expectedRevision: number; currentRevision: number } } };
  assert.equal(payload.error.code, 'STALE');
  assert.deepEqual(payload.error.details, { expectedRevision: 1, currentRevision: 2 });
});

test('Main routes decode encoded legacy entry IDs while rejecting malformed or encoded separators', async () => {
  const session = await workspaceAndSession();
  const base = `/v1/workspaces/${session.workspaceId}/main`;
  const add = await request(base, adminToken, 'POST', { body: 'Current guidance', files: [], expectedRevision: 0 });
  assert.equal(add.status, 201);

  const migrated = {
    id: 'legacy-main:c4', workspaceId: session.workspaceId, body: 'Migrated guidance', files: [],
    revision: 1, removed: false, actor: { type: 'human', id: 'legacy-author' }, createdAt: new Date().toISOString(), legacyCommitId: 'c4',
  };
  gateway.store.insert(migrated.id, 'main-entry', migrated);
  gateway.store.insert('legacy-revision:c4', 'main-revision', { id: 'legacy-revision:c4', workspaceId: session.workspaceId, entry: migrated });

  const encodedId = encodeURIComponent(migrated.id);
  const history = await request(`${base}/${encodedId}/history`, session.sessionToken);
  assert.equal(history.status, 200);
  assert.equal(((await history.json()) as Array<{ body: string }>)[0]?.body, 'Migrated guidance');

  const edited = await request(`${base}/${encodedId}`, adminToken, 'POST', { body: 'Edited migrated guidance', expectedRevision: 1 });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json() as { id: string }).id, migrated.id);
  const restored = await request(`${base}/${encodedId}/restore`, adminToken, 'POST', { revision: 1, expectedRevision: 2 });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json() as { body: string }).body, 'Migrated guidance');

  assert.equal((await request(`${base}/bad%2Fsegment/history`, session.sessionToken)).status, 400);
  assert.equal((await request(`${base}/bad%E0%A4%A/history`, session.sessionToken)).status, 400);
});
