import type mongoose from "mongoose";
import { addMemberInTransaction, findActiveTeams } from "../../teams/infrastructure/mongoTeamRepository";
import type { InvitationTeamDirectory } from "../domain/ports";

// An invitation may name only an active team of the inviting organization.
export const teamsInvitationDirectory: InvitationTeamDirectory = {
  async findTeams(organizationId, teamIds) {
    const teams = await findActiveTeams(organizationId, teamIds);
    return new Map(teams.map((team) => [team.id, { id: team.id, name: team.name }]));
  },
};

// Runs inside the accept transaction. False when the team was archived (or moved) after the
// invitation was sent: the accept still succeeds, without a team (docs/DECISIONS.md).
export type TeamPlacement = (input: {
  organizationId: string;
  userId: string;
  teamId: string;
  at: Date;
  session: mongoose.ClientSession;
}) => Promise<boolean>;

export const placeInTeam: TeamPlacement = (input) => addMemberInTransaction(input);
