import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { OrganizationVendorError, type VendorListActor } from "../src/modules/organizationVendors/domain";
import type { OrganizationVendorList } from "../src/modules/organizationVendors/application/manageOrganizationVendors";
import { organizationVendorList } from "../src/modules/organizationVendors/composition";

// The actor is always the signed-in member's own organization; no id in the path or body can widen it.
const actorFrom = (req: AuthRequest): VendorListActor => {
  const user = req.user;
  if (!user?.userId || !user.organizationId) throw new OrganizationVendorError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    userId: user.userId,
    organizationId: user.organizationId,
    roles: user.roles ?? [],
    correlationId: (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID(),
  };
};

const body = (req: AuthRequest): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

const fail = (res: Response, error: unknown): void => {
  if (error instanceof OrganizationVendorError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return;
  }
  console.error("Vendor list error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "VENDOR_LIST_INTERNAL_ERROR", message: "The vendor list request could not be completed." });
};

export const createOrganizationVendorsController = (vendors: OrganizationVendorList = organizationVendorList) => {
  const handle = (status: number, run: (req: AuthRequest) => Promise<unknown>) => async (req: AuthRequest, res: Response) => {
    try {
      res.status(status).json({ success: true, data: await run(req) });
    } catch (error) {
      fail(res, error);
    }
  };
  return {
    list: handle(200, (req) => vendors.list(actorFrom(req), req.query as Record<string, unknown>)),
    categories: handle(200, (req) => vendors.categories(actorFrom(req))),
    get: handle(200, (req) => vendors.get(actorFrom(req), req.params.vendorId)),
    create: handle(201, (req) => vendors.create(actorFrom(req), body(req))),
    update: handle(200, (req) => vendors.update(actorFrom(req), req.params.vendorId, body(req))),
    archive: handle(200, (req) => vendors.archive(actorFrom(req), req.params.vendorId)),
    restore: handle(200, (req) => vendors.restore(actorFrom(req), req.params.vendorId)),
  };
};

export const organizationVendorsController = createOrganizationVendorsController();
