import { z } from 'zod';
export type Actor = { type: 'human'; id: string } | { type: 'agent'; sessionId: string };
export interface Workspace { id: string; name: string; roots: WorkspaceRoot[] }
export interface WorkspaceRoot { id: string; path: string }
export interface Branch { id: string; workspaceId: string; name: string; revision: number; restricted: boolean }
export interface Agent { id: string; name: string }
export interface Session { id: string; agentId: string; workspaceId: string; branchId: string; nativeId: string; runtime: string }
export const scopeSchema = z.discriminatedUnion('type', [z.object({type:z.literal('workspace')}),z.object({type:z.literal('folder'),path:z.string().min(1)}),z.object({type:z.literal('file'),path:z.string().min(1)}),z.object({type:z.literal('task'),taskId:z.string().min(1)})]);
export type Scope = z.infer<typeof scopeSchema>;
export const knowledgeSchema = z.object({kind:z.enum(['finding','decision']),key:z.string().min(1),body:z.string().min(1),scope:scopeSchema});
export type Knowledge = z.infer<typeof knowledgeSchema>;
export interface ContextCommit { id: string; workspaceId: string; branchId: string; revision: number; knowledge: Knowledge; provenance: { sessionId: string; eventIds: string[] }; createdAt: string }
export interface MergeRequest { id:string; workspaceId:string; sourceBranchId:string; targetBranchId:string; commitIds:string[]; expectedRevision:number; state:'pending'|'applied'|'rejected'; reviewId?:string }
export interface Conflict { key:string; existingCommitId:string; incomingCommitId:string }
export interface Review { id:string; mergeId:string; state:'pending'|'approved'|'rejected'|'resolved'; conflicts:Conflict[]; decidedBy?:string; decision?:'approved'|'rejected' }
export type Operation = 'workspace.create'|'branch.create'|'session.register'|'event.ingest'|'context.publish'|'context.read'|'merge.create'|'merge.apply'|'review.resolve'|'review.read'|'controlled.execute';
export interface PolicyDecision { id:string; actor:Actor; operation:Operation; outcome:'allow'|'deny'|'require-approval'; reason:string; createdAt:string }
export interface NormalizedEvent { id:string; workspaceId:string; source:string; nativeId:string; sessionId?:string; type:string; mode:'observed'|'controlled'; payload:unknown; occurredAt:string }
export class DomainError extends Error { constructor(public code:string,message:string) { super(message); } }
