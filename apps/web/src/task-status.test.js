import test from 'node:test';
import assert from 'node:assert/strict';
import { CANCELLABLE, TERMINAL, TASK_STATUS, composeInstructions, deliveryOf, statusInfo, taskEvidence } from './task-status.js';

test('delivery availability explains native limits before submitting', () => {
  assert.equal(deliveryOf({ runtime: 'codex-app-server', state: 'active', taskDispatch: { available: true } }).ok, true);
  const claude = deliveryOf({ runtime: 'claude-code', state: 'active', taskDispatch: { available: false } });
  assert.equal(claude.ok, false);
  assert.match(claude.reason, /Claude Code CLI sessions cannot receive unsolicited tasks/);
  assert.match(deliveryOf({ runtime: 'codex-app-server', state: 'active', taskDispatch: { available: false } }).reason, /No managed Codex runner/);
  assert.match(deliveryOf({ runtime: 'codex-app-server', state: 'ended' }).reason, /ended/);
  assert.equal(deliveryOf(undefined).ok, false);
});

test('every Gateway status has a label and an evidence-based meaning', () => {
  for (const status of ['submitted', 'delivery-pending', 'native-accepted', 'running', 'completed', 'failed', 'delivery-unavailable', 'cancel-requested', 'cancelled', 'outcome-unknown']) {
    assert.ok(TASK_STATUS[status]?.meaning, status);
  }
  assert.equal(statusInfo('something-new').label, 'something-new');
  assert.ok(CANCELLABLE.has('running') && !CANCELLABLE.has('completed') && !CANCELLABLE.has('cancel-requested'));
  for (const status of CANCELLABLE) assert.equal(TERMINAL.has(status), false);
});

test('optional context is appended under a clear heading', () => {
  assert.equal(composeInstructions('  Fix the expiry check ', ''), 'Fix the expiry check');
  assert.equal(composeInstructions('Fix it', 'Main says 15 minutes'), 'Fix it\n\nContext from the human supervisor:\nMain says 15 minutes');
});

test('task evidence pairs Gateway task records with native events of the same turn', () => {
  const task = { id: 't1', sessionId: 's1', nativeTurnId: 'turn-1' };
  const events = [
    { type: 'task.submitted', mode: 'controlled', payload: { taskId: 't1' } },
    { type: 'task.submitted', mode: 'controlled', payload: { taskId: 'other' } },
    { type: 'turn/started', mode: 'observed', sessionId: 's1', payload: { params: { turn: { id: 'turn-1' } } } },
    { type: 'item/completed', mode: 'observed', sessionId: 's1', payload: { params: { turnId: 'turn-1' } } },
    { type: 'turn/started', mode: 'observed', sessionId: 's1', payload: { params: { turn: { id: 'turn-2' } } } },
    { type: 'turn/started', mode: 'observed', sessionId: 's2', payload: { params: { turn: { id: 'turn-1' } } } },
  ];
  assert.deepEqual(taskEvidence(task, events).map((e) => e.type), ['task.submitted', 'turn/started', 'item/completed']);
  assert.equal(taskEvidence({ ...task, nativeTurnId: undefined }, events).length, 1, 'no native evidence before acceptance');
});
