import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DomainError, scopeSchema, type Knowledge, type Session } from '../../contracts/src/index.js';
import { ContextSync, type DeliveryLedger, type Level, type FocusDeclaration } from '../../sync/src/index.js';
import { normalizeScope } from '../../core/src/scope.js';
import type { ApplicationService } from '../../core/src/index.js';

export interface BoundMcpSession {
  /** Resolved by the trusted daemon; never supplied in MCP tool arguments. */
  session: Session;
  /** Constructed for the same authenticated Agentree session. */
  service: ApplicationService;
  /** Durable delivery ledger supplied by the daemon (EntityLedger for SQLite). */
  ledger: DeliveryLedger;
}

const contextOutputSchema = {
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
};

function success(data: unknown) {
  const result = { ok: true as const, data };
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
}

function failure(error: unknown) {
  const result = {
    ok: false as const,
    error: error instanceof DomainError
      ? { code: error.code, message: error.message }
      : { code: 'INVALID_OR_FAILED', message: error instanceof Error ? error.message : 'Request failed' },
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: true };
}

function tool<T>(work: (args: T) => unknown) {
  return async (args: T) => {
    try { return success(work(args)); }
    catch (error) { return failure(error); }
  };
}

/** Build an MCP server already bound to one authenticated Agentree session. */
export function createAgentreeMcpServer(binding: BoundMcpSession): McpServer {
  const session = { ...binding.session };
  const { service, ledger } = binding;
  const sync = new ContextSync(service, ledger);
  const server = new McpServer({ name: 'agentree', version: '0.1.0' });

  server.registerTool('workspace_status', {
    title: 'Workspace status',
    description: 'Show the workspace and logical branches bound to this Agentree session.',
    inputSchema: {},
    outputSchema: contextOutputSchema,
  }, tool(() => ({
    workspace: service.workspace(session.workspaceId),
    branches: service.branches(session.workspaceId),
    currentSession: { id: session.id, runtime: session.runtime, branchId: session.branchId },
    revision: service.contextRevision(session.branchId),
  })));

  server.registerTool('context_sync', {
    title: 'Sync context',
    description: 'Pull relevant context with authority, provenance and a token budget. Reuse requestId to retry a lost response; acknowledge item IDs explicitly.',
    inputSchema: {
      requestId: z.string().min(1).max(200),
      level: z.enum(['signal', 'digest', 'full']).optional(),
      budgetTokens: z.number().int().min(1).max(32000).optional(),
      redeliverUnacknowledged: z.boolean().optional(),
    },
    outputSchema: contextOutputSchema,
  }, tool((args: { requestId: string; level?: Level; budgetTokens?: number; redeliverUnacknowledged?: boolean }) => {
    service.workspace(session.workspaceId); // also authorize cached response replay
    return sync.sync({ ...args, session });
  }));

  server.registerTool('context_acknowledge', {
    title: 'Acknowledge context',
    description: 'Confirm that this session has taken the delivered items into account.',
    inputSchema: { itemIds: z.array(z.string().min(1)).max(1000) },
    outputSchema: contextOutputSchema,
  }, tool(({ itemIds }: { itemIds: string[] }) => {
    service.workspace(session.workspaceId); // authorize before writing delivery metadata
    return { acknowledged: sync.acknowledge(session.id, itemIds) };
  }));

  server.registerTool('context_subscribe', {
    title: 'Subscribe to context scopes',
    description: 'Extend or override inferred focus with explicit workspace, folder, file or task scopes. Empty extend restores inferred focus.',
    inputSchema: { scopes: z.array(scopeSchema).max(100), mode: z.enum(['extend', 'override']).optional() },
    outputSchema: contextOutputSchema,
  }, tool((args: FocusDeclaration) => {
    const workspace = service.workspace(session.workspaceId);
    const scopes = args.scopes.map(scope => normalizeScope(scope, workspace.roots));
    sync.subscribe(session.id, { scopes, mode: args.mode ?? 'extend' });
    return { scopes, mode: args.mode ?? 'extend' };
  }));

  server.registerTool('context_get', {
    title: 'Get context',
    description: 'Read the current findings and accepted decisions for a branch in this workspace.',
    inputSchema: { branchId: z.string().min(1).optional() },
    outputSchema: contextOutputSchema,
  }, tool(({ branchId }: { branchId?: string }) => {
    const selectedBranch = branchId ?? session.branchId;
    if (!service.branches(session.workspaceId).some(item => item.id === selectedBranch)) {
      throw new DomainError('NOT_FOUND', 'Branch is not in this workspace');
    }
    const snapshot = service.snapshot(selectedBranch);
    return { branchId: selectedBranch, revision: snapshot.revision, commits: snapshot.knowledge };
  }));

  server.registerTool('context_publish', {
    title: 'Publish context',
    description: 'Publish a finding or decision to this session branch. Decisions remain subject to core review rules.',
    inputSchema: {
      kind: z.enum(['finding', 'decision']),
      key: z.string().min(1),
      body: z.string().min(1),
      scope: scopeSchema,
      impactScope: scopeSchema.optional(),
      expected: z.object({ branchRevision: z.number().int().min(0), mainRevision: z.number().int().min(0) }).optional(),
      eventIds: z.array(z.string().min(1)).optional(),
    },
    outputSchema: contextOutputSchema,
  }, tool((args: { kind: Knowledge['kind']; key: string; body: string; scope: Knowledge['scope']; impactScope?: Knowledge['scope']; expected?: { branchRevision: number; mainRevision: number }; eventIds?: string[] }) => {
    const knowledge: Knowledge = { kind: args.kind, key: args.key, body: args.body, scope: args.scope, impactScope: args.impactScope };
    return service.publish(session.branchId, knowledge, args.eventIds ?? [], args.expected);
  }));

  server.registerTool('merge_request', {
    title: 'Request context merge',
    description: 'Propose selected context commits from a source branch for integration into a target branch.',
    inputSchema: {
      sourceBranchId: z.string().min(1).optional(),
      targetBranchId: z.string().min(1),
      commitIds: z.array(z.string().min(1)).min(1),
      expectedRevision: z.number().int().min(0),
      expectedMainRevision: z.number().int().min(0).optional(),
    },
    outputSchema: contextOutputSchema,
  }, tool((args: { sourceBranchId?: string; targetBranchId: string; commitIds: string[]; expectedRevision: number; expectedMainRevision?: number }) =>
    service.createMerge(args.sourceBranchId ?? session.branchId, args.targetBranchId, args.commitIds, args.expectedRevision, args.expectedMainRevision)));

  server.registerTool('review_status', {
    title: 'Review status',
    description: 'Read the review state for a context merge request.',
    inputSchema: { reviewId: z.string().min(1) },
    outputSchema: contextOutputSchema,
  }, tool(({ reviewId }: { reviewId: string }) => service.review(reviewId)));

  return server;
}

export async function serveAgentreeMcp(binding: BoundMcpSession): Promise<McpServer> {
  const server = createAgentreeMcpServer(binding);
  await server.connect(new StdioServerTransport());
  return server;
}
