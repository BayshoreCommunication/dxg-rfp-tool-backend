import { AsyncLocalStorage } from "node:async_hooks";
import mongoose from "mongoose";

export type TenantContext = { organizationId: string; userId: string };
const storage = new AsyncLocalStorage<TenantContext>();

export const runWithTenant = <T>(context: TenantContext, callback: () => T): T =>
  storage.run(context, callback);

export const currentTenant = (): TenantContext => {
  const context = storage.getStore();
  if (!context) throw new Error("Trusted tenant context is unavailable");
  return context;
};

export const tenantFilter = (): { organizationId: string } => ({
  organizationId: currentTenant().organizationId,
});

export const tenantObjectId = (): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(currentTenant().organizationId);
