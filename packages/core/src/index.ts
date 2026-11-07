import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../../storage/src/index.js';
import { DomainError, knowledgeSchema, type Actor, type Branch, type ContextCommit, type Knowledge, type MergeRequest, type NormalizedEvent, type Operation, type PolicyDecision, type Review, type Session, type Workspace } from '../../contracts/src/index.js';
const id = () => randomUUID();
/** Construct only at the trusted daemon boundary. Never deserialize Actor from agent input. */
export class AgentreeService {
    constructor(readonly store: SqliteStore, private readonly actor: Actor) { }
    private get<T>(key: string): T { const value = this.store.get<T>(key); if (!value)
        throw new DomainError('NOT_FOUND', key); return value; }
    private session(): Session { if (this.actor.type !== 'agent')
        throw new DomainError('IDENTITY', 'Agent required'); return this.get<Session>(this.actor.sessionId); }
    private audit(type: string, payload: unknown, workspaceId = 'gateway') { this.store.appendEvent({ id: id(), workspaceId, source: 'gateway', nativeId: id(), type, mode: 'controlled', payload, occurredAt: new Date().toISOString() }); }
    authorize(operation: Operation, branchId?: string, workspaceId?: string): PolicyDecision {
        let outcome: PolicyDecision['outcome'] = 'allow', reason = 'Authorized';
        if (this.actor.type === 'agent') {
            const session = this.session();
            const branch = branchId ? this.get<Branch>(branchId) : undefined;
            if (['workspace.create', 'branch.create', 'session.register', 'review.resolve'].includes(operation) || (workspaceId !== undefined && workspaceId !== session.workspaceId) || (branch && branch.workspaceId !== session.workspaceId) || (operation === 'context.publish' && branchId !== session.branchId)) {
                outcome = 'deny';
                reason = 'Actor has no authority for this operation';
            }
            else if (operation === 'controlled.execute' || (operation === 'merge.apply' && branch?.restricted)) {
                outcome = 'require-approval';
                reason = 'Human approval required';
            }
        }
        const result: PolicyDecision = { id: id(), actor: this.actor, operation, outcome, reason, createdAt: new Date().toISOString() };
        this.audit('policy.decision', result);
        return result;
    }
    private guard(op: Operation, branchId?: string, approved = false) { const decision = this.authorize(op, branchId); if (decision.outcome === 'deny' || (decision.outcome === 'require-approval' && !approved))
        throw new DomainError(decision.outcome.toUpperCase(), decision.reason); }
    createWorkspace(name: string, roots: Workspace['roots'] = []): Workspace { this.guard('workspace.create'); const w = { id: id(), name, roots }; this.store.transaction(() => { this.store.insert(w.id, 'workspace', w); this.audit('workspace.created', w, w.id); }); return w; }
    createBranch(workspaceId: string, name: string, restricted = false): Branch { this.guard('branch.create'); this.get<Workspace>(workspaceId); const b = { id: id(), workspaceId, name, restricted, revision: 0 }; this.store.transaction(() => { this.store.insert(b.id, 'branch', b); this.audit('branch.created', b, workspaceId); }); return b; }
    registerSession(branchId: string, agent: {
        id: string;
        name: string;
    }, runtime: string, nativeId: string): Session { this.guard('session.register', branchId); const b = this.get<Branch>(branchId); const prior = this.store.list<Session>('session').find(s => s.workspaceId === b.workspaceId && s.runtime === runtime && s.nativeId === nativeId); if (prior) {
        if (prior.branchId !== branchId || prior.agentId !== agent.id)
            throw new DomainError('IDENTITY', 'Native session already registered');
        return prior;
    } const s = { id: id(), agentId: agent.id, workspaceId: b.workspaceId, branchId, runtime, nativeId }; this.store.transaction(() => { if (!this.store.get(agent.id))
        this.store.insert(agent.id, 'agent', agent); this.store.insert(s.id, 'session', s); this.audit('session.registered', s, b.workspaceId); }); return s; }
    ingest(event: NormalizedEvent): boolean { const s = event.sessionId ? this.get<Session>(event.sessionId) : undefined; this.guard('event.ingest', s?.branchId); if (event.mode !== 'observed' || (this.actor.type === 'agent' && (!s || s.id !== this.session().id)) || (s && s.workspaceId !== event.workspaceId))
        throw new DomainError('EVENT', 'Invalid observed event identity'); return this.store.transaction(() => this.store.appendEvent(event)); }
    publish(branchId: string, knowledge: Knowledge, eventIds: string[] = []): ContextCommit { this.guard('context.publish', branchId); const parsed = knowledgeSchema.parse(knowledge); const s = this.session(); return this.store.transaction(() => { const b = this.get<Branch>(branchId); for (const eventId of eventIds) {
        const event = this.store.events<NormalizedEvent>().find(e => e.id === eventId);
        if (!event || event.sessionId !== s.id)
            throw new DomainError('PROVENANCE', 'Event must belong to publishing session');
    } if (parsed.kind === 'decision' && this.contextUnchecked(branchId).some(c => c.knowledge.kind === 'decision' && c.knowledge.key === parsed.key))
        throw new DomainError('AUTHORITATIVE', 'Decision requires merge review'); const c: ContextCommit = { id: id(), workspaceId: b.workspaceId, branchId, revision: b.revision + 1, knowledge: parsed, provenance: { sessionId: s.id, eventIds: [...eventIds] }, createdAt: new Date().toISOString() }; this.store.insert(c.id, 'commit', c); this.attach(b, c.id); this.audit('context.published', c, b.workspaceId); return c; }); }
    private contextUnchecked(branchId: string): ContextCommit[] { const rows = this.store.db.prepare('SELECT commit_id FROM branch_commits WHERE branch_id=? ORDER BY revision').all(branchId) as {
        commit_id: string;
    }[]; return rows.map(r => this.get<ContextCommit>(r.commit_id)); }
    workspace(workspaceId: string): Workspace { const decision=this.authorize('context.read',undefined,workspaceId); if(decision.outcome!=='allow') throw new DomainError('DENY',decision.reason); return this.get<Workspace>(workspaceId); }
    branches(workspaceId: string): Branch[] { this.workspace(workspaceId); return this.store.list<Branch>('branch').filter(b => b.workspaceId === workspaceId); }
    /** History remains immutable; current decisions select the latest explicitly accepted revision. */
    lookup(branchId: string): ContextCommit[] { const history = this.context(branchId); return history.filter((c, i) => c.knowledge.kind === 'finding' || !history.slice(i + 1).some(n => n.knowledge.kind === 'decision' && n.knowledge.key === c.knowledge.key)); }
    context(branchId: string): ContextCommit[] { this.guard('context.read', branchId); return this.contextUnchecked(branchId); }
    private attach(b: Branch, commitId: string) { b.revision++; this.store.db.prepare('INSERT INTO branch_commits(branch_id,commit_id,revision) VALUES(?,?,?)').run(b.id, commitId, b.revision); this.store.put(b.id, 'branch', b); }
    createMerge(sourceBranchId: string, targetBranchId: string, commitIds: string[], expectedRevision: number): MergeRequest { this.guard('merge.create', targetBranchId); this.guard('context.read', sourceBranchId); return this.store.transaction(() => { const source = this.get<Branch>(sourceBranchId), target = this.get<Branch>(targetBranchId); if (source.workspaceId !== target.workspaceId || source.id === target.id || !commitIds.length || new Set(commitIds).size !== commitIds.length)
        throw new DomainError('MERGE', 'Invalid merge'); const available = this.contextUnchecked(source.id); if (commitIds.some(c => !available.some(a => a.id === c)))
        throw new DomainError('MERGE', 'Commit absent from source'); if (target.revision !== expectedRevision)
        throw new DomainError('STALE', 'Target revision changed'); const incoming = commitIds.map(c => this.get<ContextCommit>(c)); const existing = this.contextUnchecked(target.id); const conflicts = incoming.flatMap(c => [...existing, ...incoming.filter(x => x.id !== c.id)].filter(e => e.knowledge.kind === 'decision' && c.knowledge.kind === 'decision' && e.knowledge.key === c.knowledge.key && e.knowledge.body !== c.knowledge.body).map(e => ({ key: c.knowledge.key, existingCommitId: e.id, incomingCommitId: c.id }))); const m: MergeRequest = { id: id(), workspaceId: target.workspaceId, sourceBranchId, targetBranchId, commitIds: [...commitIds], expectedRevision, state: 'pending' }; if (target.restricted || conflicts.length) {
        const r: Review = { id: id(), mergeId: m.id, state: 'pending', conflicts };
        m.reviewId = r.id;
        this.store.insert(r.id, 'review', r);
    } this.store.insert(m.id, 'merge', m); this.audit('merge.created', m, m.workspaceId); return m; }); }
    applyMerge(mergeId: string): MergeRequest { const initial = this.get<MergeRequest>(mergeId); const review = initial.reviewId ? this.get<Review>(initial.reviewId) : undefined; this.guard('merge.apply', initial.targetBranchId, review?.state === 'approved'); return this.store.transaction(() => { const m = this.get<MergeRequest>(mergeId), b = this.get<Branch>(m.targetBranchId); if (m.state !== 'pending')
        throw new DomainError('STATE', 'Merge is not pending'); if (b.revision !== m.expectedRevision)
        throw new DomainError('STALE', 'Target revision changed; create a fresh merge and review'); const r = m.reviewId ? this.get<Review>(m.reviewId) : undefined; if (r && r.state !== 'approved')
        throw new DomainError('REVIEW', 'Approval required'); const existing = this.contextUnchecked(b.id); for (const cid of m.commitIds)
        if (!existing.some(c => c.id === cid))
            this.attach(b, cid); m.state = 'applied'; this.store.put(m.id, 'merge', m); if (r) {
        r.state = 'resolved';
        this.store.put(r.id, 'review', r);
    } this.audit('merge.applied', { merge: m, actor: this.actor }, m.workspaceId); return m; }); }
    review(reviewId: string): Review { const r = this.get<Review>(reviewId), m = this.get<MergeRequest>(r.mergeId); this.guard('review.read', m.targetBranchId); return r; }
    resolveReview(reviewId: string, decision: 'approved' | 'rejected'): Review { const initial = this.get<Review>(reviewId), merge = this.get<MergeRequest>(initial.mergeId); this.guard('review.resolve', merge.targetBranchId); return this.store.transaction(() => { const r = this.get<Review>(reviewId), m = this.get<MergeRequest>(r.mergeId); if (r.state !== 'pending' || m.state !== 'pending')
        throw new DomainError('STATE', 'Review already decided'); if (this.get<Branch>(m.targetBranchId).revision !== m.expectedRevision)
        throw new DomainError('STALE', 'Review target changed'); r.state = decision; r.decision = decision; r.decidedBy = this.actor.type === 'human' ? this.actor.id : undefined; this.store.put(r.id, 'review', r); if (decision === 'rejected') {
        m.state = 'rejected';
        this.store.put(m.id, 'merge', m);
    } this.audit('review.decided', { review: r, actor: this.actor }, m.workspaceId); return r; }); }
    /** Example controlled operation: callback never runs before authorization. Agent requests require approval; humans may execute. */
    executeControlled<T>(branchId: string, action: () => T): T { this.guard('controlled.execute', branchId); const result = action(); this.audit('controlled.executed', { branchId, actor: this.actor }, this.get<Branch>(branchId).workspaceId); return result; }
}
export type ApplicationService = Pick<AgentreeService, 'workspace' | 'branches' | 'lookup' | 'createWorkspace' | 'createBranch' | 'registerSession' | 'ingest' | 'publish' | 'context' | 'createMerge' | 'applyMerge' | 'review' | 'resolveReview' | 'authorize' | 'executeControlled'>;
