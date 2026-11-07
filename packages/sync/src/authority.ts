// Authority labels for delivered context. Keeps unverified agent output
// clearly separate from human-reviewed shared context.
import type { ContextCommit } from '../../contracts/src/index.js';

/**
 * - finding:            unverified finding on another agent's branch
 * - proposed-decision:  decision proposed on an agent branch, not reviewed
 * - accepted-finding:   finding merged into main (human-reviewed)
 * - accepted-decision:  decision in force on main (human-reviewed / resolved)
 * - superseded-decision: a previously delivered main decision that is no longer in force
 *
 * Observed activity is never packaged as context; agents publish knowledge explicitly.
 */
export type Authority = 'finding' | 'proposed-decision' | 'accepted-finding' | 'accepted-decision' | 'superseded-decision';

/** Higher rank wins when the same commit is visible at several authority levels. */
export const AUTHORITY_RANK: Record<Authority, number> = {
  finding: 0,
  'proposed-decision': 1,
  'accepted-finding': 2,
  'accepted-decision': 3,
  'superseded-decision': 4,
};

/** Priority multiplier: corrections and accepted decisions first. */
export const AUTHORITY_WEIGHT: Record<Authority, number> = {
  finding: 0.9,
  'proposed-decision': 1,
  'accepted-finding': 1.1,
  'accepted-decision': 1.3,
  'superseded-decision': 1.4,
};

export const isAccepted = (a: Authority) => a === 'accepted-finding' || a === 'accepted-decision';

/** Authority of a commit seen on main vs. on an agent branch. */
export function authorityOf(commit: ContextCommit, onMain: boolean, inForce = true): Authority {
  if (commit.knowledge.kind === 'finding') return onMain ? 'accepted-finding' : 'finding';
  if (!onMain) return 'proposed-decision';
  return inForce ? 'accepted-decision' : 'superseded-decision';
}
