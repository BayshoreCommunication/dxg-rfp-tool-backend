import crypto from 'node:crypto';
import { context, propagation } from '@opentelemetry/api';
import type { JobRepository } from './jobRepository';
import { aiGatewayQueue, sourceSecurityQueue } from './queue';
const withTrace = <T extends object>(
  message: T,
): T & { traceparent?: string } => {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent
    ? { ...message, traceparent: carrier.traceparent }
    : message;
};
export const createDispatcher = (
  repository: JobRepository,
  publisher?: {
    publish(
      message: Parameters<
        ReturnType<typeof sourceSecurityQueue>['add']
      >[1],
    ): Promise<unknown>;
  },
  /* Every blocked organization's id (organizationBlock), for reconcile. This is FAIRNESS, not
     enforcement: the worker defers a blocked organization's job whatever is published. So when
     the ids are not given, or cannot be read, reconcile runs over every organization as it
     always did; it never fails and never skips a pass because of the block. */
  blockedOrganizationIds?: () => Promise<Iterable<string>>,
) => {
  const id = `dispatcher-${crypto.randomUUID()}`;
  const publish =
    publisher?.publish ??
    (async (
      message: Parameters<
        ReturnType<typeof sourceSecurityQueue>['add']
      >[1],
    ) => {
      const queue =
        message.jobType === 'ai_gateway_test'
          ? aiGatewayQueue()
          : sourceSecurityQueue();
      const existing = await queue.getJob(message.jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'failed') await existing.retry();
        else if (state === 'unknown' || state === 'completed') {
          await existing.remove();
          return queue.add(message.jobType, message, {
            jobId: message.jobId,
            priority: 0,
          });
        }
        return existing;
      }
      return queue.add(message.jobType, message, {
        jobId: message.jobId,
        priority: 0,
      });
    });
  return {
    async dispatch(limit = 25) {
      const events = await repository.claimOutbox(limit, id);
      let published = 0;
      for (const event of events) {
        try {
          await publish(withTrace(event.message));
          await repository.markOutboxPublished(event.eventId);
          published++;
        } catch {
          await repository.markOutboxFailed(
            event.eventId,
            'REDIS_PUBLISH_FAILED',
          );
        }
      }
      return { claimed: events.length, published };
    },
    // Reclaim jobs whose worker died before republishing anything: an expired
    // lease leaves a row 'running', which reconcile() does not look at, so
    // without this the job is unreachable by every recovery path.
    async reconcile(limit = 100) {
      const reaped = await repository.reapExpiredLeases(limit);
      let except: string[] = [];
      try {
        except = [...((await blockedOrganizationIds?.()) ?? [])];
      } catch {
        except = [];
      }
      // A blocked organization's queued jobs are left out of the batch, so they cannot fill it
      // and starve the Redis-loss recovery of every other organization. They are republished on
      // the first pass after a reactivation.
      const messages = await repository.reconcile(limit, except);
      for (const message of messages) await publish(message);
      return messages.length + reaped.length;
    },
  };
};
