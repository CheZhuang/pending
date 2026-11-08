import { z } from 'zod';
export type Actor = {
    type: 'human';
    id: string;
} | {
    type: 'agent';
    sessionId: string;
};
export interface Workspace {
    id: string;
    name: string;
    roots: WorkspaceRoot[];
    mainBranchId: string;
}
export interface WorkspaceRoot {
    id: string;
    path: string;
}
export interface Branch {
    id: string;
    workspaceId: string;
    name: string;
    revision: number;
}
export interface Agent {
    id: string;
    name: string;
}
export interface Session {
    id: string;
    agentId: string;
    workspaceId: string;
    branchId: string;
    nativeId: string;
    runtime: string;
}
/** Paths are workspace-root relative. Branches are logical work records, never Git branches. */
export const fileRefSchema = z.object({ rootId: z.string().min(1), path: z.string().min(1) });
export type FileRef = z.infer<typeof fileRefSchema>;
export const workInputSchema = z.object({
    body: z.string().trim().min(1), files: z.array(fileRefSchema).default([]),
    intent: z.string().trim().min(1).optional(), eventIds: z.array(z.string().min(1)).default([]),
    conflictsWithMain: z.array(z.string().min(1)).default([]),
});
export type WorkInput = z.input<typeof workInputSchema>;
export interface BranchWork {
    id: string; workspaceId: string; branchId: string; sessionId: string;
    body: string; intent?: string; files: FileRef[]; eventIds: string[]; conflictsWithMain: string[];
    state: 'proposed' | 'accepted' | 'rejected'; createdAt: string;
}
export const mainInputSchema = z.object({ body: z.string().trim().min(1), files: z.array(fileRefSchema).default([]) });
export type MainInput = z.input<typeof mainInputSchema>;
export interface MainEntry {
    id: string; workspaceId: string; body: string; files: FileRef[];
    revision: number; removed: boolean; actor: Actor; createdAt: string;
    sourceWorkId?: string; legacyCommitId?: string;
    /** Historical global selection and the copied entry version, if it existed there. */
    restoredFrom?: { revision: number; entryRevision?: number };
}
export interface MainSnapshot { workspaceId: string; revision: number; entries: MainEntry[]; removedEntries: MainEntry[]; }
export interface MainRevision {
    revision: number; actor: Actor; createdAt: string; entryIds: string[];
    restoredFromRevision?: number;
}
export interface Conflict {
    id: string; workspaceId: string; branchIds: string[]; mainEntryId?: string;
    files: FileRef[]; evidenceIds: string[]; explanation: string;
    status: 'potential' | 'confirmed' | 'resolved' | 'dismissed';
    decidedBy?: string; updatedAt?: string;
}
/** Human acceptance of work records into Main; never a Git/source-code merge. */
export interface Merge {
    id: string; workspaceId: string; sourceBranchId: string; workIds: string[];
    state: 'accepted' | 'rejected'; mainRevision: number; actor: Actor; createdAt: string;
}
export interface Correction {
    id: string; workspaceId: string; branchId: string; body: string;
    mainRevision: number; actor: Actor; createdAt: string;
}
export interface BranchOverview {
    branch: Branch; sessions: Session[]; work: BranchWork[]; files: FileRef[];
    recentActivity: SequencedEvent[]; corrections: Correction[];
}
export interface SupervisionContext {
    main: MainSnapshot; branches: BranchOverview[]; conflicts: Conflict[];
    corrections: Correction[];
}
export type Operation = 'workspace.create' | 'branch.create' | 'session.register' | 'event.ingest'
    | 'context.read' | 'work.propose' | 'main.edit' | 'merge.decide' | 'conflict.decide'
    | 'correction.send' | 'controlled.execute';
export interface PolicyDecision {
    id: string;
    actor: Actor;
    operation: Operation;
    outcome: 'allow' | 'deny' | 'require-approval';
    reason: string;
    createdAt: string;
}
export interface NormalizedEvent {
    id: string;
    workspaceId: string;
    source: string;
    nativeId: string;
    sessionId?: string;
    type: string;
    mode: 'observed' | 'controlled';
    payload: unknown;
    occurredAt: string;
}
export class DomainError extends Error {
    constructor(public code: string, message: string, public details?: Record<string, unknown>) { super(message); }
}

export interface EventQuery {
    afterSequence?: number;
    throughSequence?: number;
    limit?: number;
    sessionId?: string;
    source?: string;
    type?: string;
}
export interface SequencedEvent extends NormalizedEvent {
    sequence: number;
}
export interface EventPage {
    events: SequencedEvent[];
    nextSequence: number;
    throughSequence: number;
    hasMore: boolean;
}

export type * from './gateway.js';
