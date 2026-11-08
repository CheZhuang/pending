import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Conflict, Workspace } from '../packages/contracts/src/index.js';
import { collectConflictEvidence, type GitRunner } from './conflict-evidence.js';

function conflict(paths: string[]): Conflict {
  return { id: 'c', workspaceId: 'w', branchIds: [], files: paths.map(path => ({ rootId: 'r', path })), evidenceIds: [], explanation: '', status: 'potential' };
}

test('collects bounded current file and Git evidence from a real repository', async t => {
  const root = await mkdtemp(join(tmpdir(), 'conflict-evidence-'));
  try {
    try { execFileSync('git', ['init', '-q', root]); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('sandbox does not permit spawning Git'); return; }
      throw error;
    }
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    await writeFile(join(root, 'note.txt'), 'before\n');
    execFileSync('git', ['-C', root, 'add', 'note.txt']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'initial note']);
    await writeFile(join(root, 'note.txt'), 'after\n');
    await writeFile(join(root, 'new[1].txt'), 'untracked content\n');
    const workspace: Workspace = { id: 'w', name: 'test', roots: [{ id: 'r', path: root }], mainBranchId: 'm' };
    const [evidence] = await collectConflictEvidence(workspace, conflict(['note.txt']));
    assert.equal(evidence?.currentState.exists, true);
    assert.equal(evidence?.currentState.bytes, 6);
    assert.match(evidence?.currentState.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.match(evidence?.gitStatus ?? '', /M/);
    assert.match(evidence?.workingTreeDiff ?? '', /after/);
    assert.equal(evidence?.recentChanges[0]?.subject, 'initial note');
    const [untracked] = await collectConflictEvidence(workspace, conflict(['new[1].txt']));
    assert.match(untracked?.gitStatus ?? '', /\?\?/);
    assert.match(untracked?.workingTreeDiff ?? '', /untracked content/);
    assert.equal(untracked?.gitError, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects lexical traversal and symlinks escaping the root, including Windows absolute inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conflict-evidence-'));
  const outside = await mkdtemp(join(tmpdir(), 'conflict-outside-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'escape'), 'junction');
    const workspace: Workspace = { id: 'w', name: 'test', roots: [{ id: 'r', path: root }], mainBranchId: 'm' };
    const evidence = await collectConflictEvidence(workspace, conflict(['../outside', 'escape/secret.txt', 'C:\\secret.txt', '\\\\server\\share\\secret.txt']));
    assert.equal(evidence.length, 4);
    assert.ok(evidence.every(item => item.currentState.unavailableReason === 'File reference is outside its workspace root'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('keeps slow or failing Git implementations within a per-file deadline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'conflict-evidence-'));
  try {
    await writeFile(join(root, 'x'), 'x');
    const workspace: Workspace = { id: 'w', name: 'test', roots: [{ id: 'r', path: root }], mainBranchId: 'm' };
    const execFile = promisify(nodeExecFile);
    const slow: GitRunner = async (_cwd, _args, timeoutMs) => {
      await execFile(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: timeoutMs, encoding: 'utf8' });
      return '';
    };
    const started = Date.now();
    let ticks=0;
    const ticker=setInterval(()=>ticks++,10);
    t.after(()=>clearInterval(ticker));
    const [result] = await collectConflictEvidence(workspace, conflict(['x']), slow);
    assert.ok(Date.now() - started < 2_500);
    assert.ok(ticks > 2, 'slow evidence does not block event loop delivery');
    assert.equal(result?.gitStatus, 'unavailable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reports Git failures without throwing from the evidence collector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conflict-evidence-'));
  try {
    const workspace: Workspace = { id: 'w', name: 'test', roots: [{ id: 'r', path: root }], mainBranchId: 'm' };
    const failing: GitRunner = async () => { throw new Error('not a Git checkout'); };
    const [result] = await collectConflictEvidence(workspace, conflict(['missing']), failing);
    assert.equal(result?.gitStatus, 'unavailable');
    assert.equal(result?.gitError, 'not a Git checkout');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('caps file count and diff output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conflict-evidence-'));
  try {
    const workspace: Workspace = { id: 'w', name: 'test', roots: [{ id: 'r', path: root }], mainBranchId: 'm' };
    const many = Array.from({ length: 13 }, (_, i) => `missing-${i}`);
    let calls = 0;
    const runner: GitRunner = async (_cwd, args) => {
      calls++;
      if (args[0] === 'rev-parse') return resolve(root);
      if (args[0] === 'diff') return 'x'.repeat(20_000);
      if (args[0] === 'log') return '';
      return '';
    };
    const result = await collectConflictEvidence(workspace, conflict(many), runner);
    assert.equal(result.length, 12);
    assert.ok(result.every(item => item.workingTreeDiff.length <= 16_000));
    assert.equal(calls, 48);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('untracked evidence uses the platform null device and survives unavailable commit history', async () => {
  const { devNull }=await import('node:os');
  const root=await mkdtemp(join(tmpdir(),'conflict-untracked-'));
  try {
    await writeFile(join(root,'fresh.txt'),'new');
    const workspace:Workspace={id:'w',name:'test',roots:[{id:'r',path:root}],mainBranchId:'m'};
    const runner:GitRunner=async (_cwd,args)=>{
      if(args[0]==='rev-parse')return root;
      if(args[0]==='status')return '?? fresh.txt';
      if(args[0]==='diff'){
        assert.ok(args.includes('--no-index'));
        assert.equal(args.at(-2),devNull);
        throw Object.assign(new Error('diff found changes'),{code:1,stdout:'+new'});
      }
      throw new Error('No commits yet');
    };
    const [evidence]=await collectConflictEvidence(workspace,conflict(['fresh.txt']),runner);
    assert.equal(evidence?.workingTreeDiff,'+new');
    assert.equal(evidence?.gitStatus,'?? fresh.txt');
    assert.equal(evidence?.gitError,'No commits yet');
    const failing:GitRunner=async (cwd,args,timeout)=>{
      if(args[0]==='diff')throw Object.assign(new Error('diff failed'),{code:128,stdout:'partial'});
      return runner(cwd,args,timeout);
    };
    const [failed]=await collectConflictEvidence(workspace,conflict(['fresh.txt']),failing);
    assert.equal(failed?.gitError,'diff failed');
    assert.equal(failed?.workingTreeDiff,'');
  } finally {await rm(root,{recursive:true,force:true});}
});
