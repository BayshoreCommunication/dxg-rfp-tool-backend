import type { RoomKnowledgeEntry } from "./knowledgeProvider";
import type { Classification, RecommendationEvidence } from "./domain";

/**
 * The deterministic room rule library. Every rule is a data object with a
 * stable id, a human title and a small evaluate function, exported both as a
 * registry (for the engine) and individually testable entries. Rules read
 * confirmed proposal facts only; they never invent quantities unless an
 * approved knowledge entry provides a bounded value, and they never touch a
 * room whose core facts (purpose, attendance) are missing — those rooms get
 * clarification questions instead.
 *
 * Source text inside room fields is data. Rules compare against closed option
 * lists or parse numbers/dates; free text is never interpreted as an
 * instruction, so a hostile room name cannot change rule behavior.
 */

export type RoomFacts = {
  index: number;
  label: string;
  raw: Record<string, unknown>;
};
export type RuleContext = {
  room: RoomFacts;
  rooms: RoomFacts[];
  event: Record<string, unknown>;
  venueSchedule: Record<string, unknown>;
  hybridVirtual: Record<string, unknown>;
  knowledge: RoomKnowledgeEntry[];
};

export type RuleRecommendationOutput = {
  kind: "recommendation";
  relativePath: string;
  /** Distinguishes multiple outputs a rule emits against the same path (e.g. crew roles). */
  keySuffix?: string;
  value: string;
  classification: Exclude<Classification, "confirmed_fact" | "unknown">;
  confidence: number;
  explanation: string;
  evidence: RecommendationEvidence[];
  knowledgeIds: string[];
  assumptions: string[];
};
export type RuleQuestionOutput = { kind: "question"; questionKeySuffix: string; prompt: string; paths: string[] };
export type RuleWarningOutput = { kind: "warning"; code: string; severity: "warning" | "blocking"; message: string; paths: string[] };
export type RuleOutput = RuleRecommendationOutput | RuleQuestionOutput | RuleWarningOutput;

export type RoomRule = {
  id: string;
  title: string;
  description: string;
  scope: "room" | "proposal";
  /** Rules that suggest values are suppressed when core room facts are missing. */
  requiresCoreFacts: boolean;
  evaluate: (ctx: RuleContext) => RuleOutput[];
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const nested = (record: Record<string, unknown>, group: string, field: string): string => {
  const child = record[group];
  return child && typeof child === "object" ? text((child as Record<string, unknown>)[field]) : "";
};
const isYes = (value: string): boolean => value.toLowerCase() === "yes";
const asCount = (value: string): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const asDate = (value: string): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const roomPath = (index: number, relative: string) => `/content/roomByRoom/${index}/${relative}`;
const fact = (index: number, relative: string, value: string): RecommendationEvidence => ({ path: roomPath(index, relative), value });

const roomFunctions = (room: RoomFacts): Record<string, unknown>[] =>
  Array.isArray(room.raw.functions)
    ? room.raw.functions.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];

const functionNames = (room: RoomFacts): string[] => {
  const entries = roomFunctions(room);
  return entries.length > 0
    ? entries.map((entry) => text(entry.functionName))
    : [text(room.raw.roomFunction)];
};

const functionAttendances = (room: RoomFacts): number[] => {
  const entries = roomFunctions(room);
  const values = entries.length > 0
    ? entries.map((entry) => asCount(text(entry.estimatedAttendees)))
    : [asCount(text(room.raw.estimatedAttendeesInRoom))];
  return values.filter((value): value is number => value !== null && value > 0);
};

const peakRoomAttendance = (room: RoomFacts): number | null => {
  const values = functionAttendances(room);
  if (values.length > 0) return Math.max(...values);
  return asCount(text(room.raw.estimatedAttendeesInRoom));
};

export const hasCoreRoomFacts = (room: RoomFacts): { purpose: boolean; attendance: boolean } => ({
  purpose: functionNames(room).length > 0 && functionNames(room).every(Boolean),
  attendance: roomFunctions(room).length > 0
    ? roomFunctions(room).every((entry) => {
        const attendance = asCount(text(entry.estimatedAttendees));
        return attendance !== null && attendance > 0;
      })
    : peakRoomAttendance(room) !== null && peakRoomAttendance(room)! > 0,
});

/** Crew tokens must match the wizard's Show Crew options exactly. */
export const CREW = {
  a1: "A1 (Audio Engineer)",
  v1: "V1 (Video Engineer)",
  v2: "V2 (Video Assist)",
  graphics: "Graphics Operator",
  td: "TD (Technical Director)",
  cameraOp: "Camera Operator",
  teleprompterOp: "Teleprompter Operator",
  l1: "L1 (Lighting Director)",
} as const;

const crewList = (room: RoomFacts): string[] => (Array.isArray(room.raw.showCrewNeeded) ? room.raw.showCrewNeeded.map((x) => text(x)) : []);

const crewRecommendation = (
  ctx: RuleContext,
  role: string,
  triggerRelative: string,
  triggerValue: string,
  explanation: string,
): RuleOutput[] => {
  if (crewList(ctx.room).includes(role)) return [];
  return [{
    kind: "recommendation",
    relativePath: "showCrewNeeded",
    keySuffix: role.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
    value: role,
    classification: "deterministic_derivation",
    confidence: 0.95,
    explanation,
    evidence: [fact(ctx.room.index, triggerRelative, triggerValue)],
    knowledgeIds: [],
    assumptions: [],
  }];
};

export const ROOM_RULES: RoomRule[] = [
  {
    id: "ROOM_CREW_AUDIO_A1_001",
    title: "Audio system implies an A1",
    description: "A room with a dedicated audio system needs an audio engineer to run it.",
    scope: "room",
    requiresCoreFacts: true,
    evaluate: (ctx) => {
      const required = text(ctx.room.raw.audioSystemRequired);
      if (!isYes(required)) return [];
      return crewRecommendation(ctx, CREW.a1, "audioSystemRequired", required,
        "A dedicated audio system was selected for this room, which requires an A1 to mix and operate it.");
    },
  },
  {
    id: "ROOM_CREW_VIDEO_LED_001",
    title: "LED wall implies video and graphics roles",
    description: "An LED wall needs a video engineer, video assist, graphics operator and technical director.",
    scope: "room",
    requiresCoreFacts: true,
    evaluate: (ctx) => {
      const led = text(ctx.room.raw.ledWall);
      if (!isYes(led)) return [];
      return [CREW.v1, CREW.v2, CREW.graphics, CREW.td].flatMap((role) =>
        crewRecommendation(ctx, role, "ledWall", led,
          `An LED wall was selected for this room; ${role} is part of the standard LED wall operating crew.`));
    },
  },
  {
    id: "ROOM_CREW_CAMERA_OPS_001",
    title: "Cameras imply camera operators",
    description: "Operated cameras need camera operators.",
    scope: "room",
    requiresCoreFacts: true,
    evaluate: (ctx) => {
      const cameras = nested(ctx.room.raw, "cameras", "cameras");
      if (!isYes(cameras)) return [];
      return crewRecommendation(ctx, CREW.cameraOp, "cameras/cameras", cameras,
        "Cameras were selected for this room, which requires camera operators.");
    },
  },
  {
    id: "ROOM_CREW_TELEPROMPTER_001",
    title: "Teleprompter implies an operator",
    description: "A teleprompter needs a dedicated operator.",
    scope: "room",
    requiresCoreFacts: true,
    evaluate: (ctx) => {
      const required = text(ctx.room.raw.teleprompterRequired);
      if (!isYes(required)) return [];
      return crewRecommendation(ctx, CREW.teleprompterOp, "teleprompterRequired", required,
        "A teleprompter was selected for this room, which requires a teleprompter operator.");
    },
  },
  {
    id: "ROOM_CREW_LIGHTING_L1_001",
    title: "Programmable lighting implies an L1",
    description: "Moving lights or programmable effects need a lighting director.",
    scope: "room",
    requiresCoreFacts: true,
    evaluate: (ctx) => {
      const lighting = Array.isArray(ctx.room.raw.lightingRequirements) ? ctx.room.raw.lightingRequirements.map((x) => text(x)) : [];
      const programmable = lighting.find((option) => option.toLowerCase().includes("moving lights") || option.toLowerCase().includes("programmable"));
      if (!programmable) return [];
      return crewRecommendation(ctx, CREW.l1, "lightingRequirements", programmable,
        "Programmable lighting effects were selected for this room, which requires an L1 to program and run cues.");
    },
  },
  {
    id: "ROOM_AUDIO_QA_001",
    title: "Passed-mic Q&A implies handheld wireless microphones",
    description: "Audience Q&A via passed microphones needs handheld wireless mics; quantity comes from approved knowledge, bounded by room attendance.",
    scope: "room",
    requiresCoreFacts: true,
    evaluate: (ctx) => {
      const qa = nested(ctx.room.raw, "audienceQa", "audienceQa");
      const methodRaw = nested(ctx.room.raw, "audienceQa", "audienceQaMethod");
      const method = methodRaw.toLowerCase();
      if (!method) return [];
      // The wizard only ever writes audienceQaMethod — it has no separate
      // yes/no toggle — so requiring audienceQa === "Yes" made this rule
      // unreachable from the UI. A chosen method other than "no Q&A" is itself
      // the confirmation that the room takes audience questions; an explicit
      // "No" on the legacy field still wins.
      const declinesQa = /\bno\b/.test(qa.trim().toLowerCase()) || method.startsWith("no q&a");
      if (declinesQa) return [];
      const entry = ctx.knowledge.find((candidate) =>
        (candidate.applicability.audienceQaMethodIncludes ?? []).some((fragment) => method.includes(fragment)));
      if (!entry || !entry.guidance.handheldMicBands) return [];
      const outputs: RuleOutput[] = [];
      const micEvidence = [fact(ctx.room.index, "audienceQa/audienceQaMethod", methodRaw)];
      if (qa) micEvidence.unshift(fact(ctx.room.index, "audienceQa/audienceQa", qa));
      const micsSelected = nested(ctx.room.raw, "wirelessMics", "wirelessMics");
      if (!isYes(micsSelected)) {
        outputs.push({
          kind: "recommendation",
          relativePath: "wirelessMics/wirelessMics",
          value: "Yes",
          classification: "deterministic_derivation",
          confidence: 0.9,
          explanation: "Passing microphones to the audience requires handheld wireless microphones; the Q&A method selected for this room entails them.",
          evidence: micEvidence,
          knowledgeIds: [],
          assumptions: [],
        });
        outputs.push({
          kind: "recommendation",
          relativePath: "wirelessMics/wirelessMicsType",
          value: "Handhelds",
          classification: "deterministic_derivation",
          confidence: 0.9,
          explanation: "Passed-microphone Q&A uses handheld wireless microphones.",
          evidence: micEvidence,
          knowledgeIds: [],
          assumptions: [],
        });
      }
      const existingQty = asCount(nested(ctx.room.raw, "wirelessMics", "wirelessMicsQty"));
      const attendance = peakRoomAttendance(ctx.room);
      if (existingQty === null && attendance !== null) {
        const band = entry.guidance.handheldMicBands.find((candidate) => candidate.maxAttendees === null || attendance <= candidate.maxAttendees);
        if (band) {
          outputs.push({
            kind: "recommendation",
            relativePath: "wirelessMics/wirelessMicsQty",
            value: String(band.quantity),
            classification: "recommended_assumption",
            confidence: 0.75,
            explanation: `For roughly ${attendance} attendees with passed-microphone Q&A, ${band.quantity} handheld channel(s) is the approved baseline (${entry.title}).`,
            evidence: [
              ...micEvidence,
              fact(
                ctx.room.index,
                roomFunctions(ctx.room).length > 0
                  ? `functions/${roomFunctions(ctx.room).findIndex((entry) => asCount(text(entry.estimatedAttendees)) === attendance)}/estimatedAttendees`
                  : "estimatedAttendeesInRoom",
                String(attendance),
              ),
            ],
            knowledgeIds: [entry.id],
            assumptions: [
              "Staff runners can reach seated attendees with passed microphones.",
              entry.guidance.note,
            ],
          });
        }
      }
      return outputs;
    },
  },
  {
    id: "ROOM_RECORDING_CLARIFY_001",
    title: "Recording needs camera, composition and ownership details",
    description: "When recording is requested, ask about camera count, recording composition and media ownership instead of inventing them.",
    scope: "room",
    requiresCoreFacts: false,
    evaluate: (ctx) => {
      const recording = nested(ctx.room.raw, "videoRecording", "videoRecording");
      if (!isYes(recording)) return [];
      const outputs: RuleOutput[] = [];
      const cameras = nested(ctx.room.raw, "cameras", "cameras");
      const cameraQty = asCount(nested(ctx.room.raw, "cameras", "camerasQty"));
      if (!isYes(cameras) || cameraQty === null)
        outputs.push({ kind: "question", questionKeySuffix: "camera-count", prompt: "Video recording is requested for this room. How many cameras should capture it?", paths: [roomPath(ctx.room.index, "cameras/camerasQty")] });
      if (!nested(ctx.room.raw, "videoRecording", "videoRecordingType"))
        outputs.push({ kind: "question", questionKeySuffix: "composition", prompt: "What recording composition is needed (program cut, ISO records, or both)?", paths: [roomPath(ctx.room.index, "videoRecording/videoRecordingType")] });
      outputs.push({ kind: "question", questionKeySuffix: "media-ownership", prompt: "Who owns and receives the recorded media after the event?", paths: [] });
      return outputs;
    },
  },
  {
    id: "ROOM_SCHEDULE_END_001",
    title: "Show end must be after show start",
    description: "A room whose show ends at or before it starts cannot be scheduled or priced.",
    scope: "room",
    requiresCoreFacts: false,
    evaluate: (ctx) => {
      const entries = roomFunctions(ctx.room);
      const schedules = entries.length > 0 ? entries : [ctx.room.raw];
      return schedules.flatMap((entry, functionIndex) => {
        const start = asDate(text(entry.showStartDateTime));
        const end = asDate(text(entry.showEndDateTime));
        if (!start || !end || end.getTime() > start.getTime()) return [];
        const prefix = entries.length > 0 ? `functions/${functionIndex}/` : "";
        const functionName = entries.length > 0 ? text(entry.functionName) : text(ctx.room.raw.roomFunction);
        return [{
          kind: "warning" as const,
          code: "ROOM_SHOW_END_NOT_AFTER_START",
          severity: "blocking" as const,
          message: `${functionName || "This function"} has a show end that is not after its show start. Vendors cannot schedule against this.`,
          paths: [roomPath(ctx.room.index, `${prefix}showStartDateTime`), roomPath(ctx.room.index, `${prefix}showEndDateTime`)],
        }];
      });
    },
  },
  {
    id: "ROOM_SCHEDULE_LOADIN_001",
    title: "Load-in must not be after the show starts",
    description: "Load-in after the show start is impossible to execute.",
    scope: "room",
    requiresCoreFacts: false,
    evaluate: (ctx) => {
      const loadIn = asDate(text(ctx.room.raw.loadInDateTime));
      if (!loadIn) return [];
      const entries = roomFunctions(ctx.room);
      const schedules = entries.length > 0 ? entries : [ctx.room.raw];
      return schedules.flatMap((entry, functionIndex) => {
        const start = asDate(text(entry.showStartDateTime));
        if (!start || loadIn.getTime() <= start.getTime()) return [];
        const prefix = entries.length > 0 ? `functions/${functionIndex}/` : "";
        const functionName = entries.length > 0 ? text(entry.functionName) : text(ctx.room.raw.roomFunction);
        return [{
          kind: "warning" as const,
          code: "ROOM_LOADIN_AFTER_SHOW",
          severity: "blocking" as const,
          message: `This room's load-in is scheduled after ${functionName || "a function"} starts.`,
          paths: [roomPath(ctx.room.index, "loadInDateTime"), roomPath(ctx.room.index, `${prefix}showStartDateTime`)],
        }];
      });
    },
  },
  {
    id: "ROOM_ATTENDANCE_EXCEEDS_001",
    title: "Room attendance should not exceed event attendance",
    description: "A single room holding more people than the whole event signals a data error.",
    scope: "room",
    requiresCoreFacts: false,
    evaluate: (ctx) => {
      const roomAttendance = peakRoomAttendance(ctx.room);
      const eventAttendance = asCount(text(ctx.event.attendees));
      if (roomAttendance === null || eventAttendance === null || eventAttendance <= 0 || roomAttendance <= eventAttendance) return [];
      return [{
        kind: "warning",
        code: "ROOM_ATTENDANCE_EXCEEDS_EVENT",
        severity: "warning",
        message: `This room expects ${roomAttendance} attendees but the event expects ${eventAttendance} in total.`,
        paths: [roomPath(ctx.room.index, "estimatedAttendeesInRoom"), "/content/event/attendees"],
      }];
    },
  },
  {
    id: "ROOM_PURPOSE_MISSING_001",
    title: "Missing room purpose blocks recommendations",
    description: "Without knowing what a room is for, equipment must not be suggested.",
    scope: "room",
    requiresCoreFacts: false,
    evaluate: (ctx) => {
      if (hasCoreRoomFacts(ctx.room).purpose) return [];
      return [{ kind: "question", questionKeySuffix: "purpose", prompt: "What is this room's purpose or function (e.g. general session, breakout, VIP reception)?", paths: [roomPath(ctx.room.index, "roomFunction")] }];
    },
  },
  {
    id: "ROOM_ATTENDANCE_MISSING_001",
    title: "Missing room attendance blocks sizing",
    description: "Attendance drives audio sizing and mic counts; ask rather than assume.",
    scope: "room",
    requiresCoreFacts: false,
    evaluate: (ctx) => {
      if (hasCoreRoomFacts(ctx.room).attendance) return [];
      return [{ kind: "question", questionKeySuffix: "attendance", prompt: "How many attendees are expected in this room?", paths: [roomPath(ctx.room.index, "estimatedAttendeesInRoom")] }];
    },
  },
];

export const PROPOSAL_RULES: RoomRule[] = [
  {
    id: "ROOM_COUNT_MISMATCH_001",
    title: "Declared room count must match room modules",
    description: "Vendors price the wrong scope when the declared count and the specified rooms disagree.",
    scope: "proposal",
    requiresCoreFacts: false,
    evaluate: (ctx) => {
      const declared = asCount(text(ctx.venueSchedule.numberOfEventRooms));
      if (declared === null || ctx.rooms.length === 0 || declared === ctx.rooms.length) return [];
      return [{
        kind: "warning",
        code: "ROOM_COUNT_MISMATCH",
        severity: "warning",
        message: `The schedule declares ${declared} room(s) but ${ctx.rooms.length} room specification(s) exist.`,
        paths: ["/content/venueSchedule/numberOfEventRooms"],
      }];
    },
  },
  {
    id: "ROOM_HYBRID_CLARIFY_001",
    title: "Hybrid events need streaming and remote-speaker answers",
    description: "Hybrid or virtual formats change every room's video path; ask for the missing operational facts.",
    scope: "proposal",
    requiresCoreFacts: false,
    evaluate: (ctx) => {
      const format = text(ctx.event.eventFormat).toLowerCase();
      if (!format.includes("hybrid") && !format.includes("virtual")) return [];
      const outputs: RuleOutput[] = [];
      if (!text(ctx.hybridVirtual.streamingPlatform))
        outputs.push({ kind: "question", questionKeySuffix: "streaming-platform", prompt: "Which streaming platform will carry the hybrid/virtual program?", paths: ["/content/hybridVirtual/streamingPlatform"] });
      if (!nested(ctx.hybridVirtual, "remoteSpeakers", "remoteSpeakers"))
        outputs.push({ kind: "question", questionKeySuffix: "remote-speakers", prompt: "Will remote speakers present into any room, and how many?", paths: ["/content/hybridVirtual/remoteSpeakers/remoteSpeakers"] });
      if (!text(ctx.hybridVirtual.dedicatedVirtualProducer))
        outputs.push({ kind: "question", questionKeySuffix: "virtual-production-owner", prompt: "Who owns virtual production (a dedicated virtual producer, the AV vendor, or in-house staff)?", paths: ["/content/hybridVirtual/dedicatedVirtualProducer"] });
      return outputs;
    },
  },
];

export const ALL_RULES: RoomRule[] = [...ROOM_RULES, ...PROPOSAL_RULES];
