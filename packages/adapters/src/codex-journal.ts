import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const snapshotSchema = z.object({
  threadId: z.string(),
  sequence: z.number().int().nonnegative(),
  records: z.array(z.object({
    sequence: z.number().int().positive(), nativeId: z.string(), type: z.string(),
    occurredAt: z.string(), payload: z.unknown(),
  })),
});

/** Local write-ahead observations, outside the target project. One owner per thread. */
export class CodexEventJournal {
  private readonly path: string;
  constructor(private readonly threadId: string, path?: string) {
    const root = process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
    this.path = path ?? join(root, 'agentree', 'codex-journals', `${createHash('sha256').update(threadId).digest('hex')}.json`);
  }
  load(): z.infer<typeof snapshotSchema> {
    try {
      const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (snapshot.threadId !== this.threadId || snapshot.records.some((record, index) =>
        record.sequence > snapshot.sequence || (index > 0 && record.sequence <= snapshot.records[index - 1]!.sequence))) {
        throw new Error('Invalid Codex journal identity or sequence');
      }
      return snapshot;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { threadId: this.threadId, sequence: 0, records: [] };
      throw error;
    }
  }
  save(sequence: number, records: z.infer<typeof snapshotSchema>['records']): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ threadId: this.threadId, sequence, records }), { mode: 0o600, flush: true });
      renameSync(temporary, this.path);
    } finally { rmSync(temporary, { force: true }); }
  }
}
