import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const hookInputSchema = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  hook_event_name: z.literal('PreToolUse'),
  tool_name: z.string().min(1),
  tool_input: z.unknown(),
  tool_use_id: z.string().min(1).optional(),
});

const decideResponseSchema = z.object({
  outcome: z.enum(['allow', 'deny']).optional(),
  decision: z.enum(['allow', 'deny']).optional(),
  by: z.string().optional(),
  reason: z.string().optional(),
}).refine(value => value.outcome !== undefined || value.decision !== undefined);

export interface ClaudeDecideRequest {
  requestId: string;
  sessionId: string;
  tool: string;
  input: unknown;
  nativeSessionId: string;
  cwd: string;
}

export type ClaudeHookEnvironment = Record<string, string | undefined>;
export type ClaudeDecide = (request: ClaudeDecideRequest) => Promise<z.infer<typeof decideResponseSchema>>;

export function createClaudeDecideClient(
  gatewayUrl: string,
  timeoutMs = 100_000,
  sessionToken = process.env.HARNESS_SESSION_TOKEN,
): ClaudeDecide {
  return async request => {
    const response = await fetch(new URL('/v1/decide', gatewayUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Gateway returned HTTP ${response.status}`);
    return decideResponseSchema.parse(await response.json());
  };
}

/** Process one Claude PreToolUse hook payload. Allow emits no stdout. */
export async function handleClaudePreToolHook(
  rawInput: string,
  env: ClaudeHookEnvironment,
  decide: ClaudeDecide,
  output: (line: string) => void = line => process.stdout.write(`${line}\n`),
  diagnostic: (line: string) => void = line => process.stderr.write(`${line}\n`),
): Promise<number> {
  if (!env.HARNESS_SESSION_ID) {
    diagnostic('[Harness] No managed session binding; allowing native Claude permissions.');
    return 0;
  }

  let nativeInput: z.infer<typeof hookInputSchema>;
  try {
    nativeInput = hookInputSchema.parse(JSON.parse(rawInput));
  } catch {
    return deny(output, 'Gateway', 'invalid Claude hook input');
  }

  try {
    const result = await decide({
      requestId: nativeInput.tool_use_id ?? randomUUID(),
      sessionId: env.HARNESS_SESSION_ID,
      tool: nativeInput.tool_name,
      input: nativeInput.tool_input,
      nativeSessionId: nativeInput.session_id,
      cwd: nativeInput.cwd,
    });
    const decision = result.outcome ?? result.decision;
    if (decision === 'allow') return 0;
    return deny(output, result.by ?? 'Gateway', result.reason ?? 'policy denied this operation');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown Gateway error';
    if (env.HARNESS_FAIL_OPEN === '1') {
      diagnostic(`[Harness] Gateway unavailable; HARNESS_FAIL_OPEN=1, allowing operation (${message}).`);
      return 0;
    }
    return deny(output, 'Gateway', `网关不可用 (${message})`);
  }
}

function deny(output: (line: string) => void, by: string, reason: string): number {
  const readableReason = `[Harness] Blocked by ${by}: ${reason}`;
  output(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: readableReason,
    },
  }));
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const gatewayUrl = process.env.HARNESS_GATEWAY_URL ?? 'http://localhost:8787';
  await handleClaudePreToolHook(raw, process.env, createClaudeDecideClient(gatewayUrl));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    process.stderr.write(`[Harness] Hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[Harness] Blocked by Gateway: 网关不可用',
    } }));
  });
}
