import mongoose, { Document, Schema } from "mongoose";

export interface ITeamMembership extends Document {
  organizationId: mongoose.Types.ObjectId;
  teamId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  // Manager scope over the team's proposals also needs the team_manager role (rfpAccessPolicy).
  isManager: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const teamMembershipSchema = new Schema<ITeamMembership>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    isManager: { type: Boolean, default: false, required: true },
  },
  { timestamps: true },
);

teamMembershipSchema.index({ teamId: 1, userId: 1 }, { unique: true });
teamMembershipSchema.index({ organizationId: 1, userId: 1, isManager: 1 });

const TeamMembership = mongoose.model<ITeamMembership>("TeamMembership", teamMembershipSchema);
export default TeamMembership;
