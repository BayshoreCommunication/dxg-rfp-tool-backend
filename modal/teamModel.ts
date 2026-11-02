import mongoose, { Document, Schema } from "mongoose";

export interface ITeam extends Document {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  // An archived team keeps its memberships and its proposals' teamId, but its managers lose
  // the team scope (actor lookups read active teams only). Owners and Admins still see the RFPs.
  archived: boolean;
  archivedAt?: Date | null;
  createdBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const teamSchema = new Schema<ITeam>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    archived: { type: Boolean, default: false, required: true },
    archivedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// Active team names are unique per organization, ignoring case. Archived names can be reused.
teamSchema.index(
  { organizationId: 1, name: 1 },
  {
    unique: true,
    name: "active_team_name_per_organization",
    partialFilterExpression: { archived: false },
    collation: { locale: "en", strength: 2 },
  },
);
teamSchema.index({ organizationId: 1, archived: 1 });

const Team = mongoose.model<ITeam>("Team", teamSchema);
export default Team;
