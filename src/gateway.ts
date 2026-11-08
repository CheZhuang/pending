import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { SqliteStore } from '../packages/storage/src/index.js';
import { AgentreeService } from '../packages/core/src/index.js';
import { DomainError, mainInputSchema, workInputSchema, type Session, type Workspace } from '../packages/contracts/src/index.js';
export interface GatewayOptions {
    database: string;
    adminToken: string;
    approvalTimeoutMs?: number;
    consoleOrigins?: string[];
}
import type { ToolApproval } from '../packages/contracts/src/gateway.js';
export type { ToolApproval } from '../packages/contracts/src/gateway.js';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const text = z.string().min(1);
const registration = z.object({ runtime: text, cwd: text.optional(), label: text.optional(), branchId: text.optional(), nativeId: text.optional() });
const decision = z.object({ requestId: text, sessionId: text.optional(), tool: text, input: z.unknown(), nativeSessionId: text.optional(), cwd: text.optional() });
/** Local daemon boundary: HTTP input never supplies a Core actor. */
export function createGateway(options: GatewayOptions) {
    if (options.adminToken.length < 32)
        throw new Error('Admin token must contain at least 32 characters');
    const store = new SqliteStore(options.database);
    const admin = new AgentreeService(store, { type: 'human', id: 'local-admin' });
    store.db.exec(`CREATE TABLE IF NOT EXISTS gateway_credentials (hash TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS gateway_sessions (session_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gateway_exit_reports (session_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gateway_approvals (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX IF NOT EXISTS gateway_pending_deadline ON gateway_approvals(json_extract(data,'$.state'),json_extract(data,'$.expiresAt'));`);
    const streams = new Set<ServerResponse>();
    const browserSessions = new Map<string, {
        origin: string;
        expires: number;
    }>();
    const allowedOrigins = new Set(options.consoleOrigins ?? []);
    store.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS gateway_request_identity ON gateway_approvals(json_extract(data,'$.sessionId'),json_extract(data,'$.requestId')) WHERE json_extract(data,'$.requestId') IS NOT NULL;`);
    const audit = (type: string, payload: unknown, workspaceId: string, sessionId?: string) => {
        const id = randomUUID();
        store.appendEvent({ id, workspaceId, source: 'gateway', nativeId: id, sessionId, type, mode: 'controlled', payload, occurredAt: new Date().toISOString() });
    };
    const approvals = () => (store.db.prepare('SELECT data FROM gateway_approvals ORDER BY rowid').all() as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as ToolApproval);
    const save = (a: ToolApproval) => store.db.prepare('INSERT OR REPLACE INTO gateway_approvals(id,data) VALUES(?,?)').run(a.id, JSON.stringify(a));
    // Caller owns the transaction; lifecycle changes can settle multiple approvals atomically.
    function settle(a: ToolApproval, state: ToolApproval['state'], reason: string) {
        a.state = state;
        a.reason = reason;
        a.decidedAt = new Date().toISOString();
        save(a);
        audit('tool.decided', { approvalId: a.id, requestId: a.requestId, outcome: state === 'approved' ? 'allow' : 'deny', state, reason, actor: state === 'timeout' ? 'gateway' : 'local-admin' }, a.workspaceId, a.sessionId);
    }
    function finish(a: ToolApproval, state: ToolApproval['state'], reason: string) {
        if (a.state !== 'pending')
            throw new DomainError('STATE', 'Approval already decided');
        const overdue = state !== 'timeout' && Date.parse(a.expiresAt) <= Date.now();
        store.transaction(() => settle(a, overdue ? 'timeout' : state, overdue ? 'Approval deadline elapsed' : reason));
        if (overdue)
            throw new DomainError('STATE', 'Approval deadline elapsed');
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
    function lifecycle(id: string) {
        const state = String(store.db.prepare('SELECT state FROM gateway_sessions WHERE session_id=?').get(id)?.state ?? 'ended');
        const row = store.db.prepare('SELECT data FROM gateway_exit_reports WHERE session_id=?').get(id);
        return { state, processStatus: row ? 'exit-reported' : 'unknown', ...(row ? { exit: JSON.parse(String(row.data)) } : {}) };
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
            const origin = req.headers.origin;
            if (origin && !allowedOrigins.has(origin))
                throw new DomainError('DENY', 'Console origin is not allowed');
            if (origin) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Access-Control-Allow-Credentials', 'true');
                res.setHeader('Vary', 'Origin');
            }
            if (method === 'OPTIONS' && origin) {
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID');
                res.writeHead(204);
                res.end();
                return;
            }
            const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
            const adminBearer = timingSafeEqual(Buffer.from(digest(token)), Buffer.from(digest(options.adminToken)));
            const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('gateway_console='))?.slice('gateway_console='.length);
            const browser = cookie ? browserSessions.get(digest(cookie)) : undefined;
            const browserAdmin = !!browser && browser.expires > Date.now() && (!origin || origin === browser.origin);
            if (browserAdmin && method !== 'GET' && !origin)
                throw new DomainError('DENY', 'Browser writes require the paired Origin');
            const isAdmin = adminBearer || browserAdmin;
            const credential = store.db.prepare('SELECT session_id FROM gateway_credentials WHERE hash=?').get(digest(token));
            if (!isAdmin && !credential)
                return send({ error: { code: 'UNAUTHORIZED', message: 'Credential required' } }, 401);
            if (path === '/v1/console/login' && method === 'POST') {
                if (!adminBearer || !origin)
                    throw new DomainError('DENY', 'Admin bearer and allowed Console Origin required');
                const browserToken = randomBytes(32).toString('hex');
                browserSessions.set(digest(browserToken), { origin, expires: Date.now() + 8 * 60 * 60 * 1000 });
                res.setHeader('Set-Cookie', `gateway_console=${browserToken}; HttpOnly; SameSite=Strict; Path=/v1; Max-Age=28800`);
                return send({ ok: true });
            }
            if (path === '/v1/console/logout' && method === 'POST') {
                if (cookie)
                    browserSessions.delete(digest(cookie));
                res.setHeader('Set-Cookie', 'gateway_console=; HttpOnly; SameSite=Strict; Path=/v1; Max-Age=0');
                return send({ ok: true });
            }
            const sid = isAdmin ? undefined : String(credential!.session_id);
            if (sid && !(/^\/v1\/sessions\/[^/]+\/end$/.test(path) || path === '/v1/stream'))
                active(sid);
            const svc = sid ? new AgentreeService(store, { type: 'agent', sessionId: sid }) : admin;
            const human = () => {
                if (!isAdmin)
                    throw new DomainError('DENY', 'Human admin credential required');
            };
            const own = (id: string) => {
                if (sid && sid !== id)
                    throw new DomainError('DENY', 'Session credential mismatch');
                return session(id);
            };
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
                return send(store.list<Session>('session').map(s => ({ ...s, ...lifecycle(s.id) })));
            }
            const sessionRoute = path.match(/^\/v1\/sessions\/([^/]+)(?:\/(end|kill))?$/);
            if (sessionRoute) {
                const s = own(sessionRoute[1]);
                if (method === 'GET' && !sessionRoute[2])
                    return send({ ...s, ...lifecycle(s.id) });
                if (method === 'POST' && sessionRoute[2]) {
                    if (sessionRoute[2] === 'kill')
                        human();
                    const exiting = sessionRoute[2] === 'end';
                    const report = exiting ? z.object({ exitCode: z.number().int().nullable().optional(), signal: z.string().nullable().optional() }).parse(await body(req)) : undefined;
                    const prior = String(store.db.prepare('SELECT state FROM gateway_sessions WHERE session_id=?').get(s.id)?.state);
                    const state = exiting ? 'ended' : prior === 'ended' ? 'ended' : 'kill-requested';
                    store.transaction(() => {
                        store.db.prepare('UPDATE gateway_sessions SET state=? WHERE session_id=?').run(state, s.id);
                        const hasExit = report?.exitCode !== undefined || report?.signal !== undefined;
                        const recorded = store.db.prepare('SELECT 1 FROM gateway_exit_reports WHERE session_id=?').get(s.id);
                        if (hasExit && !recorded) {
                            store.db.prepare('INSERT INTO gateway_exit_reports VALUES(?,?)').run(s.id, JSON.stringify(report));
                            audit('session.exited', report, s.workspaceId, s.id);
                        }
                        else if (prior !== state)
                            audit(exiting ? 'session.ended' : 'session.kill-requested', {}, s.workspaceId, s.id);
                        for (const a of approvals())
                            if (a.sessionId === s.id && a.state === 'pending') {
                                const overdue = Date.parse(a.expiresAt) <= Date.now();
                                settle(a, overdue ? 'timeout' : 'denied', overdue ? 'Approval deadline elapsed' : 'Session ended');
                            }
                    });
                    return send({ ok: true, ...lifecycle(s.id) }, exiting || prior === 'ended' ? 200 : 202);
                }
            }
            if (path === '/v1/decide' && method === 'POST') {
                if (!sid)
                    throw new DomainError('DENY', 'Session credential required');
                const b = decision.parse(await body(req));
                active(sid);
                if (b.sessionId && b.sessionId !== sid)
                    throw new DomainError('DENY', 'Session credential mismatch');
                const s = session(sid);
                const prior = store.db.prepare("SELECT data FROM gateway_approvals WHERE json_extract(data,'$.sessionId')=? AND json_extract(data,'$.requestId')=?").get(sid, b.requestId);
                let a: ToolApproval;
                if (prior) {
                    a = JSON.parse(String(prior.data));
                    if (a.tool !== b.tool || !isDeepStrictEqual(a.input, b.input ?? null))
                        throw new DomainError('STATE', 'Request ID already used for different tool input');
                }
                else {
                    const policy = svc.authorize('controlled.execute', s.branchId, s.workspaceId);
                    if (policy.outcome === 'deny')
                        return send({ requestId: b.requestId, outcome: 'deny', reason: policy.reason });
                    a = { id: randomUUID(), requestId: b.requestId, workspaceId: s.workspaceId, sessionId: sid, tool: b.tool, input: b.input ?? null, state: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (options.approvalTimeoutMs ?? 60000)).toISOString(), policyDecisionId: policy.id };
                    store.transaction(() => { save(a); audit('tool.pending', a, s.workspaceId, sid); });
                }
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
                        return send({ requestId: a.requestId, approvalId: a.id, outcome, reason: outcome === 'deny' && current.state === 'approved' ? 'Session is inactive' : current.reason, by: 'Gateway' });
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
                    const b = z.object({ name: text }).parse(await body(req));
                    return send(admin.createBranch(wid, b.name), 201);
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
                    if (browser && (!cookie || !browserSessions.has(digest(cookie)) || browser.expires <= Date.now())) {
                        res.end();
                        return;
                    }
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
            const mainRoute = path.match(/^\/v1\/workspaces\/([^/]+)\/main(?:\/([^/]+)(?:\/(history))?)?$/);
            if (mainRoute) {
                const [,wid,entryId,history] = mainRoute;
                if (method === 'GET') return send(history && entryId ? svc.mainHistory(wid!,entryId) : svc.main(wid!));
                if (method === 'POST' && !history) {
                    human();
                    const b = mainInputSchema.extend({expectedRevision:z.number().int().min(0),remove:z.boolean().optional()}).parse(await body(req));
                    return send(admin.editMain(wid!,b,b.expectedRevision,entryId,b.remove),entryId ? 200 : 201);
                }
            }
            const supervisionRoute = path.match(/^\/v1\/workspaces\/([^/]+)\/(supervision|conflicts|merges)(?:\/([^/]+))?$/);
            if (supervisionRoute) {
                const [,wid,kind,conflictId] = supervisionRoute;
                if (method === 'GET' && !conflictId) return send(kind === 'supervision' ? svc.supervision(wid!) : kind === 'conflicts' ? svc.conflicts(wid!) : svc.merges(wid!));
                if (method === 'POST' && kind === 'conflicts') {
                    human();
                    if (conflictId) {
                        const b = z.object({status:z.enum(['potential','confirmed','resolved','dismissed']),explanation:text}).parse(await body(req));
                        return send(admin.decideConflict(wid!,conflictId,b.status,b.explanation));
                    }
                    const b = z.object({branchIds:z.array(text).min(1),mainEntryId:text.optional(),explanation:text}).parse(await body(req));
                    return send(admin.reportConflict(wid!,b),201);
                }
            }
            const branchRoute = path.match(/^\/v1\/branches\/([^/]+)\/(work|corrections|merge)$/);
            if (branchRoute) {
                const [,branchId,kind] = branchRoute;
                if (method === 'GET' && kind === 'work') return send(svc.branchOverview(branchId!));
                if (method === 'POST' && kind === 'work') return send(svc.proposeWork(branchId!,workInputSchema.parse(await body(req))),201);
                if (method === 'POST' && kind === 'corrections') {
                    human();
                    const b = z.object({body:text}).parse(await body(req));
                    return send(admin.sendCorrection(branchId!,b.body),201);
                }
                if (method === 'POST' && kind === 'merge') {
                    human();
                    const b = z.object({workIds:z.array(text).min(1),decision:z.enum(['accepted','rejected']),expectedMainRevision:z.number().int().min(0)}).parse(await body(req));
                    return send(admin.decideMerge(branchId!,b.workIds,b.decision,b.expectedMainRevision),201);
                }
            }
            send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
        }
        catch (error) {
            const code = error instanceof DomainError ? error.code : error instanceof z.ZodError || error instanceof SyntaxError ? 'BODY' : 'INTERNAL';
            send({ error: { code, message: code === 'INTERNAL' ? 'Internal server error' : (error as Error).message } }, code === 'NOT_FOUND' ? 404 : code === 'DENY' || code === 'IDENTITY' ? 403 : ['STATE', 'STALE', 'REVIEW', 'REQUIRE-APPROVAL'].includes(code) ? 409 : code === 'INTERNAL' ? 500 : 400);
        }
    });
    return { server, store, close: async () => {
            clearInterval(timer);
            for (const res of streams)
                res.end();
            server.closeAllConnections();
            await new Promise<void>((r, j) => server.close(e => e ? j(e) : r()));
            store.db.close();
        } };
}
