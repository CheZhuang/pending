/** Gateway v1 wire contracts. Core domain records retain their existing shapes. */
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
}
