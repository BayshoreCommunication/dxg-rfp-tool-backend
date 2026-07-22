// Package templates. The engine prices a *configuration*, never a catalog: a
// template names the components a room type actually needs, each component
// resolves to one representative approved record, and quantities come from the
// proposal (or from a documented default that is surfaced as an assumption).

import type { ProposalFacts } from "./proposalAccess";

export type ComponentKind = "equipment" | "labor";
export type Component = {
  key: string;
  label: string;
  kind: ComponentKind;
  category: string;
  subcategory: string | RegExp;
  /** quantity_dimension the record must carry, so "per box/day" is never mixed with "per unit/day". */
  dimension?: string;
  /** Prefers a representative item (matched against item label + spec); falls back to the whole pool. */
  labelHint?: RegExp;
  quantity: (drivers: Drivers) => number;
  driver: string;
  applies?: (facts: ProposalFacts, drivers: Drivers) => boolean;
  /** Workbook's killer feature: a projector implies a screen, mics imply a sound system. */
  implied?: boolean;
  /** In-house AV markup never touches interpretation, captioning, connectivity or management. */
  inHouseExempt?: boolean;
  unionExempt?: boolean;
};
export type PackageTemplate = {
  key: string;
  label: string;
  category: string;
  applies: (facts: ProposalFacts, drivers: Drivers) => boolean;
  components: Component[];
};

export type Drivers = {
  days: number;
  breakoutRooms: number;
  hoursPerBreakout: number;
  wirelessChannelsPerBreakout: number;
  speakerBoxesPerBreakout: number;
  lineArrayBoxes: number;
  generalSessionMics: number;
  ledWashFixtures: number;
  trussFeet: number;
  stageDecks: number;
  ledWallSqFt: number;
  cameras: number;
  coreCrewHours: number;
};

// Documented planning defaults. Every one of these is echoed back as an
// assumption whenever it is actually used, so nothing is silently invented.
export const DRIVER_DEFAULTS = {
  hoursPerBreakout: 10,
  wirelessChannelsPerBreakout: 2,
  speakerBoxesPerBreakout: 2,
  lineArrayBoxes: 4,
  generalSessionMics: 4,
  ledWashFixtures: 12,
  trussFeet: 80,
  stageDecks: 12,
  ledWallSqFt: 200,
  cameras: 2,
  coreCrewHours: 10,
} as const;

const ATTENDEES_PER_BOX = 250;

export type DriverAssumption = { key: string; label: string; note: string; templateKey: string };

export const deriveDrivers = (facts: ProposalFacts): { drivers: Drivers; assumptions: DriverAssumption[] } => {
  const assumptions: DriverAssumption[] = [];
  const assume = (key: string, label: string, note: string, templateKey: string) => assumptions.push({ key, label, note, templateKey });

  if (facts.breakoutRoomsDerived)
    assume("breakout_room_count", "Breakout room count derived", `${facts.declaredRoomCount} rooms were declared without a room-by-room breakdown; one is assumed to be the general session and ${facts.breakoutRoomCount} to be breakouts.`, "BREAKOUT_ROOM");
  assume("breakout_tech_hours", "Breakout technician call", `${DRIVER_DEFAULTS.hoursPerBreakout} technician hours per breakout room per show day (standard call) - confirm the schedule.`, "BREAKOUT_ROOM");
  if (facts.wirelessChannels === null)
    assume("breakout_wireless_channels", "Wireless channels per breakout", `${DRIVER_DEFAULTS.wirelessChannelsPerBreakout} wireless channels per breakout room - confirm the channel count.`, "BREAKOUT_ROOM");
  assume("breakout_sound_scale", "Breakout sound system size", `${DRIVER_DEFAULTS.speakerBoxesPerBreakout} powered speakers per breakout room - confirm room size and audience.`, "BREAKOUT_ROOM");

  const lineArrayBoxes = facts.attendees === null
    ? DRIVER_DEFAULTS.lineArrayBoxes
    : Math.min(Math.max(Math.ceil(facts.attendees / ATTENDEES_PER_BOX), DRIVER_DEFAULTS.lineArrayBoxes), 16);
  if (facts.attendees === null)
    assume("general_session_audio_scale", "General session audio scale", `${DRIVER_DEFAULTS.lineArrayBoxes} main speakers assumed because the audience size is not stated.`, "GENERAL_SESSION");
  assume("general_session_mics", "General session wireless channels", `${DRIVER_DEFAULTS.generalSessionMics} wireless channels on the main stage - confirm presenter count.`, "GENERAL_SESSION");
  assume("general_session_lighting_rig", "General session lighting rig", `${DRIVER_DEFAULTS.ledWashFixtures} LED wash fixtures on ${DRIVER_DEFAULTS.trussFeet} ft of truss - confirm the lighting plot.`, "GENERAL_SESSION");
  assume("general_session_stage", "General session stage size", `${DRIVER_DEFAULTS.stageDecks} stage decks (roughly ${DRIVER_DEFAULTS.stageDecks * 32} sq ft) - confirm stage dimensions.`, "GENERAL_SESSION");
  assume("general_session_crew_call", "General session crew call", `${DRIVER_DEFAULTS.coreCrewHours} hours per core crew role per show day - confirm load-in, rehearsal and strike.`, "GENERAL_SESSION");
  if (facts.ledWallRequested && facts.ledWallSqFt === null)
    assume("led_wall_area", "LED wall area", `${DRIVER_DEFAULTS.ledWallSqFt} sq ft of LED assumed because no wall dimensions were given.`, "GENERAL_SESSION");
  if (facts.cameraCount === null)
    assume("camera_count", "Camera count", `${DRIVER_DEFAULTS.cameras} cameras assumed because no camera count was given.`, "RECORDING");
  assume("connectivity_drops", "Connectivity scope", "One managed network drop assumed - confirm bandwidth and how many drops the show needs.", "CONNECTIVITY");

  return {
    drivers: {
      days: facts.days,
      breakoutRooms: facts.breakoutRoomCount,
      hoursPerBreakout: DRIVER_DEFAULTS.hoursPerBreakout,
      wirelessChannelsPerBreakout: facts.wirelessChannels ?? DRIVER_DEFAULTS.wirelessChannelsPerBreakout,
      speakerBoxesPerBreakout: DRIVER_DEFAULTS.speakerBoxesPerBreakout,
      lineArrayBoxes,
      generalSessionMics: DRIVER_DEFAULTS.generalSessionMics,
      ledWashFixtures: DRIVER_DEFAULTS.ledWashFixtures,
      trussFeet: DRIVER_DEFAULTS.trussFeet,
      stageDecks: DRIVER_DEFAULTS.stageDecks,
      ledWallSqFt: facts.ledWallSqFt ?? DRIVER_DEFAULTS.ledWallSqFt,
      cameras: facts.cameraCount ?? DRIVER_DEFAULTS.cameras,
      coreCrewHours: DRIVER_DEFAULTS.coreCrewHours,
    },
    assumptions,
  };
};

const BREAKOUT_ROOM: PackageTemplate = {
  key: "BREAKOUT_ROOM",
  label: "Breakout rooms",
  category: "breakout_room",
  applies: (_facts, drivers) => drivers.breakoutRooms > 0,
  components: [
    { key: "breakout_projector", label: "Projector", kind: "equipment", category: "video", subcategory: "Projector", dimension: "each", labelHint: /breakout/i, driver: "rooms", quantity: (d) => d.breakoutRooms },
    { key: "breakout_screen", label: "Screen", kind: "equipment", category: "video", subcategory: "Screen", dimension: "each", implied: true, driver: "rooms", quantity: (d) => d.breakoutRooms },
    { key: "breakout_confidence_monitor", label: "Confidence monitor", kind: "equipment", category: "video", subcategory: "Confidence Monitor", dimension: "each", driver: "rooms", quantity: (d) => d.breakoutRooms },
    { key: "breakout_wireless_mic", label: "Wireless microphones", kind: "equipment", category: "audio", subcategory: "Wireless Mic", dimension: "channel", driver: "channels", quantity: (d) => d.breakoutRooms * d.wirelessChannelsPerBreakout },
    { key: "breakout_sound_system", label: "Room sound system", kind: "equipment", category: "audio", subcategory: "Speakers", dimension: "box", implied: true, driver: "boxes", quantity: (d) => d.breakoutRooms * d.speakerBoxesPerBreakout },
    { key: "breakout_audio_cabling", label: "Room audio cabling", kind: "equipment", category: "audio", subcategory: "Cabling", driver: "rooms", quantity: (d) => d.breakoutRooms },
    { key: "breakout_playback", label: "Playback laptop", kind: "equipment", category: "audio", subcategory: "Playback Computer", dimension: "each", driver: "rooms", quantity: (d) => d.breakoutRooms },
    { key: "breakout_technician", label: "Breakout technician", kind: "labor", category: "labor", subcategory: "Stage", labelHint: /breakout technician/i, driver: "hours", quantity: (d) => d.breakoutRooms * d.hoursPerBreakout * d.days },
  ],
};

const GENERAL_SESSION: PackageTemplate = {
  key: "GENERAL_SESSION",
  label: "General session",
  category: "general_session",
  applies: () => true,
  components: [
    { key: "gs_line_array", label: "Main speakers", kind: "equipment", category: "audio", subcategory: "Speakers", dimension: "box", driver: "boxes", quantity: (d) => d.lineArrayBoxes },
    { key: "gs_console", label: "Digital console", kind: "equipment", category: "audio", subcategory: "Digital Console", dimension: "each", driver: "each", quantity: () => 1 },
    { key: "gs_wireless_mic", label: "Wireless microphones", kind: "equipment", category: "audio", subcategory: "Wireless Mic", dimension: "channel", driver: "channels", quantity: (d) => d.generalSessionMics },
    { key: "gs_comms", label: "Intercom", kind: "equipment", category: "audio", subcategory: "Intercom", driver: "each", quantity: () => 1 },
    { key: "gs_led_wall", label: "LED wall", kind: "equipment", category: "video", subcategory: "LED Wall", dimension: "sq_ft", driver: "sq_ft", applies: (facts) => facts.ledWallRequested, quantity: (d) => d.ledWallSqFt },
    { key: "gs_projector", label: "Projection", kind: "equipment", category: "video", subcategory: "Projector", dimension: "each", driver: "each", applies: (facts) => !facts.ledWallRequested, quantity: () => 2 },
    { key: "gs_switcher", label: "Switcher", kind: "equipment", category: "video", subcategory: "Switcher", dimension: "each", driver: "each", quantity: () => 1 },
    { key: "gs_playback", label: "Playback and graphics", kind: "equipment", category: "video", subcategory: "Playback", dimension: "each", driver: "each", quantity: () => 1 },
    { key: "gs_lighting_console", label: "Lighting console", kind: "equipment", category: "lighting", subcategory: "Console", dimension: "each", driver: "each", quantity: () => 1 },
    { key: "gs_led_wash", label: "LED wash fixtures", kind: "equipment", category: "lighting", subcategory: "Fixture - LED Wash", dimension: "fixture", driver: "fixtures", quantity: (d) => d.ledWashFixtures },
    { key: "gs_truss", label: "Truss", kind: "equipment", category: "lighting", subcategory: "Truss", dimension: "linear_ft", driver: "linear_ft", quantity: (d) => d.trussFeet },
    { key: "gs_stage_deck", label: "Staging", kind: "equipment", category: "staging", subcategory: "Stage Deck", dimension: "deck", driver: "decks", quantity: (d) => d.stageDecks },
    { key: "gs_a1", label: "A1 audio lead", kind: "labor", category: "labor", subcategory: "Audio", labelHint: /^A1\b/, driver: "hours", quantity: (d) => d.coreCrewHours * d.days },
    { key: "gs_v1", label: "V1 video lead", kind: "labor", category: "labor", subcategory: "Video", labelHint: /^V1\b/, driver: "hours", quantity: (d) => d.coreCrewHours * d.days },
    { key: "gs_l1", label: "L1 lighting lead", kind: "labor", category: "labor", subcategory: "Lighting", labelHint: /^L1\b/, driver: "hours", quantity: (d) => d.coreCrewHours * d.days },
    { key: "gs_td", label: "Technical director", kind: "labor", category: "labor", subcategory: "Stage", labelHint: /technical director/i, driver: "hours", quantity: (d) => d.coreCrewHours * d.days },
    { key: "gs_management", label: "Production management", kind: "labor", category: "production_management", subcategory: "Management", dimension: "each", inHouseExempt: true, unionExempt: true, driver: "days", quantity: (d) => d.days },
  ],
};

const RECORDING: PackageTemplate = {
  key: "RECORDING",
  label: "Recording and cameras",
  category: "video",
  applies: (facts) => facts.recordingRequested,
  components: [
    { key: "recording_camera", label: "Cameras", kind: "equipment", category: "video", subcategory: "Camera", dimension: "camera", driver: "cameras", quantity: (d) => d.cameras },
    { key: "recording_camera_support", label: "Camera support", kind: "equipment", category: "video", subcategory: "Camera Support", dimension: "each", implied: true, driver: "cameras", quantity: (d) => d.cameras },
    { key: "recording_camera_operator", label: "Camera operators", kind: "labor", category: "labor", subcategory: "Video", labelHint: /camera operator/i, driver: "hours", quantity: (d) => d.cameras * d.coreCrewHours * d.days },
  ],
};

const HYBRID: PackageTemplate = {
  key: "HYBRID",
  label: "Hybrid and streaming",
  category: "streaming_hybrid",
  applies: (facts) => facts.hybridRequested,
  components: [
    { key: "hybrid_encoder", label: "Encoder", kind: "equipment", category: "streaming_hybrid", subcategory: "Encoding", dimension: "each", driver: "each", quantity: () => 1 },
    { key: "hybrid_package", label: "Streaming package", kind: "equipment", category: "streaming_hybrid", subcategory: "Package", driver: "each", quantity: () => 1 },
    { key: "hybrid_operator", label: "Streaming operator", kind: "labor", category: "labor", subcategory: "Streaming", driver: "hours", quantity: (d) => d.coreCrewHours * d.days },
  ],
};

const CONNECTIVITY: PackageTemplate = {
  key: "CONNECTIVITY",
  label: "Connectivity",
  category: "connectivity",
  applies: (facts) => facts.internetRequested,
  components: [
    { key: "connectivity_internet", label: "Managed network drop", kind: "equipment", category: "connectivity", subcategory: "Internet", dimension: "each", inHouseExempt: true, driver: "each", quantity: () => 1 },
  ],
};

export const PACKAGE_TEMPLATES: PackageTemplate[] = [GENERAL_SESSION, BREAKOUT_ROOM, RECORDING, HYBRID, CONNECTIVITY];
