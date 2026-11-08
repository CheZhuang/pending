import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOlder, loadRecent } from './history.js';
import { fakeGateway, history } from './test-gateway.js';

const seqs = (events) => events.map((e) => e.sequence);
const contiguousAbove = (events, cursor, newest) => {
  assert.equal(events[0]?.sequence, cursor + 1, 'starts right after the cursor');
  assert.equal(events.at(-1).sequence, newest);
  assert.deepEqual(seqs(events), Array.from({ length: newest - cursor }, (_, i) => cursor + 1 + i), 'no gap and no duplicate');
};

test('a large history loads only a recent window, in a few requests', async () => {
  const api = fakeGateway(history({ count: 50_000 }));
  const recent = await loadRecent(api, 'w', { target: 200 });
  assert.ok(recent.events.length >= 200 && recent.events.length <= 1000, `window size ${recent.events.length}`);
  assert.ok(api.calls.length <= 3, `${api.calls.length} requests`);
  assert.equal(recent.through, 50_000);
  assert.equal(recent.hasOlder, true);
  contiguousAbove(recent.events, recent.cursor, 50_000);
});

test('loading older pages joins the window without gaps or duplicates, down to the first event', async () => {
  const api = fakeGateway(history({ count: 4_000 }));
  const recent = await loadRecent(api, 'w', { target: 200 });
  let events = recent.events;
  let cursor = recent.cursor;
  let rounds = 0;
  while (cursor > 0) {
    const older = await loadOlder(api, 'w', cursor, { target: 300 });
    assert.ok(older.events.length > 0);
    assert.ok(older.events.at(-1).sequence === cursor, 'ends exactly where the loaded window starts');
    events = older.events.concat(events);
    cursor = older.cursor;
    rounds += 1;
  }
  assert.ok(rounds <= 10, `${rounds} rounds`);
  contiguousAbove(events, 0, 4_000);
});

test('a workspace that is sparse in a busy Gateway gets a bounded window of only its own events', async () => {
  const api = fakeGateway(history({ count: 300, every: 400 })); // 1 of every 400 sequences
  const recent = await loadRecent(api, 'w', { target: 200, maxSteps: 4 });
  assert.ok(recent.events.length > 0);
  assert.ok(recent.events.every((e) => e.workspaceId === 'w'));
  assert.ok(api.calls.length <= 12, `${api.calls.length} requests`);
  assert.equal(recent.hasOlder, true, 'more history remains available on demand');
  const all = history({ count: 300, every: 400 }).filter((e) => e.workspaceId === 'w' && e.sequence > recent.cursor);
  assert.deepEqual(seqs(recent.events), seqs(all), 'everything above the cursor, nothing skipped');
});

test('an empty workspace loads nothing and streams from its start', async () => {
  const api = fakeGateway(history({ workspaceId: 'other', count: 10 }));
  const recent = await loadRecent(api, 'w');
  assert.deepEqual(recent, { events: [], cursor: 0, through: 0, hasOlder: false });
});

test('a short history is loaded whole', async () => {
  const api = fakeGateway(history({ count: 40 }));
  const recent = await loadRecent(api, 'w');
  assert.equal(recent.hasOlder, false);
  contiguousAbove(recent.events, 0, 40);
});
