import {
  asNumber,
  filled,
  isYes,
  text,
  type UnknownRecord,
} from "../investment/proposalAccess";
import type {
  ScopeEvidence,
  ScopeRuleSeverity,
} from "./scopeRules";

export const ROOM_SCHEDULE_ANALYSIS_VERSION = "room-schedule-analysis.v1";
export const ROOM_RELOCATION_MINUTES = 90;

export const ROOM_SCHEDULE_CATEGORIES = [
  "room_gap",
  "schedule_conflict",
  "crew_conflict",
  "reuse_opportunity",
  "duplicate_rental",
  "missing_input",
] as const;

export type RoomScheduleCategory =
  (typeof ROOM_SCHEDULE_CATEGORIES)[number];

export type RoomScheduleFinding = {
  id: string;
  code: string;
  category: RoomScheduleCategory;
  severity: ScopeRuleSeverity;
  confidence: "high" | "medium" | "low";
  roomKeys: string[];
  paths: string[];
  evidence: ScopeEvidence[];
  explanation: string;
  suggestedNextAction: string;
  question?: string;
  reusableResourceKeys?: string[];
  duplicateRentalReview?: boolean;
  source: "approved_room_schedule_rule";
  ruleVersion: typeof ROOM_SCHEDULE_ANALYSIS_VERSION;
};

export type RoomScheduleSubtotal = {
  roomKey: string;
  roomLabel: string;
  status: "pricing_not_evaluated";
  amountMinor: null;
  currency: null;
  reason: string;
};

export type RoomScheduleAnalysis = {
  version: typeof ROOM_SCHEDULE_ANALYSIS_VERSION;
  roomCount: number;
  rooms: Array<{
    roomKey: string;
    roomLabel: string;
    showStartAt: string | null;
    showEndAt: string | null;
    findingCount: number;
    confidence: "high" | "medium" | "low";
  }>;
  findings: RoomScheduleFinding[];
  roomLevelGapIds: string[];
  scheduleConflictIds: string[];
  crewConflictIds: string[];
  reusableEquipmentOpportunityIds: string[];
  duplicateRentalIds: string[];
  missingInputIds: string[];
  roomSubtotals: RoomScheduleSubtotal[];
  sharedServicesSubtotal: {
    status: "pricing_not_evaluated";
    amountMinor: null;
    currency: null;
    reason: string;
  };
  confidence: "high" | "medium" | "low";
};

type RoomContext = {
  room: UnknownRecord;
  index: number;
  key: string;
  label: string;
  start: Date | null;
  end: Date | null;
  startRaw: string | null;
  endRaw: string | null;
  crew: Map<string, number>;
  resources: Map<string, number>;
};

const record = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
const records = (value: unknown): UnknownRecord[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is UnknownRecord =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
const count = (value: unknown): number =>
  Math.max(0, Math.floor(asNumber(value) ?? 0));
const pathFor = (index: number, suffix: string): string =>
  `/content/roomByRoom/${index}/${suffix}`;
const boundedLabel = (value: unknown, fallback: string): string => {
  const normalized = text(value);
  return normalized ? normalized.slice(0, 80) : fallback;
};
const parseInstant = (value: unknown): Date | null => {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const safeValue = (value: unknown): string | undefined => {
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  const normalized = text(value);
  return normalized && normalized.length <= 80 ? normalized : undefined;
};
const evidence = (
  path: string,
  value: unknown,
  state?: ScopeEvidence["state"],
): ScopeEvidence => ({
  path,
  state: state ?? (filled(value) ? "present" : "missing"),
  ...(safeValue(value) === undefined ? {} : { value: safeValue(value) }),
});
const normalizedRole = (value: string): string =>
  value.trim().replace(/\s+/g, " ").toLocaleUpperCase("en-US");

const crewRequirements = (room: UnknownRecord): Map<string, number> => {
  const quantities = record(room.showCrewQty);
  const requested = Array.isArray(room.showCrewNeeded)
    ? room.showCrewNeeded
        .filter((value): value is string => typeof value === "string")
        .map(normalizedRole)
        .filter(Boolean)
    : [];
  const output = new Map<string, number>();
  for (const role of requested) {
    const matchingQuantity = Object.entries(quantities).find(
      ([key]) => normalizedRole(key) === role,
    )?.[1];
    output.set(role, Math.max(1, count(matchingQuantity)));
  }
  for (const [role, quantity] of Object.entries(quantities)) {
    const normalized = normalizedRole(role);
    const normalizedQuantity = count(quantity);
    if (normalized && normalizedQuantity > 0)
      output.set(normalized, normalizedQuantity);
  }
  return output;
};

const resourceRequirements = (room: UnknownRecord): Map<string, number> => {
  const output = new Map<string, number>();
  const add = (key: string, required: unknown, quantity: unknown, fallback = 1) => {
    if (!isYes(required)) return;
    output.set(key, Math.max(fallback, count(quantity)));
  };
  const podium = record(room.podiumMic);
  const wireless = record(room.wirelessMics);
  const displays = record(room.largeMonitorsOrScreenProjector);
  const laptops = record(room.presentationLaptops);
  const playback = record(room.videoPlayback);
  const cameras = record(room.cameras);
  const programMonitor = record(room.programConfidenceMonitor);
  const notesMonitor = record(room.notesConfidenceMonitor);
  const lighting = record(room.stageWashLighting);

  add("podium_microphone", podium.podiumMic, podium.podiumMicQty);
  add("wireless_microphone", wireless.wirelessMics, wireless.wirelessMicsQty);
  add(
    "display_monitor",
    displays.largeMonitorsOrScreenProjector,
    displays.numberOfMonitors,
    0,
  );
  add(
    "projection_screen",
    displays.largeMonitorsOrScreenProjector,
    displays.numberOfScreens,
    0,
  );
  add("led_wall", room.ledWall, 1);
  add(
    "presentation_laptop",
    laptops.presentationLaptops,
    laptops.presentationLaptopQty,
  );
  add("playback_system", playback.videoPlayback, playback.videoPlaybackCount);
  add("camera", cameras.cameras, cameras.camerasQty);
  add(
    "program_confidence_monitor",
    programMonitor.programConfidenceMonitor,
    programMonitor.programConfidenceMonitorQty,
  );
  add(
    "notes_confidence_monitor",
    notesMonitor.notesConfidenceMonitor,
    notesMonitor.notesConfidenceMonitorQty,
  );
  add("teleprompter", room.teleprompterRequired ?? room.teleprompterNeeded, 1);
  add("stage_wash_lighting", lighting.stageWashLighting, 1);
  return new Map([...output].filter(([, quantity]) => quantity > 0));
};

const overlaps = (left: RoomContext, right: RoomContext): boolean =>
  Boolean(
    left.start &&
      left.end &&
      right.start &&
      right.end &&
      left.start < right.end &&
      right.start < left.end,
  );
const relocationGapMinutes = (
  left: RoomContext,
  right: RoomContext,
): number | null => {
  if (!left.start || !left.end || !right.start || !right.end) return null;
  const earlierEnd = left.end <= right.start
    ? left.end
    : right.end <= left.start
      ? right.end
      : null;
  const laterStart = left.end <= right.start
    ? right.start
    : right.end <= left.start
      ? left.start
      : null;
  return earlierEnd && laterStart
    ? Math.floor((laterStart.getTime() - earlierEnd.getTime()) / 60_000)
    : null;
};
const sharedKeys = <T>(left: Map<string, T>, right: Map<string, T>): string[] =>
  [...left.keys()].filter((key) => right.has(key)).sort();
const findingId = (
  code: string,
  roomKeys: readonly string[],
  suffix = "",
): string =>
  `${ROOM_SCHEDULE_ANALYSIS_VERSION}:${code.toLocaleLowerCase("en-US")}:${roomKeys.join("+") || "proposal"}${suffix ? `:${suffix}` : ""}`;

const buildRoomContexts = (proposal: UnknownRecord): RoomContext[] =>
  records(proposal.roomByRoom).map((room, index) => {
    const key = boundedLabel(room._id, `room-${index + 1}`);
    const label = boundedLabel(room.roomFunction, `Room ${index + 1}`);
    const startRaw = text(room.showStartDateTime) || null;
    const endRaw = text(room.showEndDateTime) || null;
    return {
      room,
      index,
      key,
      label,
      start: parseInstant(startRaw),
      end: parseInstant(endRaw),
      startRaw,
      endRaw,
      crew: crewRequirements(room),
      resources: resourceRequirements(room),
    };
  });

export const computeRoomScheduleAnalysis = (
  proposal: UnknownRecord,
): RoomScheduleAnalysis => {
  const rooms = buildRoomContexts(proposal);
  const findings: RoomScheduleFinding[] = [];
  const add = (
    input: Omit<
      RoomScheduleFinding,
      "id" | "source" | "ruleVersion"
    > & { idSuffix?: string },
  ) => {
    const { idSuffix, ...finding } = input;
    findings.push({
      ...finding,
      id: findingId(finding.code, finding.roomKeys, idSuffix),
      source: "approved_room_schedule_rule",
      ruleVersion: ROOM_SCHEDULE_ANALYSIS_VERSION,
    });
  };

  for (const context of rooms) {
    const { room, index, key, label, start, end, startRaw, endRaw } = context;
    const missingBasics = [
      [pathFor(index, "roomFunction"), room.roomFunction],
      [pathFor(index, "roomSetup"), room.roomSetup],
      [pathFor(index, "estimatedAttendeesInRoom"), room.estimatedAttendeesInRoom],
    ] as const;
    const missing = missingBasics.filter(([, value]) => !filled(value));
    if (missing.length) {
      add({
        code: "ROOM_PLANNING_INPUTS_MISSING",
        category: "room_gap",
        severity: "high_confidence_gap",
        confidence: "high",
        roomKeys: [key],
        paths: missing.map(([path]) => path),
        evidence: missing.map(([path, value]) => evidence(path, value)),
        explanation: `${label} is missing ${missing.map(([path]) => path.split("/").pop()).join(", ")} needed to size room production.`,
        suggestedNextAction:
          "Add the room function, layout, and room attendance before finalizing equipment or crew.",
        question:
          "What is this room used for, how is it laid out, and how many attendees will it hold?",
      });
    }

    const schedulePaths = [
      pathFor(index, "showStartDateTime"),
      pathFor(index, "showEndDateTime"),
    ];
    if (!start || !end) {
      add({
        code: "ROOM_SHOW_WINDOW_MISSING",
        category: "missing_input",
        severity: "high_confidence_gap",
        confidence: "high",
        roomKeys: [key],
        paths: schedulePaths,
        evidence: [
          evidence(schedulePaths[0], startRaw),
          evidence(schedulePaths[1], endRaw),
        ],
        explanation: `${label} does not have a complete show start and end window, so simultaneous rooms and resource reuse cannot be evaluated.`,
        suggestedNextAction:
          "Add the room show start and end date-times.",
        question: "When does this room's show activity start and end?",
      });
    } else if (start >= end) {
      add({
        code: "ROOM_SHOW_WINDOW_REVERSED",
        category: "schedule_conflict",
        severity: "blocking",
        confidence: "high",
        roomKeys: [key],
        paths: schedulePaths,
        evidence: [
          evidence(schedulePaths[0], startRaw, "conflicting"),
          evidence(schedulePaths[1], endRaw, "conflicting"),
        ],
        explanation: `${label} ends before or at its start time.`,
        suggestedNextAction:
          "Correct the room show window before planning labor or shared equipment.",
      });
    }

    const loadInRaw = text(room.loadInDateTime);
    const rehearsalRaw = text(room.rehearsalDateTime);
    const loadIn = parseInstant(loadInRaw);
    const rehearsal = parseInstant(rehearsalRaw);
    if (loadIn && start && loadIn >= start) {
      const paths = [
        pathFor(index, "loadInDateTime"),
        pathFor(index, "showStartDateTime"),
      ];
      add({
        code: "ROOM_LOAD_IN_AFTER_SHOW_START",
        category: "schedule_conflict",
        severity: "blocking",
        confidence: "high",
        roomKeys: [key],
        paths,
        evidence: [
          evidence(paths[0], loadInRaw, "conflicting"),
          evidence(paths[1], startRaw, "conflicting"),
        ],
        explanation: `${label} load-in is scheduled at or after show start.`,
        suggestedNextAction:
          "Move load-in early enough for setup, testing, and venue access.",
      });
    }
    if (rehearsal && start && rehearsal >= start) {
      const paths = [
        pathFor(index, "rehearsalDateTime"),
        pathFor(index, "showStartDateTime"),
      ];
      add({
        code: "ROOM_REHEARSAL_AFTER_SHOW_START",
        category: "schedule_conflict",
        severity: "blocking",
        confidence: "high",
        roomKeys: [key],
        paths,
        evidence: [
          evidence(paths[0], rehearsalRaw, "conflicting"),
          evidence(paths[1], startRaw, "conflicting"),
        ],
        explanation: `${label} rehearsal is scheduled at or after show start.`,
        suggestedNextAction:
          "Move rehearsal before the show and retain setup/testing time.",
      });
    }
  }

  for (let leftIndex = 0; leftIndex < rooms.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < rooms.length;
      rightIndex += 1
    ) {
      const left = rooms[leftIndex];
      const right = rooms[rightIndex];
      const roomKeys = [left.key, right.key];
      const commonCrew = sharedKeys(left.crew, right.crew);
      const commonResources = sharedKeys(left.resources, right.resources);

      if (overlaps(left, right)) {
        if (commonCrew.length) {
          add({
            code: "SIMULTANEOUS_CREW_ROLE_CONFLICT",
            category: "crew_conflict",
            severity: "high_confidence_gap",
            confidence: "high",
            roomKeys,
            paths: [
              pathFor(left.index, "showCrewNeeded"),
              pathFor(right.index, "showCrewNeeded"),
            ],
            evidence: [
              evidence(pathFor(left.index, "showStartDateTime"), left.startRaw),
              evidence(pathFor(right.index, "showStartDateTime"), right.startRaw),
            ],
            explanation: `${left.label} and ${right.label} overlap and both require ${commonCrew.join(", ")}. One person cannot cover both rooms at the same time.`,
            suggestedNextAction:
              "Confirm distinct crew assignments and aggregate simultaneous role quantities.",
            question: "Are separate crew members assigned to every overlapping room?",
            idSuffix: commonCrew.join("+").toLocaleLowerCase("en-US"),
          });
        }
        if (commonResources.length) {
          add({
            code: "SIMULTANEOUS_RESOURCE_CAPACITY_REVIEW",
            category: "schedule_conflict",
            severity: "review_recommended",
            confidence: "high",
            roomKeys,
            paths: [
              pathFor(left.index, "showStartDateTime"),
              pathFor(right.index, "showStartDateTime"),
            ],
            evidence: [
              evidence(pathFor(left.index, "showStartDateTime"), left.startRaw),
              evidence(pathFor(right.index, "showStartDateTime"), right.startRaw),
            ],
            explanation: `${left.label} and ${right.label} overlap and both request ${commonResources.join(", ")}. Shared physical inventory cannot cover both rooms simultaneously.`,
            suggestedNextAction:
              "Aggregate simultaneous quantities and confirm separate inventory for both rooms.",
            question: "Does the planned inventory cover both rooms at their overlapping peak?",
            reusableResourceKeys: commonResources,
            idSuffix: commonResources.join("+"),
          });
        }
        continue;
      }

      const gap = relocationGapMinutes(left, right);
      if (
        commonResources.length &&
        gap !== null &&
        gap >= ROOM_RELOCATION_MINUTES
      ) {
        add({
          code: "NON_OVERLAPPING_RESOURCE_REUSE_OPPORTUNITY",
          category: "reuse_opportunity",
          severity: "optional_optimization",
          confidence: "medium",
          roomKeys,
          paths: [
            pathFor(left.index, "showStartDateTime"),
            pathFor(left.index, "showEndDateTime"),
            pathFor(right.index, "showStartDateTime"),
            pathFor(right.index, "showEndDateTime"),
          ],
          evidence: [
            evidence(pathFor(left.index, "showEndDateTime"), left.endRaw),
            evidence(pathFor(right.index, "showStartDateTime"), right.startRaw),
          ],
          explanation: `${left.label} and ${right.label} do not overlap and share ${commonResources.join(", ")} requirements. The ${gap}-minute gap may allow reuse, but transport, reset, testing, and venue constraints are not confirmed.`,
          suggestedNextAction:
            "Ask vendors to price dedicated inventory and a validated shared-inventory option separately.",
          question:
            "Is there enough transport, reset, and testing time to move this equipment safely?",
          reusableResourceKeys: commonResources,
          duplicateRentalReview: true,
          idSuffix: commonResources.join("+"),
        });
      }
    }
  }

  const idsFor = (categories: RoomScheduleCategory[]): string[] =>
    findings
      .filter((finding) => categories.includes(finding.category))
      .map((finding) => finding.id);
  const roomSummaries = rooms.map((room) => {
    const roomFindings = findings.filter((finding) =>
      finding.roomKeys.includes(room.key),
    );
    return {
      roomKey: room.key,
      roomLabel: room.label,
      showStartAt: room.startRaw,
      showEndAt: room.endRaw,
      findingCount: roomFindings.length,
      confidence:
        room.start && room.end
          ? ("high" as const)
          : ("low" as const),
    };
  });
  const confidence =
    rooms.length === 0 ||
    rooms.some((room) => !room.start || !room.end)
      ? "low"
      : findings.some((finding) => finding.confidence === "medium")
        ? "medium"
        : "high";

  return {
    version: ROOM_SCHEDULE_ANALYSIS_VERSION,
    roomCount: rooms.length,
    rooms: roomSummaries,
    findings,
    roomLevelGapIds: idsFor(["room_gap"]),
    scheduleConflictIds: idsFor(["schedule_conflict"]),
    crewConflictIds: idsFor(["crew_conflict"]),
    reusableEquipmentOpportunityIds: idsFor(["reuse_opportunity"]),
    duplicateRentalIds: findings
      .filter((finding) => finding.duplicateRentalReview)
      .map((finding) => finding.id),
    missingInputIds: idsFor(["missing_input"]),
    roomSubtotals: rooms.map((room) => ({
      roomKey: room.key,
      roomLabel: room.label,
      status: "pricing_not_evaluated",
      amountMinor: null,
      currency: null,
      reason:
        "Room scope is analyzed here; authoritative pricing is calculated separately.",
    })),
    sharedServicesSubtotal: {
      status: "pricing_not_evaluated",
      amountMinor: null,
      currency: null,
      reason:
        "Shared services require approved pricing and validated reuse decisions.",
    },
    confidence,
  };
};
