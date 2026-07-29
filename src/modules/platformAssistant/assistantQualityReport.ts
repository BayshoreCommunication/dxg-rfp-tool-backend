/* eslint-disable @typescript-eslint/no-explicit-any */
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import { PRICING_CATEGORIES } from "../pricing/domain";
import {
  ASSISTANT_FINDING_CATEGORIES,
  type AssistantFindingCategory,
} from "./productAnalytics";
import {
  ASSISTANT_INTENTS,
  type AssistantIntent,
} from "./intentRouter";
import { PlatformAssistantError } from "./domain";

export const ASSISTANT_QUALITY_REPORT_SCHEMA_VERSION =
  "assistant-quality-report.v1" as const;
export const ASSISTANT_QUALITY_MINIMUM_SAMPLE = 5;
export const ASSISTANT_QUALITY_MAX_DAYS = 90;

const safeDimensionPattern = /^[a-zA-Z0-9._:-]{1,100}$/;
const isoDayPattern = /^\d{4}-\d{2}-\d{2}$/;

export type AssistantQualityFilters = {
  from: string;
  to: string;
  days: number;
  organizationCohort: string | null;
  model: string | null;
  promptVersion: string | null;
  knowledgeVersion: string | null;
  intent: AssistantIntent | null;
  findingCategory: AssistantFindingCategory | null;
};

const day = (value: unknown): string | null => {
  if (typeof value !== "string" || !isoDayPattern.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
};

const dimension = (value: unknown): string | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !safeDimensionPattern.test(value)) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_QUALITY_FILTER",
      "An Assistant Quality filter is invalid.",
      422,
    );
  }
  return value;
};

export const parseAssistantQualityFilters = (
  query: Record<string, unknown>,
  now = new Date(),
): AssistantQualityFilters => {
  const requestedFrom = day(query.from);
  const requestedTo = day(query.to);
  if (
    (query.from !== undefined && query.from !== "" && !requestedFrom) ||
    (query.to !== undefined && query.to !== "" && !requestedTo)
  ) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_QUALITY_FILTER",
      "Assistant Quality dates must use YYYY-MM-DD.",
      422,
    );
  }
  const defaultTo = now.toISOString().slice(0, 10);
  const defaultFromDate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 29,
    ),
  );
  const from = requestedFrom ?? defaultFromDate.toISOString().slice(0, 10);
  const to = requestedTo ?? defaultTo;
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T23:59:59.999Z`);
  const days = Math.floor((toMs - fromMs) / 86_400_000) + 1;
  if (days < 1 || days > ASSISTANT_QUALITY_MAX_DAYS) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_QUALITY_FILTER",
      `Assistant Quality date ranges must be between 1 and ${ASSISTANT_QUALITY_MAX_DAYS} days.`,
      422,
    );
  }
  const intent = dimension(query.intent);
  if (
    intent &&
    !ASSISTANT_INTENTS.includes(intent as AssistantIntent)
  ) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_QUALITY_FILTER",
      "The Assistant Quality intent filter is invalid.",
      422,
    );
  }
  const findingCategory = dimension(query.findingCategory);
  if (
    findingCategory &&
    !ASSISTANT_FINDING_CATEGORIES.includes(
      findingCategory as AssistantFindingCategory,
    )
  ) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_QUALITY_FILTER",
      "The Assistant Quality finding filter is invalid.",
      422,
    );
  }
  return {
    from,
    to,
    days,
    organizationCohort: dimension(query.organizationCohort),
    model: dimension(query.model),
    promptVersion: dimension(query.promptVersion),
    knowledgeVersion: dimension(query.knowledgeVersion),
    intent: (intent as AssistantIntent | null) ?? null,
    findingCategory:
      (findingCategory as AssistantFindingCategory | null) ?? null,
  };
};

type ReportContext = {
  organizationMongoId: string;
  actorUserMongoId: string;
  correlationId: string;
};

type MetricRow = {
  eligible_sessions: string;
  resolved_sessions: string;
  submitted: string;
  completed: string;
  failed: string;
  retried: string;
  clarifications: string;
  abstentions: string;
  cited: string;
  helpful: string;
  feedback_total: string;
  first_token_samples: string;
  p50_first_token_ms: string | null;
  p95_first_token_ms: string | null;
  completion_samples: string;
  p50_completion_ms: string | null;
  p95_completion_ms: string | null;
  input_tokens: string;
  output_tokens: string;
  estimated_cost_micros: string;
};

const count = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const protectedCount = (value: number) =>
  value >= ASSISTANT_QUALITY_MINIMUM_SAMPLE ? value : null;
const rate = (numerator: number, denominator: number) =>
  denominator >= ASSISTANT_QUALITY_MINIMUM_SAMPLE
    ? Number((numerator / denominator).toFixed(4))
    : null;
const protectedPercentile = (samples: number, value: unknown) =>
  samples >= ASSISTANT_QUALITY_MINIMUM_SAMPLE && value !== null
    ? Math.round(Number(value))
    : null;

const filteredEvents = (filters: AssistantQualityFilters) => {
  const parameters: unknown[] = [
    `${filters.from}T00:00:00.000Z`,
    `${filters.to}T23:59:59.999Z`,
  ];
  const clauses = [
    "occurred_at >= $1::timestamptz",
    "occurred_at <= $2::timestamptz",
  ];
  const add = (column: string, value: string | null) => {
    if (!value) return;
    parameters.push(value);
    clauses.push(`${column} = $${parameters.length}`);
  };
  add("organization_cohort", filters.organizationCohort);
  add("model", filters.model);
  add("prompt_version", filters.promptVersion);
  add("knowledge_version", filters.knowledgeVersion);
  add("intent", filters.intent);
  add("finding_category", filters.findingCategory);
  return {
    parameters,
    where: clauses.join(" AND "),
  };
};

const summaryQuery = (where: string) => `
  WITH filtered AS (
    SELECT * FROM rfpilot.assistant_product_events WHERE ${where}
  ), sessions AS (
    SELECT session_key,
      bool_or(event_type='message_submitted') AS eligible,
      bool_or(event_type='response_completed') AS completed,
      bool_or(event_type='feedback_submitted' AND feedback_value='helpful') AS helpful,
      bool_or(event_type IN (
        'citation_opened','internal_route_opened','proposal_handoff_completed'
      )) AS engaged
    FROM filtered GROUP BY session_key
  )
  SELECT
    (SELECT count(*) FROM sessions WHERE eligible)::text AS eligible_sessions,
    (SELECT count(*) FROM sessions
      WHERE eligible AND completed AND (helpful OR engaged))::text AS resolved_sessions,
    count(*) FILTER (WHERE event_type='message_submitted')::text AS submitted,
    count(*) FILTER (WHERE event_type='response_completed')::text AS completed,
    count(*) FILTER (WHERE event_type='response_failed')::text AS failed,
    count(*) FILTER (WHERE event_type='response_retried')::text AS retried,
    count(*) FILTER (
      WHERE event_type='response_completed' AND response_kind='clarification'
    )::text AS clarifications,
    count(*) FILTER (
      WHERE event_type='response_completed' AND response_kind='abstention'
    )::text AS abstentions,
    count(*) FILTER (
      WHERE event_type='response_completed' AND cited=true
    )::text AS cited,
    count(*) FILTER (
      WHERE event_type='feedback_submitted' AND feedback_value='helpful'
    )::text AS helpful,
    count(*) FILTER (WHERE event_type='feedback_submitted')::text AS feedback_total,
    count(first_token_ms)::text AS first_token_samples,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY first_token_ms)
      FILTER (WHERE first_token_ms IS NOT NULL) AS p50_first_token_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms)
      FILTER (WHERE first_token_ms IS NOT NULL) AS p95_first_token_ms,
    count(completion_latency_ms)::text AS completion_samples,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY completion_latency_ms)
      FILTER (WHERE completion_latency_ms IS NOT NULL) AS p50_completion_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY completion_latency_ms)
      FILTER (WHERE completion_latency_ms IS NOT NULL) AS p95_completion_ms,
    coalesce(sum(input_tokens) FILTER (WHERE event_type='response_completed'),0)::text
      AS input_tokens,
    coalesce(sum(output_tokens) FILTER (WHERE event_type='response_completed'),0)::text
      AS output_tokens,
    coalesce(sum(estimated_cost_micros)
      FILTER (WHERE event_type='response_completed'),0)::text AS estimated_cost_micros
  FROM filtered`;

const breakdownQuery = (where: string, column: string) => `
  WITH filtered AS (
    SELECT * FROM rfpilot.assistant_product_events WHERE ${where}
  )
  SELECT coalesce(${column},'unknown') AS dimension,
    count(*) FILTER (WHERE event_type='message_submitted')::int AS submitted,
    count(*) FILTER (WHERE event_type='response_completed')::int AS completed,
    count(*) FILTER (WHERE event_type='response_failed')::int AS failed,
    count(*) FILTER (
      WHERE event_type='feedback_submitted' AND feedback_value='helpful'
    )::int AS helpful,
    count(*) FILTER (WHERE event_type='feedback_submitted')::int AS feedback_total
  FROM filtered
  GROUP BY coalesce(${column},'unknown')
  HAVING count(*) FILTER (
    WHERE event_type IN ('message_submitted','response_completed','feedback_submitted')
  ) >= ${ASSISTANT_QUALITY_MINIMUM_SAMPLE}
  ORDER BY submitted DESC, dimension
  LIMIT 50`;

const presentBreakdown = (rows: any[]) =>
  rows.map((row) => ({
    dimension: String(row.dimension),
    submitted: count(row.submitted),
    completed: count(row.completed),
    failed: count(row.failed),
    helpful: count(row.helpful),
    feedbackTotal: count(row.feedback_total),
    completionRate: rate(count(row.completed), count(row.submitted)),
    helpfulRate: rate(count(row.helpful), count(row.feedback_total)),
  }));

export const assistantQualityReport = async (
  context: ReportContext,
  filters: AssistantQualityFilters,
) =>
  withPostgresTransaction(async (client) => {
    await client.query(
      "SELECT set_config('app.organization_mongo_id',$1,true)",
      [context.organizationMongoId],
    );
    const organization = await client.query<{ id: string }>(
      `SELECT id FROM rfpilot.organizations
       WHERE external_mongo_id=$1 AND status='active'`,
      [context.organizationMongoId],
    );
    if (!organization.rows[0]) {
      throw new PlatformAssistantError(
        "ORGANIZATION_NOT_READY",
        "Organization data foundation is unavailable.",
        503,
      );
    }
    const organizationId = organization.rows[0].id;
    await client.query("SELECT set_config('app.organization_id',$1,true)", [
      organizationId,
    ]);

    const filtered = filteredEvents(filters);
    const [summaryResult, negativeFeedback, findingCategories] =
      await Promise.all([
        client.query<MetricRow>(
          summaryQuery(filtered.where),
          filtered.parameters,
        ),
        client.query<any>(
          `SELECT feedback_reason AS dimension,count(*)::int AS count
           FROM rfpilot.assistant_product_events
           WHERE ${filtered.where}
             AND event_type='feedback_submitted'
             AND feedback_value='not_helpful'
             AND feedback_reason IS NOT NULL
           GROUP BY feedback_reason
           HAVING count(*) >= ${ASSISTANT_QUALITY_MINIMUM_SAMPLE}
           ORDER BY count DESC, feedback_reason
           LIMIT 20`,
          filtered.parameters,
        ),
        client.query<any>(
          `SELECT finding_category AS dimension,count(*)::int AS count
           FROM rfpilot.assistant_product_events
           WHERE ${filtered.where}
             AND finding_category IS NOT NULL
           GROUP BY finding_category
           HAVING count(*) >= ${ASSISTANT_QUALITY_MINIMUM_SAMPLE}
           ORDER BY count DESC, finding_category
           LIMIT 20`,
          filtered.parameters,
        ),
      ]);

    const dimensions = [
      ["intents", "intent"],
      ["models", "model"],
      ["promptVersions", "prompt_version"],
      ["knowledgeVersions", "knowledge_version"],
      ["ruleVersions", "rule_version"],
      ["pricingVersions", "pricing_version"],
    ] as const;
    const breakdownResults = await Promise.all(
      dimensions.map(([, column]) =>
        client.query<any>(
          breakdownQuery(filtered.where, column),
          filtered.parameters,
        ),
      ),
    );
    const breakdowns = Object.fromEntries(
      dimensions.map(([name], index) => [
        name,
        presentBreakdown(breakdownResults[index].rows),
      ]),
    );

    const [knowledge, rules, approvedPriceCategories] = await Promise.all([
      client.query<any>(
        `SELECT release_number,state,expires_at,
           CASE
             WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired'
             ELSE 'expiring'
           END AS condition
         FROM rfpilot.knowledge_releases
         WHERE state='active' AND expires_at IS NOT NULL
           AND expires_at <= now()+interval '30 days'
         ORDER BY expires_at ASC LIMIT 50`,
      ),
      client.query<any>(
        `SELECT rule_key,status,updated_at,
           CASE
             WHEN status='retired' THEN 'retired'
             ELSE 'stale'
           END AS condition
         FROM rfpilot.expert_rules
         WHERE status='retired'
           OR (status='active' AND updated_at < now()-interval '180 days')
         ORDER BY
           CASE WHEN status='retired' THEN 0 ELSE 1 END,
           updated_at ASC
         LIMIT 50`,
      ),
      client.query<{ category: string }>(
        `SELECT DISTINCT category
         FROM rfpilot.pricing_records WHERE status='approved'`,
      ),
    ]);

    const raw = summaryResult.rows[0];
    const eligible = count(raw?.eligible_sessions);
    const resolved = count(raw?.resolved_sessions);
    const submitted = count(raw?.submitted);
    const completed = count(raw?.completed);
    const failed = count(raw?.failed);
    const retried = count(raw?.retried);
    const feedbackTotal = count(raw?.feedback_total);
    const helpful = count(raw?.helpful);
    const cited = count(raw?.cited);
    const firstTokenSamples = count(raw?.first_token_samples);
    const completionSamples = count(raw?.completion_samples);
    const approved = new Set(
      approvedPriceCategories.rows.map((row) => row.category),
    );

    const requestId = uuidv7();
    await client.query(
      `INSERT INTO rfpilot.audit_events(
        id,organization_id,actor_external_user_id,action,target_type,target_id,
        decision,correlation_id,metadata
      ) VALUES($1,$2,$3,'assistant_quality_report_viewed',
        'assistant_quality_report',$4,'allowed',$5,$6::jsonb)`,
      [
        uuidv7(),
        organizationId,
        context.actorUserMongoId,
        requestId,
        context.correlationId,
        JSON.stringify({
          schemaVersion: ASSISTANT_QUALITY_REPORT_SCHEMA_VERSION,
          from: filters.from,
          to: filters.to,
          filtered: Object.entries(filters)
            .filter(
              ([key, value]) =>
                !["from", "to", "days"].includes(key) && value !== null,
            )
            .map(([key]) => key),
        }),
      ],
    );

    return {
      schemaVersion: ASSISTANT_QUALITY_REPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      window: { from: filters.from, to: filters.to, days: filters.days },
      privacy: {
        minimumSampleSize: ASSISTANT_QUALITY_MINIMUM_SAMPLE,
        sampleProtected: eligible < ASSISTANT_QUALITY_MINIMUM_SAMPLE,
        conversationsIncluded: false,
        directIdentifiersIncluded: false,
      },
      summary: {
        eligibleSessions: protectedCount(eligible),
        resolvedSessions: protectedCount(resolved),
        resolvedSessionRate: rate(resolved, eligible),
        helpfulRate: rate(helpful, feedbackTotal),
        completionRate: rate(completed, submitted),
        errorRate: rate(failed, submitted),
        retryRate: rate(retried, submitted),
        clarificationRate: rate(count(raw?.clarifications), completed),
        abstentionRate: rate(count(raw?.abstentions), completed),
        citationUsageRate: rate(cited, completed),
        citationValidityRate:
          cited >= ASSISTANT_QUALITY_MINIMUM_SAMPLE ? 1 : null,
        p50FirstTokenMs: protectedPercentile(
          firstTokenSamples,
          raw?.p50_first_token_ms,
        ),
        p95FirstTokenMs: protectedPercentile(
          firstTokenSamples,
          raw?.p95_first_token_ms,
        ),
        p50CompletionMs: protectedPercentile(
          completionSamples,
          raw?.p50_completion_ms,
        ),
        p95CompletionMs: protectedPercentile(
          completionSamples,
          raw?.p95_completion_ms,
        ),
        inputTokens:
          completed >= ASSISTANT_QUALITY_MINIMUM_SAMPLE
            ? count(raw?.input_tokens)
            : null,
        outputTokens:
          completed >= ASSISTANT_QUALITY_MINIMUM_SAMPLE
            ? count(raw?.output_tokens)
            : null,
        estimatedCostMicros:
          completed >= ASSISTANT_QUALITY_MINIMUM_SAMPLE
            ? count(raw?.estimated_cost_micros)
            : null,
      },
      breakdowns: {
        ...breakdowns,
        negativeFeedback: negativeFeedback.rows.map((row) => ({
          dimension: String(row.dimension),
          count: count(row.count),
        })),
        findingCategories: findingCategories.rows.map((row) => ({
          dimension: String(row.dimension),
          count: count(row.count),
        })),
      },
      governance: {
        expiringKnowledge: knowledge.rows.map((row: any) => ({
          releaseNumber: count(row.release_number),
          state: String(row.state),
          condition: String(row.condition),
          expiresAt: row.expires_at,
        })),
        staleOrRetiredRules: rules.rows.map((row: any) => ({
          ruleKey: String(row.rule_key),
          status: String(row.status),
          condition: String(row.condition),
          updatedAt: row.updated_at,
        })),
        unavailableApprovedPriceCategories: PRICING_CATEGORIES.filter(
          (category) => !approved.has(category),
        ),
      },
    };
  });
