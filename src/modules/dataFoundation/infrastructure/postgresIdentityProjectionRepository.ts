import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../../config/postgres";
import { IdentityProjectionError } from "../domain/identityProjectionError";
import type {
  IdentityProjectionInput,
  IdentityProjectionRepository,
} from "../domain/ports/identityProjectionRepository";

type Client = Parameters<Parameters<typeof withPostgresTransaction>[0]>[0];

/* Both upserts use DO NOTHING and then re-read, never DO UPDATE SET status.
   The backfill script may reactivate rows because an operator ran it
   deliberately; this path runs on every sign-in, so flipping a suspended
   organization or a removed user back to 'active' would let a revoked account
   restore its own access. A row that exists in a non-active state is reported
   as not ready instead. */

const projectOrganization = async (
  client: Client,
  input: IdentityProjectionInput,
): Promise<{ organizationId: string; created: boolean }> => {
  await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
    input.organizationMongoId,
  ]);
  const active = await client.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [input.organizationMongoId],
  );
  if (active.rows[0]) return { organizationId: active.rows[0].id, created: false };

  if (!input.organizationName?.trim()) {
    throw new IdentityProjectionError(
      "ORGANIZATION_NOT_READY",
      "Organization data foundation is unavailable.",
    );
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO rfpilot.organizations(id, external_mongo_id, name)
     VALUES ($1,$2,$3)
     ON CONFLICT (external_mongo_id) DO NOTHING
     RETURNING id`,
    [uuidv7(), input.organizationMongoId, input.organizationName.trim().slice(0, 200)],
  );
  if (inserted.rows[0]) return { organizationId: inserted.rows[0].id, created: true };

  /* The conflict fired, so a row exists but the status filter above rejected
     it. Suspended and archived tenants stay unavailable. */
  throw new IdentityProjectionError(
    "ORGANIZATION_NOT_ACTIVE",
    "Organization data foundation is unavailable.",
  );
};

const projectUser = async (
  client: Client,
  organizationId: string,
  input: IdentityProjectionInput,
): Promise<{ userId: string; created: boolean }> => {
  /* rfpilot.users has FORCE ROW LEVEL SECURITY, so the tenant GUC must be set
     before the insert or the WITH CHECK clause rejects it. */
  await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO rfpilot.users(id, organization_id, external_mongo_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (organization_id, external_mongo_id) DO NOTHING
     RETURNING id`,
    [uuidv7(), organizationId, input.userMongoId],
  );
  if (inserted.rows[0]) return { userId: inserted.rows[0].id, created: true };

  const existing = await client.query<{ id: string }>(
    "SELECT id FROM rfpilot.users WHERE organization_id=$1 AND external_mongo_id=$2 AND status='active'",
    [organizationId, input.userMongoId],
  );
  if (existing.rows[0]) return { userId: existing.rows[0].id, created: false };
  throw new IdentityProjectionError(
    "ASSISTANT_ACTOR_NOT_ACTIVE",
    "Your assistant workspace is not ready.",
  );
};

export const postgresIdentityProjectionRepository: IdentityProjectionRepository = {
  ensure(input) {
    return withPostgresTransaction(async (client) => {
      const organization = await projectOrganization(client, input);
      const user = await projectUser(client, organization.organizationId, input);
      if (organization.created || user.created) {
        await client.query(
          `INSERT INTO rfpilot.audit_events(
             id,organization_id,actor_external_user_id,action,target_type,target_id,
             decision,correlation_id,metadata
           ) VALUES($1,$2,$3,'identity.projection.created','user',$4,'allowed',$5,$6::jsonb)`,
          [
            uuidv7(),
            organization.organizationId,
            input.userMongoId,
            user.userId,
            input.correlationId,
            JSON.stringify({
              organizationCreated: organization.created,
              userCreated: user.created,
            }),
          ],
        );
      }
      return {
        organizationId: organization.organizationId,
        userId: user.userId,
        organizationCreated: organization.created,
        userCreated: user.created,
      };
    });
  },
};
