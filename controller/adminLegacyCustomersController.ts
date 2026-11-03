import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { Pool } from "pg";
import type { AuthRequest } from "../middleware/auth";
import {
  getPlacement,
  listTargetOrganizations,
  listUnplacedLegacyCustomers,
  placeLegacyCustomer,
  PlacementError,
  rollbackPlacement,
  type NewOrganizationDetails,
  type PlacementActor,
  type PlacementTarget,
} from "../src/modules/tenancy/legacyCustomerPlacement";

// ORG-110 admin API. Moving Postgres rows between organizations needs the table-owner (migration)
// role, which the API doesn't hold by default. Placement runs here only when
// POSTGRES_MIGRATION_URL is configured for this process; with the Postgres foundation on and no
// migration role, it is refused with 503 rather than moving MongoDB alone.
let migrationPool: Pool | null | undefined;
const placementPool = (): Pool | null => {
  if (process.env.POSTGRES_FOUNDATION_ENABLED !== "true") return null;
  const connectionString = process.env.POSTGRES_MIGRATION_URL?.trim();
  if (!connectionString) {
    throw new PlacementError("PLACEMENT_REQUIRES_MIGRATION_ROLE", "Placement needs the Postgres migration role, which this server isn't configured with.", 503);
  }
  migrationPool ??= new Pool({ connectionString, max: 2, ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : undefined });
  return migrationPool;
};
export const closePlacementPool = async () => {
  await migrationPool?.end();
  migrationPool = undefined;
};

const actorFrom = (req: AuthRequest): PlacementActor => ({
  adminUserId: req.user!.userId,
  adminOrganizationId: req.user!.organizationId!,
  correlationId: (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID(),
});
const body = (req: AuthRequest): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

const fail = (res: Response, error: unknown) => {
  if (error instanceof PlacementError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    return;
  }
  console.error("Legacy customer placement error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "PLACEMENT_INTERNAL_ERROR", message: "The placement request could not be completed." });
};

const targetFrom = (input: Record<string, unknown>): PlacementTarget => {
  if (input.target === "new") {
    const organization = (typeof input.organization === "object" && input.organization !== null ? input.organization : {}) as Record<string, unknown>;
    return { kind: "new", organization: organization as unknown as NewOrganizationDetails };
  }
  if (input.target === "existing") {
    return { kind: "existing", organizationId: String(input.organizationId ?? ""), role: String(input.role ?? ""), teamId: (input.teamId as string | null | undefined) ?? null };
  }
  throw new PlacementError("TARGET_REQUIRED", "Choose a new or an existing organization.", 400);
};

export const listLegacyCustomers = async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ success: true, data: { customers: await listUnplacedLegacyCustomers() } });
  } catch (error) { fail(res, error); }
};

export const listPlacementTargets = async (req: AuthRequest, res: Response) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json({ success: true, data: { organizations: await listTargetOrganizations({ q }) } });
  } catch (error) { fail(res, error); }
};

export const placeCustomer = async (req: AuthRequest, res: Response) => {
  try {
    const placement = await placeLegacyCustomer({ userId: String(req.params.userId ?? ""), target: targetFrom(body(req)), actor: actorFrom(req), pool: placementPool() });
    res.status(201).json({ success: true, data: { placement } });
  } catch (error) { fail(res, error); }
};

export const getPlacementRun = async (req: AuthRequest, res: Response) => {
  try {
    const placement = await getPlacement(String(req.params.runId ?? ""));
    if (!placement) throw new PlacementError("PLACEMENT_NOT_FOUND", "Placement run not found.", 404);
    res.json({ success: true, data: { placement } });
  } catch (error) { fail(res, error); }
};

export const rollbackPlacementRun = async (req: AuthRequest, res: Response) => {
  try {
    const result = await rollbackPlacement({ runId: String(req.params.runId ?? ""), actor: actorFrom(req), pool: placementPool() });
    res.json({ success: true, data: { rollback: result } });
  } catch (error) { fail(res, error); }
};
