import {
  asNumber,
  filled,
  isNo,
  isYes,
  readFacts,
  text,
  type UnknownRecord,
} from "../investment/proposalAccess";

export const SCOPE_RULESET_VERSION = "scope-guidance.v1";

export const SCOPE_RULE_CATEGORIES = [
  "missing_dependency",
  "quantity_mismatch",
  "possible_duplication",
  "needs_confirmation",
] as const;

export const SCOPE_RULE_SEVERITIES = [
  "blocking",
  "high_confidence_gap",
  "review_recommended",
  "optional_optimization",
  "needs_venue_confirmation",
  "insufficient_information",
] as const;

export type ScopeRuleCategory = (typeof SCOPE_RULE_CATEGORIES)[number];
export type ScopeRuleSeverity = (typeof SCOPE_RULE_SEVERITIES)[number];

export type ScopeEvidence = {
  path: string;
  state: "missing" | "present" | "conflicting";
  value?: string;
};

export type ScopeFinding = {
  id: string;
  ruleId: string;
  ruleVersion: string;
  category: ScopeRuleCategory;
  severity: ScopeRuleSeverity;
  confidence: "high" | "medium" | "low";
  paths: string[];
  evidence: ScopeEvidence[];
  explanation: string;
  suggestedNextAction: string;
  question?: string;
  source: "approved_scope_rule";
};

type ScopeContext = {
  proposal: UnknownRecord;
  rooms: UnknownRecord[];
};

type FindingInput = Omit<
  ScopeFinding,
  "id" | "ruleId" | "ruleVersion" | "category" | "source"
> & {
  scopeKey?: string;
};

export type ScopeRule = {
  id: string;
  version: typeof SCOPE_RULESET_VERSION;
  category: ScopeRuleCategory;
  defaultSeverity: ScopeRuleSeverity;
  applicability: readonly string[];
  requiredInputs: readonly string[];
  affectedFields: readonly string[];
  source: string;
  evaluate(context: ScopeContext): FindingInput[];
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
const shortValue = (value: unknown): string | undefined => {
  if (typeof value === "boolean" || typeof value === "number")
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
  ...(shortValue(value) === undefined ? {} : { value: shortValue(value) }),
});
const roomPath = (index: number, suffix: string): string =>
  `/content/roomByRoom/${index}/${suffix}`;
const roomLabel = (room: UnknownRecord, index: number): string =>
  text(room.roomFunction) || `Room ${index + 1}`;
const anyRoomProductionScope = (room: UnknownRecord): boolean => {
  const display = record(room.largeMonitorsOrScreenProjector);
  const playback = record(room.videoPlayback);
  const cameras = record(room.cameras);
  return (
    isYes(display.largeMonitorsOrScreenProjector) ||
    isYes(room.ledWall) ||
    isYes(playback.videoPlayback) ||
    isYes(cameras.cameras) ||
    isYes(record(room.stageWashLighting).stageWashLighting)
  );
};

const rule = (
  definition: Omit<ScopeRule, "version">,
): ScopeRule => ({ ...definition, version: SCOPE_RULESET_VERSION });

export const SCOPE_RULES: readonly ScopeRule[] = Object.freeze([
  rule({
    id: "DISPLAY_SURFACE_QUANTITY_MISSING",
    category: "missing_dependency",
    defaultSeverity: "high_confidence_gap",
    applicability: ["A room requests a display/projector surface."],
    requiredInputs: ["monitor count or screen count"],
    affectedFields: [
      "/content/rooms/*/video/monitorCount",
      "/content/rooms/*/video/screenCount",
    ],
    source: "RFPilot room video dependency policy",
    evaluate: ({ rooms }) =>
      rooms.flatMap((room, index) => {
        const display = record(room.largeMonitorsOrScreenProjector);
        if (
          !isYes(display.largeMonitorsOrScreenProjector) ||
          count(display.numberOfMonitors) + count(display.numberOfScreens) > 0
        )
          return [];
        const paths = [
          roomPath(index, "largeMonitorsOrScreenProjector/numberOfMonitors"),
          roomPath(index, "largeMonitorsOrScreenProjector/numberOfScreens"),
        ];
        return [{
          severity: "high_confidence_gap",
          confidence: "high",
          paths,
          evidence: paths.map((path) => evidence(path, undefined)),
          explanation: `${roomLabel(room, index)} requests a display or projection surface but does not state any monitor or screen quantity.`,
          suggestedNextAction:
            "Add the display surface and quantity, or confirm that the venue will provide it.",
          question: "Which display surface and quantity should vendors provide?",
          scopeKey: String(index),
        }];
      }),
  }),
  rule({
    id: "CAMERA_COUNT_MISSING",
    category: "missing_dependency",
    defaultSeverity: "high_confidence_gap",
    applicability: ["Proposal-level recording is required."],
    requiredInputs: ["camera count"],
    affectedFields: ["/content/videoRecording/cameraCount"],
    source: "RFPilot recording workflow policy",
    evaluate: ({ proposal, rooms }) => {
      const recording = record(proposal.videoRecordingStep);
      const hasRoomPlan = rooms.some((room) => {
        const cameras = record(room.cameras);
        return isYes(cameras.cameras) && (
          text(cameras.cameraPlanMode) === "Vendor Recommendation" || count(cameras.camerasQty) > 0
        );
      });
      if (!isYes(recording.videoRecordingRequired) || hasRoomPlan || count(recording.numberOfCameras) > 0)
        return [];
      const path = "/content/videoRecordingStep/numberOfCameras";
      return [{
        severity: "high_confidence_gap",
        confidence: "high",
        paths: [path],
        evidence: [evidence(path, recording.numberOfCameras)],
        explanation: "Video recording is required but no camera count is specified.",
        suggestedNextAction:
          "Add a planning camera count and confirm positions with the production team.",
        question: "How many camera positions should be included?",
      }];
    },
  }),
  rule({
    id: "CAMERA_OPERATOR_CAPACITY",
    category: "quantity_mismatch",
    defaultSeverity: "high_confidence_gap",
    applicability: ["Proposal-level recording has one or more cameras."],
    requiredInputs: ["camera count", "camera operator count"],
    affectedFields: [
      "/content/videoRecording/cameraCount",
      "/content/videoRecording/cameraOperatorCount",
    ],
    source: "RFPilot recording labor dependency policy",
    evaluate: ({ proposal }) => {
      const recording = record(proposal.videoRecordingStep);
      const cameras = count(recording.numberOfCameras);
      const operators = count(recording.cameraOperators);
      if (!isYes(recording.videoRecordingRequired) || cameras === 0 || operators >= cameras)
        return [];
      const paths = [
        "/content/videoRecordingStep/numberOfCameras",
        "/content/videoRecordingStep/cameraOperators",
      ];
      return [{
        severity: "high_confidence_gap",
        confidence: "high",
        paths,
        evidence: [
          evidence(paths[0], cameras),
          evidence(paths[1], operators, "conflicting"),
        ],
        explanation: `The proposal requests ${cameras} camera(s) but only ${operators} camera operator(s).`,
        suggestedNextAction:
          "Confirm whether any cameras are locked off or increase the operator count.",
        question: "Which cameras require dedicated operators during the show?",
      }];
    },
  }),
  rule({
    id: "RECORDING_DELIVERY_MISSING",
    category: "missing_dependency",
    defaultSeverity: "high_confidence_gap",
    applicability: ["Proposal-level recording is required."],
    requiredInputs: ["storage, handoff, or edited deliverable"],
    affectedFields: [
      "/content/videoRecording/recordingMedia",
      "/content/videoRecording/rawFootageTurnover",
      "/content/videoRecording/editedDeliverable/required",
    ],
    source: "RFPilot recording delivery policy",
    evaluate: ({ proposal }) => {
      const recording = record(proposal.videoRecordingStep);
      const edited = record(recording.editedDeliverable);
      if (
        !isYes(recording.videoRecordingRequired) ||
        filled(recording.recordingMedia) ||
        filled(recording.rawFootageTurnover) ||
        filled(edited.needed) ||
        (Array.isArray(recording.deliveryMethod) &&
          recording.deliveryMethod.length > 0)
      )
        return [];
      const paths = [
        "/content/videoRecordingStep/recordingMedia",
        "/content/videoRecordingStep/rawFootageTurnover",
        "/content/videoRecordingStep/editedDeliverable/needed",
      ];
      return [{
        severity: "high_confidence_gap",
        confidence: "high",
        paths,
        evidence: paths.map((path) => evidence(path, undefined)),
        explanation:
          "Recording is requested but storage, handoff, and edited-deliverable requirements are not defined.",
        suggestedNextAction:
          "Specify recording media, raw-footage handoff, deliverable formats, and turnaround.",
        question: "What files must be delivered, by which method, and when?",
      }];
    },
  }),
  rule({
    id: "STREAMING_CONNECTIVITY_UNDEFINED",
    category: "missing_dependency",
    defaultSeverity: "high_confidence_gap",
    applicability: ["The event is hybrid/virtual or includes streaming."],
    requiredInputs: ["venue internet requirement", "internet use cases"],
    affectedFields: [
      "/content/venueTechnical/wirelessInternetRequired",
      "/content/venueTechnical/internetUseCases",
    ],
    source: "RFPilot hybrid connectivity policy",
    evaluate: ({ proposal }) => {
      const facts = readFacts(proposal);
      const venue = record(proposal.venue);
      if (
        !facts.hybridRequested ||
        isYes(venue.wirelessInternetRequired) ||
        records(venue.internetUseCases).length > 0 ||
        (Array.isArray(venue.internetUseCases) && venue.internetUseCases.length > 0)
      )
        return [];
      const paths = [
        "/content/venue/wirelessInternetRequired",
        "/content/venue/internetUseCases",
      ];
      return [{
        severity: "high_confidence_gap",
        confidence: "high",
        paths,
        evidence: [
          evidence(paths[0], venue.wirelessInternetRequired),
          evidence(paths[1], venue.internetUseCases),
        ],
        explanation:
          "Hybrid or streaming scope is present, but the proposal does not document an internet or uplink plan.",
        suggestedNextAction:
          "Document wired/managed connectivity, stream destinations, resolution, redundancy, and venue ownership.",
        question: "What bandwidth, redundancy, resolution, and destinations must the venue support?",
      }];
    },
  }),
  rule({
    id: "HYBRID_PRODUCTION_OWNER_MISSING",
    category: "missing_dependency",
    defaultSeverity: "high_confidence_gap",
    applicability: ["The event is hybrid/virtual."],
    requiredInputs: ["stream owner or dedicated virtual producer"],
    affectedFields: [
      "/content/hybridVirtual/streamOwner",
      "/content/hybridVirtual/dedicatedVirtualProducer",
    ],
    source: "RFPilot hybrid production ownership policy",
    evaluate: ({ proposal }) => {
      const facts = readFacts(proposal);
      const hybrid = record(proposal.hybridVirtual);
      if (
        !facts.hybridRequested ||
        filled(hybrid.streamOwnership) ||
        isYes(hybrid.dedicatedVirtualProducer)
      )
        return [];
      const paths = [
        "/content/hybridVirtual/streamOwnership",
        "/content/hybridVirtual/dedicatedVirtualProducer",
      ];
      return [{
        severity: "high_confidence_gap",
        confidence: "high",
        paths,
        evidence: paths.map((path) => evidence(path, undefined)),
        explanation:
          "Hybrid production is requested, but stream ownership and virtual-producer responsibility are not assigned.",
        suggestedNextAction:
          "Assign the streaming platform owner and the person responsible for the virtual show.",
        question: "Who owns the virtual platform and live virtual production?",
      }];
    },
  }),
  rule({
    id: "AUDIENCE_QA_METHOD_MISSING",
    category: "missing_dependency",
    defaultSeverity: "high_confidence_gap",
    applicability: ["A room requests audience Q&A."],
    requiredInputs: ["Q&A microphone method"],
    affectedFields: ["/content/rooms/*/video/audienceQaMethod"],
    source: "RFPilot audience Q&A audio policy",
    evaluate: ({ rooms }) =>
      rooms.flatMap((room, index) => {
        const qa = record(room.audienceQa);
        if (!isYes(qa.audienceQa) || filled(qa.audienceQaMethod)) return [];
        const path = roomPath(index, "audienceQa/audienceQaMethod");
        return [{
          severity: "high_confidence_gap",
          confidence: "high",
          paths: [path],
          evidence: [evidence(path, qa.audienceQaMethod)],
          explanation: `${roomLabel(room, index)} includes audience Q&A but does not specify how questions will reach presenters.`,
          suggestedNextAction:
            "Choose roaming wireless microphones, aisle stands, a moderator, or an approved digital Q&A method.",
          question: "How should audience questions reach the stage?",
          scopeKey: String(index),
        }];
      }),
  }),
  rule({
    id: "PLAYBACK_CONTROL_MISSING",
    category: "missing_dependency",
    defaultSeverity: "high_confidence_gap",
    applicability: ["A room requests video playback."],
    requiredInputs: ["playback count", "playback format"],
    affectedFields: [
      "/content/rooms/*/video/videoPlaybackCount",
      "/content/rooms/*/video/videoPlaybackFormat",
    ],
    source: "RFPilot playback workflow policy",
    evaluate: ({ rooms }) =>
      rooms.flatMap((room, index) => {
        const playback = record(room.videoPlayback);
        if (
          !isYes(playback.videoPlayback) ||
          (count(playback.videoPlaybackCount) > 0 &&
            filled(playback.videoPlaybackFormat))
        )
          return [];
        const paths = [
          roomPath(index, "videoPlayback/videoPlaybackCount"),
          roomPath(index, "videoPlayback/videoPlaybackFormat"),
        ];
        return [{
          severity: "high_confidence_gap",
          confidence: "high",
          paths,
          evidence: [
            evidence(paths[0], playback.videoPlaybackCount),
            evidence(paths[1], playback.videoPlaybackFormat),
          ],
          explanation: `${roomLabel(room, index)} requests playback without a complete playback/control requirement.`,
          suggestedNextAction:
            "Add the playback source count, file/codec format, operator ownership, and backup plan.",
          question: "Who supplies and operates playback, and what formats must be supported?",
          scopeKey: String(index),
        }];
      }),
  }),
  rule({
    id: "VIDEO_LIGHTING_REVIEW_NEEDED",
    category: "needs_confirmation",
    defaultSeverity: "review_recommended",
    applicability: ["A room has camera, display, LED, or playback scope."],
    requiredInputs: ["lighting requirement or explicit no-lighting decision"],
    affectedFields: ["/content/rooms/*/lighting"],
    source: "RFPilot video/lighting review policy",
    evaluate: ({ rooms }) =>
      rooms.flatMap((room, index) => {
        const lighting = record(room.stageWashLighting);
        const hasLighting =
          isYes(lighting.stageWashLighting) ||
          filled(room.backlightingFor) ||
          filled(room.drapeOrScenicUplighting) ||
          filled(room.audienceLighting) ||
          (Array.isArray(room.lightingRequirements) &&
            room.lightingRequirements.length > 0);
        if (!anyRoomProductionScope(room) || hasLighting) return [];
        const path = roomPath(index, "stageWashLighting");
        return [{
          severity: "review_recommended",
          confidence: "medium",
          paths: [path],
          evidence: [evidence(path, lighting.stageWashLighting)],
          explanation: `${roomLabel(room, index)} has video or stage scope but no lighting review is recorded.`,
          suggestedNextAction:
            "Confirm whether stage wash, speaker key light, scenic light, or audience light is needed.",
          question: "Has lighting been reviewed for the stage, cameras, and scenic elements?",
          scopeKey: String(index),
        }];
      }),
  }),
  rule({
    id: "WIRELESS_CHANNEL_CAPACITY_CONFIRMATION",
    category: "needs_confirmation",
    defaultSeverity: "needs_venue_confirmation",
    applicability: ["A room requests wireless microphones."],
    requiredInputs: ["wireless channel count", "venue frequency coordination"],
    affectedFields: ["/content/rooms/*/audio/wirelessMicCount"],
    source: "RFPilot wireless coordination policy",
    evaluate: ({ rooms }) =>
      rooms.flatMap((room, index) => {
        const wireless = record(room.wirelessMics);
        const microphones = count(wireless.wirelessMicsQty);
        if (!isYes(wireless.wirelessMics) || microphones === 0) return [];
        const path = roomPath(index, "wirelessMics/wirelessMicsQty");
        return [{
          severity: "needs_venue_confirmation",
          confidence: "high",
          paths: [path],
          evidence: [evidence(path, microphones)],
          explanation: `${roomLabel(room, index)} requests ${microphones} wireless microphone channel(s); available coordinated capacity is venue-dependent.`,
          suggestedNextAction:
            "Confirm receiver/channel capacity and frequency coordination with the venue or in-house AV provider.",
          question: "How many coordinated wireless channels can the venue support?",
          scopeKey: String(index),
        }];
      }),
  }),
  rule({
    id: "RIGGING_DETAILS_MISSING",
    category: "needs_confirmation",
    defaultSeverity: "needs_venue_confirmation",
    applicability: ["Rigging is required."],
    requiredInputs: ["rigging plot/specs", "venue-provided motors/lifts"],
    affectedFields: [
      "/content/venueTechnical/riggingPlotOrSpecs",
      "/content/venueTechnical/trussAndMotorsProvided",
      "/content/venueTechnical/liftsProvided",
    ],
    source: "RFPilot venue rigging policy",
    evaluate: ({ proposal }) => {
      const venue = record(proposal.venue);
      if (
        !isYes(venue.riggingRequired) ||
        (filled(venue.riggingPlotOrSpecs) &&
          filled(venue.trussAndMotorsProvidedByVenue) &&
          filled(venue.liftsProvidedByVenue))
      )
        return [];
      const paths = [
        "/content/venue/riggingPlotOrSpecs",
        "/content/venue/trussAndMotorsProvidedByVenue",
        "/content/venue/liftsProvidedByVenue",
      ];
      return [{
        severity: "needs_venue_confirmation",
        confidence: "high",
        paths,
        evidence: [
          evidence(paths[0], venue.riggingPlotOrSpecs),
          evidence(paths[1], venue.trussAndMotorsProvidedByVenue),
          evidence(paths[2], venue.liftsProvidedByVenue),
        ],
        explanation:
          "Rigging is required, but the plot/specification or venue-provided rigging responsibilities are incomplete.",
        suggestedNextAction:
          "Ask the venue for rigging rules, approved vendors, load limits, rates, motors, and lift responsibilities.",
        question: "What rigging equipment and labor must come from the venue?",
      }];
    },
  }),
  rule({
    id: "VENUE_EQUIPMENT_DUPLICATION_REVIEW",
    category: "possible_duplication",
    defaultSeverity: "optional_optimization",
    applicability: [
      "An in-house AV company is identified and room equipment is requested.",
    ],
    requiredInputs: ["venue-provided equipment list"],
    affectedFields: [
      "/content/venueTechnical/inHouseAvCompanyName",
      "/content/rooms",
    ],
    source: "RFPilot venue/external rental responsibility policy",
    evaluate: ({ proposal, rooms }) => {
      const venue = record(proposal.venue);
      if (
        !filled(venue.inHouseAvCompanyName) ||
        !rooms.some(anyRoomProductionScope)
      )
        return [];
      const path = "/content/venue/inHouseAvCompanyName";
      return [{
        severity: "optional_optimization",
        confidence: "medium",
        paths: [path],
        evidence: [evidence(path, venue.inHouseAvCompanyName)],
        explanation:
          "An in-house AV company is identified while external room equipment is also scoped, so duplicate rentals are possible.",
        suggestedNextAction:
          "Compare the venue-provided inventory with the external rental scope before requesting prices.",
        question: "Which equipment and services are already included by the venue?",
      }];
    },
  }),
  rule({
    id: "LABOR_ACCESS_OR_UNION_INPUTS_MISSING",
    category: "needs_confirmation",
    defaultSeverity: "insufficient_information",
    applicability: ["One or more rooms request show crew."],
    requiredInputs: ["venue access requirements", "union status"],
    affectedFields: [
      "/content/venueTechnical/accessRequirements",
      "/content/venueSchedule/unionVenue",
    ],
    source: "RFPilot labor planning policy",
    evaluate: ({ proposal, rooms }) => {
      const hasCrew = rooms.some(
        (room) =>
          (Array.isArray(room.showCrewNeeded) && room.showCrewNeeded.length > 0) ||
          Object.values(record(room.showCrewQty)).some(
            (value) => count(value) > 0,
          ),
      );
      if (!hasCrew) return [];
      const venue = record(proposal.venue);
      const schedule = record(proposal.venueSchedule);
      const missingAccess = !filled(venue.venueAccessRequirements);
      const unknownUnion =
        !isYes(schedule.isUnionVenue) && !isNo(schedule.isUnionVenue);
      if (!missingAccess && !unknownUnion) return [];
      const paths = [
        "/content/venue/venueAccessRequirements",
        "/content/venueSchedule/isUnionVenue",
      ];
      return [{
        severity: "insufficient_information",
        confidence: "high",
        paths,
        evidence: [
          evidence(paths[0], venue.venueAccessRequirements),
          evidence(paths[1], schedule.isUnionVenue),
        ],
        explanation:
          "Crew is requested, but venue access and/or union conditions are not complete enough to finalize labor.",
        suggestedNextAction:
          "Confirm access windows, dock/elevator rules, union jurisdiction, minimum calls, breaks, and steward requirements.",
        question: "What venue access and union rules apply to setup, show, and strike labor?",
      }];
    },
  }),
]);

export const computeScopeGuidance = (
  proposal: UnknownRecord,
): ScopeFinding[] => {
  const context: ScopeContext = {
    proposal,
    rooms: records(proposal.roomByRoom),
  };
  return SCOPE_RULES.flatMap((definition) =>
    definition.evaluate(context).map(({ scopeKey, ...finding }) => ({
      ...finding,
      id: `${definition.version}:${definition.id.toLocaleLowerCase("en-US")}:${scopeKey ?? "proposal"}`,
      ruleId: definition.id,
      ruleVersion: definition.version,
      category: definition.category,
      source: "approved_scope_rule" as const,
    })),
  );
};
