import { DelayedError, type Job } from "bullmq";
import { organizationBlockGate } from "../organizationBlock/organizationBlockGate";
import { pseudonym, safeLog } from "../../shared/observability/safeTelemetry";
import type { QueueMessage } from "./domain";

/* Background work for an organization that RFPilot staff blocked is PAUSED (owner decision,
   2026-11-18; organizationBlock/domain.ts). Every durable job type goes through this, in both
   workers, as the first thing the processor does, BEFORE the job is claimed in PostgreSQL:

   - blocked: the job is not executed. It is moved back to BullMQ's delayed set for
     BLOCKED_JOB_DEFER_MS and asked again then. Nothing is claimed, no attempt is counted (BullMQ's
     manual delay skips the attempt, and the job row in PostgreSQL is still `queued`), nothing is
     failed, dead-lettered or dropped. After a reactivation the job runs at its next turn, at
     most BLOCKED_JOB_DEFER_MS later.
   - the gate could not be read (MongoDB unavailable): the job is deferred the same way, for
     LOOKUP_FAILED_DEFER_MS. It is not executed on a guess and it is not failed.

   The authoritative record is the PostgreSQL job row and its outbox event; if Redis loses the
   delayed job the dispatcher's reconcile publishes it again and it comes back here. */

export const BLOCKED_JOB_DEFER_MS = 5 * 60_000;
export const LOOKUP_FAILED_DEFER_MS = 30_000;

type Deferrable = Pick<Job<QueueMessage>, "data" | "moveToDelayed">;

export const createOrganizationBlockDeferral = (
  isBlocked: (organizationId: string) => Promise<boolean> = (organizationId) => organizationBlockGate.isBlocked(organizationId),
  now: () => number = Date.now,
) =>
  /** Returns when the job may run. Otherwise defers it and throws BullMQ's DelayedError. */
  async (job: Deferrable, token: string | undefined): Promise<void> => {
    let deferMs = 0;
    let reason = "";
    try {
      if (await isBlocked(job.data.organizationMongoId)) {
        deferMs = BLOCKED_JOB_DEFER_MS;
        reason = "organization_blocked";
      }
    } catch {
      deferMs = LOOKUP_FAILED_DEFER_MS;
      reason = "organization_block_lookup_failed";
    }
    if (!deferMs) return;
    safeLog("info", "job.deferred", {
      jobId: job.data.jobId,
      jobType: job.data.jobType,
      correlationId: job.data.correlationId,
      organizationPseudonym: pseudonym(job.data.organizationMongoId),
      outcome: reason,
    });
    await job.moveToDelayed(now() + deferMs, token);
    throw new DelayedError();
  };

export const deferJobOfBlockedOrganization = createOrganizationBlockDeferral();
