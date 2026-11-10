// ORG-403: tells the lifecycle module that a planner write changed a proposal, so it can re-derive
// the stored stage and append a transition. Called after the write succeeded; it never throws.
export type ProposalChangeReason =
  | "created"
  | "copied"
  | "updated"
  | "status_changed"
  | "metadata_changed"
  | "archived"
  | "restored";

export interface ProposalLifecycleRecorder {
  recordChange(input: { proposalId: string; actorUserId: string; reason: ProposalChangeReason }): Promise<void>;
}
