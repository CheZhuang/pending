import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DomainError, workInputSchema, type Session } from '../../contracts/src/index.js';
import { ContextSync, type DeliveryLedger } from '../../sync/src/index.js';
import type { ApplicationService } from '../../core/src/index.js';

export interface BoundMcpSession {
  session: Session;
  service: ApplicationService;
  ledger: DeliveryLedger;
  authorize?: () => Promise<void>;
}
const outputSchema = { ok: z.boolean(), data: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string() }).optional() };
function success(data: unknown) { const result = { ok: true as const, data }; return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result }; }
function failure(error: unknown) {
  const result = { ok: false as const, error: error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'INVALID_OR_FAILED', message: error instanceof Error ? error.message : 'Request failed' } };
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: true };
}
function tool<T>(work: (args: T) => unknown, authorize?: () => Promise<void>) {
  return async (args: T) => { try { await authorize?.(); return success(await work(args)); } catch (error) { return failure(error); } };
}

/** MCP server bound to one trusted native session. Agents can read and propose work only. */
export function createAgentreeMcpServer(binding: BoundMcpSession): McpServer {
  const session = { ...binding.session };
  const { service } = binding;
  const sync = new ContextSync(service, binding.ledger);
  const bound = <T>(fn: (args: T) => unknown) => tool(fn, binding.authorize);
  const server = new McpServer({ name: 'agentree', version: '0.2.0' });

  server.registerTool('workspace_status', {
    title: 'Workspace status', description: 'Show the workspace and logical branches bound to this session.',
    inputSchema: {}, outputSchema,
  }, bound(() => ({ workspace: service.workspace(session.workspaceId), branches: service.branches(session.workspaceId), session: { id: session.id, branchId: session.branchId, runtime: session.runtime } })));

  server.registerTool('context_get', {
    title: 'Get supervision context', description: 'Read current Main, proposed branch work, conflicts and branch corrections.',
    inputSchema: {}, outputSchema,
  }, bound(() => service.supervision(session.workspaceId)));

  server.registerTool('context_sync', {
    title: 'Retrieve updates', description: 'Retrieve current Main, branch work and corrections. Reuse requestId when retrying a lost response.',
    inputSchema: { requestId: z.string().min(1).max(200), limit: z.number().int().min(1).max(500).optional(), redeliverUnacknowledged: z.boolean().optional() },
    outputSchema,
  }, bound((args: { requestId: string; limit?: number; redeliverUnacknowledged?: boolean }) => sync.sync({ ...args, session })));

  server.registerTool('context_acknowledge', {
    title: 'Acknowledge retrieved items', description: 'Mark delivered item IDs as acknowledged for this session.',
    inputSchema: { itemIds: z.array(z.string().min(1)).max(1000) }, outputSchema,
  }, bound(({ itemIds }: { itemIds: string[] }) => {
    service.workspace(session.workspaceId); // Core authorization also applies to delivery metadata writes.
    return { acknowledged: sync.acknowledge(session.id, itemIds) };
  }));

  server.registerTool('work_propose', {
    title: 'Propose branch work', description: 'Record work completed on this branch with optional rooted files and native evidence IDs.',
    inputSchema: {
      body: z.string().trim().min(1), files: z.array(z.object({ rootId: z.string().min(1), path: z.string().min(1) })).optional(),
      intent: z.string().trim().min(1).optional(), eventIds: z.array(z.string().min(1)).optional(), conflictsWithMain: z.array(z.string().min(1)).optional(),
    }, outputSchema,
  }, bound((args: z.input<typeof workInputSchema>) => service.proposeWork(session.branchId, args)));

  return server;
}
export async function serveAgentreeMcp(binding: BoundMcpSession): Promise<McpServer> {
  const server = createAgentreeMcpServer(binding); await server.connect(new StdioServerTransport()); return server;
}
