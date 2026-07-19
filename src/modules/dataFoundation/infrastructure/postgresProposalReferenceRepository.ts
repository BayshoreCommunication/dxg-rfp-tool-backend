import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../../config/postgres";
import type { ProposalReferenceRepository } from "../domain/ports/proposalReferenceRepository";

export const postgresProposalReferenceRepository: ProposalReferenceRepository = {
  async upsertWithOutbox(input) {
    return withPostgresTransaction(async (client) => {
      await client.query("SELECT set_config('app.organization_mongo_id', $1, true)", [input.organizationMongoId]);
      const organization = await client.query<{ id: string }>(
        "SELECT id FROM rfpilot.organizations WHERE external_mongo_id = $1 AND status = 'active'",
        [input.organizationMongoId],
      );
      const organizationId = organization.rows[0]?.id;
      if (!organizationId) throw new Error("PostgreSQL organization reference is unavailable");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      const user = await client.query<{ id: string }>(
        "SELECT id FROM rfpilot.users WHERE organization_id = $1 AND external_mongo_id = $2 AND status = 'active'",
        [organizationId, input.ownerUserMongoId],
      );
      const ownerUserId = user.rows[0]?.id;
      if (!ownerUserId) throw new Error("PostgreSQL user reference is unavailable");
      const proposalReferenceId = uuidv7();
      const proposal = await client.query<{ id: string; created: boolean }>(`
        WITH upsert AS (
          INSERT INTO rfpilot.proposal_references (
          id, organization_id, owner_user_id, external_mongo_id, source_version,
          source_checksum, source_updated_at, reconciled_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
          ON CONFLICT (organization_id, external_mongo_id) DO UPDATE SET
            owner_user_id = EXCLUDED.owner_user_id,
            source_version = EXCLUDED.source_version,
            source_checksum = EXCLUDED.source_checksum,
            source_updated_at = EXCLUDED.source_updated_at,
            reconciled_at = now(),
            updated_at = now()
          WHERE (rfpilot.proposal_references.owner_user_id, rfpilot.proposal_references.source_version, rfpilot.proposal_references.source_checksum, rfpilot.proposal_references.source_updated_at)
            IS DISTINCT FROM (EXCLUDED.owner_user_id, EXCLUDED.source_version, EXCLUDED.source_checksum, EXCLUDED.source_updated_at)
          RETURNING id, (xmax = 0) AS created
        )
        SELECT id, created FROM upsert
        UNION ALL
        SELECT id, false FROM rfpilot.proposal_references
        WHERE organization_id = $2 AND external_mongo_id = $4 AND NOT EXISTS (SELECT 1 FROM upsert)
      `, [proposalReferenceId, organizationId, ownerUserId, input.proposalMongoId, input.sourceVersion ?? null, input.sourceChecksum ?? null, input.sourceUpdatedAt ?? null]);
      const resolvedProposalId = proposal.rows[0].id;
      const outboxEventId = uuidv7();
      const idempotencyKey = `${input.eventType}:${input.proposalMongoId}:${input.sourceChecksum ?? input.sourceVersion ?? "unknown"}`;
      const outbox = await client.query<{ id: string; created: boolean }>(`
        INSERT INTO rfpilot.outbox_events (
          id, organization_id, aggregate_type, aggregate_id, event_type,
          event_version, idempotency_key, payload
        ) VALUES ($1,$2,'proposal_reference',$3,$4,1,$5,$6::jsonb)
        ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING id, (xmax = 0) AS created
      `, [outboxEventId, organizationId, resolvedProposalId, input.eventType, idempotencyKey, JSON.stringify({ proposalMongoId: input.proposalMongoId, proposalReferenceId: resolvedProposalId, correlationId: input.correlationId })]);
      return {
        proposalReferenceId: resolvedProposalId,
        outboxEventId: outbox.rows[0].id,
        referenceCreated: proposal.rows[0].created,
        outboxCreated: outbox.rows[0].created,
      };
    });
  },
};
