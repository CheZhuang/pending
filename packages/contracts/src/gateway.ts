/** Gateway v1 native-session and approval wire contracts. Supervision records are exported by index.ts. */
export interface RegisterManagedSessionRequest {
  runtime: string; cwd?: string; label?: string; branchId?: string; nativeId?: string;
}
export interface RegisterManagedSessionResponse {
  id: string; sessionId: string; workspaceId: string; branchId: string;
  agentId: string; nativeId: string; runtime: string; sessionToken: string; seq: number;
}
export interface ToolDecisionRequest {
  requestId: string; sessionId?: string; tool: string; input: unknown; nativeSessionId?: string; cwd?: string;
}
export interface ToolDecisionResponse {
  requestId?: string; approvalId?: string; outcome: 'allow' | 'deny'; reason?: string; by?: string;
}
export interface ToolApproval {
  id: string; requestId: string; workspaceId: string; sessionId: string; tool: string; input: unknown;
  state: 'pending' | 'approved' | 'denied' | 'timeout'; createdAt: string; expiresAt: string;
  policyDecisionId: string; reason?: string; decidedAt?: string;
}
export interface DecideToolApprovalRequest { decision: 'approved' | 'denied'; reason?: string }
export interface GatewayError { error: {code: string; message: string} }

export interface SessionLifecycle {
  state: 'active' | 'kill-requested' | 'ended';
  processStatus: 'unknown' | 'exit-reported';
  exit?: {exitCode?: number|null; signal?: string|null};
  /** Launcher-reported identity; presence alone is not proof the process is still running. */
  process?: ProcessIdentity;
}

/** Opaque OS birth identity; never compare PID alone or parse as an ISO date. */
export interface ProcessIdentity { pid: number; startTime?: string }
export interface DiscoveredProcess extends ProcessIdentity {
  id: string; runtime: 'claude-code' | 'codex'; parentPid?: number;
  executable?: string; argv?: string[]; commandLine?: string; cwd?: string;
  evidence: string; identityReliable: boolean; managedSessionId?: string;
  /** Discovery alone grants no adapter capabilities. Consult the managed Session when linked. */
  capabilities: { passiveObservation: boolean; managedSession: boolean; contextInjection: boolean; preExecutionInterception: boolean };
  nativeObservation: 'unavailable';
}
export interface ProcessInventory {
  processes: DiscoveredProcess[]; status: 'initializing' | 'ok' | 'unavailable'; scannedAt?: string; message?: string;
}
