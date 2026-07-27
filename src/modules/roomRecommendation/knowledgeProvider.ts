/**
 * Approved production knowledge that may influence room recommendations.
 *
 * This is deliberately a provider interface, not a table read: the governed
 * knowledge stores (knowledge_releases and expert_rules) already own approval
 * authority, and this module must not create a competing one. The synthetic
 * provider below is deterministic fixture data marked as such, structured so a
 * production adapter backed by approved releases or expert rules can replace
 * it without touching the engine. Only entries that are approved, inside
 * their effective window and visible to the tenant are ever returned.
 */
export type RoomKnowledgeEntry = {
  id: string;
  title: string;
  applicability: {
    /** Q&A methods (lowercased fragments) this entry speaks to. */
    audienceQaMethodIncludes?: string[];
  };
  guidance: {
    /** Bounded handheld-mic counts by room attendance. Order matters; first band that fits wins. */
    handheldMicBands?: Array<{ maxAttendees: number | null; quantity: number }>;
    note: string;
  };
  exclusions: string[];
  effectiveAt: string;
  expiresAt: string | null;
  approvalStatus: "draft" | "approved" | "retired";
  provenance: string;
  /** null = available to every organization; otherwise a Mongo organization id. */
  organizationScope: string | null;
};

export type RoomKnowledgeProvider = {
  listApproved(input: { organizationMongoId: string; asOf: Date }): Promise<RoomKnowledgeEntry[]>;
};

const SYNTHETIC_ENTRIES: RoomKnowledgeEntry[] = [
  {
    id: "RRK-AUDIO-QA-001",
    title: "Passed-microphone audience Q&A handheld baseline",
    applicability: { audienceQaMethodIncludes: ["passed handheld", "combination"] },
    guidance: {
      handheldMicBands: [
        { maxAttendees: 150, quantity: 2 },
        { maxAttendees: 500, quantity: 3 },
        { maxAttendees: null, quantity: 4 },
      ],
      note: "Baseline counts assume staff runners can reach seated attendees; theater-in-the-round or multi-level rooms need review.",
    },
    exclusions: ["Fixed floor-mic-only rooms", "Digital/app-only Q&A"],
    effectiveAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    approvalStatus: "approved",
    provenance: "synthetic:room-recommendation-fixture.v1",
    organizationScope: null,
  },
  {
    // Present to prove the filter: never approved, must never influence output.
    id: "RRK-DRAFT-999",
    title: "Unapproved draft entry",
    applicability: { audienceQaMethodIncludes: ["passed handheld"] },
    guidance: { handheldMicBands: [{ maxAttendees: null, quantity: 99 }], note: "Draft data." },
    exclusions: [],
    effectiveAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    approvalStatus: "draft",
    provenance: "synthetic:room-recommendation-fixture.v1",
    organizationScope: null,
  },
];

const withinWindow = (entry: RoomKnowledgeEntry, asOf: Date) =>
  new Date(entry.effectiveAt).getTime() <= asOf.getTime() &&
  (entry.expiresAt === null || new Date(entry.expiresAt).getTime() > asOf.getTime());

export const filterEligibleKnowledge = (entries: RoomKnowledgeEntry[], input: { organizationMongoId: string; asOf: Date }): RoomKnowledgeEntry[] =>
  entries.filter((entry) =>
    entry.approvalStatus === "approved" &&
    withinWindow(entry, input.asOf) &&
    (entry.organizationScope === null || entry.organizationScope === input.organizationMongoId));

export const syntheticRoomKnowledgeProvider: RoomKnowledgeProvider = {
  async listApproved(input) {
    return filterEligibleKnowledge(SYNTHETIC_ENTRIES, input);
  },
};
