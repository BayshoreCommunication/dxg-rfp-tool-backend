import { AsyncLocalStorage } from "node:async_hooks";
import mongoose from "mongoose";
import type { RfpActor } from "../../identity/domain/rfpAccessPolicy";

// rfpActor is set by the authenticate middleware for planner requests (ORG-103) and is what
// proposal repositories scope by. Other tenant scopes (workers, admin) leave it unset.
export type TenantContext = { organizationId: string; userId: string; rfpActor?: RfpActor };
const storage = new AsyncLocalStorage<TenantContext>();

export const runWithTenant = <T>(context: TenantContext, callback: () => T): T =>
  storage.run(context, callback);

export const currentTenant = (): TenantContext => {
  const context = storage.getStore();
  if (!context) throw new Error("Trusted tenant context is unavailable");
  return context;
};

export const currentTenantOrNull = (): TenantContext | null => storage.getStore() ?? null;

export const tenantFilter = (): { organizationId: string } => ({
  organizationId: currentTenant().organizationId,
});

export const tenantObjectId = (): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(currentTenant().organizationId);

export const currentRfpActor = (): RfpActor => {
  const actor = currentTenant().rfpActor;
  if (!actor) throw new Error("Proposal access actor is unavailable outside an authenticated request");
  return actor;
};
