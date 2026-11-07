import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { SqliteStore } from '../packages/storage/src/index.js';
import { AgentreeService } from '../packages/core/src/index.js';
import { DomainError, type Session, type Workspace } from '../packages/contracts/src/index.js';
export interface GatewayOptions {
    database: string;
    adminToken: string;
    approvalTimeoutMs?: number;
}
import type { ToolApproval } from '../packages/contracts/src/gateway.js';
export type { ToolApproval } from '../packages/contracts/src/gateway.js';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const text = z.string().min(1);
const registration = z.object({ runtime: text, cwd: text.optional(), label: text.optional(), branchId: text.optional(), nativeId: text.optional() });
const decision = z.object({ sessionId: text.optional(), tool: text, input: z.unknown(), nativeSessionId: text.optional(), cwd: text.optional() });
/** Local daemon boundary: HTTP input never supplies a Core actor. */
export function createGateway(options: GatewayOptions) {
    if (options.adminToken.length < 32)
        throw new Error('Admin token must contain at least 32 characters');
    const store = new SqliteStore(options.database);
    const admin = new AgentreeService(store, { type: 'human', id: 'local-admin' });
    store.db.exec(`CREATE TABLE IF NOT EXISTS gateway_credentials (hash TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS gateway_sessions (session_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gateway_approvals (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX IF NOT EXISTS gateway_pending_deadline ON gateway_approvals(json_extract(data,'$.state'),json_extract(data,'$.expiresAt'));`);
    const streams = new Set<ServerResponse>();
    const audit = (type: string, payload: unknown, workspaceId: string, sessionId?: string) => {
        const id = randomUUID();
        store.appendEvent({ id, workspaceId, source: 'gateway', nativeId: id, sessionId, type, mode: 'controlled', payload, occurredAt: new Date().toISOString() });
    };
    const approvals = () => (store.db.prepare('SELECT data FROM gateway_approvals ORDER BY rowid').all() as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as ToolApproval);
    const save = (a: ToolApproval) => store.db.prepare('INSERT OR REPLACE INTO gateway_approvals(id,data) VALUES(?,?)').run(a.id, JSON.stringify(a));
    function finish(a: ToolApproval, state: ToolApproval['state'], reason: string) {
        if (a.state !== 'pending')
            throw new DomainError('STATE', 'Approval already decided');
        if (state !== 'timeout' && Date.parse(a.expiresAt) <= Date.now()) {
            finish(a, 'timeout', 'Approval deadline elapsed');
            throw new DomainError('STATE', 'Approval deadline elapsed');
        }
        store.transaction(() => {
            a.state = state;
            a.reason = reason;
            a.decidedAt = new Date().toISOString();
            save(a);
            audit('tool.decided', { approvalId: a.id, outcome: state === 'approved' ? 'allow' : 'deny', state, reason, actor: state === 'timeout' ? 'gateway' : 'local-admin' }, a.workspaceId, a.sessionId);
        });
    }
    function expire() {
        const rows = store.db.prepare("SELECT data FROM gateway_approvals WHERE json_extract(data,'$.state')='pending' AND json_extract(data,'$.expiresAt')<=?").all(new Date().toISOString()) as {
            data: string;
        }[];
        for (const row of rows)
            finish(JSON.parse(row.data), 'timeout', 'Approval deadline elapsed');
    }
    expire();
    const timer = setInterval(expire, 100);
    timer.unref();
    function session(id: string) {
        const s = store.get<Session>(id, 'session');
        if (!s)
            throw new DomainError('NOT_FOUND', 'Session not found');
        return s;
    }
    function active(id: string) {
        if (store.db.prepare('SELECT state FROM gateway_sessions WHERE session_id=?').get(id)?.state !== 'active')
            throw new DomainError('DENY', 'Session is inactive');
    }
    async function body(req: IncomingMessage) {
        let raw = '';
        for await (const chunk of req) {
            raw += chunk;
            if (Buffer.byteLength(raw) > 1024 * 1024)
                throw new DomainError('BODY', 'Body exceeds 1 MiB');
        }
        return raw ? JSON.parse(raw) : {};
    }
    const server = createServer(async (req, res) => {
        const send = (data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
        try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const path = url.pathname;
            const method = req.method;
            if (path === '/health' && method === 'GET')
                return send({ status: 'ok' });
            // No cookie authentication or ambient browser authority; reject browser origins entirely.
            if (req.headers.origin)
                throw new DomainError('DENY', 'Browser Origin requests require a same-origin Console proxy');
            const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
            const isAdmin = timingSafeEqual(Buffer.from(digest(token)), Buffer.from(digest(options.adminToken)));
            const credential = store.db.prepare('SELECT session_id FROM gateway_credentials WHERE hash=?').get(digest(token));
            if (!isAdmin && !credential)
                return send({ error: { code: 'UNAUTHORIZED', message: 'Bearer credential required' } }, 401);
            const sid = isAdmin ? undefined : String(credential!.session_id);
            if (sid)
                active(sid);
            const svc = sid ? new AgentreeService(store, { type: 'agent', sessionId: sid }) : admin;
            const human = () => { if (!isAdmin)
                throw new DomainError('DENY', 'Human admin credential required'); };
            const own = (id: string) => { if (sid && sid !== id)
                throw new DomainError('DENY', 'Session credential mismatch'); return session(id); };
            if (path === '/v1/workspaces' && method === 'GET') {
                human();
                return send(store.list('workspace'));
            }
            if (path === '/v1/workspaces' && method === 'POST') {
                human();
                const b = z.object({ name: text, roots: z.array(z.object({ id: text, path: text })).default([]) }).parse(await body(req));
                return send(admin.createWorkspace(b.name, b.roots), 201);
            }
            if (path === '/v1/sessions' && method === 'POST') {
                human();
                const b = registration.parse(await body(req));
                let branchId = b.branchId;
                if (!branchId) {
                    if (!b.cwd)
                        throw new DomainError('BODY', 'cwd or branchId required');
                    const cwd = resolve(b.cwd);
                    let w = store.list<Workspace>('workspace').find(w => w.roots.some(r => r.path === cwd));
                    w ??= admin.createWorkspace(b.label ?? cwd, [{ id: 'root', path: cwd }]);
                    branchId = admin.createBranch(w.id, b.label ?? 'agent').id;
                }
                const s = admin.registerSession(branchId, { id: randomUUID(), name: b.label ?? b.runtime }, b.runtime, b.nativeId ?? randomUUID());
                const sessionToken = randomBytes(32).toString('hex');
                store.db.prepare('INSERT OR REPLACE INTO gateway_credentials(hash,session_id) VALUES(?,?)').run(digest(sessionToken), s.id);
                store.db.prepare("INSERT OR REPLACE INTO gateway_sessions VALUES(?,'active')").run(s.id);
                return send({ ...s, sessionId: s.id, sessionToken, seq: Number(store.db.prepare('SELECT COALESCE(MAX(sequence),0) AS seq FROM events').get()!.seq) }, 201);
            }
            if (path === '/v1/sessions' && method === 'GET') {
                human();
                return send(store.list<Session>('session').map(s => ({ ...s, state: store.db.prepare('SELECT state FROM gateway_sessions WHERE session_id=?').get(s.id)?.state ?? 'ended' })));
            }
            const sessionRoute = path.match(/^\/v1\/sessions\/([^/]+)(?:\/(end|kill))?$/);
            if (sessionRoute) {
                const s = own(sessionRoute[1]);
                if (method === 'GET' && !sessionRoute[2])
                    return send(s);
                if (method === 'POST' && sessionRoute[2]) {
                    if (sessionRoute[2] === 'kill')
                        human();
                    expire();
                    store.transaction(() => {
                        store.db.prepare('UPDATE gateway_sessions SET state=? WHERE session_id=?').run(sessionRoute[2] === 'kill' ? 'killed' : 'ended', s.id);
                        audit(sessionRoute[2] === 'kill' ? 'session.killed' : 'session.ended', {}, s.workspaceId, s.id);
                        for (const a of approvals())
                            if (a.sessionId === s.id && a.state === 'pending')
                                finish(a, 'denied', 'Session ended');
                    });
                    return send({ ok: true });
                }
            }
            if (path === '/v1/decide' && method === 'POST') {
                if (!sid)
                    throw new DomainError('DENY', 'Session credential required');
                const b = decision.parse(await body(req));
                if (b.sessionId && b.sessionId !== sid)
                    throw new DomainError('DENY', 'Session credential mismatch');
                const s = session(sid);
                const policy = svc.authorize('controlled.execute', s.branchId, s.workspaceId);
                if (policy.outcome === 'deny')
                    return send({ outcome: 'deny', reason: policy.reason });
                const a: ToolApproval = { id: randomUUID(), workspaceId: s.workspaceId, sessionId: sid, tool: b.tool, input: b.input ?? null, state: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (options.approvalTimeoutMs ?? 60000)).toISOString(), policyDecisionId: policy.id };
                store.transaction(() => { save(a); audit('tool.pending', a, s.workspaceId, sid); });
                // Only an attached pre-execution hook can enforce the returned decision.
                while (!res.destroyed) {
                    const row = store.db.prepare('SELECT data FROM gateway_approvals WHERE id=?').get(a.id)!;
                    const current = JSON.parse(String(row.data)) as ToolApproval;
                    if (current.state !== 'pending') {
                        let outcome: 'allow' | 'deny' = current.state === 'approved' ? 'allow' : 'deny';
                        try {
                            active(sid);
                        }
                        catch {
                            outcome = 'deny';
                        }
                        audit('tool.execution-decision', { approvalId: a.id, outcome }, s.workspaceId, sid);
                        return send({ approvalId: a.id, outcome, reason: outcome === 'deny' && current.state === 'approved' ? 'Session is inactive' : current.reason, by: 'Gateway' });
                    }
                    await new Promise(r => setTimeout(r, 50));
                }
                return;
            }
            if (path === '/v1/approvals' && method === 'GET') {
                human();
                expire();
                return send(approvals());
            }
            const approvalRoute = path.match(/^\/v1\/approvals\/([^/]+)$/);
            if (approvalRoute && method === 'POST') {
                human();
                expire();
                const b = z.object({ decision: z.enum(['approved', 'denied']), reason: text.optional() }).parse(await body(req));
                const a = approvals().find(a => a.id === approvalRoute[1]);
                if (!a)
                    throw new DomainError('NOT_FOUND', 'Approval not found');
                finish(a, b.decision, b.reason ?? b.decision);
                return send(a);
            }
            const workspaceRoute = path.match(/^\/v1\/workspaces\/([^/]+)(?:\/(branches|events))?$/);
            if (workspaceRoute) {
                const wid = workspaceRoute[1];
                svc.workspace(wid);
                if (method === 'GET' && !workspaceRoute[2])
                    return send(svc.workspace(wid));
                if (method === 'GET' && workspaceRoute[2] === 'branches')
                    return send(svc.branches(wid));
                if (method === 'POST' && workspaceRoute[2] === 'branches') {
                    human();
                    const b = z.object({ name: text, restricted: z.boolean().optional() }).parse(await body(req));
                    return send(admin.createBranch(wid, b.name, b.restricted), 201);
                }
                if (method === 'GET' && workspaceRoute[2] === 'events')
                    return send(svc.events(wid, { afterSequence: Number(url.searchParams.get('after') ?? 0), limit: Number(url.searchParams.get('limit') ?? 100) }));
            }
            if (path === '/v1/events' && method === 'POST') {
                const b = z.object({ id: text, workspaceId: text, source: text, nativeId: text, sessionId: text.optional(), type: text, mode: z.literal('observed'), payload: z.unknown(), occurredAt: text }).parse(await body(req));
                return send({ inserted: svc.ingest({ ...b, payload: b.payload }) });
            }
            if (path === '/v1/stream' && method === 'GET') {
                let cursor = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
                if (!Number.isSafeInteger(cursor) || cursor < 0)
                    throw new DomainError('CURSOR', 'Invalid cursor');
                const workspaceId = sid ? session(sid).workspaceId : url.searchParams.get('workspaceId');
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
                res.write(': connected\n\n');
                streams.add(res);
                const poll = () => {
                    const rows = store.db.prepare('SELECT sequence,data FROM events WHERE sequence>? ORDER BY sequence LIMIT 100').all(cursor) as {
                        sequence: number;
                        data: string;
                    }[];
                    for (const row of rows) {
                        cursor = row.sequence;
                        const e = JSON.parse(row.data);
                        if (workspaceId && e.workspaceId !== workspaceId)
                            continue;
                        if (sid && e.sessionId !== sid)
                            continue;
                        if (!res.write(`id: ${row.sequence}\ndata: ${JSON.stringify({ ...e, seq: row.sequence })}\n\n`)) {
                            res.destroy();
                            break;
                        }
                    }
                };
                poll();
                const interval = setInterval(poll, 100);
                const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
                res.on('close', () => { clearInterval(interval); clearInterval(heartbeat); streams.delete(res); });
                return;
            }
            const contextRoute = path.match(/^\/v1\/branches\/([^/]+)\/context$/);
            if (contextRoute) {
                if (method === 'GET')
                    return send(svc.snapshot(contextRoute[1]));
                if (method === 'POST') {
                    const b = z.object({ knowledge: z.unknown(), eventIds: z.array(text).optional(), expected: z.object({ branchRevision: z.number(), mainRevision: z.number() }).optional() }).parse(await body(req));
                    return send(svc.publish(contextRoute[1], b.knowledge as Parameters<typeof svc.publish>[1], b.eventIds, b.expected), 201);
                }
            }
            if (path === '/v1/merges' && method === 'POST') {
                const b = z.object({ sourceBranchId: text, targetBranchId: text, commitIds: z.array(text), expectedRevision: z.number(), expectedMainRevision: z.number().optional() }).parse(await body(req));
                return send(svc.createMerge(b.sourceBranchId, b.targetBranchId, b.commitIds, b.expectedRevision, b.expectedMainRevision), 201);
            }
            if ((path === '/v1/merges' || path === '/v1/reviews') && method === 'GET') {
                human();
                return send(store.list(path.endsWith('merges') ? 'merge' : 'review'));
            }
            const mergeRoute = path.match(/^\/v1\/merges\/([^/]+)\/apply$/);
            if (mergeRoute && method === 'POST')
                return send(svc.applyMerge(mergeRoute[1]));
            const reviewRoute = path.match(/^\/v1\/reviews\/([^/]+)$/);
            if (reviewRoute) {
                if (method === 'GET')
                    return send(svc.review(reviewRoute[1]));
                if (method === 'POST') {
                    human();
                    const b = z.object({ decision: z.enum(['approved', 'rejected']), resolutions: z.array(z.object({ existingCommitId: text, incomingCommitId: text, selectedCommitId: text })).optional() }).parse(await body(req));
                    return send(svc.resolveReview(reviewRoute[1], b.decision, b.resolutions));
                }
            }
            send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
        }
        catch (error) {
            const code = error instanceof DomainError ? error.code : error instanceof z.ZodError || error instanceof SyntaxError ? 'BODY' : 'INTERNAL';
            send({ error: { code, message: code === 'INTERNAL' ? 'Internal server error' : (error as Error).message } }, code === 'NOT_FOUND' ? 404 : code === 'DENY' || code === 'IDENTITY' ? 403 : ['STATE', 'STALE', 'REVIEW', 'REQUIRE-APPROVAL'].includes(code) ? 409 : code === 'INTERNAL' ? 500 : 400);
        }
    });
    return { server, store, close: async () => { clearInterval(timer); for (const res of streams)
            res.end(); server.closeAllConnections(); await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); store.db.close(); } };
}
