import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../../config/postgres";

// Onboarding funnel: of the accounts that started in a window, how many sent
// a first proposal message and generated a first draft, how fast, and what
// share did so within the activation window. No new event stream: both
// milestones already exist as durable rows (user-role conversation messages
// and succeeded draft runs), each stamped with the acting user, and account
// start is the tenant-isolated user projection. Aggregate-only, sample
// protected, and audited, following the Assistant Quality report.

export const ONBOARDING_FUNNEL_REPORT_SCHEMA_VERSION =
  "onboarding-funnel-report.v1" as const;
export const ONBOARDING_FUNNEL_MINIMUM_SAMPLE = 5;
export const ONBOARDING_FUNNEL_MAX_DAYS = 180;
export const ONBOARDING_FUNNEL_DEFAULT_DAYS = 90;
export const ONBOARDING_ACTIVATION_WINDOW_DAYS = 7;

export class OnboardingFunnelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "OnboardingFunnelError";
  }
}

export type OnboardingFunnelFilters = { from: string; to: string; days: number };

const isoDayPattern = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: unknown): string | null => {
  if (typeof value !== "string" || !isoDayPattern.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
};

export const parseOnboardingFunnelFilters = (
  query: Record<string, unknown>,
  now = new Date(),
): OnboardingFunnelFilters => {
  const requestedFrom = day(query.from);
  const requestedTo = day(query.to);
  if (
    (query.from !== undefined && query.from !== "" && !requestedFrom) ||
    (query.to !== undefined && query.to !== "" && !requestedTo)
  ) {
    throw new OnboardingFunnelError(
      "INVALID_ONBOARDING_FUNNEL_FILTER",
      "Onboarding funnel dates must use YYYY-MM-DD.",
      422,
    );
  }
  const to = requestedTo ?? now.toISOString().slice(0, 10);
  const from =
    requestedFrom ??
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - (ONBOARDING_FUNNEL_DEFAULT_DAYS - 1),
      ),
    )
      .toISOString()
      .slice(0, 10);
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T23:59:59.999Z`);
  const days = Math.floor((toMs - fromMs) / 86_400_000) + 1;
  if (days < 1 || days > ONBOARDING_FUNNEL_MAX_DAYS) {
    throw new OnboardingFunnelError(
      "INVALID_ONBOARDING_FUNNEL_FILTER",
      `Onboarding funnel date ranges must be between 1 and ${ONBOARDING_FUNNEL_MAX_DAYS} days.`,
      422,
    );
  }
  return { from, to, days };
};

type ReportContext = {
  organizationMongoId: string;
  actorUserMongoId: string;
  correlationId: string;
};

type FunnelRow = {
  new_accounts: string;
  legacy_accounts: string;
  matured_accounts: string;
  message_within: string;
  draft_within: string;
  message_any: string;
  draft_any: string;
  p50_message_hours: string | null;
  p90_message_hours: string | null;
  p50_draft_hours: string | null;
  p90_draft_hours: string | null;
};

const count = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const protectedCount = (value: number) =>
  value >= ONBOARDING_FUNNEL_MINIMUM_SAMPLE ? value : null;
const rate = (numerator: number, denominator: number) =>
  denominator >= ONBOARDING_FUNNEL_MINIMUM_SAMPLE
    ? Number((numerator / denominator).toFixed(4))
    : null;
const protectedHours = (samples: number, value: unknown) =>
  samples >= ONBOARDING_FUNNEL_MINIMUM_SAMPLE && value !== null
    ? Number(Number(value).toFixed(1))
    : null;

// One statement. Account start = rfpilot.users.created_at (the tenant
// projection written at first sign-in, which for a new account is sign-up).
// Accounts whose first milestone predates that stamp are legacy projections
// backfilled after the fact; they are counted and excluded so they cannot
// produce negative durations or inflate rates. "Within window" is measured
// only over matured accounts, those old enough for the whole activation
// window to have elapsed, so a signup from yesterday cannot read as a miss.
export const ONBOARDING_FUNNEL_QUERY = `
  WITH cohort AS (
    SELECT u.external_mongo_id, u.created_at,
      u.created_at <= now() - ($4::int * interval '1 day') AS matured
    FROM rfpilot.users u
    WHERE u.organization_id = $3
      AND u.created_at >= $1::timestamptz
      AND u.created_at <= $2::timestamptz
  ), first_message AS (
    SELECT actor_external_user_id AS ext, min(created_at) AS at
    FROM rfpilot.conversation_messages
    WHERE organization_id = $3
      AND role = 'user'
      AND actor_external_user_id IS NOT NULL
    GROUP BY actor_external_user_id
  ), first_draft AS (
    SELECT actor_external_user_id AS ext,
      min(coalesce(completed_at, updated_at)) AS at
    FROM rfpilot.proposal_draft_runs
    WHERE organization_id = $3 AND status = 'succeeded'
    GROUP BY actor_external_user_id
  ), joined AS (
    SELECT c.matured,
      (fm.at IS NOT NULL AND fm.at < c.created_at)
        OR (fd.at IS NOT NULL AND fd.at < c.created_at) AS legacy,
      fm.at AS message_at,
      fd.at AS draft_at,
      extract(epoch FROM (fm.at - c.created_at)) / 3600 AS message_hours,
      extract(epoch FROM (fd.at - c.created_at)) / 3600 AS draft_hours
    FROM cohort c
    LEFT JOIN first_message fm ON fm.ext = c.external_mongo_id
    LEFT JOIN first_draft fd ON fd.ext = c.external_mongo_id
  ), live AS (
    SELECT * FROM joined WHERE NOT legacy
  )
  SELECT
    (SELECT count(*) FROM joined)::text AS new_accounts,
    (SELECT count(*) FROM joined WHERE legacy)::text AS legacy_accounts,
    count(*) FILTER (WHERE matured)::text AS matured_accounts,
    count(*) FILTER (
      WHERE matured AND message_hours IS NOT NULL AND message_hours <= $4::int * 24
    )::text AS message_within,
    count(*) FILTER (
      WHERE matured AND draft_hours IS NOT NULL AND draft_hours <= $4::int * 24
    )::text AS draft_within,
    count(*) FILTER (WHERE message_at IS NOT NULL)::text AS message_any,
    count(*) FILTER (WHERE draft_at IS NOT NULL)::text AS draft_any,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY message_hours)
      FILTER (WHERE message_hours IS NOT NULL) AS p50_message_hours,
    percentile_cont(0.9) WITHIN GROUP (ORDER BY message_hours)
      FILTER (WHERE message_hours IS NOT NULL) AS p90_message_hours,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY draft_hours)
      FILTER (WHERE draft_hours IS NOT NULL) AS p50_draft_hours,
    percentile_cont(0.9) WITHIN GROUP (ORDER BY draft_hours)
      FILTER (WHERE draft_hours IS NOT NULL) AS p90_draft_hours
  FROM live`;

export type OnboardingFunnelReport = {
  schemaVersion: typeof ONBOARDING_FUNNEL_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  window: { from: string; to: string; days: number };
  activationWindowDays: number;
  privacy: {
    minimumSampleSize: number;
    sampleProtected: boolean;
    conversationsIncluded: false;
    directIdentifiersIncluded: false;
  };
  accounts: {
    started: number | null;
    matured: number | null;
    notYetMatured: number | null;
    legacyExcluded: number;
  };
  firstMessage: OnboardingMilestone;
  firstDraft: OnboardingMilestone;
  definitions: {
    accountStart: string;
    firstMessage: string;
    firstDraft: string;
    withinWindow: string;
  };
};

export type OnboardingMilestone = {
  /** Matured accounts that reached the milestone inside the activation window. */
  withinWindow: number | null;
  /** withinWindow / matured, when both are large enough to publish. */
  withinWindowRate: number | null;
  /** Accounts in the window that reached the milestone at any time. */
  reachedEver: number | null;
  p50Hours: number | null;
  p90Hours: number | null;
};

type Deps = {
  transaction: typeof withPostgresTransaction;
  now?: () => Date;
};

export const onboardingFunnelReport = async (
  context: ReportContext,
  filters: OnboardingFunnelFilters,
  deps: Deps = { transaction: withPostgresTransaction },
): Promise<OnboardingFunnelReport> =>
  deps.transaction(async (client) => {
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
      throw new OnboardingFunnelError(
        "ORGANIZATION_NOT_READY",
        "Organization data foundation is unavailable.",
        503,
      );
    }
    const organizationId = organization.rows[0].id;
    await client.query("SELECT set_config('app.organization_id',$1,true)", [
      organizationId,
    ]);

    const result = await client.query<FunnelRow>(ONBOARDING_FUNNEL_QUERY, [
      `${filters.from}T00:00:00.000Z`,
      `${filters.to}T23:59:59.999Z`,
      organizationId,
      ONBOARDING_ACTIVATION_WINDOW_DAYS,
    ]);
    const raw = result.rows[0];
    const started = count(raw?.new_accounts);
    const legacy = count(raw?.legacy_accounts);
    const matured = count(raw?.matured_accounts);
    const live = started - legacy;
    const messageAny = count(raw?.message_any);
    const draftAny = count(raw?.draft_any);

    await client.query(
      `INSERT INTO rfpilot.audit_events(
        id,organization_id,actor_external_user_id,action,target_type,target_id,
        decision,correlation_id,metadata
      ) VALUES($1,$2,$3,'onboarding_funnel_report_viewed',
        'onboarding_funnel_report',$4,'allowed',$5,$6::jsonb)`,
      [
        uuidv7(),
        organizationId,
        context.actorUserMongoId,
        uuidv7(),
        context.correlationId,
        JSON.stringify({
          schemaVersion: ONBOARDING_FUNNEL_REPORT_SCHEMA_VERSION,
          from: filters.from,
          to: filters.to,
        }),
      ],
    );

    const milestone = (
      within: unknown,
      any: number,
      p50: unknown,
      p90: unknown,
    ): OnboardingMilestone => ({
      withinWindow: protectedCount(count(within)),
      withinWindowRate: rate(count(within), matured),
      reachedEver: protectedCount(any),
      p50Hours: protectedHours(any, p50),
      p90Hours: protectedHours(any, p90),
    });

    return {
      schemaVersion: ONBOARDING_FUNNEL_REPORT_SCHEMA_VERSION,
      generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
      window: { from: filters.from, to: filters.to, days: filters.days },
      activationWindowDays: ONBOARDING_ACTIVATION_WINDOW_DAYS,
      privacy: {
        minimumSampleSize: ONBOARDING_FUNNEL_MINIMUM_SAMPLE,
        sampleProtected: live < ONBOARDING_FUNNEL_MINIMUM_SAMPLE,
        conversationsIncluded: false,
        directIdentifiersIncluded: false,
      },
      accounts: {
        started: protectedCount(live),
        matured: protectedCount(matured),
        notYetMatured: protectedCount(live - matured),
        legacyExcluded: legacy,
      },
      firstMessage: milestone(
        raw?.message_within,
        messageAny,
        raw?.p50_message_hours,
        raw?.p90_message_hours,
      ),
      firstDraft: milestone(
        raw?.draft_within,
        draftAny,
        raw?.p50_draft_hours,
        raw?.p90_draft_hours,
      ),
      definitions: {
        accountStart:
          "When the account first signed in to this organization (its tenant record's creation time). Accounts whose activity predates that record were backfilled later and are excluded.",
        firstMessage:
          "The first message the planner sent in any proposal assistant conversation, including one that only attached a file.",
        firstDraft:
          "The first successfully completed proposal draft generated for the planner.",
        withinWindow: `Measured only over accounts old enough for the full ${ONBOARDING_ACTIVATION_WINDOW_DAYS}-day window to have passed, so a signup from this week is not counted as a miss.`,
      },
    };
  });
