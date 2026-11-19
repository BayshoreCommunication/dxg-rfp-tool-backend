import mongoose from "mongoose";

/* The query fragment of a cross-organization sweep that leaves some organizations alone (those
   RFPilot staff blocked): `organizationId` not in the given ids. A sweep that reads a LIMITED,
   oldest-first batch must exclude them IN THE QUERY. Filtering the batch afterwards leaves a
   blocked organization's rows at the head of every batch (they stay due for as long as the block
   lasts), and once they fill it no other organization's row is ever reached. An empty or missing
   list adds nothing to the query. */
export const exceptOrganizations = (organizationIds: readonly string[] | undefined): { organizationId?: { $nin: mongoose.Types.ObjectId[] } } =>
  organizationIds?.length
    ? { organizationId: { $nin: organizationIds.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id)) } }
    : {};
