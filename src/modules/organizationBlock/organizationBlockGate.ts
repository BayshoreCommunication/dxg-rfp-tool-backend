import mongoose from "mongoose";
import Organization from "../../../modal/organizationModel";
import { isOrganizationBlocked } from "./domain";

/* The one lookup behind every enforcement point of the organization block (see domain.ts).

   NOT CACHED, on purpose. Each call is one read of one document by `_id`. A block therefore
   takes effect on the very next request or job on every API instance, worker and cron process,
   and a reactivation likewise; there is no window to bound and nothing to invalidate.

   Failure: a failed read REJECTS. It never answers "blocked" and never answers "not blocked".
   The caller's request or job then fails as a whole (an error answer, or a deferred job), which
   is closed for a blocked organization and is what that request would have done anyway: every
   surface that asks here reads MongoDB for its own work. Nobody is marked blocked by an error,
   so an outage ends when MongoDB is back, with no organization locked out. */

type Lookup = (organizationId: string) => Promise<{ blocked?: { at?: unknown } | null } | null>;

const mongoLookup: Lookup = (organizationId) =>
  Organization.findById(organizationId).select("blocked").lean<{ blocked?: { at?: unknown } | null } | null>();

export const createOrganizationBlockGate = (lookup: Lookup = mongoLookup) => {
  /** Is this organization blocked? An id that is not an organization id, or an organization
      that does not exist, is not blocked: the caller's own "not found" handling applies. */
  const isBlocked = async (organizationId: unknown): Promise<boolean> => {
    const id = organizationId == null ? "" : String(organizationId);
    if (!mongoose.isValidObjectId(id)) return false;
    return isOrganizationBlocked(await lookup(id));
  };
  return { isBlocked };
};

export const organizationBlockGate = createOrganizationBlockGate();

/** Every blocked organization's id, for a sweep that walks many organizations. The query only
    narrows the read; `isOrganizationBlocked` decides. */
export const blockedOrganizationIds = async (): Promise<Set<string>> => {
  const rows = await Organization.find({ "blocked.at": { $type: "date" } }).select("blocked").lean<Array<{ _id: unknown; blocked?: { at?: unknown } | null }>>();
  return new Set(rows.filter(isOrganizationBlocked).map((row) => String(row._id)));
};
