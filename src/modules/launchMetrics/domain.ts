// ORG-505: the PRD's launch success metrics for Organization Accounts
// (docs/specs/ORGANIZATION_ACCOUNTS_PRD.md, "Success Metrics"). Everything here is a count, a
// rate or a duration across all customer organizations: no names, emails, ids or RFP content.

export const INVITE_ACCEPTANCE_DAYS = 7;
export const FIRST_RFP_TARGET_SECONDS = 5 * 60;
export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
// The audit event is written a moment after the grant check, so a use right at expiry still counts.
const GRANT_CLOCK_TOLERANCE_MS = 5_000;

export const LAUNCH_METRIC_TARGETS = {
  inviteAcceptanceRate: 0.6,
  medianSecondsToFirstRfpOpened: FIRST_RFP_TARGET_SECONDS,
  organizationsWithTwoOrMoreActiveUsersRate: 0.25,
  supportAccessUnderGrantRate: 1,
  orphanedRfps: 0,
} as const;

export class LaunchMetricsError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "LaunchMetricsError";
  }
}

export type InvitationTiming = { createdAt: Date; acceptedAt: Date | null };
export type AcceptanceTiming = { acceptedAt: Date; firstRfpOpenedAt: Date | null };
export type SupportRead = { at: Date; grant: { createdAt: Date; expiresAt: Date; revokedAt: Date | null } | null };

// Platform-scope reads. Each returns only the dates or counts the metric needs.
export type LaunchMetricsSource = {
  /** Invitations created between the two instants. */
  invitations(since: Date, until: Date): Promise<InvitationTiming[]>;
  /** Invitations accepted in the window, with when that member first opened an RFP in the organization. */
  acceptances(since: Date, until: Date): Promise<AcceptanceTiming[]>;
  /** Active customer-role members per active customer organization (one number per organization). */
  activeMemberCounts(): Promise<number[]>;
  /** RFPilot Support reads of customer RFP data in the window, each with the grant its audit event names. */
  supportReads(since: Date, until: Date): Promise<SupportRead[]>;
  /** Support attempts refused for want of a grant in the window (no data was returned). */
  supportRefusals(since: Date, until: Date): Promise<number>;
  orphanedRfps(): Promise<{ total: number; organizations: number }>;
  /** When first-RFP-opened tracking began: the earliest stamp on any membership (null: none yet). */
  firstOpenTrackingSince(): Promise<Date | null>;
};

const rate = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000);

export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const parseWindowDays = (value: unknown): number => {
  if (value === undefined || value === null || value === "") return DEFAULT_WINDOW_DAYS;
  const text = String(value).trim();
  const days = Number(text);
  if (!/^\d{1,3}$/.test(text) || days < 1 || days > MAX_WINDOW_DAYS) {
    throw new LaunchMetricsError("INVALID_WINDOW", `days must be a whole number from 1 to ${MAX_WINDOW_DAYS}.`, 400);
  }
  return days;
};

// "Invite acceptance within 7 days". An invitation counts once it is at least 7 days old, so a
// fresh invitation can't drag the rate down; a revoked or expired one stays in the denominator.
// The report asks for invitations created in the window that ended 7 days ago, so all of them count.
export const inviteAcceptance = (invitations: readonly InvitationTiming[], now: Date) => {
  const limit = INVITE_ACCEPTANCE_DAYS * DAY_MS;
  const matured = invitations.filter((invitation) => now.getTime() - invitation.createdAt.getTime() >= limit);
  const within = matured.filter((invitation) => invitation.acceptedAt && invitation.acceptedAt.getTime() - invitation.createdAt.getTime() <= limit);
  return {
    sent: invitations.length,
    atLeast7DaysOld: matured.length,
    acceptedWithin7Days: within.length,
    acceptedLater: matured.filter((invitation) => invitation.acceptedAt).length - within.length,
    rate: rate(within.length, matured.length),
    target: LAUNCH_METRIC_TARGETS.inviteAcceptanceRate,
  };
};

// "Invitee time from accept to first RFP opened". A first open that predates the acceptance
// belongs to an earlier membership of someone who rejoined, so it is left out, not counted as 0.
// Someone who accepted before opens were tracked may have opened RFPs unrecorded, so their first
// recorded open says nothing about how long they took: they are left out too.
export const timeToFirstRfpOpened = (acceptances: readonly AcceptanceTiming[], trackingSince: Date | null = null) => {
  const seconds: number[] = [];
  let notYetOpened = 0;
  let openedBeforeAccepting = 0;
  let acceptedBeforeTracking = 0;
  for (const { acceptedAt, firstRfpOpenedAt } of acceptances) {
    if (trackingSince && acceptedAt.getTime() < trackingSince.getTime()) acceptedBeforeTracking++;
    else if (!firstRfpOpenedAt) notYetOpened++;
    else if (firstRfpOpenedAt.getTime() < acceptedAt.getTime()) openedBeforeAccepting++;
    else seconds.push(Math.round((firstRfpOpenedAt.getTime() - acceptedAt.getTime()) / 1000));
  }
  return {
    accepted: acceptances.length,
    opened: seconds.length,
    notYetOpened,
    excludedOpenedBeforeAccepting: openedBeforeAccepting,
    excludedAcceptedBeforeTracking: acceptedBeforeTracking,
    medianSeconds: median(seconds),
    openedWithin5Minutes: seconds.filter((value) => value <= FIRST_RFP_TARGET_SECONDS).length,
    targetMedianSeconds: LAUNCH_METRIC_TARGETS.medianSecondsToFirstRfpOpened,
  };
};

// "Orgs with 2+ active users", over organizations that have at least one active member.
export const organizationsWithTwoOrMore = (memberCounts: readonly number[]) => {
  const populated = memberCounts.filter((count) => count >= 1);
  const two = populated.filter((count) => count >= 2).length;
  return {
    organizations: populated.length,
    withTwoOrMoreActiveUsers: two,
    rate: rate(two, populated.length),
    target: LAUNCH_METRIC_TARGETS.organizationsWithTwoOrMoreActiveUsersRate,
  };
};

export const isUnderActiveGrant = ({ at, grant }: SupportRead) =>
  grant !== null &&
  grant.createdAt.getTime() <= at.getTime() + GRANT_CLOCK_TOLERANCE_MS &&
  at.getTime() <= grant.expiresAt.getTime() + GRANT_CLOCK_TOLERANCE_MS &&
  (grant.revokedAt === null || at.getTime() <= grant.revokedAt.getTime() + GRANT_CLOCK_TOLERANCE_MS);

// "Support data access under active grant". Each read's audit event is checked against the grant
// it names: that grant must exist in the same organization, cover what was read, and have been
// active at that moment. `reads` counts audit events (one per grant used), not HTTP requests.
export const supportAccessUnderGrant = (reads: readonly SupportRead[], refusedWithoutGrant: number) => {
  const under = reads.filter(isUnderActiveGrant).length;
  return {
    reads: reads.length,
    underActiveGrant: under,
    withoutActiveGrant: reads.length - under,
    refusedWithoutGrant,
    rate: rate(under, reads.length),
    target: LAUNCH_METRIC_TARGETS.supportAccessUnderGrantRate,
  };
};

export const launchMetricsReport = async (source: LaunchMetricsSource, input: { days?: number; now?: Date } = {}) => {
  const now = input.now ?? new Date();
  const days = input.days ?? DEFAULT_WINDOW_DAYS;
  const since = new Date(now.getTime() - days * DAY_MS);
  const maturity = INVITE_ACCEPTANCE_DAYS * DAY_MS;
  const [invitations, acceptances, memberCounts, reads, refusals, orphans, trackingSince] = await Promise.all([
    // Shifted back 7 days so every invitation in the cohort has had its 7 days.
    source.invitations(new Date(since.getTime() - maturity), new Date(now.getTime() - maturity)),
    source.acceptances(since, now),
    source.activeMemberCounts(),
    source.supportReads(since, now),
    source.supportRefusals(since, now),
    source.orphanedRfps(),
    source.firstOpenTrackingSince(),
  ]);
  return {
    generatedAt: now.toISOString(),
    window: { days, since: since.toISOString(), until: now.toISOString() },
    // Over the window.
    inviteAcceptance: inviteAcceptance(invitations, now),
    timeToFirstRfpOpened: timeToFirstRfpOpened(acceptances, trackingSince),
    supportAccessUnderGrant: supportAccessUnderGrant(reads, refusals),
    // As of now.
    organizationsWithTwoOrMoreActiveUsers: organizationsWithTwoOrMore(memberCounts),
    orphanedRfps: { total: orphans.total, organizations: orphans.organizations, target: LAUNCH_METRIC_TARGETS.orphanedRfps },
  };
};

export type LaunchMetricsReport = Awaited<ReturnType<typeof launchMetricsReport>>;
