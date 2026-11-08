import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { resolve, extname, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { SqliteStore } from '../packages/storage/src/index.js';
import { PendingTreeService } from '../packages/core/src/index.js';
import { DomainError, workInputSchema, type Correction, type Session, type Workspace } from '../packages/contracts/src/index.js';
import { TaskDispatch } from './task-dispatch.js';
import { ContextSync } from '../packages/sync/src/engine.js';
import { EntityLedger } from '../packages/sync/src/ledger.js';
import { collectConflictEvidence } from './conflict-evidence.js';
import { ProcessDiscovery, sameProcess, type ProcessProvider, type ManagedProcessBinding } from '../packages/adapters/src/process-discovery.js';
import { LocalProcessProvider } from '../packages/adapters/src/process-platform.js';
import { ensureLocalHumanToken } from '../packages/adapters/src/local-auth.js';
export interface GatewayOptions {
    database: string;
    consoleDirectory?: string;
    approvalTimeoutMs?: number;
    consoleOrigins?: string[];
    processProvider?: ProcessProvider;
    discoveryIntervalMs?: number;
}
import type { ToolApproval } from '../packages/contracts/src/gateway.js';
export type { ToolApproval } from '../packages/contracts/src/gateway.js';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const text = z.string().min(1);
const registration = z.object({ runtime: text, cwd: text.optional(), label: text.optional(), branchId: text.optional(), nativeId: text.optional() });
const decision = z.object({ requestId: text, sessionId: text.optional(), tool: text, input: z.unknown(), nativeSessionId: text.optional(), cwd: text.optional() });
const safeRevision = z.number().min(0).refine(Number.isSafeInteger, 'Expected a safe integer revision');
const mainWrite = z.object({ body: z.string().trim().min(1), files: z.array(z.object({ rootId: text, path: text })).optional(), expectedRevision: safeRevision, remove: z.boolean().optional() });
const mainRestore = z.object({ revision: safeRevision, expectedRevision: safeRevision });
function decodeMainSegment(value: string): string {
    let decoded: string;
    try { decoded = decodeURIComponent(value); }
    catch { throw new DomainError('BODY','Malformed URL encoding in Main path'); }
    if (decoded.includes('/') || decoded.includes('\\')) throw new DomainError('BODY','Main path components cannot contain slashes');
    return decoded;
}
/** Local daemon boundary: HTTP input never supplies a Core actor. */
export function createGateway(options: GatewayOptions) {
    const humanHash = digest(ensureLocalHumanToken(options.database));
    const consoleTickets = new Map<string, number>();
    const consoleSessions = new Map<string, number>();
    const store = new SqliteStore(options.database);
    const admin = new PendingTreeService(store, { type: 'human', id: 'local-admin' });
    store.db.exec(`CREATE TABLE IF NOT EXISTS gateway_credentials (hash TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS gateway_sessions (session_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gateway_exit_reports (session_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gateway_approvals (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX IF NOT EXISTS gateway_pending_deadline ON gateway_approvals(json_extract(data,'$.state'),json_extract(data,'$.expiresAt'));`);
    const streams = new Set<ServerResponse>();
    // Trusted launcher claims are ephemeral, like the processes they describe.
    const processBindings = new Map<string, ManagedProcessBinding>();
    const discovery = new ProcessDiscovery(options.processProvider ?? new LocalProcessProvider(), () => [...processBindings.values()].filter(b =>
        store.db.prepare('SELECT state FROM gateway_sessions WHERE session_id=?').get(b.sessionId)?.state === 'active'));
    const allowedOrigins = new Set(options.consoleOrigins ?? []);
    for (const origin of allowedOrigins) {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.origin !== origin)
            throw new Error('Console origins must be explicit loopback HTTP origins');
    }
    store.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS gateway_request_identity ON gateway_approvals(json_extract(data,'$.sessionId'),json_extract(data,'$.requestId')) WHERE json_extract(data,'$.requestId') IS NOT NULL;`);
    const audit = (type: string, payload: unknown, workspaceId: string, sessionId?: string) => {
        const id = randomUUID();
        store.appendEvent({ id, workspaceId, source: 'gateway', nativeId: id, sessionId, type, mode: 'controlled', payload, occurredAt: new Date().toISOString() });
    };
    const deliverySync = new ContextSync(admin, new EntityLedger(store, (sessionId, changes) => {
        const bound = store.get<Session>(sessionId, 'session');
        if (bound) audit('correction.delivery-state', { changes }, bound.workspaceId, sessionId);
    }));
    const withConflictEvidence = async (workspaceId: string, conflicts: ReturnType<PendingTreeService['conflicts']>, includeEvidence: boolean) => {
        if (!includeEvidence) return conflicts;
        const workspace = store.get<Workspace>(workspaceId, 'workspace');
        if (!workspace) return conflicts;
        const files = [...new Map(conflicts.flatMap(c => c.files).map(f => [JSON.stringify(f),f])).values()].slice(0,12);
        if (!files.length) return conflicts;
        const evidence = await collectConflictEvidence(workspace,{...conflicts[0]!,files});
        const inspected = new Map(evidence.map(e => [JSON.stringify(e.file),e]));
        return conflicts.map(conflict => ({...conflict,fileEvidence:conflict.files.slice(0,12).flatMap(file => {
            const item = inspected.get(JSON.stringify(file));
            return item ? [item] : [];
        })}));
    };
    const tasks = new TaskDispatch(store,(type,task)=>audit(type,{taskId:task.id,requestId:task.requestId,status:task.status,nativeTurnId:task.nativeTurnId,reason:task.reason},task.workspaceId,task.sessionId));
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
    discovery.start(options.discoveryIntervalMs);
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
        const latestTask=tasks.list(id)[0];
        return { state, ...(processBindings.has(id) ? {process:processBindings.get(id)!.process} : {}), processStatus: row ? 'exit-reported' : 'unknown', ...(row ? { exit: JSON.parse(String(row.data)) } : {}),taskDispatch:{available:state==='active'&&session(id).runtime==='codex-app-server'&&tasks.available(id),...(latestTask?{latestTask:{id:latestTask.id,status:latestTask.status,nativeTurnId:latestTask.nativeTurnId}}:{})} };
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
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        res.setHeader('Referrer-Policy', 'no-referrer');
        try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const path = url.pathname;
            const method = req.method;
            const address = server.address();
            if (!address || typeof address === 'string' || !['127.0.0.1', '::1'].includes(address.address))
                throw new DomainError('DENY', 'Gateway requires a loopback listener');
            const hosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
            if (!hosts.has(req.headers.host ?? '')) throw new DomainError('DENY', 'Invalid Gateway Host');
            const origin = req.headers.origin;
            const sameOrigin = origin === `http://${req.headers.host}`;
            if (origin && !sameOrigin && !allowedOrigins.has(origin))
                throw new DomainError('DENY', 'Console origin is not allowed');
            const consoleNavigation = method === 'GET' && !!options.consoleDirectory
                && (path === '/' || path === '/index.html')
                && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
            if (req.headers['sec-fetch-site'] === 'cross-site' && !origin && !consoleNavigation)
                throw new DomainError('DENY', 'Cross-site requests require an allowed Origin');
            if (!origin && req.headers['sec-fetch-site'] && method !== 'GET' && method !== 'HEAD')
                throw new DomainError('DENY', 'Browser writes require an Origin');
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
            if (path === '/health' && method === 'GET') return send({ status: 'ok', application: 'pendingtree', database: resolve(options.database) });
            const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
            // A ticket is a short-lived, one-use capability passed in a launcher URL
            // fragment. No GET or ordinary anonymous request can mint one.
            if (path === '/v1/console-session' && method === 'POST') {
                if (req.headers.authorization) return send({error:{code:'UNAUTHORIZED',message:'Use a Console ticket'}},401);
                const b = z.object({ticket:text}).parse(await body(req));
                const key = digest(b.ticket);
                const deadline = consoleTickets.get(key);
                consoleTickets.delete(key);
                if (!deadline || deadline <= Date.now()) return send({error:{code:'UNAUTHORIZED',message:'Invalid or expired Console ticket'}},401);
                const cookie = randomBytes(32).toString('hex');
                consoleSessions.set(digest(cookie), Date.now() + 12 * 60 * 60 * 1000);
                res.setHeader('Set-Cookie', `pendingtree_console=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
                return send({ok:true});
            }
            const credential = token ? store.db.prepare('SELECT session_id FROM gateway_credentials WHERE hash=?').get(digest(token)) : undefined;
            const cookie = req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('pendingtree_console='))?.slice('pendingtree_console='.length);
            const isAdmin = req.headers.authorization !== undefined ? !!token && digest(token) === humanHash
                : !!cookie && (consoleSessions.get(digest(cookie)) ?? 0) > Date.now();
            if (path.startsWith('/v1/') && !isAdmin && !credential)
                return send({ error: { code: 'UNAUTHORIZED', message: 'Gateway credential required' } }, 401);
            const sid = credential ? String(credential.session_id) : undefined;
            if (sid && !(/^\/v1\/sessions\/[^/]+\/end$/.test(path) || path === '/v1/stream'))
                active(sid);
            const svc = sid ? new PendingTreeService(store, { type: 'agent', sessionId: sid }) : admin;
            const human = () => {
                if (!isAdmin)
                    throw new DomainError('DENY', 'Human admin credential required');
            };
            const own = (id: string) => {
                if (sid && sid !== id)
                    throw new DomainError('DENY', 'Session credential mismatch');
                return session(id);
            };
            if (path === '/v1/console-ticket' && method === 'POST') {
                human();
                const now = Date.now();
                for (const [key, deadline] of consoleTickets) if (deadline <= now) consoleTickets.delete(key);
                for (const [key, deadline] of consoleSessions) if (deadline <= now) consoleSessions.delete(key);
                const ticket = randomBytes(32).toString('hex');
                consoleTickets.set(digest(ticket), now + 60000);
                return send({ticket});
            }
            if (path === '/v1/workspaces' && method === 'GET') {
                human();
                return send(store.list('workspace'));
            }
            if (path === '/v1/processes' && method === 'GET') {
                human();
                if (discovery.current().status === 'initializing') await discovery.refresh();
                return send(discovery.current());
            }
            if (path === '/v1/processes/refresh' && method === 'POST') {
                human();
                return send(await discovery.refresh());
            }
            const processRoute = path.match(/^\/v1\/sessions\/([^/]+)\/process$/);
            if (processRoute && method === 'POST') {
                const s = own(processRoute[1]!);
                if (sid !== s.id) throw new DomainError('DENY', 'Session credential required');
                active(s.id);
                const identity = z.object({pid:z.number().int().positive().safe(),startTime:text}).parse(await body(req));
                const inventory = await discovery.refresh();
                active(s.id); // The session may have ended while enumeration was in flight.
                const found = inventory.processes.find(p => sameProcess(p, identity));
                if (!found || !(found.runtime === s.runtime || (found.runtime === 'codex' && s.runtime === 'codex-app-server')))
                    throw new DomainError('DENY', 'Process identity does not match this runtime');
                if ([...processBindings.values()].some(b => b.sessionId !== s.id && sameProcess(b.process, identity)))
                    throw new DomainError('STATE', 'Process already associated with another managed session');
                processBindings.set(s.id, {sessionId:s.id,runtime:s.runtime,process:identity});
                return send({ok:true});
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
                store.transaction(() => {
                    store.db.prepare('INSERT INTO gateway_credentials(hash,session_id) VALUES(?,?)').run(digest(sessionToken), s.id);
                    store.db.prepare("INSERT INTO gateway_sessions VALUES(?,'active')").run(s.id);
                });
                return send({ ...s, sessionId: s.id, sessionToken, seq: Number(store.db.prepare('SELECT COALESCE(MAX(sequence),0) AS seq FROM events').get()!.seq) }, 201);
            }
            if (path === '/v1/sessions' && method === 'GET') {
                human();
                return send(store.list<Session>('session').map(s => ({ ...s, ...lifecycle(s.id) })));
            }
            const correctionNotificationRoute = path.match(/^\/v1\/sessions\/([^/]+)\/corrections\/(pending|delivered)$/);
            if (correctionNotificationRoute) {
                const s = own(correctionNotificationRoute[1]!);
                if (!sid || sid !== s.id) throw new DomainError('DENY', 'Session credential required');
                if (method === 'GET' && correctionNotificationRoute[2] === 'pending')
                    return send(deliverySync.pendingCorrections(s));
                if (method === 'POST' && correctionNotificationRoute[2] === 'delivered') {
                    const b = z.object({ itemIds: z.array(text).max(100) }).parse(await body(req));
                    active(sid);
                    const allowed = new Set(deliverySync.correctionItemIds(s));
                    if (b.itemIds.some(itemId => !allowed.has(itemId))) throw new DomainError('DENY', 'Correction item is not addressed to this session branch');
                    return send({ delivered: deliverySync.markCorrectionsDelivered(s.id, b.itemIds) });
                }
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
                        if(exiting) { tasks.sessionEnded(s.id); processBindings.delete(s.id); }
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
                if (b.nativeSessionId && b.nativeSessionId !== s.nativeId)
                    throw new DomainError('DENY', 'Native session identity mismatch');
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
                if (!sid) throw new DomainError('DENY', 'Session credential required for activity');
                const b = z.object({ id: text, workspaceId: text, source: text, nativeId: text, sessionId: text.optional(), type: text, mode: z.literal('observed'), payload: z.unknown(), occurredAt: text }).parse(await body(req));
                active(sid);
                const inserted=svc.ingest({ ...b, payload: b.payload });
                if(inserted&&b.sessionId)tasks.observe(b.sessionId,b.type,b.payload);
                return send({ inserted });
            }
            if(path==='/v1/tasks'&&method==='POST') {
                human();
                const b=z.object({sessionId:text,instructions:text.max(100000),includeMain:z.boolean().default(false),requestId:text.max(200)}).parse(await body(req));
                const target=session(b.sessionId);
                if(!tasks.byRequestId(b.requestId))active(target.id);
                const snapshot=b.includeMain?admin.main(target.workspaceId):null;
                const mainContext=snapshot?{revision:snapshot.revision,entries:snapshot.entries.filter(e=>!e.removed).map(e=>({id:e.id,body:e.body}))}:null;
                return send(tasks.submit({...b,mainContext},target),201);
            }
            if(path==='/v1/tasks'&&method==='GET') {
                human();
                return send(tasks.list(url.searchParams.get('sessionId')??undefined));
            }
            const taskRoute=path.match(/^\/v1\/tasks\/([^/]+)(?:\/(cancel))?$/);
            if(taskRoute) {
                human();
                if(method==='GET'&&!taskRoute[2])return send(tasks.get(taskRoute[1]));
                if(method==='POST'&&taskRoute[2]==='cancel')return send(tasks.cancel(taskRoute[1]));
            }
            if(path==='/v1/native/tasks/next'&&method==='GET') {
                if(!sid)throw new DomainError('DENY','Session credential required');
                if(url.searchParams.get('busy')==='1'){tasks.heartbeat(sid);return send(null);}
                return send(tasks.claim(sid));
            }
            const nativeTaskRead=path.match(/^\/v1\/native\/tasks\/([^/]+)$/);
            if(nativeTaskRead&&method==='GET'){
                if(!sid)throw new DomainError('DENY','Session credential required');
                const t=tasks.get(nativeTaskRead[1]);
                if(t.sessionId!==sid)throw new DomainError('DENY','Task belongs to another session');
                return send(t);
            }
            const nativeTaskRoute=path.match(/^\/v1\/native\/tasks\/([^/]+)\/(accepted|unavailable)$/);
            if(nativeTaskRoute&&method==='POST') {
                if(!sid)throw new DomainError('DENY','Session credential required');
                const b=z.object({nativeTurnId:text.optional(),reason:text.optional()}).parse(await body(req));
                active(sid);
                return send(nativeTaskRoute[2]==='accepted'?tasks.accepted(nativeTaskRoute[1],sid,text.parse(b.nativeTurnId)):tasks.unavailable(nativeTaskRoute[1],sid,text.parse(b.reason)));
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
                    if (isAdmin && !req.headers.authorization && (consoleSessions.get(digest(cookie!)) ?? 0) <= Date.now()) {
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
            // Resolve reserved Main paths before entry IDs so IDs named "history",
            // "preview" or "restore" cannot shadow the API surface.
            const mainBase = path.match(/^\/v1\/workspaces\/([^/]+)\/main$/);
            const mainNested = path.match(/^\/v1\/workspaces\/([^/]+)\/main\/(.+)$/);
            if (mainBase && method === 'GET') return send(svc.main(decodeMainSegment(mainBase[1]!)));
            if (mainBase && method === 'POST') {
                human();
                const b = mainWrite.parse(await body(req));
                const input = { body: b.body, ...(b.files === undefined ? {} : { files: b.files }) };
                return send(admin.editMain(decodeMainSegment(mainBase[1]!),input,b.expectedRevision,undefined,b.remove),201);
            }
            if (mainNested) {
                const wid = decodeMainSegment(mainNested[1]!);
                const nested = mainNested[2]!.split('/').map(decodeMainSegment).join('/');
                if (nested === 'history' && method === 'GET') return send(svc.mainHistory(wid));
                if (nested === 'preview' && method === 'GET') {
                    const revisionText = url.searchParams.get('revision');
                    const parsed = z.object({revision:safeRevision}).safeParse({revision:revisionText === null || revisionText.trim() === '' ? undefined : Number(revisionText)});
                    if (!parsed.success) throw parsed.error;
                    return send(svc.mainAtRevision(wid,parsed.data.revision));
                }
                if (nested === 'restore' && method === 'POST') {
                    human();
                    const b = mainRestore.parse(await body(req));
                    return send(admin.restoreMain(wid,b.revision,b.expectedRevision));
                }
                const entryHistory = nested.match(/^([^/]+)\/history$/);
                if (entryHistory && method === 'GET') return send(svc.mainHistory(wid,entryHistory[1]!));
                const entryRestore = nested.match(/^([^/]+)\/restore$/);
                if (entryRestore && method === 'POST') {
                    human();
                    const b = mainRestore.parse(await body(req));
                    return send(admin.restoreMain(wid,b.revision,b.expectedRevision,entryRestore[1]!));
                }
                const entryRemove = nested.match(/^([^/]+)\/remove$/);
                if (entryRemove && method === 'POST') {
                    human();
                    const b = z.object({expectedRevision:safeRevision}).parse(await body(req));
                    return send(admin.removeMain(wid,entryRemove[1]!,b.expectedRevision));
                }
                // Backward-compatible entry edit/removal endpoint.
                if (!nested.includes('/') && !['history','preview','restore'].includes(nested) && method === 'POST') {
                    human();
                    const b = mainWrite.parse(await body(req));
                    const input = { body: b.body, ...(b.files === undefined ? {} : { files: b.files }) };
                    return send(admin.editMain(wid,input,b.expectedRevision,nested,b.remove),200);
                }
            }
            const supervisionRoute = path.match(/^\/v1\/workspaces\/([^/]+)\/(supervision|conflicts|merges)(?:\/([^/]+))?$/);
            if (supervisionRoute) {
                const [,wid,kind,conflictId] = supervisionRoute;
                if (method === 'GET' && !conflictId) {
                    if (kind === 'supervision') {
                        const view = svc.supervision(wid!);
                        for (const branch of view.branches) branch.corrections = branch.corrections.map((correction: Correction) => ({
                            ...correction,
                            deliveries: branch.sessions.map((bound) => {
                                const record = deliverySync.status(bound.id).items[`correction:${correction.id}`];
                                return { sessionId: bound.id, runtime: bound.runtime,
                                    state: record?.state === 'acknowledged' ? 'acknowledged' : record?.state === 'delivered' ? 'retrieved' : 'not-retrieved',
                                    ...(record?.deliveredAt ? { retrievedAt: record.deliveredAt } : {}),
                                    ...(record?.acknowledgedAt ? { acknowledgedAt: record.acknowledgedAt } : {}) };
                            }),
                        }));
                        return send(view);
                    }
                    if (kind === 'conflicts') return send(await withConflictEvidence(wid!, svc.conflicts(wid!), isAdmin && url.searchParams.get('evidence') === '1'));
                    return send(svc.merges(wid!));
                }
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
                if (method === 'POST' && kind === 'work') {
                    const b = workInputSchema.parse(await body(req));
                    if (sid) active(sid);
                    return send(svc.proposeWork(branchId!,b),201);
                }
                if (method === 'POST' && kind === 'corrections') {
                    human();
                    const b = z.object({body:text}).parse(await body(req));
                    return send(admin.sendCorrection(branchId!,b.body),201);
                }
                if (method === 'POST' && kind === 'merge') {
                    human();
                    const b = z.object({workIds:z.array(text).min(1),decision:z.enum(['accepted','rejected']),expectedMainRevision:z.number().int().min(0),overrideConflicts:z.boolean().default(false)}).parse(await body(req));
                    return send(admin.decideMerge(branchId!,b.workIds,b.decision,b.expectedMainRevision,b.overrideConflicts),201);
                }
            }
            if (method === 'GET' && options.consoleDirectory && !path.startsWith('/v1/')) {
                const root = resolve(options.consoleDirectory);
                const target = resolve(root, '.' + decodeURIComponent(path));
                if (!target.startsWith(root + sep) && target !== root) throw new DomainError('DENY', 'Invalid asset path');
                let file = target;
                if (!extname(path)) file = resolve(root, 'index.html');
                try {
                    const data = readFileSync(file);
                    const mime: Record<string,string> = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon'};
                    res.writeHead(200, {'content-type': mime[extname(file)] ?? 'application/octet-stream', 'x-content-type-options':'nosniff', 'cache-control':'no-cache'});
                    res.end(data); return;
                } catch { /* missing Console build or asset */ }
            }
            send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
        }
        catch (error) {
            const code = error instanceof DomainError ? error.code : error instanceof z.ZodError || error instanceof SyntaxError ? 'BODY' : 'INTERNAL';
            const details = error instanceof DomainError ? error.details : undefined;
            send({ error: { code, message: code === 'INTERNAL' ? 'Internal server error' : (error as Error).message, ...(details === undefined ? {} : {details}) } }, code === 'NOT_FOUND' ? 404 : code === 'DENY' || code === 'IDENTITY' ? 403 : ['STATE', 'STALE', 'CONFLICT', 'REVIEW', 'REQUIRE-APPROVAL'].includes(code) ? 409 : code === 'INTERNAL' ? 500 : 400);
        }
    });
    return { server, store, close: async () => {
            clearInterval(timer);
            await discovery.close();
            for (const res of streams)
                res.end();
            server.closeAllConnections();
            await new Promise<void>((r, j) => server.close(e => e ? j(e) : r()));
            store.db.close();
        } };
}
