// Teams a proposal can belong to, in the requesting tenant (ORG-202).
export interface ProposalTeamAssignment {
  // The creator's team when they're on exactly one active team, otherwise null.
  defaultTeamFor(ownerUserId: string): Promise<string | null>;
  // Whether the proposal may be put on teamId: an active team in the tenant, or the team the
  // proposal is already on (an edit that resends an archived team's id leaves it unchanged).
  isAssignable(input: { teamId: string; proposalId: string }): Promise<boolean>;
}
