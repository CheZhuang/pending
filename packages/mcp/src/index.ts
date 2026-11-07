import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DomainError, scopeSchema, type Knowledge, type Session } from '../../contracts/src/index.js';
import type { ApplicationService } from '../../core/src/index.js';

export interface BoundMcpSession {
  /** Resolved by the trusted daemon; never supplied in MCP tool arguments. */
  session: Session;
  /** Constructed for the same authenticated Agentree session. */
  service: ApplicationService;
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
  const { session, service } = binding;
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
  })));

  server.registerTool('context_sync', {
    title: 'Sync context',
    description: 'Get context commits on this session branch newer than afterRevision. Scope filtering is not yet applied.',
    inputSchema: { afterRevision: z.number().int().min(0).optional() },
    outputSchema: contextOutputSchema,
  }, tool(({ afterRevision }: { afterRevision?: number }) => {
    const commits = service.context(session.branchId).filter(commit => commit.revision > (afterRevision ?? 0));
    const branch = service.branches(session.workspaceId).find(item => item.id === session.branchId);
    return { branchId: session.branchId, currentRevision: branch?.revision ?? 0, commits };
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
    return { branchId: selectedBranch, commits: service.lookup(selectedBranch) };
  }));

  server.registerTool('context_publish', {
    title: 'Publish context',
    description: 'Publish a finding or decision to this session branch. Decisions remain subject to core review rules.',
    inputSchema: {
      kind: z.enum(['finding', 'decision']),
      key: z.string().min(1),
      body: z.string().min(1),
      scope: scopeSchema,
      eventIds: z.array(z.string().min(1)).optional(),
    },
    outputSchema: contextOutputSchema,
  }, tool((args: { kind: Knowledge['kind']; key: string; body: string; scope: Knowledge['scope']; eventIds?: string[] }) => {
    const knowledge: Knowledge = { kind: args.kind, key: args.key, body: args.body, scope: args.scope };
    return service.publish(session.branchId, knowledge, args.eventIds ?? []);
  }));

  server.registerTool('merge_request', {
    title: 'Request context merge',
    description: 'Propose selected context commits from a source branch for integration into a target branch.',
    inputSchema: {
      sourceBranchId: z.string().min(1).optional(),
      targetBranchId: z.string().min(1),
      commitIds: z.array(z.string().min(1)).min(1),
      expectedRevision: z.number().int().min(0),
    },
    outputSchema: contextOutputSchema,
  }, tool((args: { sourceBranchId?: string; targetBranchId: string; commitIds: string[]; expectedRevision: number }) =>
    service.createMerge(args.sourceBranchId ?? session.branchId, args.targetBranchId, args.commitIds, args.expectedRevision)));

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
