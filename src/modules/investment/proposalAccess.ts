// Read-only view over the legacy proposal document. The investment engine is a
// pure function, so every proposal-shaped lookup lives here and is expressed in
// terms of the legacy field names the questionnaire actually writes (the same
// names contracts/proposal/v1/legacyAdapter.ts maps to the canonical schema).

import { activeProposalWorkflowContent } from "../proposals/domain/workflowSections";

export type UnknownRecord = Record<string, unknown>;

export const valueAt = (proposal: UnknownRecord, path: string): unknown =>
  path.replace(/^\/content\//, "").split("/").reduce<unknown>((node, key) =>
    node && typeof node === "object" ? (node as UnknownRecord)[key] : undefined, proposal);

export const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
export const isYes = (value: unknown) => /^(yes|true)$/i.test(text(value)) || value === true;
export const isNo = (value: unknown) => /^(no|false)$/i.test(text(value)) || value === false;
export const filled = (value: unknown) =>
  value !== undefined && value !== null
  && !(typeof value === "string" && value.trim() === "")
  && !(Array.isArray(value) && value.length === 0);
export const asNumber = (value: unknown): number | null => {
  const n = Number(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(n) ? n : null;
};
export const positive = (value: unknown): number | null => {
  const n = asNumber(value);
  return n !== null && n > 0 ? n : null;
};
const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
const asRecords = (value: unknown): UnknownRecord[] =>
  Array.isArray(value) ? value.filter((item): item is UnknownRecord => !!item && typeof item === "object") : [];

export const evaluateCondition = (proposal: UnknownRecord, condition: { path: string; op: string; value?: unknown }): boolean => {
  const actual = valueAt(proposal, condition.path);
  switch (condition.op) {
    case "filled": return filled(actual);
    case "empty": return !filled(actual);
    case "eq": return text(actual).toLowerCase() === text(condition.value).toLowerCase() || (asNumber(actual) !== null && asNumber(actual) === asNumber(condition.value));
    case "neq": return !evaluateCondition(proposal, { ...condition, op: "eq" });
    case "gte": { const a = asNumber(actual), b = asNumber(condition.value); return a !== null && b !== null && a >= b; }
    case "lte": { const a = asNumber(actual), b = asNumber(condition.value); return a !== null && b !== null && a <= b; }
    case "contains": return text(actual).toLowerCase().includes(text(condition.value).toLowerCase());
    default: return false;
  }
};

export const eventDays = (proposal: UnknownRecord): number => {
  const start = new Date(text(valueAt(proposal, "/content/event/startDate")));
  const end = new Date(text(valueAt(proposal, "/content/event/endDate")));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
  const span = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  return Math.min(Math.max(span, 1), 30);
};

const GENERAL_SESSION_ROOM = /general session|plenary|main stage|keynote|main room|opening|closing/i;
const LUMENS_STATED = /\d[\d,]*\s*(lumens?|lm\b|k\s*lumens?)/i;

export type AvProvider = "in_house" | "outside" | "unknown";
export type TriState = "yes" | "no" | "unknown";

export type ProposalFacts = {
  days: number;
  rehearsalDays: number;
  datesStated: boolean;
  rooms: UnknownRecord[];
  roomDetailStated: boolean;
  declaredRoomCount: number | null;
  breakoutRoomCount: number;
  breakoutRoomsDerived: boolean;
  generalSessionRoomStated: boolean;
  attendees: number | null;
  audienceStated: boolean;
  format: string;
  unionVenue: TriState;
  avProvider: AvProvider;
  marketText: string;
  hybridRequested: boolean;
  streamingScopeStated: boolean;
  recordingRequested: boolean;
  cameraCount: number | null;
  wirelessChannels: number | null;
  ledWallRequested: boolean;
  ledWallSqFt: number | null;
  surfaceSizeStated: boolean;
  lumensStated: boolean;
  internetRequested: boolean;
  internetAnswered: boolean;
  accessibilityAnswered: boolean;
  captioningRequested: boolean;
  captionLanguageCount: number;
  interpretationRequested: boolean;
  scenicRequested: boolean;
  stageSqFt: number | null;
  crewHoursPerDay: number | null;
};

const dateOnly = (value: unknown): string => text(value).slice(0, 10);
const outsideShowDates = (date: string, start: string, end: string) =>
  Boolean(date && start && end && (date < start || date > end));
const durationHours = (start: unknown, end: unknown): number | null => {
  const startAt = new Date(text(start)), endAt = new Date(text(end));
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) return null;
  return Math.min(Math.max((endAt.getTime() - startAt.getTime()) / 3_600_000, 1), 24);
};
const stageArea = (value: unknown): number | null => {
  const dimensions = text(value).match(/(\d+(?:\.\d+)?)\s*(?:ft|feet|')?\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  if (!dimensions) return null;
  const width = Number(dimensions[1]), depth = Number(dimensions[2]);
  return width > 0 && depth > 0 ? Math.round(width * depth) : null;
};

export const readFacts = (proposal: UnknownRecord): ProposalFacts => {
  const activeProposal = activeProposalWorkflowContent(proposal);
  const event = asRecord(activeProposal.event);
  const venueSchedule = asRecord(activeProposal.venueSchedule);
  const venue = asRecord(activeProposal.venue);
  const hybrid = asRecord(activeProposal.hybridVirtual);
  const captions = asRecord(hybrid.closedCaptions);
  const rooms = asRecords(activeProposal.roomByRoom);

  const declaredRoomCount = positive(venueSchedule.numberOfEventRooms);
  const namedBreakouts = rooms.filter((room) => !GENERAL_SESSION_ROOM.test(text(room.roomFunction))).length;
  const breakoutRoomsDerived = rooms.length === 0 && (declaredRoomCount ?? 0) > 1;
  const breakoutRoomCount = rooms.length ? namedBreakouts : breakoutRoomsDerived ? (declaredRoomCount ?? 1) - 1 : 0;

  const roomValue = (path: string[]): unknown[] =>
    rooms.map((room) => path.reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as UnknownRecord)[key] : undefined), room));
  const firstPositive = (values: unknown[]) => values.map(positive).find((value): value is number => value !== null) ?? null;

  const cameraCountForRoom = (room: UnknownRecord): number | null => {
    const cameras = asRecord(room.cameras);
    const type = text(cameras.cameraType);
    if (text(cameras.cameraPlanMode) === "Specific Camera Plan") {
      if (type === "PTZ Camera") return positive(cameras.ptzCameraQty);
      if (type === "Studio / Broadcast Camera") return positive(cameras.studioCameraQty);
      if (type === "Both") {
        const ptz = positive(cameras.ptzCameraQty), studio = positive(cameras.studioCameraQty);
        return ptz && studio ? ptz + studio : null;
      }
      if (type === "Other — Specify") return positive(cameras.otherCameraQty);
    }
    return positive(cameras.camerasQty);
  };

  const wirelessChannels = firstPositive(roomValue(["wirelessMics", "wirelessMicsQty"]));
  const cameraCount = rooms
    .map(cameraCountForRoom)
    .find((value): value is number => value !== null) ?? null;
  const ledWallRequested = rooms.some((room) => isYes(room.ledWall));
  const ledWallsForRoom = (room: UnknownRecord): UnknownRecord[] => {
    if (Array.isArray(room.ledWalls) && room.ledWalls.length > 0) {
      return room.ledWalls.map(asRecord);
    }
    return [{
      width: room.ledWallWidth,
      height: room.ledWallHeight,
      pixelPitch: room.ledWallPixelPitch,
      specs: room.ledWallSpecs,
      notes: room.ledWallNotes,
    }];
  };
  const ledWallSqFt = (() => {
    const areas = rooms.flatMap((room) => isYes(room.ledWall)
      ? ledWallsForRoom(room).map((wall) => {
          const width = positive(wall.width), height = positive(wall.height);
          return width && height ? width * height : 0;
        })
      : []);
    const total = areas.reduce((sum, area) => sum + area, 0);
    return total > 0 ? Math.round(total) : null;
  })();
  const surfaceSizeStated = rooms.some((room) => {
    const monitors = asRecord(room.largeMonitorsOrScreenProjector);
    return filled(monitors.screenSize) || ledWallsForRoom(room).some((wall) =>
      filled(wall.pixelPitch) || (filled(wall.width) && filled(wall.height)));
  });
  const freeText = [
    text(event.statementOfWork), text(event.eventProfile), text(event.sacredConstraints),
    ...rooms.map((room) => [
      ...ledWallsForRoom(room).flatMap((wall) => [text(wall.specs), text(wall.notes)]),
      text(room.contentVideoNeeds), text(room.roomSetup),
    ].join(" ")),
  ].join(" ");
  const accessText = [text(venue.accessRequirements), text(venue.venueAccessRequirements), freeText].join(" ");
  const captionLanguages = Array.isArray(captions.captionLanguages)
    ? captions.captionLanguages.filter((language) => text(language)).length
    : 0;
  const showStart = dateOnly(event.startDate), showEnd = dateOnly(event.endDate);
  const rehearsalDates = new Set(
    [
      dateOnly(venueSchedule.rehearsalDate),
      ...rooms.map((room) => dateOnly(room.rehearsalDateTime)),
    ].filter((date) => outsideShowDates(date, showStart, showEnd)),
  );
  const crewHours = roomValue(["showStartDateTime"])
    .map((start, index) => durationHours(start, rooms[index]?.showEndDateTime))
    .filter((hours): hours is number => hours !== null);
  const stageSqFt = roomValue(["stageDimensions"])
    .map(stageArea)
    .find((area): area is number => area !== null) ?? null;

  const attendees = positive(event.attendees);
  const format = text(event.eventFormat);
  const streamingScopeStated = filled(hybrid.streamingPlatform) || filled(hybrid.streamingPlatformOther);

  return {
    days: eventDays(activeProposal),
    rehearsalDays: rehearsalDates.size,
    datesStated: filled(event.startDate) && filled(event.endDate),
    rooms,
    roomDetailStated: rooms.length > 0,
    declaredRoomCount,
    breakoutRoomCount: Math.max(breakoutRoomCount, 0),
    breakoutRoomsDerived,
    generalSessionRoomStated: rooms.some((room) => GENERAL_SESSION_ROOM.test(text(room.roomFunction))),
    attendees,
    audienceStated: attendees !== null || rooms.some((room) => positive(room.estimatedAttendeesInRoom) !== null || positive(room.audioSystemForHowManyPpl) !== null),
    format,
    unionVenue: isYes(venueSchedule.isUnionVenue) || rooms.some((room) => isYes(room.unionLabor))
      ? "yes"
      : isNo(venueSchedule.isUnionVenue) ? "no" : "unknown",
    avProvider: isYes(venue.inHouseAvRequired) || filled(venue.inHouseAvCompanyName)
      ? "in_house"
      : isNo(venue.inHouseAvRequired) ? "outside" : "unknown",
    marketText: [venueSchedule.venueCity, venueSchedule.venueState, venueSchedule.venueName].map(text).filter(Boolean).join(" "),
    hybridRequested: /hybrid|virtual/i.test(format) || streamingScopeStated || (positive(hybrid.virtualAttendeeEstimate) ?? 0) > 0,
    streamingScopeStated,
    recordingRequested: rooms.some((room) =>
      isYes(asRecord(room.videoRecording).videoRecording) ||
      isYes(asRecord(room.cameras).cameras),
    ),
    cameraCount,
    wirelessChannels,
    ledWallRequested,
    ledWallSqFt,
    surfaceSizeStated,
    lumensStated: LUMENS_STATED.test(freeText),
    internetRequested: isYes(venue.wirelessInternetRequired) || filled(venue.internetUseCases),
    internetAnswered: filled(venue.wirelessInternetRequired) || filled(venue.internetUseCases),
    accessibilityAnswered: filled(captions.closedCaptions) || filled(captions.captionLanguages) || filled(venue.accessRequirements) || filled(venue.venueAccessRequirements),
    captioningRequested: isYes(captions.closedCaptions),
    captionLanguageCount: Math.max(captionLanguages, isYes(captions.closedCaptions) ? 1 : 0),
    interpretationRequested: /\binterpret(?:ation|er|ing)?\b|\bASL\b|assisted listening/i.test(accessText),
    scenicRequested: rooms.some((room) => isYes(room.scenicStageDesign)),
    stageSqFt,
    crewHoursPerDay: crewHours.length ? Math.max(...crewHours) : null,
  };
};
