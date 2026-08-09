import type {
  Measurement,
  ProposalContent,
  ProposalV1,
  Room,
} from "../../generated/proposal-v1";
import type { ProposalPublicV1 } from "../../generated/proposal-public-v1";
import { formatContractErrors, validateProposalV1 } from "./validators";

type UnknownRecord = Record<string, unknown>;

export type LegacyMappingIssue = {
  path: string;
  code: "invalid" | "missing" | "unmapped" | "normalized";
  message: string;
};

export type LegacyProposalContext = {
  organizationId: string;
  ownerUserId?: string;
  now?: string;
};

export type LegacyProposalMappingResult =
  | { success: true; proposal: ProposalV1; issues: LegacyMappingIssue[] }
  | { success: false; proposal: null; issues: LegacyMappingIssue[] };

const record = (value: unknown): UnknownRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
};

const integer = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const booleanOrNull = (value: unknown): boolean | null | undefined => {
  if (typeof value === "boolean") return value;
  const normalized = text(value)?.toLowerCase();
  if (["yes", "y", "true"].includes(normalized ?? "")) return true;
  if (["no", "n", "false"].includes(normalized ?? "")) return false;
  if (["not sure", "not_sure", "unknown", "tbd"].includes(normalized ?? "")) return null;
  return undefined;
};

const strings = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.map(text).filter((item): item is string => Boolean(item));
  return normalized.length ? [...new Set(normalized)] : undefined;
};

const measurement = (
  value: unknown,
  defaultUnit: Measurement["unit"],
  path: string,
  issues: LegacyMappingIssue[],
): Measurement | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return { value, unit: defaultUnit };
  }
  const normalized = text(value);
  if (!normalized) return undefined;
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(inches?|in|["”]|feet|foot|ft|'|mm|cm|meters?|metres?|m|amps?|a)?/i);
  if (!match) {
    issues.push({ path, code: "invalid", message: `Unable to normalize measurement: ${normalized}` });
    return undefined;
  }
  const unitToken = match[2]?.toLowerCase();
  const unit: Measurement["unit"] =
    !unitToken ? defaultUnit
      : ["inch", "inches", "in", '"', "”"].includes(unitToken) ? "in"
        : ["feet", "foot", "ft", "'"].includes(unitToken) ? "ft"
          : unitToken === "mm" ? "mm"
            : unitToken === "cm" ? "cm"
              : ["meter", "meters", "metre", "metres", "m"].includes(unitToken) ? "m"
                : ["amp", "amps", "a"].includes(unitToken) ? "amp"
                  : defaultUnit;
  return { value: Number.parseFloat(match[1]), unit };
};

const optional = <T>(key: string, value: T | undefined): Record<string, T> =>
  value === undefined ? {} : { [key]: value };

const date = (
  value: unknown,
  path: string,
  issues: LegacyMappingIssue[],
): string | undefined => {
  const normalized = text(value);
  if (!normalized) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  issues.push({ path, code: "invalid", message: `Expected ISO date; received ${normalized}` });
  return undefined;
};

const dateTime = (
  value: unknown,
  path: string,
  issues: LegacyMappingIssue[],
): string | undefined => {
  const normalized = text(value);
  if (!normalized) return undefined;
  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  issues.push({ path, code: "invalid", message: `Expected a valid date-time; received ${normalized}` });
  return undefined;
};

const eventFormat = (value: unknown): ProposalV1["content"]["event"]["format"] => {
  switch (text(value)?.toLowerCase()) {
    case "hybrid":
      return "hybrid";
    case "virtual":
      return "virtual";
    default:
      return "in_person";
  }
};

const lifecycleStatus = (legacy: UnknownRecord): ProposalV1["lifecycle"]["status"] => {
  if (legacy.isArchived === true) return "archived";
  switch (text(legacy.status)?.toLowerCase()) {
    case "submitted": return "submitted";
    case "reviewed": return "in_review";
    case "approved": return "approved";
    case "rejected": return "rejected";
    case "published": return "published";
    default: return "draft";
  }
};

const localSchedulePoint = (
  dateValue: unknown,
  timeValue: unknown,
  path: string,
  issues: LegacyMappingIssue[],
) => {
  const normalizedDate = date(dateValue, `${path}/date`, issues);
  if (!normalizedDate) return undefined;
  const normalizedTime = text(timeValue);
  if (normalizedTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(normalizedTime)) {
    issues.push({
      path: `${path}/time`,
      code: "invalid",
      message: `Expected HH:mm time; received ${normalizedTime}`,
    });
  }
  return {
    date: normalizedDate,
    ...(normalizedTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(normalizedTime)
      ? { time: normalizedTime }
      : {}),
  };
};

const confirmationStatus = (value: unknown) => {
  switch (text(value)?.toUpperCase()) {
    case "CONTRACT_SIGNED": return "contract_signed" as const;
    case "VERBAL_CONFIRM": return "verbal_confirmation" as const;
    case "STRONG_PREF": return "strong_preference" as const;
    case "NOT_SELECTED": return "not_selected" as const;
    default: return undefined;
  }
};

const hasMeaningfulValue = (value: unknown): boolean => {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value === "object") return Object.values(value as UnknownRecord).some(hasMeaningfulValue);
  return true;
};

const mapRoom = (
  value: unknown,
  index: number,
  issues: LegacyMappingIssue[],
): Room | null => {
  const room = record(value);
  const roomFunction = text(room.roomFunction);
  if (!roomFunction) {
    issues.push({
      path: `/roomByRoom/${index}/roomFunction`,
      code: "missing",
      message: "Room was not migrated because its function is missing",
    });
    return null;
  }

  const podium = record(room.podiumMic);
  const wireless = record(room.wirelessMics);
  const monitors = record(room.largeMonitorsOrScreenProjector);
  const laptops = record(room.presentationLaptops);
  const clientLaptops = record(room.clientProvideOwnPresentationLaptop);
  const playback = record(room.videoPlayback);
  const audienceQa = record(room.audienceQa);
  const cameras = record(room.cameras);
  const recording = record(room.videoRecording);
  const cameraPlanMode = text(cameras.cameraPlanMode) === "Vendor Recommendation"
    ? "vendor_recommendation" as const
    : text(cameras.cameraPlanMode) === "Specific Camera Plan"
      ? "specific" as const
      : undefined;
  const cameraType = (() => {
    const value = text(cameras.cameraType);
    if (value === "PTZ Camera") return "ptz" as const;
    if (value === "Studio / Broadcast Camera") return "studio_broadcast" as const;
    if (value === "Both") return "both" as const;
    if (value === "Other — Specify") return "other" as const;
    return undefined;
  })();
  const ptzCameraCount = integer(cameras.ptzCameraQty);
  const studioCameraCount = integer(cameras.studioCameraQty);
  const otherCameraCount = integer(cameras.otherCameraQty);
  const derivedCameraCount = cameraPlanMode === "specific"
    ? cameraType === "ptz" ? ptzCameraCount
      : cameraType === "studio_broadcast" ? studioCameraCount
        : cameraType === "both" && ptzCameraCount !== undefined && studioCameraCount !== undefined
          ? ptzCameraCount + studioCameraCount
          : cameraType === "other" ? otherCameraCount : integer(cameras.camerasQty)
    : integer(cameras.camerasQty);
  const stageWash = record(room.stageWashLighting);
  const programMonitor = record(room.programConfidenceMonitor);
  const notesMonitor = record(room.notesConfidenceMonitor);
  const crewQuantitySource = record(room.showCrewQty);
  const crewQuantities = Object.fromEntries(
    Object.entries(crewQuantitySource)
      .map(([key, value]) => [key, integer(value)])
      .filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
  const scheduleEntries = Array.isArray(room.functions)
    ? room.functions.flatMap((value, functionIndex) => {
        const entry = record(value);
        const functionName = text(entry.functionName);
        if (!functionName) {
          issues.push({
            path: `/roomByRoom/${index}/functions/${functionIndex}/functionName`,
            code: "missing",
            message: "Scheduled function was not migrated because its name is missing",
          });
          return [];
        }
        return [{
          function: functionName,
          ...optional("setup", text(entry.roomSetup)),
          ...optional("scheduleDate", date(entry.scheduleDate, `/roomByRoom/${index}/functions/${functionIndex}/scheduleDate`, issues)),
          ...optional("estimatedAttendees", integer(entry.estimatedAttendees)),
          ...optional("showStartAt", dateTime(entry.showStartDateTime, `/roomByRoom/${index}/functions/${functionIndex}/showStartDateTime`, issues)),
          ...optional("showEndAt", dateTime(entry.showEndDateTime, `/roomByRoom/${index}/functions/${functionIndex}/showEndDateTime`, issues)),
        }];
      })
    : [];
  const rawLedWalls = Array.isArray(room.ledWalls) ? room.ledWalls.slice(0, 20) : [];
  const mapLedWall = (value: unknown, wallIndex: number) => {
    const wall = record(value);
    return {
      ...optional("width", measurement(wall.width, "ft", `/roomByRoom/${index}/ledWalls/${wallIndex}/width`, issues)),
      ...optional("height", measurement(wall.height, "ft", `/roomByRoom/${index}/ledWalls/${wallIndex}/height`, issues)),
      ...optional("pixelPitch", measurement(wall.pixelPitch, "mm", `/roomByRoom/${index}/ledWalls/${wallIndex}/pixelPitch`, issues)),
      ...optional("specs", text(wall.specs)),
      ...optional("shape", text(wall.shape)),
      ...optional("switcher", text(wall.switcher)),
      ...optional("notes", text(wall.notes)),
    };
  };
  const legacyLedWall = {
    ...optional("width", measurement(room.ledWallWidth, "ft", `/roomByRoom/${index}/ledWallWidth`, issues)),
    ...optional("height", measurement(room.ledWallHeight, "ft", `/roomByRoom/${index}/ledWallHeight`, issues)),
    ...optional("pixelPitch", measurement(room.ledWallPixelPitch, "mm", `/roomByRoom/${index}/ledWallPixelPitch`, issues)),
    ...optional("specs", text(room.ledWallSpecs)),
    ...optional("shape", text(room.ledWallShape)),
    ...optional("switcher", text(room.ledWallSwitcher)),
    ...optional("notes", text(room.ledWallNotes)),
  };
  const ledWalls = rawLedWalls.length > 0
    ? rawLedWalls.map(mapLedWall)
    : Object.keys(legacyLedWall).length > 0 ? [legacyLedWall] : [];
  const requestedLedWallCount = integer(room.ledWallCount);
  const activeLedWallCount = requestedLedWallCount ?? (ledWalls.length || undefined);

  return {
    id: text(room._id) ?? `room-${index + 1}`,
    function: roomFunction,
    ...optional("location", text(room.roomLocation)),
    ...optional("setup", text(room.roomSetup)),
    ...optional("scheduleDate", date(room.scheduleDate, `/roomByRoom/${index}/scheduleDate`, issues)),
    ...optional("estimatedAttendees", integer(room.estimatedAttendeesInRoom)),
    ...optional("loadInAt", dateTime(room.loadInDateTime, `/roomByRoom/${index}/loadInDateTime`, issues)),
    ...optional("rehearsalAt", dateTime(room.rehearsalDateTime, `/roomByRoom/${index}/rehearsalDateTime`, issues)),
    ...optional("showStartAt", dateTime(room.showStartDateTime, `/roomByRoom/${index}/showStartDateTime`, issues)),
    ...optional("showEndAt", dateTime(room.showEndDateTime, `/roomByRoom/${index}/showEndDateTime`, issues)),
    ...(scheduleEntries.length > 0 ? { scheduleEntries } : {}),
    audio: {
      ...optional("systemRequired", booleanOrNull(room.audioSystemRequired)),
      ...optional("systemAudienceCount", integer(room.audioSystemForHowManyPpl)),
      ...optional("podiumMicRequired", booleanOrNull(podium.podiumMic)),
      ...optional("podiumMicCount", integer(podium.podiumMicQty)),
      ...optional("wirelessMicRequired", booleanOrNull(wireless.wirelessMics)),
      ...optional("wirelessMicCount", integer(wireless.wirelessMicsQty)),
      ...optional("wirelessMicType", text(wireless.wirelessMicsType)),
      ...optional("recordingRequired", booleanOrNull(room.audioRecording)),
    },
    video: {
      ...optional("displayRequired", booleanOrNull(monitors.largeMonitorsOrScreenProjector)),
      ...optional("monitorCount", integer(monitors.numberOfMonitors)),
      ...optional("monitorSize", measurement(monitors.monitorSize, "in", `/roomByRoom/${index}/largeMonitorsOrScreenProjector/monitorSize`, issues)),
      ...optional("screenCount", integer(monitors.numberOfScreens)),
      ...optional("screenSize", measurement(monitors.screenSize, "ft", `/roomByRoom/${index}/largeMonitorsOrScreenProjector/screenSize`, issues)),
      ...optional("ledWallRequired", booleanOrNull(room.ledWall)),
      ...optional("ledWallCount", activeLedWallCount),
      ...(ledWalls.length > 0 ? { ledWalls: ledWalls.slice(0, activeLedWallCount ?? ledWalls.length) } : {}),
      ...optional("ledWallWidth", measurement(room.ledWallWidth, "ft", `/roomByRoom/${index}/ledWallWidth`, issues)),
      ...optional("ledWallHeight", measurement(room.ledWallHeight, "ft", `/roomByRoom/${index}/ledWallHeight`, issues)),
      ...optional("ledWallPixelPitch", measurement(room.ledWallPixelPitch, "mm", `/roomByRoom/${index}/ledWallPixelPitch`, issues)),
      ...optional("ledWallSpecs", text(room.ledWallSpecs)),
      ...optional("ledWallShape", text(room.ledWallShape)),
      ...optional("ledWallSwitcher", text(room.ledWallSwitcher)),
      ...optional("ledWallNotes", text(room.ledWallNotes)),
      ...optional("presentationLaptopsRequired", booleanOrNull(laptops.presentationLaptops)),
      ...optional("presentationLaptopCount", integer(laptops.presentationLaptopQty)),
      ...optional("clientLaptopsProvided", booleanOrNull(clientLaptops.clientProvideOwnPresentationLaptop)),
      ...optional("clientLaptopCount", integer(clientLaptops.clientLaptopQty)),
      ...optional("videoPlaybackRequired", booleanOrNull(playback.videoPlayback)),
      ...optional("videoPlaybackCount", integer(playback.videoPlaybackCount)),
      ...optional("videoPlaybackFormat", text(playback.videoPlaybackFormat)),
      ...optional("aspectRatio", text(room.videoFormatAspectRatio)),
      ...optional("audienceQaRequired", booleanOrNull(audienceQa.audienceQa)),
      ...optional("audienceQaMethod", text(audienceQa.audienceQaMethod)),
      ...optional("camerasRequired", booleanOrNull(cameras.cameras)),
      ...optional("cameraCount", derivedCameraCount),
      ...optional("cameraPlanMode", cameraPlanMode),
      ...optional("cameraType", cameraType),
      ...optional("ptzCameraCount", ptzCameraCount),
      ...optional("studioCameraCount", studioCameraCount),
      ...optional("otherCameraType", text(cameras.otherCameraType)),
      ...optional("otherCameraCount", otherCameraCount),
      ...optional("videoRecordingRequired", booleanOrNull(recording.videoRecording)),
      ...optional("recordingType", text(recording.videoRecordingType)),
      ...optional("programConfidenceMonitorRequired", booleanOrNull(programMonitor.programConfidenceMonitor)),
      ...optional("programConfidenceMonitorCount", integer(programMonitor.programConfidenceMonitorQty)),
      ...optional("notesConfidenceMonitorRequired", booleanOrNull(notesMonitor.notesConfidenceMonitor)),
      ...optional("notesConfidenceMonitorCount", integer(notesMonitor.notesConfidenceMonitorQty)),
      ...optional("speakerTimerRequired", booleanOrNull(room.speakerTimer)),
      ...optional("teleprompterRequired", booleanOrNull(room.teleprompterRequired ?? room.teleprompterNeeded)),
      ...optional("teleprompterBilingual", booleanOrNull(room.teleprompterBilingual)),
      ...optional("teleprompterLanguages", strings(room.teleprompterLanguages)),
    },
    lighting: {
      ...optional("stageWashRequired", booleanOrNull(stageWash.stageWashLighting)),
      ...optional("stageDimensions", text(room.stageDimensions ?? stageWash.stageWashLightingStageSize)),
      ...optional("backlighting", text(room.backlightingFor)),
      ...optional("scenicUplighting", text(room.drapeOrScenicUplighting)),
      ...optional("audienceLighting", text(room.audienceLighting)),
      ...optional("requirements", strings(room.lightingRequirements)),
    },
    production: {
      ...optional("scenicStageDesign", booleanOrNull(room.scenicStageDesign)),
      ...optional("scenicNotes", text(room.scenicStageDesignNotes)),
      ...optional("unionLabor", booleanOrNull(room.unionLabor)),
      ...optional("unionLaborDetails", text(room.unionLaborDetails)),
      ...optional("crewRoles", strings(room.showCrewNeeded)),
      ...(Object.keys(crewQuantities).length ? { crewQuantities } : {}),
      ...optional("otherRoles", text(room.otherRolesNeeded)),
      ...optional("contentVideoNeeds", text(room.contentVideoNeeds)),
    },
  };
};

export const mapLegacyProposalToV1 = (
  input: unknown,
  context: LegacyProposalContext,
): LegacyProposalMappingResult => {
  const legacy = record(input);
  const event = record(legacy.event);
  const eventType = record(event.eventType);
  const venueSchedule = record(legacy.venueSchedule);
  const contact = record(legacy.contact);
  const settings = record(legacy.proposalSettings);
  const hybrid = record(legacy.hybridVirtual);
  const remoteSpeakers = record(hybrid.remoteSpeakers);
  const captions = record(hybrid.closedCaptions);
  const creative = record(legacy.contentCreative);
  const liveDataFeeds = record(creative.liveDataFeeds);
  const videoRecording = record(legacy.videoRecordingStep);
  const editedDeliverable = record(videoRecording.editedDeliverable);
  const venue = record(legacy.venue);
  const uploads = record(legacy.uploads);
  const coVendors = record(uploads.coVendors);
  const budget = record(legacy.budget);
  const evaluationMatrix = record(budget.evaluationMatrix);
  const now = context.now ?? new Date().toISOString();
  const issues: LegacyMappingIssue[] = [];

  const eventName = text(event.eventName);
  const firstName = text(contact.contactFirstName);
  const lastName = text(contact.contactLastName);
  const email = text(contact.contactEmail);

  for (const [path, value] of [
    ["/event/eventName", eventName],
    ["/contact/contactFirstName", firstName],
    ["/contact/contactLastName", lastName],
    ["/contact/contactEmail", email],
  ] as const) {
    if (!value) issues.push({ path, code: "missing", message: "Required legacy value is missing" });
  }

  if (!eventName || !firstName || !lastName || !email) {
    return { success: false, proposal: null, issues };
  }

  const legacyRooms = Array.isArray(legacy.roomByRoom) ? legacy.roomByRoom : [];
  const rooms = legacyRooms
    .map((room, index) => mapRoom(room, index, issues))
    .filter((room): room is Room => room !== null);

  const declaredRoomCount = integer(venueSchedule.numberOfEventRooms);
  const roomCount = Math.max(1, (declaredRoomCount ?? rooms.length) || 1);
  if (declaredRoomCount === undefined) {
    issues.push({
      path: "/venueSchedule/numberOfEventRooms",
      code: "normalized",
      message: `Room count derived as ${roomCount}`,
    });
  }

  const additionalContacts = Array.isArray(contact.additionalContacts)
    ? contact.additionalContacts
        .map(record)
        .map((item) => {
          const fullName = text(item.fullName) ?? "";
          const [additionalFirstName, ...rest] = fullName.split(/\s+/);
          const additionalLastName = rest.join(" ");
          const additionalEmail = text(item.email);
          if (!additionalFirstName || !additionalLastName || !additionalEmail) return null;
          return {
            firstName: additionalFirstName,
            lastName: additionalLastName,
            fullName,
            email: additionalEmail,
            ...optional("title", text(item.titleAndRole)),
            ...optional("phone", text(item.phone)),
            ...optional("role", text(item.role)),
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
    : [];

  const coVendorDefinitions = [
    ["in_house_venue_av", coVendors.inHouseVenueAv],
    ["event_decorator", coVendors.eventDecorator],
    ["registration_technology", coVendors.registrationTech],
    ["agency_of_record", coVendors.agencyOfRecord],
    ["photographer", coVendors.photographer],
  ] as const;
  const mappedCoVendors = coVendorDefinitions
    .map(([category, value]) => {
      const item = record(value);
      if (!hasMeaningfulValue(item)) return null;
      return {
        category,
        ...optional("companyName", text(item.companyName)),
        contact: {
          ...optional("name", text(item.contactName)),
          ...optional("email", text(item.contactEmail)),
          ...optional("phone", text(item.contactPhone)),
        },
        ...optional("status", text(item.status)),
        ...optional("notes", text(item.notes)),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const evaluationWeights = Object.fromEntries(
    Object.entries(evaluationMatrix)
      .map(([key, value]) => [key, typeof value === "number" ? value : integer(value)])
      .filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );

  const unmigratedSourceFields = [
    "brandGuideFiles",
    "brandGuideUrl",
    "eventLogoFiles",
    "referenceFiles",
    "referenceUrls",
    "venueDocs",
    "ndaDocumentFiles",
  ].filter((key) => hasMeaningfulValue(uploads[key]));
  if (unmigratedSourceFields.length) {
    issues.push({
      path: "/uploads",
      code: "unmapped",
      message: `Source references require document-service IDs before migration: ${unmigratedSourceFields.join(", ")}`,
    });
  }
  if (hasMeaningfulValue(legacy.production)) {
    issues.push({
      path: "/production",
      code: "unmapped",
      message: "Legacy aggregate production fields require reconciliation with room-level production requirements",
    });
  }

  const content: ProposalContent = {
    event: {
      name: eventName,
      format: eventFormat(event.eventFormat),
      ...optional("edition", text(event.editionYear)),
      ...optional("theme", text(event.eventTheme)),
      ...optional("website", text(event.eventWebsite)),
      ...optional("startDate", date(event.startDate, "/event/startDate", issues)),
      ...optional("endDate", date(event.endDate, "/event/endDate", issues)),
      ...optional("attendeeCount", integer(event.attendees)),
      ...optional("type", text(eventType.eventType ?? event.eventType)),
      ...optional("typeOther", text(eventType.eventTypeOther ?? event.eventTypeOther)),
      ...optional("primaryAudiences", strings(event.primaryAudience)),
      ...optional("objectives", text(event.eventObjectives)),
      ...optional("toneDirections", strings(event.toneDirection)),
      ...optional("sacredConstraints", text(event.sacredConstraints)),
      ...optional("organizationBackground", text(event.aboutOrganization)),
      ...optional("statementOfWork", text(event.statementOfWork)),
      ...optional("eventProfile", text(event.eventProfile)),
      ...optional("rfpTimelineNotes", text(event.rfpTimeline)),
    },
    venueSchedule: {
      roomCount,
      ...optional("venueName", text(venueSchedule.venueName)),
      ...optional("city", text(venueSchedule.venueCity)),
      ...optional("region", text(venueSchedule.venueState)),
      ...optional("address", text(venueSchedule.venueAddress)),
      ...optional("venueType", text(venueSchedule.venueType)),
      ...optional("confirmationStatus", confirmationStatus(venueSchedule.venueConfirmedStatus)),
      ...optional("unionVenue", booleanOrNull(venueSchedule.isUnionVenue)),
      ...optional("unionJurisdictions", strings(venueSchedule.unionJurisdictions)),
      ...optional("unionJurisdictionOther", text(venueSchedule.unionJurisdictionOther)),
      ...optional("timeZone", text(venueSchedule.timeZone)),
      ...optional("loadIn", localSchedulePoint(venueSchedule.loadInDate, venueSchedule.loadInTime, "/venueSchedule/loadIn", issues)),
      ...optional("rehearsal", localSchedulePoint(venueSchedule.rehearsalDate, venueSchedule.rehearsalTime, "/venueSchedule/rehearsal", issues)),
      ...optional("showStart", localSchedulePoint(venueSchedule.showStartDate, venueSchedule.showStartTime, "/venueSchedule/showStart", issues)),
      ...optional("showEnd", localSchedulePoint(venueSchedule.showEndDate, venueSchedule.showEndTime, "/venueSchedule/showEnd", issues)),
      ...optional("strike", localSchedulePoint(venueSchedule.strikeDate, venueSchedule.strikeTime, "/venueSchedule/strike", issues)),
    },
    rooms,
    hybridVirtual: {
      ...optional("virtualAttendeeCount", integer(hybrid.virtualAttendeeEstimate)),
      ...optional("streamingPlatform", text(hybrid.streamingPlatform)),
      ...optional("streamingPlatformOther", text(hybrid.streamingPlatformOther)),
      ...optional("platformIntegrationWithAv", booleanOrNull(hybrid.platformIntegrationWithAv)),
      ...optional("streamOwner", text(hybrid.streamOwnership)),
      remoteSpeakers: {
        ...optional("required", booleanOrNull(remoteSpeakers.remoteSpeakers)),
        ...optional("count", integer(remoteSpeakers.howManyRemoteSpeakers)),
        ...optional("feedPlatform", text(remoteSpeakers.remoteFeedPlatform)),
        ...optional("techRehearsalOwner", text(remoteSpeakers.techRehearsalOwner)),
      },
      ...optional("liveVirtualQa", booleanOrNull(hybrid.liveVirtualQa)),
      ...optional("virtualOnlyBreakouts", booleanOrNull(hybrid.virtualOnlyBreakouts)),
      ...optional("dedicatedVirtualProducer", booleanOrNull(hybrid.dedicatedVirtualProducer)),
      closedCaptions: {
        ...optional("required", booleanOrNull(captions.closedCaptions)),
        ...optional("languages", strings(captions.captionLanguages)),
        ...optional("languageOther", text(captions.captionLanguageOther)),
        ...optional(
          "type",
          (() => {
            const value = text(captions.captionType)?.toLowerCase();
            return value === "ai" || value === "human" ? value : value ? "unknown" : undefined;
          })(),
        ),
      },
      ...optional("onDemandRecording", booleanOrNull(hybrid.onDemandRecording)),
      ...optional("sponsorOverlays", booleanOrNull(hybrid.sponsorOverlays)),
      ...optional("virtualNetworking", booleanOrNull(hybrid.virtualNetworking)),
    },
    contentCreative: {
      ...optional("servicesRequired", booleanOrNull(creative.contentServicesNeeded)),
      ...optional("presentationTemplateOwner", text(creative.presentationTemplateDesign)),
      ...optional("speakerSlideCollectionOwner", text(creative.speakerSlideCollection)),
      ...optional("motionGraphicsOwner", text(creative.motionGraphicsOpenerVideo)),
      ...optional("lowerThirdsOwner", text(creative.lowerThirdsNameSupers)),
      ...optional("eventLogoBrandStandardsOwner", text(creative.eventLogoBrandStandards)),
      ...optional("sizzleRecapOwner", text(creative.sizzleRecapVideo)),
      liveDataFeeds: {
        ...optional("required", booleanOrNull(liveDataFeeds.needed)),
        ...optional("owner", text(liveDataFeeds.ownership)),
      },
      ...optional("sponsorRecognitionOwner", text(creative.sponsorRecognitionContent)),
      ...optional("socialMediaCaptureOwner", text(creative.socialMediaContentCapture)),
      ...optional("virtualBackgroundOwner", text(creative.virtualBackgroundDesign)),
      ...optional("creativeDirectionNotes", text(creative.creativeDirectionNotes)),
    },
    videoRecording: {
      ...optional("required", booleanOrNull(videoRecording.videoRecordingRequired)),
      ...optional("cameraCount", integer(videoRecording.numberOfCameras)),
      ...optional("cameraPositions", strings(videoRecording.cameraPositions)),
      ...optional("imagRequired", booleanOrNull(videoRecording.imagRequired)),
      ...optional("cameraOperatorCount", integer(videoRecording.cameraOperators)),
      ...optional("isoRecordings", text(videoRecording.isoRecordings)),
      ...optional("resolution", text(videoRecording.recordingResolution)),
      ...optional("recordingMedia", text(videoRecording.recordingMedia)),
      editedDeliverable: {
        ...optional("required", booleanOrNull(editedDeliverable.needed)),
        ...optional("types", strings(editedDeliverable.deliverableType)),
        ...optional("turnaroundTime", text(editedDeliverable.turnaroundTime)),
        ...optional("reelLengthPreference", text(editedDeliverable.reelLengthPreference)),
      },
      ...optional("rawFootageTurnover", booleanOrNull(videoRecording.rawFootageTurnover)),
      ...optional("deliverableFormats", strings(videoRecording.deliverableFormat)),
      ...optional("deliveryMethods", strings(videoRecording.deliveryMethod)),
    },
    venueTechnical: {
      avContact: {
        ...optional("name", text(venue.venueAvContactName)),
        ...optional("email", text(venue.venueAvContactEmail)),
        ...optional("phone", text(venue.venueAvContactPhone)),
      },
      ...optional("inHouseAvCompanyName", text(venue.inHouseAvCompanyName)),
      ...optional("riggingRequired", booleanOrNull(venue.riggingRequired)),
      ...optional("riggingPlotOrSpecs", text(venue.riggingPlotOrSpecs)),
      ...optional("trussAndMotorsProvided", booleanOrNull(venue.trussAndMotorsProvidedByVenue)),
      ...optional("liftsProvided", booleanOrNull(venue.liftsProvidedByVenue)),
      ...optional("powerDropsRequired", booleanOrNull(venue.powerDropsRequired)),
      ...optional("powerDropAmperage", measurement(venue.powerDropAmperage, "amp", "/venue/powerDropAmperage", issues)),
      ...optional("powerDropCount", integer(venue.numberOfPowerDrops)),
      ...optional("wirelessInternetRequired", booleanOrNull(venue.wirelessInternetRequired)),
      ...optional("internetUseCases", strings(venue.internetUseCases)),
      ...optional("coiRequirements", text(venue.coiRequirements)),
      ...optional("accessRequirements", text(venue.venueAccessRequirements)),
    },
    ...(mappedCoVendors.length
      ? { vendorCoordination: { coVendors: mappedCoVendors } }
      : {}),
    confidentiality: {
      ...optional("ndaRequired", booleanOrNull(uploads.ndaRequired)),
      ...optional("ndaType", text(uploads.ndaType)),
    },
    budgetPreferences: {
      ...optional("budgetBand", text(budget.estimatedAvBudget)),
      ...optional("flexibility", text(budget.budgetFlexibility)),
      ...optional("proposalFormats", strings(budget.proposalFormatPreferences)),
      ...(Object.keys(evaluationWeights).length ? { evaluationWeights } : {}),
      ...optional("sustainabilityDeiNotes", text(budget.sustainabilityDeiNotes)),
      ...optional("vendorQuestionsDueDate", date(budget.vendorQuestionsDueDate, "/budget/vendorQuestionsDueDate", issues)),
      ...optional("vendorAnswersDate", date(budget.responseToVendorQuestionsDate, "/budget/responseToVendorQuestionsDate", issues)),
      ...optional("proposalDueDate", date(budget.proposalSubmissionDueDate, "/budget/proposalSubmissionDueDate", issues)),
      ...optional("shortlistDate", date(budget.shortlistNotificationDate, "/budget/shortlistNotificationDate", issues)),
      ...optional("vendorPresentation", booleanOrNull(budget.vendorPresentationOpportunity)),
      ...optional("vendorPresentationDate", date(budget.vendorPresentationDate, "/budget/vendorPresentationDate", issues)),
      ...optional("vendorSelectionDate", date(budget.vendorSelectionDate, "/budget/vendorSelectionDate", issues)),
      ...optional("decisionDate", date(budget.decisionDate, "/budget/decisionDate", issues)),
      ...optional("competitiveBid", booleanOrNull(budget.competitiveBid)),
      ...optional("proposalCount", integer(budget.numberOfProposals)),
      ...optional("scoringNotes", text(budget.scoringNotes)),
      ...optional("producerCallRequested", booleanOrNull(budget.callWithDxgProducer)),
      ...optional("referralSource", text(budget.howDidYouHear)),
      ...optional("referralSourceOther", text(budget.howDidYouHearOther)),
    },
    contacts: {
      primary: {
        firstName,
        lastName,
        email,
        ...optional("title", text(contact.contactTitle)),
        ...optional("organizationDisplayName", text(contact.contactOrganization)),
        ...optional("organizationLegalName", text(contact.organizationLegalName)),
        ...optional("phone", text(contact.contactPhone)),
        ...optional("phoneExtension", text(contact.contactPhoneExt)),
        ...optional("phoneType", text(contact.contactPhoneType)),
      },
      ...(additionalContacts.length ? { additional: additionalContacts } : {}),
      ...optional(
        "preferredMethod",
        (() => {
          const method = text(contact.preferredContactMethod)?.toLowerCase();
          return method === "email" || method === "phone" || method === "either" ? method : undefined;
        })(),
      ),
      ...optional("bestTimeToReach", text(contact.bestTimeToReach)),
      ...optional("additionalNotes", text(contact.anythingElse)),
    },
  };

  const proposal: ProposalV1 = {
    schemaVersion: "proposal.v1",
    id: text(legacy._id) ?? text(legacy.id) ?? "legacy-pending-id",
    organizationId: context.organizationId,
    ownerUserId: context.ownerUserId ?? text(legacy.userId) ?? "legacy-unknown-owner",
    version: Math.max(1, integer(legacy.version) ?? 1),
    lifecycle: {
      status: lifecycleStatus(legacy),
      favorite: legacy.isFavorite === true,
      ...optional("archivedAt", dateTime(legacy.archivedAt, "/archivedAt", issues)),
    },
    content,
    presentation: {
      ...optional("linkPrefix", text(settings.linkPrefix)),
      ...optional("font", text(settings.defaultFont)),
      ...optional("language", text(settings.proposalLanguage)),
      ...optional("dateFormat", text(settings.dateFormat)),
      ...optional("decimalPrecision", integer(settings.decimalPrecision)),
    },
    createdAt: dateTime(legacy.createdAt, "/createdAt", issues) ?? now,
    updatedAt: dateTime(legacy.updatedAt, "/updatedAt", issues) ?? now,
  };

  if (!validateProposalV1(proposal)) {
    issues.push(
      ...formatContractErrors(validateProposalV1.errors).map((issue) => ({
        path: issue.path,
        code: "invalid" as const,
        message: issue.message,
      })),
    );
    return { success: false, proposal: null, issues };
  }

  return { success: true, proposal, issues };
};

export const toPublicProposalV1 = (
  proposal: ProposalV1,
  publishedAt = proposal.lifecycle.publishedAt,
): ProposalPublicV1 => {
  if (!publishedAt) {
    throw new Error("A published timestamp is required for the public proposal projection");
  }
  const publicContent = { ...proposal.content };
  delete publicContent.sourceReferences;
  return {
    schemaVersion: "proposal-public.v1",
    proposalId: proposal.id,
    version: proposal.version,
    content: publicContent,
    presentation: proposal.presentation ?? {},
    publishedAt,
  };
};
