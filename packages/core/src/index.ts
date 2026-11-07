import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { SqliteStore } from '../../storage/src/index.js';
import {
    DomainError, knowledgeSchema, type Actor, type Branch, type ContextCommit,
    type ContextEntry, type ContextRevision, type ContextSnapshot, type Knowledge,
    type MergeRequest, type NormalizedEvent, type Operation, type PolicyDecision,
    type Review, type Session, type Workspace, type EventQuery, type EventPage,
    type Conflict, type ConflictResolution,
} from '../../contracts/src/index.js';
import { decisionIdentity, normalizeScope, scopesOverlap } from './scope.js';
export { decisionIdentity, normalizeScope, scopesOverlap } from './scope.js';
const id = () => randomUUID();
const impact = (commit: ContextCommit) => commit.knowledge.impactScope ?? commit.knowledge.scope;
const overlaps = (a: ContextCommit, b: ContextCommit) => a.knowledge.key === b.knowledge.key
    && (decisionIdentity(a.knowledge.key,a.knowledge.scope) === decisionIdentity(b.knowledge.key,b.knowledge.scope)
        || scopesOverlap(impact(a), impact(b)));
const identity = (commit: ContextCommit) => decisionIdentity(commit.knowledge.key, commit.knowledge.scope);
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;

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
            if (['workspace.create', 'branch.create', 'session.register', 'review.resolve'].includes(operation)
                || (workspaceId !== undefined && workspaceId !== session.workspaceId)
                || (branch && branch.workspaceId !== session.workspaceId)
                || (operation === 'context.publish' && branchId !== session.branchId)) {
                outcome = 'deny';
                reason = 'Actor has no authority for this operation';
            } else if (operation === 'controlled.execute' || (operation === 'merge.apply' && branch?.restricted)) {
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
        const main: Branch = {id:w.mainBranchId, workspaceId:w.id, name:'main', restricted:true, revision:0};
        this.store.transaction(() => {
            this.store.insert(w.id, 'workspace', w);
            this.store.insert(main.id, 'branch', main);
            this.audit('workspace.created', w, w.id);
            this.audit('branch.created', main, w.id);
        });
        return w;
    }
    createBranch(workspaceId: string, name: string, restricted = false): Branch {
        this.guard('branch.create', undefined, false, workspaceId);
        this.get<Workspace>(workspaceId,'workspace');
        if (!name.trim() || name === 'main') throw new DomainError('BRANCH', 'Branch name is empty or reserved');
        const b: Branch = { id: id(), workspaceId, name, restricted, revision: 0 };
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
                throw new DomainError('BRANCH', 'Publish drafts on an agent branch; main accepts reviewed merges');
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
    publish(branchId: string, knowledge: Knowledge, eventIds: string[] = [], expected?: ContextRevision): ContextCommit {
        this.guard('context.publish', branchId);
        const parsed = knowledgeSchema.parse(knowledge);
        const s = this.session();
        return this.store.transaction(() => {
            const b = this.get<Branch>(branchId,'branch'), w = this.get<Workspace>(b.workspaceId,'workspace');
            if (b.id === w.mainBranchId) throw new DomainError('AUTHORITATIVE', 'Main accepts reviewed merges only');
            const token = this.revision(b);
            if (expected) this.assertRevision(token,expected);
            parsed.scope = normalizeScope(parsed.scope,w.roots);
            if (parsed.impactScope) parsed.impactScope = normalizeScope(parsed.impactScope,w.roots);
            for (const eventId of eventIds) {
                const event = this.store.event<NormalizedEvent>(eventId);
                if (!event || event.sessionId !== s.id || event.workspaceId !== b.workspaceId)
                    throw new DomainError('PROVENANCE', 'Event must belong to publishing session');
            }
            // Inherited decisions do not prevent publishing a competing local proposal.
            if (parsed.kind === 'decision' && this.store.decisions<ContextCommit>(b.id,b.revision)
                .some(c => decisionIdentity(c.knowledge.key,c.knowledge.scope) === decisionIdentity(parsed.key,parsed.scope)))
                throw new DomainError('AUTHORITATIVE', 'Local decision replacement requires merge review');
            const c: ContextCommit = { id: id(), workspaceId: b.workspaceId, branchId, revision: b.revision + 1,
                knowledge: parsed, provenance: { sessionId: s.id, eventIds: [...eventIds] }, createdAt: new Date().toISOString() };
            this.store.insert(c.id, 'commit', c);
            this.attach(b,c.id);
            if (parsed.kind === 'decision') this.store.recordDecision(b.id,b.revision,identity(c),c.id);
            this.audit('context.published', c, b.workspaceId);
            return c;
        });
    }
    private revision(b: Branch): ContextRevision {
        const w = this.get<Workspace>(b.workspaceId,'workspace');
        return {branchRevision:b.revision, mainRevision:this.get<Branch>(w.mainBranchId,'branch').revision};
    }
    private assertRevision(actual: ContextRevision, expected: ContextRevision) {
        if (actual.branchRevision !== expected.branchRevision || actual.mainRevision !== expected.mainRevision)
            throw new DomainError('STALE', 'Context changed; refresh the snapshot and review');
    }
    private entries(branchId: string, revision: number): ContextEntry[] {
        const rows = this.store.db.prepare(`SELECT e.data,bc.revision FROM branch_commits bc
            JOIN entities e ON e.id=bc.commit_id WHERE bc.branch_id=? AND bc.revision<=? ORDER BY bc.revision`)
            .all(branchId,revision) as Array<{data:string;revision:number}>;
        return rows.map(row => ({commit:JSON.parse(row.data) as ContextCommit, branchId, revision:row.revision}));
    }
    private effective(b: Branch, token: ContextRevision): ContextCommit[] {
        const mainId = this.get<Workspace>(b.workspaceId,'workspace').mainBranchId;
        const main = this.store.decisions<ContextCommit>(mainId,token.mainRevision);
        if (b.id === mainId) return main;
        const local = this.store.decisions<ContextCommit>(b.id,token.branchRevision);
        return [...local.filter(c => !main.some(shared => overlaps(c,shared))), ...main];
    }
    workspace(workspaceId: string): Workspace {
        this.guard('context.read',undefined,false,workspaceId);
        return this.get<Workspace>(workspaceId,'workspace');
    }
    branches(workspaceId: string): Branch[] {
        this.workspace(workspaceId);
        const rows = this.store.db.prepare("SELECT data FROM entities WHERE kind='branch' AND workspace_ref=? ORDER BY rowid").all(workspaceId) as Array<{data:string}>;
        return rows.map(row => JSON.parse(row.data) as Branch);
    }
    /** Cheap change detection for sync consumers; no context history is loaded. */
    contextRevision(branchId: string): ContextRevision {
        this.guard('context.read',branchId);
        return this.store.transaction(() => this.revision(this.get<Branch>(branchId,'branch')),false);
    }
    /** Main is live by default; supplying a revision reconstructs the same immutable view. */
    snapshot(branchId: string, revision?: ContextRevision): ContextSnapshot {
        this.guard('context.read',branchId);
        return this.store.transaction(() => {
            const b = this.get<Branch>(branchId,'branch'), current = this.revision(b), token = revision ?? current;
            const mainId = this.get<Workspace>(b.workspaceId,'workspace').mainBranchId;
            if (!integer(token.branchRevision) || !integer(token.mainRevision)
                || token.branchRevision > current.branchRevision || token.mainRevision > current.mainRevision
                || (b.id === mainId && token.branchRevision !== token.mainRevision))
                throw new DomainError('REVISION', 'Snapshot revision is out of range');
            const shared = this.entries(mainId,token.mainRevision);
            const sharedIds = new Set(shared.map(e => e.commit.id));
            const entries = b.id === mainId ? shared : [...this.entries(b.id,token.branchRevision).filter(e => !sharedIds.has(e.commit.id)), ...shared];
            const history = entries.map(e => e.commit);
            return {branchId,revision:{...token},entries,history,knowledge:[...history.filter(c => c.knowledge.kind === 'finding'), ...this.effective(b,token)]};
        },false);
    }
    lookup(branchId: string): ContextCommit[] { return this.snapshot(branchId).knowledge; }
    context(branchId: string): ContextCommit[] { return this.snapshot(branchId).history; }
    private attach(b: Branch, commitId: string) {
        b.revision++;
        this.store.db.prepare('INSERT INTO branch_commits(branch_id,commit_id,revision) VALUES(?,?,?)').run(b.id,commitId,b.revision);
        this.store.put(b.id,'branch',b);
    }
    private hasCommit(branchId: string, commitId: string): boolean {
        return !!this.store.db.prepare('SELECT 1 FROM branch_commits WHERE branch_id=? AND commit_id=?').get(branchId,commitId);
    }
    createMerge(sourceBranchId: string, targetBranchId: string, commitIds: string[], expectedRevision: number, expectedMainRevision?: number): MergeRequest {
        this.guard('merge.create',targetBranchId);
        this.guard('context.read',sourceBranchId);
        return this.store.transaction(() => {
            const source = this.get<Branch>(sourceBranchId,'branch'), target = this.get<Branch>(targetBranchId,'branch');
            if (source.workspaceId !== target.workspaceId || source.id === target.id || !commitIds.length || new Set(commitIds).size !== commitIds.length)
                throw new DomainError('MERGE','Invalid merge');
            const token = this.revision(target);
            this.assertRevision(token,{branchRevision:expectedRevision,mainRevision:expectedMainRevision ?? token.mainRevision});
            const mainId = this.get<Workspace>(source.workspaceId,'workspace').mainBranchId;
            for (const cid of commitIds) {
                if (!this.hasCommit(source.id,cid) && !this.hasCommit(mainId,cid)) throw new DomainError('MERGE','Commit absent from source');
                if (this.hasCommit(target.id,cid) || (target.id !== mainId && this.hasCommit(mainId,cid)))
                    throw new DomainError('MERGE','Commit already visible in target');
            }
            const incoming = commitIds.map(cid => this.get<ContextCommit>(cid,'commit'));
            const decisions = incoming.filter(c => c.knowledge.kind === 'decision');
            if (decisions.some((c,i) => decisions.slice(i+1).some(other => identity(c) === identity(other) || overlaps(c,other))))
                throw new DomainError('MERGE','Overlapping incoming decisions must be reviewed separately');
            const existing = this.effective(target,token);
            const conflicts: Conflict[] = decisions.flatMap(c => existing.filter(e => overlaps(e,c) && e.knowledge.body !== c.knowledge.body)
                .map(e => ({key:c.knowledge.key,existingCommitId:e.id,incomingCommitId:c.id})));
            const m: MergeRequest = {id:id(),workspaceId:target.workspaceId,sourceBranchId,targetBranchId,commitIds:[...commitIds],
                expectedRevision,expectedMainRevision:token.mainRevision,state:'pending'};
            if (target.restricted || conflicts.length) {
                const r: Review = {id:id(),mergeId:m.id,state:'pending',conflicts};
                m.reviewId = r.id;
                this.store.insert(r.id,'review',r);
            }
            this.store.insert(m.id,'merge',m);
            this.audit('merge.created',m,m.workspaceId);
            return m;
        });
    }
    applyMerge(mergeId: string): MergeRequest {
        const initial = this.get<MergeRequest>(mergeId,'merge');
        const review = initial.reviewId ? this.get<Review>(initial.reviewId,'review') : undefined;
        this.guard('merge.apply',initial.targetBranchId,review?.state === 'approved');
        return this.store.transaction(() => {
            const m = this.get<MergeRequest>(mergeId,'merge'), b = this.get<Branch>(m.targetBranchId,'branch');
            if (m.state !== 'pending') throw new DomainError('STATE','Merge is not pending');
            this.assertRevision(this.revision(b),{branchRevision:m.expectedRevision,mainRevision:m.expectedMainRevision});
            const r = m.reviewId ? this.get<Review>(m.reviewId,'review') : undefined;
            if (r && r.state !== 'approved') throw new DomainError('REVIEW','Approval required');
            const active = this.store.decisions<ContextCommit>(b.id,b.revision);
            for (const cid of m.commitIds) {
                const c = this.get<ContextCommit>(cid,'commit');
                this.attach(b,cid);
                if (c.knowledge.kind !== 'decision') continue;
                const rejected = r?.resolutions?.some(choice => choice.incomingCommitId === cid && choice.selectedCommitId !== cid);
                if (rejected) continue;
                // Materialized decision choices are append-only; history keeps every proposal.
                for (const old of active.filter(old => overlaps(old,c) && old.knowledge.body !== c.knowledge.body && identity(old) !== identity(c)))
                    this.store.recordDecision(b.id,b.revision,identity(old),null);
                this.store.recordDecision(b.id,b.revision,identity(c),cid);
            }
            m.state = 'applied';
            this.store.put(m.id,'merge',m);
            if (r) { r.state = 'resolved'; this.store.put(r.id,'review',r); }
            this.audit('merge.applied',{merge:m,actor:this.actor},m.workspaceId);
            return m;
        });
    }
    review(reviewId: string): Review {
        const r = this.get<Review>(reviewId,'review'), m = this.get<MergeRequest>(r.mergeId,'merge');
        this.guard('review.read',m.targetBranchId);
        return r;
    }
    resolveReview(reviewId: string, decision: 'approved' | 'rejected', resolutions?: ConflictResolution[]): Review {
        const initial = this.get<Review>(reviewId,'review'), merge = this.get<MergeRequest>(initial.mergeId,'merge');
        this.guard('review.resolve',merge.targetBranchId);
        return this.store.transaction(() => {
            const r = this.get<Review>(reviewId,'review'), m = this.get<MergeRequest>(r.mergeId,'merge');
            if (r.state !== 'pending' || m.state !== 'pending') throw new DomainError('STATE','Review already decided');
            this.assertRevision(this.revision(this.get<Branch>(m.targetBranchId,'branch')),{branchRevision:m.expectedRevision,mainRevision:m.expectedMainRevision});
            if (resolutions !== undefined) {
                if (decision !== 'approved' || resolutions.length !== r.conflicts.length
                    || new Set(resolutions.map(c => JSON.stringify([c.existingCommitId,c.incomingCommitId]))).size !== resolutions.length
                    || resolutions.some(choice => !r.conflicts.some(c => c.existingCommitId === choice.existingCommitId && c.incomingCommitId === choice.incomingCommitId)
                        || ![choice.existingCommitId,choice.incomingCommitId].includes(choice.selectedCommitId)))
                    throw new DomainError('RESOLUTION','Select one existing or incoming commit for each conflict');
                // A proposal is accepted or retained as a whole, never partially by impact region.
                for (const cid of m.commitIds) {
                    const choices = resolutions.filter(c => c.incomingCommitId === cid);
                    if (choices.some(c => c.selectedCommitId === cid) && choices.some(c => c.selectedCommitId !== cid))
                        throw new DomainError('RESOLUTION','Overlapping conflicts must agree on whether to accept the incoming decision');
                }
                for (const existingId of new Set(resolutions.map(c => c.existingCommitId))) {
                    const choices = resolutions.filter(c => c.existingCommitId === existingId);
                    if (choices.some(c => c.selectedCommitId === existingId) && choices.some(c => c.selectedCommitId !== existingId))
                        throw new DomainError('RESOLUTION','An existing decision cannot be both retained and superseded');
                }
            }
            r.state = decision;
            r.decision = decision;
            r.decidedBy = this.actor.type === 'human' ? this.actor.id : undefined;
            if (decision === 'approved') r.resolutions = resolutions ?? r.conflicts.map(c => ({...c,selectedCommitId:c.incomingCommitId}));
            this.store.put(r.id,'review',r);
            if (decision === 'rejected') { m.state = 'rejected'; this.store.put(m.id,'merge',m); }
            this.audit('review.decided',{review:r,actor:this.actor},m.workspaceId);
            return r;
        });
    }
    /** Example enforcement boundary. External side effects are not SQLite transactions. */
    executeControlled<T>(branchId: string, action: () => T): T {
        this.guard('controlled.execute',branchId);
        const result = action();
        this.audit('controlled.executed',{branchId,actor:this.actor},this.get<Branch>(branchId,'branch').workspaceId);
        return result;
    }
}
export type ApplicationService = Pick<AgentreeService, 'workspace' | 'branches' | 'lookup' | 'contextRevision' | 'snapshot' | 'events' | 'createWorkspace' | 'createBranch' | 'registerSession' | 'ingest' | 'publish' | 'context' | 'createMerge' | 'applyMerge' | 'review' | 'resolveReview' | 'authorize' | 'executeControlled'>;
