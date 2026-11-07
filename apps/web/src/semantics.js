// Shared Agentree semantics for the UI. Authority labels come straight from the
// sync package so the console never invents its own meaning for context.
import { authorityOf, AUTHORITY_RANK } from '../../../packages/sync/src/authority.ts';

export { authorityOf, AUTHORITY_RANK };

export const AUTHORITY_TEXT = {
  finding: 'Finding · unverified',
  'proposed-decision': 'Proposed decision',
  'accepted-finding': 'Accepted finding',
  'accepted-decision': 'Accepted decision',
  'superseded-decision': 'Superseded',
  shadowed: 'Proposed · shadowed by main',
};

/**
 * Label every entry of a branch snapshot the same way sync and the CLI do:
 * entries attached to main are accepted (or superseded when no longer in force),
 * local entries are unverified findings or proposals.
 */
export function labelSnapshot(snapshot, mainBranchId) {
  const inForce = new Set((snapshot?.knowledge ?? []).map((c) => c.id));
  return (snapshot?.entries ?? []).map((entry) => {
    const onMain = entry.branchId === mainBranchId;
    let authority = authorityOf(entry.commit, onMain, inForce.has(entry.commit.id));
    if (!onMain && entry.commit.knowledge.kind === 'decision' && !inForce.has(entry.commit.id)) authority = 'shadowed';
    return { ...entry, authority, inForce: inForce.has(entry.commit.id) };
  });
}

/**
 * What the adapters declare they can do per runtime (packages/adapters docs).
 * The gateway does not report capabilities, so this is shown as declared, not verified.
 */
export const RUNTIME_CAPABILITIES = {
  'claude-code': { observe: true, managed: true, intercept: true, inject: false },
  claude: { observe: true, managed: true, intercept: true, inject: false },
  codex: { observe: true, managed: true, intercept: false, inject: false },
};

export const CAPABILITY_TEXT = {
  observe: 'Observation',
  managed: 'Managed session',
  intercept: 'Pre-execution interception',
  inject: 'Context injection',
};
