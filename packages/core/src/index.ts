import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { SqliteStore } from '../../storage/src/index.js';
import {
    DomainError, mainInputSchema, workInputSchema, type Actor, type Branch, type MainEntry,
    type MainInput, type MainSnapshot, type MainRevision, type BranchWork, type WorkInput, type FileRef,
    type Merge, type Correction, type Conflict, type BranchOverview, type SupervisionContext,
    type NormalizedEvent, type Operation, type PolicyDecision, type Session, type Workspace,
    type EventQuery, type EventPage,
} from '../../contracts/src/index.js';
import { normalizeFile } from './scope.js';
import { extractTouches } from '../../sync/src/focus.js';
import { createHash } from 'node:crypto';
export { normalizeFile } from './scope.js';
const id = () => randomUUID();
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** Existing immutable entry rows and whole-Main restoration markers share one ledger. */
interface MainRevisionRecord {
    id: string; workspaceId: string; entry?: MainEntry;
    revision?: number; actor?: Actor; createdAt?: string; restoredFromRevision?: number;
}

/** Construct only at the trusted daemon boundary. Never deserialize Actor from agent input. */
export class AgentreeService {
    constructor(readonly store: SqliteStore, private readonly actor: Actor) {}

    private get<T>(key: string, kind: string): T {
        const value = this.store.get<T>(key,kind);
        if (!value) throw new DomainError('NOT_FOUND', key);
        return value;
    }
    private session(): Session {
        if (this.actor.type !== 'agent') throw new DomainError('IDENTITY', 'Agent required');
        return this.get<Session>(this.actor.sessionId,'session');
    }
    private audit(type: string, payload: unknown, workspaceId = 'gateway') {
        this.store.appendEvent({ id: id(), workspaceId, source: 'gateway', nativeId: id(), type, mode: 'controlled', payload, occurredAt: new Date().toISOString() });
    }
    authorize(operation: Operation, branchId?: string, workspaceId?: string): PolicyDecision {
        const branch = branchId ? this.get<Branch>(branchId,'branch') : undefined;
        let outcome: PolicyDecision['outcome'] = 'allow', reason = 'Authorized';
        if (this.actor.type === 'agent') {
            const session = this.session();
            if (['workspace.create', 'branch.create', 'session.register', 'main.edit', 'merge.decide', 'conflict.decide', 'correction.send'].includes(operation)
                || (workspaceId !== undefined && workspaceId !== session.workspaceId)
                || (branch && branch.workspaceId !== session.workspaceId)
                || (operation === 'work.propose' && branchId !== session.branchId)) {
                outcome = 'deny';
                reason = 'Actor has no authority for this operation';
            } else if (operation === 'controlled.execute') {
                outcome = 'require-approval';
                reason = 'Human approval required';
            }
        }
        const result: PolicyDecision = { id: id(), actor: this.actor, operation, outcome, reason, createdAt: new Date().toISOString() };
        // Successful reads must not create events: otherwise sync polling feeds itself.
        if (operation !== 'context.read' || outcome !== 'allow')
            this.audit('policy.decision', result, branch?.workspaceId ?? workspaceId);
        return result;
    }
    private guard(op: Operation, branchId?: string, approved = false, workspaceId?: string) {
        const decision = this.authorize(op, branchId, workspaceId);
        if (decision.outcome === 'deny' || (decision.outcome === 'require-approval' && !approved))
            throw new DomainError(decision.outcome.toUpperCase(), decision.reason);
    }

    createWorkspace(name: string, roots: Workspace['roots'] = []): Workspace {
        this.guard('workspace.create');
        const canonical = roots.map(root => ({id: root.id, path: resolve(root.path)}));
        if (roots.some(root => !root.id || !root.path)
            || new Set(canonical.map(r => r.id)).size !== roots.length
            || new Set(canonical.map(r => r.path)).size !== roots.length)
            throw new DomainError('ROOTS', 'Workspace roots require unique IDs and paths');
        const w: Workspace = { id: id(), name, roots: canonical, mainBranchId: id() };
        const main: Branch = {id:w.mainBranchId, workspaceId:w.id, name:'main', revision:0};
        this.store.transaction(() => {
            this.store.insert(w.id, 'workspace', w);
            this.store.insert(main.id, 'branch', main);
            this.audit('workspace.created', w, w.id);
            this.audit('branch.created', main, w.id);
        });
        return w;
    }
    createBranch(workspaceId: string, name: string): Branch {
        this.guard('branch.create', undefined, false, workspaceId);
        this.get<Workspace>(workspaceId,'workspace');
        if (!name.trim() || name === 'main') throw new DomainError('BRANCH', 'Branch name is empty or reserved');
        const b: Branch = { id: id(), workspaceId, name, revision: 0 };
        this.store.transaction(() => {
            this.store.insert(b.id, 'branch', b);
            this.audit('branch.created', b, workspaceId);
        });
        return b;
    }
    registerSession(branchId: string, agent: {id: string; name: string}, runtime: string, nativeId: string): Session {
        this.guard('session.register', branchId);
        return this.store.transaction(() => {
            const b = this.get<Branch>(branchId,'branch');
            if (this.get<Workspace>(b.workspaceId,'workspace').mainBranchId === b.id)
                throw new DomainError('BRANCH', 'Sessions belong to an independent branch; Main is human governed');
            const row = this.store.db.prepare(`SELECT data FROM entities WHERE kind='session' AND workspace_ref=?
                AND json_extract(data,'$.runtime')=? AND json_extract(data,'$.nativeId')=?`).get(b.workspaceId,runtime,nativeId) as {data:string}|undefined;
            if (row) {
                const prior = JSON.parse(row.data) as Session;
                if (prior.branchId !== branchId || prior.agentId !== agent.id) throw new DomainError('IDENTITY', 'Native session already registered');
                return prior;
            }
            const s: Session = { id: id(), agentId: agent.id, workspaceId: b.workspaceId, branchId, runtime, nativeId };
            if (!this.store.get(agent.id,'agent')) this.store.insert(agent.id, 'agent', agent);
            this.store.insert(s.id, 'session', s);
            this.audit('session.registered', s, b.workspaceId);
            return s;
        });
    }
    ingest(event: NormalizedEvent): boolean {
        const s = event.sessionId ? this.get<Session>(event.sessionId,'session') : undefined;
        this.guard('event.ingest', s?.branchId, false, event.workspaceId);
        this.get<Workspace>(event.workspaceId,'workspace');
        if (event.mode !== 'observed' || event.source === 'gateway'
            || (this.actor.type === 'agent' && (!s || s.id !== this.session().id))
            || (s && s.workspaceId !== event.workspaceId)) throw new DomainError('EVENT', 'Invalid observed event identity');
        return this.store.transaction(() => this.store.appendEvent(event));
    }
    events(workspaceId: string, query: EventQuery = {}): EventPage {
        this.guard('context.read', undefined, false, workspaceId);
        this.get<Workspace>(workspaceId,'workspace');
        if (!integer(query.afterSequence ?? 0) || (query.throughSequence !== undefined && !integer(query.throughSequence))
            || !integer(query.limit ?? 100) || (query.limit ?? 100) < 1 || (query.limit ?? 100) > 1000
            || (query.throughSequence !== undefined && query.throughSequence < (query.afterSequence ?? 0)))
            throw new DomainError('CURSOR', 'Invalid event cursor or limit (1–1000)');
        return this.store.eventPage(workspaceId,query);
    }
    workspace(workspaceId: string): Workspace {
        this.guard('context.read',undefined,false,workspaceId);
        return this.get<Workspace>(workspaceId,'workspace');
    }
    branches(workspaceId: string): Branch[] {
        const workspace = this.workspace(workspaceId);
        return this.store.list<Branch>('branch').filter(b => b.workspaceId === workspaceId && b.id !== workspace.mainBranchId);
    }
    private mainBranch(workspaceId: string): Branch {
        return this.get<Branch>(this.get<Workspace>(workspaceId,'workspace').mainBranchId,'branch');
    }
    private checkRevision(workspaceId: string, expected: number) {
        if (!integer(expected)) throw new DomainError('REVISION','Expected Main revision must be a nonnegative safe integer');
        const currentRevision = this.mainBranch(workspaceId).revision;
        if (currentRevision !== expected)
            throw new DomainError('STALE',`Main changed from revision ${expected} to ${currentRevision}; refresh and review before retrying`,
                {expectedRevision:expected,currentRevision});
    }
    private files(workspaceId: string, files: FileRef[]): FileRef[] {
        const w = this.get<Workspace>(workspaceId,'workspace');
        const normalized = files.map(file => normalizeFile(file,w.roots));
        return [...new Map(normalized.map(file => [JSON.stringify(file),file])).values()];
    }
    main(workspaceId: string): MainSnapshot {
        this.workspace(workspaceId);
        const read = (): MainSnapshot => {
            const revision = this.mainBranch(workspaceId).revision;
            const entries = this.store.list<MainEntry>('main-entry').filter(e => e.workspaceId === workspaceId);
            return {workspaceId,revision,entries:entries.filter(e => !e.removed),removedEntries:entries.filter(e => e.removed)};
        };
        // Pair the revision and content even when another daemon connection commits a rollback.
        return this.store.db.isTransaction ? read() : this.store.transaction(read,false);
    }
    mainHistory(workspaceId: string): MainRevision[];
    mainHistory(workspaceId: string, entryId: string): MainEntry[];
    mainHistory(workspaceId: string, entryId?: string): MainRevision[] | MainEntry[] {
        this.workspace(workspaceId);
        const records = this.store.list<MainRevisionRecord>('main-revision').filter(r => r.workspaceId === workspaceId);
        if (entryId !== undefined) {
            const entry = this.get<MainEntry>(entryId,'main-entry');
            if (entry.workspaceId !== workspaceId) throw new DomainError('NOT_FOUND','Main entry not in workspace');
            return records.flatMap(r => r.entry?.id === entryId ? [r.entry] : []).sort((a,b) => a.revision-b.revision);
        }
        const revisions = new Map<number,MainRevision>();
        for (const record of records) {
            const revision = record.entry?.revision ?? record.revision!;
            const entryIds = record.entry ? [record.entry.id] : [];
            const restoredFromRevision = record.entry?.restoredFrom?.revision ?? record.restoredFromRevision;
            const previous = revisions.get(revision);
            if (previous) previous.entryIds.push(...entryIds);
            else revisions.set(revision,{revision,actor:record.entry?.actor ?? record.actor!,
                createdAt:record.entry?.createdAt ?? record.createdAt!,entryIds,
                ...(restoredFromRevision !== undefined ? {restoredFromRevision} : {})});
        }
        return [...revisions.values()].sort((a,b) => a.revision-b.revision);
    }
    private historicalMain(workspaceId: string, revision: number): MainSnapshot {
        if (!integer(revision)) throw new DomainError('REVISION','Historical Main revision must be a nonnegative safe integer');
        if (revision > this.mainBranch(workspaceId).revision) throw new DomainError('NOT_FOUND','Historical Main revision does not exist');
        const versions = this.store.list<MainRevisionRecord>('main-revision')
            .flatMap(r => r.workspaceId === workspaceId && r.entry && r.entry.revision <= revision ? [r.entry] : [])
            .sort((a,b) => a.revision-b.revision);
        const latest = new Map<string,MainEntry>();
        for (const entry of versions) latest.set(entry.id,entry);
        const entries = [...latest.values()];
        return {workspaceId,revision,entries:entries.filter(e => !e.removed),removedEntries:entries.filter(e => e.removed)};
    }
    /** Read a consistent historical snapshot without changing the current Main. */
    mainAtRevision(workspaceId: string, revision: number): MainSnapshot {
        this.workspace(workspaceId);
        return this.store.transaction(() => this.historicalMain(workspaceId,revision),false);
    }
    private nextMainRevision(workspaceId: string): number {
        const branch = this.mainBranch(workspaceId);
        if (!integer(branch.revision + 1)) throw new DomainError('REVISION','Main revision limit reached');
        branch.revision++;
        this.store.put(branch.id,'branch',branch);
        return branch.revision;
    }
    /** Caller owns the transaction; the immutable ledger and current projection move together. */
    private persistMain(entry: MainEntry, eventType: string): MainEntry {
        this.store.put(entry.id,'main-entry',entry);
        const revisionId = id();
        this.store.insert(revisionId,'main-revision',{id:revisionId,workspaceId:entry.workspaceId,entry});
        this.audit(eventType,entry,entry.workspaceId);
        return entry;
    }
    /** Caller owns the write transaction. Every revision, including removal, is retained. */
    private writeMain(workspaceId: string, input: MainInput, entryId?: string, removed = false, sourceWorkId?: string): MainEntry {
        const parsed = mainInputSchema.parse(input);
        const prior = entryId ? this.get<MainEntry>(entryId,'main-entry') : undefined;
        if (prior && prior.workspaceId !== workspaceId) throw new DomainError('NOT_FOUND','Main entry not in workspace');
        if (prior?.removed) throw new DomainError('STATE','Removed entries must be restored before editing');
        const entry: MainEntry = {id:entryId ?? id(),workspaceId,body:parsed.body,files:this.files(workspaceId,input.files === undefined && prior ? prior.files : parsed.files),
            revision:this.nextMainRevision(workspaceId),removed,actor:this.actor,createdAt:new Date().toISOString(),
            ...(sourceWorkId ? {sourceWorkId} : prior?.sourceWorkId ? {sourceWorkId:prior.sourceWorkId} : {}),
            ...(prior?.legacyCommitId ? {legacyCommitId:prior.legacyCommitId} : {})};
        return this.persistMain(entry,removed ? 'main.removed' : prior ? 'main.updated' : 'main.created');
    }
    editMain(workspaceId: string, input: MainInput, expectedRevision: number, entryId?: string, remove = false): MainEntry {
        this.guard('main.edit',undefined,false,workspaceId);
        this.get<Workspace>(workspaceId,'workspace');
        return this.store.transaction(() => {
            this.checkRevision(workspaceId,expectedRevision);
            if (remove && !entryId) throw new DomainError('MAIN','Removal requires an existing entry');
            // Removal preserves the current content even for legacy callers supplying a body.
            const content = remove ? this.get<MainEntry>(entryId!,'main-entry') : input;
            return this.writeMain(workspaceId,content,entryId,remove);
        });
    }
    removeMain(workspaceId: string, entryId: string, expectedRevision: number): MainEntry {
        return this.editMain(workspaceId,{body:''},expectedRevision,entryId,true);
    }
    restoreMain(workspaceId: string, revision: number, expectedRevision: number): MainSnapshot;
    restoreMain(workspaceId: string, revision: number, expectedRevision: number, entryId: string): MainEntry;
    restoreMain(workspaceId: string, revision: number, expectedRevision: number, entryId?: string): MainSnapshot | MainEntry {
        this.guard('main.edit',undefined,false,workspaceId);
        this.get<Workspace>(workspaceId,'workspace');
        return this.store.transaction(() => {
            this.checkRevision(workspaceId,expectedRevision);
            const snapshot = this.historicalMain(workspaceId,revision);
            const target = new Map([...snapshot.entries,...snapshot.removedEntries].map(e => [e.id,e]));
            const current = this.store.list<MainEntry>('main-entry').filter(e => e.workspaceId === workspaceId);
            const selected = entryId !== undefined ? current.filter(e => e.id === entryId) : current;
            if (entryId !== undefined && (!selected.length || !target.has(entryId)))
                throw new DomainError('NOT_FOUND','Main entry did not exist at the selected revision in this workspace');
            const newRevision = this.nextMainRevision(workspaceId);
            const createdAt = new Date().toISOString();
            let restored: MainEntry | undefined;
            for (const prior of selected) {
                const source = target.get(prior.id);
                restored = this.persistMain({...(source ?? prior),revision:newRevision,actor:this.actor,createdAt,
                    removed:source?.removed ?? true,
                    restoredFrom:{revision,...(source ? {entryRevision:source.revision} : {})}},'main.restored');
            }
            if (entryId !== undefined) return restored!;
            // A marker also records empty/no-op whole restorations in the immutable ledger.
            const marker: MainRevisionRecord = {id:id(),workspaceId,revision:newRevision,actor:this.actor,createdAt,restoredFromRevision:revision};
            this.store.insert(marker.id,'main-revision',marker);
            this.audit('main.snapshot-restored',marker,workspaceId);
            return this.main(workspaceId);
        });
    }
    proposeWork(branchId: string, input: WorkInput): BranchWork {
        this.guard('work.propose',branchId);
        const session = this.session();
        const parsed = workInputSchema.parse(input);
        return this.store.transaction(() => {
            const branch = this.get<Branch>(branchId,'branch');
            const main = this.main(branch.workspaceId);
            for (const eventId of parsed.eventIds) {
                const event = this.store.event<NormalizedEvent>(eventId);
                if (!event || event.sessionId !== session.id || event.workspaceId !== branch.workspaceId)
                    throw new DomainError('PROVENANCE','Evidence must belong to the publishing session');
            }
            if (parsed.conflictsWithMain.some(entryId => !main.entries.some(e => e.id === entryId)))
                throw new DomainError('MAIN','Incompatibility must reference a current Main entry');
            const work: BranchWork = {id:id(),workspaceId:branch.workspaceId,branchId,sessionId:session.id,
                ...parsed,files:this.files(branch.workspaceId,parsed.files),state:'proposed',createdAt:new Date().toISOString()};
            this.store.insert(work.id,'branch-work',work);
            branch.revision++;
            this.store.put(branch.id,'branch',branch);
            this.audit('work.proposed',work,branch.workspaceId);
            return work;
        });
    }
    branchOverview(branchId: string): BranchOverview {
        return this.overview(branchId).overview;
    }
    /** Overview plus every observed write, so file evidence never ages out of the 30-event activity window. */
    private overview(branchId: string): { overview: BranchOverview; writes: Array<{ eventId: string; file: FileRef }> } {
        this.guard('context.read',branchId);
        const branch = this.get<Branch>(branchId,'branch');
        const workspace = this.get<Workspace>(branch.workspaceId,'workspace');
        if (branch.id === workspace.mainBranchId) throw new DomainError('BRANCH','Main is the shared reference; use the Main API');
        const sessions = this.store.list<Session>('session').filter(s => s.branchId === branchId);
        const activity = this.store.recentSessionEvents(branch.workspaceId,sessions.map(s => s.id));
        const writes = this.store.observedSessionEvents(branch.workspaceId,sessions.map(s => s.id)).flatMap(e =>
            extractTouches(e,workspace.roots).filter(t => t.access === 'write').map(t => ({eventId:e.id,file:{rootId:t.rootId!,path:t.path}})));
        const work = this.store.list<BranchWork>('branch-work').filter(w => w.branchId === branchId);
        const files = [...work.filter(w => w.state === 'proposed').flatMap(w => w.files), ...writes.map(w => w.file)];
        // Corrections are addressed to one branch: an agent reading a sibling branch does not see them.
        const ownBranch = this.actor.type === 'agent' ? this.session().branchId : undefined;
        const corrections = ownBranch !== undefined && ownBranch !== branchId ? []
            : this.store.list<Correction>('correction').filter(c => c.branchId === branchId);
        return {overview:{branch,sessions,work,files:[...new Map(files.map(f => [JSON.stringify(f),f])).values()],
            recentActivity:activity,corrections},writes};
    }
    /** The id depends on what the signal is about, never on its evidence: new evidence for the same
     *  branches and file updates the signal instead of reopening a decided one under a new id. */
    private signal(workspaceId: string, basis: string, branchIds: string[], files: FileRef[], evidenceIds: string[], explanation: string, mainEntryId?: string): Conflict {
        const stable = JSON.stringify([workspaceId,basis,[...branchIds].sort(),files,mainEntryId ?? null]);
        return {id:`conflict:${createHash('sha256').update(stable).digest('hex').slice(0,24)}`,workspaceId,branchIds,files,evidenceIds,explanation,
            ...(mainEntryId ? {mainEntryId} : {}),status:'potential'};
    }
    conflicts(workspaceId: string): Conflict[] {
        const w = this.workspace(workspaceId);
        const branches = this.branches(workspaceId).filter(b => b.id !== w.mainBranchId).map(b => this.overview(b.id));
        const main = this.main(workspaceId);
        const signals: Conflict[] = [];
        const same = (a: FileRef, b: FileRef) => a.rootId === b.rootId && a.path === b.path;
        const evidence = ({overview, writes}: (typeof branches)[number], file: FileRef) => [...new Set([
            ...overview.work.filter(w => w.state === 'proposed' && w.files.some(f => same(f,file))).map(w => w.id),
            ...writes.filter(x => same(x.file,file)).map(x => x.eventId),
        ])];
        for (let i = 0; i < branches.length; i++) for (const other of branches.slice(i+1)) {
            const branch = branches[i]!;
            for (const file of branch.overview.files.filter(f => other.overview.files.some(o => same(f,o)))) {
                signals.push(this.signal(workspaceId,'file-overlap',[branch.overview.branch.id,other.overview.branch.id],[file],[...evidence(branch,file),...evidence(other,file)],
                    'Both branches report changes or intentions for this file. Inspect their work; overlap alone does not establish incompatibility.'));
            }
        }
        for (const branch of branches) for (const entry of main.entries) {
            // One signal per file, so a branch touching one more Main file does not reopen the others.
            for (const file of branch.overview.files.filter(file => entry.files.some(f => same(f,file)))) {
                signals.push(this.signal(workspaceId,'main-file',[branch.overview.branch.id],[file],
                    [...evidence(branch,file),`${entry.id}:${entry.revision}`],
                    'This branch affects a file referenced by Main. Check the explicit shared expectation; file overlap is only a potential conflict.',entry.id));
            }
        }
        for (const branch of branches) for (const work of branch.overview.work.filter(w => w.state === 'proposed')) {
            for (const entryId of work.conflictsWithMain) {
                const entry = main.entries.find(e => e.id === entryId);
                if (entry) signals.push(this.signal(workspaceId,`explicit:${work.id}`,[branch.overview.branch.id],work.files,[work.id,`${entry.id}:${entry.revision}`],
                    'The agent explicitly reported that this work may conflict with a Main requirement. Human assessment is required.',entryId));
            }
        }
        const stored = this.store.list<Conflict>('conflict').filter(c => c.workspaceId === workspaceId);
        const result = new Map(signals.map(c => [c.id,c]));
        for (const conflict of stored) result.set(conflict.id,conflict);
        return [...result.values()];
    }
    reportConflict(workspaceId: string, input: {branchIds:string[];mainEntryId?:string;explanation:string}): Conflict {
        this.guard('conflict.decide',undefined,false,workspaceId);
        const w = this.workspace(workspaceId);
        if (!input.explanation.trim() || !input.branchIds.length || new Set(input.branchIds).size !== input.branchIds.length
            || input.branchIds.some(b => !this.branches(workspaceId).some(branch => branch.id === b && b !== w.mainBranchId)))
            throw new DomainError('CONFLICT','Report requires relevant branches and an explanation');
        if (input.mainEntryId && !this.main(workspaceId).entries.some(e => e.id === input.mainEntryId))
            throw new DomainError('MAIN','Main entry not found');
        const c: Conflict = {id:id(),workspaceId,branchIds:input.branchIds,mainEntryId:input.mainEntryId,
            files:[],evidenceIds:[],explanation:input.explanation.trim(),status:'potential'};
        return this.store.transaction(() => {this.store.insert(c.id,'conflict',c);this.audit('conflict.reported',{conflict:c,actor:this.actor},workspaceId);return c;});
    }
    decideConflict(workspaceId: string, conflictId: string, status: Conflict['status'], explanation: string): Conflict {
        this.guard('conflict.decide',undefined,false,workspaceId);
        if (!['potential','confirmed','resolved','dismissed'].includes(status) || !explanation.trim())
            throw new DomainError('CONFLICT','A valid status and human explanation are required');
        const c = this.conflicts(workspaceId).find(c => c.id === conflictId);
        if (!c) throw new DomainError('NOT_FOUND','Conflict not found');
        c.status = status; c.explanation = explanation.trim();
        c.decidedBy = this.actor.type === 'human' ? this.actor.id : undefined;
        c.updatedAt = new Date().toISOString();
        return this.store.transaction(() => {this.store.put(c.id,'conflict',c);this.audit('conflict.decided',{conflict:c,actor:this.actor},workspaceId);return c;});
    }
    sendCorrection(branchId: string, body: string): Correction {
        this.guard('correction.send',branchId);
        const branch = this.get<Branch>(branchId,'branch');
        if (!body.trim() || branch.id === this.mainBranch(branch.workspaceId).id)
            throw new DomainError('CORRECTION','A correction requires text and an independent branch');
        const correction: Correction = {id:id(),workspaceId:branch.workspaceId,branchId,body:body.trim(),
            mainRevision:this.main(branch.workspaceId).revision,actor:this.actor,createdAt:new Date().toISOString()};
        return this.store.transaction(() => {this.store.insert(correction.id,'correction',correction);this.audit('correction.sent',correction,branch.workspaceId);return correction;});
    }
    merges(workspaceId: string): Merge[] {
        this.workspace(workspaceId);
        return this.store.list<Merge>('acceptance').filter(m => m.workspaceId === workspaceId);
    }
    /** Accept work records and shared conclusions only. This method never touches source files or Git. */
    decideMerge(branchId: string, workIds: string[], decision: 'accepted' | 'rejected', expectedMainRevision: number): Merge {
        this.guard('merge.decide',branchId);
        const branch = this.get<Branch>(branchId,'branch');
        return this.store.transaction(() => {
            this.checkRevision(branch.workspaceId,expectedMainRevision);
            if (!['accepted','rejected'].includes(decision) || !workIds.length || new Set(workIds).size !== workIds.length)
                throw new DomainError('MERGE','Select distinct proposed work records');
            const works = workIds.map(workId => this.get<BranchWork>(workId,'branch-work'));
            if (works.some(work => work.branchId !== branchId || work.state !== 'proposed'))
                throw new DomainError('MERGE','Work must be pending on the selected branch');
            for (const work of works) {
                if (decision === 'accepted') this.writeMain(branch.workspaceId,{body:work.body,files:work.files},undefined,false,work.id);
                work.state = decision;
                this.store.put(work.id,'branch-work',work);
            }
            branch.revision++;
            this.store.put(branch.id,'branch',branch);
            const merge: Merge = {id:id(),workspaceId:branch.workspaceId,sourceBranchId:branchId,workIds:[...workIds],
                state:decision,mainRevision:this.mainBranch(branch.workspaceId).revision,actor:this.actor,createdAt:new Date().toISOString()};
            this.store.insert(merge.id,'acceptance',merge);
            this.audit('merge.decided',merge,branch.workspaceId);
            return merge;
        });
    }
    supervision(workspaceId: string): SupervisionContext {
        const w = this.workspace(workspaceId);
        const branches = this.branches(workspaceId).filter(b => b.id !== w.mainBranchId).map(b => this.branchOverview(b.id));
        const ownBranch = this.actor.type === 'agent' ? this.session().branchId : undefined;
        return {main:this.main(workspaceId),branches,conflicts:this.conflicts(workspaceId),
            corrections:branches.filter(b => !ownBranch || b.branch.id === ownBranch).flatMap(b => b.corrections)};
    }
    /** Native runtimes retain responsibility for executing approved actions. */
    executeControlled<T>(branchId: string, action: () => T): T {
        this.guard('controlled.execute',branchId);
        const result = action();
        this.audit('controlled.executed',{branchId,actor:this.actor},this.get<Branch>(branchId,'branch').workspaceId);
        return result;
    }
}
export type ApplicationService = Pick<AgentreeService, 'workspace' | 'branches' | 'events' | 'createWorkspace' | 'createBranch' | 'registerSession' | 'ingest' | 'main' | 'mainHistory' | 'mainAtRevision' | 'editMain' | 'removeMain' | 'restoreMain' | 'proposeWork' | 'branchOverview' | 'conflicts' | 'reportConflict' | 'decideConflict' | 'sendCorrection' | 'merges' | 'decideMerge' | 'supervision' | 'authorize' | 'executeControlled'>;
