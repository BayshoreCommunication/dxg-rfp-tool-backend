import type { RfpActor } from "../identity/domain/rfpAccessPolicy";
import { parseFilters, parseListRequest, quarterOf } from "./domain";
import type { RfpDashboardRepository } from "./mongoRfpDashboardRepository";

export const createRfpDashboard = (dependencies: {
  repository: RfpDashboardRepository;
  organizationTimeZone: (organizationId: string) => Promise<string | null>;
  now?: () => Date;
}) => {
  const now = dependencies.now ?? (() => new Date());
  return {
    async list(actor: RfpActor, query: Record<string, unknown>) {
      const request = parseListRequest(query);
      const { items, total } = await dependencies.repository.list(actor, request);
      return {
        items,
        pagination: { total, page: request.page, limit: request.limit, totalPages: Math.ceil(total / request.limit) },
      };
    },

    async summary(actor: RfpActor, query: Record<string, unknown>) {
      const filters = parseFilters(query);
      // "This quarter" is the organization's calendar quarter, not the server's.
      const quarter = quarterOf(now(), await dependencies.organizationTimeZone(String(actor.organizationId)));
      const summary = await dependencies.repository.summary(actor, filters, quarter);
      return { ...summary, quarter: { label: quarter.label, start: quarter.start, end: quarter.end, timeZone: quarter.timeZone } };
    },
  };
};

export type RfpDashboard = ReturnType<typeof createRfpDashboard>;
