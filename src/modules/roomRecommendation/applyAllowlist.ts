import { RoomRecommendationError } from "./domain";

/**
 * The only room fields a room recommendation may ever write, mirroring how
 * canonicalMapping.ts governs scalar candidate application. rooms[] was
 * deliberately excluded from that allowlist, so this file is the explicit,
 * reviewed expansion — kept intentionally tiny. Adding a field here means
 * adding a normalizer, a test, and a documented rule that produces it.
 *
 * Values are normalized to exactly what the legacy wizard stores (display
 * strings such as "Yes" and quantities persisted as strings).
 */
type RoomFieldMapping = {
  /** Room-relative canonical path segments, e.g. "wirelessMics/wirelessMicsQty". */
  relativePath: string;
  /** Room-relative Mongo dot path, e.g. "wirelessMics.wirelessMicsQty". */
  relativeMongoPath: string;
  /** "set" writes a scalar; "append" adds to an array via $addToSet (never removes). */
  kind: "set" | "append";
  normalize: (value: unknown) => string;
};

const invalid = (message: string): never => {
  throw new RoomRecommendationError("INVALID_RECOMMENDATION_VALUE", message);
};

const yesNo = (value: unknown): string => {
  const key = String(value).trim().toLowerCase();
  if (key === "yes" || key === "true") return "Yes";
  if (key === "no" || key === "false") return "No";
  return invalid("Room yes/no value is invalid.");
};

const quantity = (min: number, max: number) => (value: unknown): string => {
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return invalid(`Room quantity must be between ${min} and ${max}.`);
  return String(parsed);
};

// Exact option strings from the Room Specifications wizard's Type select,
// with the aliases a rule or reviewer plausibly types.
const WIRELESS_MIC_TYPES: Array<{ stored: string; aliases: string[] }> = [
  { stored: "Handhelds", aliases: ["handheld", "handhelds", "handheld mics"] },
  { stored: "Headset Mics", aliases: ["headset", "headsets", "headset mics"] },
  { stored: "Lavalier (Lav) Mics", aliases: ["lavalier", "lav", "lavs", "lav mics", "lavalier (lav) mics"] },
  { stored: "Both", aliases: ["both"] },
];
const wirelessMicType = (value: unknown): string => {
  const key = String(value).trim().toLowerCase();
  const match = WIRELESS_MIC_TYPES.find((option) => option.stored.toLowerCase() === key || option.aliases.includes(key));
  return match ? match.stored : invalid("Wireless microphone type is invalid.");
};

// Exact option strings from the wizard's Show Crew checklist. Appends are the
// only allowed array operation: a recommendation can add a missing role but
// can never remove or reorder what the planner selected.
const CREW_ROLE_OPTIONS = [
  "A1 (Audio Engineer)",
  "A2 (Audio Assist)",
  "V1 (Video Engineer)",
  "V2 (Video Assist)",
  "TD (Technical Director)",
  "L1 (Lighting Director)",
  "Graphics Operator",
  "Camera Operator",
  "Showcaller",
  "Stage Manager",
  "Teleprompter Operator",
  "Breakout Room Manager",
];
const crewRole = (value: unknown): string => {
  const key = String(value).trim().toLowerCase();
  const match = CREW_ROLE_OPTIONS.find((option) => option.toLowerCase() === key);
  return match ?? invalid("Crew role is not a recognized show-crew option.");
};

const MAPPINGS: RoomFieldMapping[] = [
  { relativePath: "wirelessMics/wirelessMics", relativeMongoPath: "wirelessMics.wirelessMics", kind: "set", normalize: yesNo },
  { relativePath: "wirelessMics/wirelessMicsQty", relativeMongoPath: "wirelessMics.wirelessMicsQty", kind: "set", normalize: quantity(1, 200) },
  { relativePath: "wirelessMics/wirelessMicsType", relativeMongoPath: "wirelessMics.wirelessMicsType", kind: "set", normalize: wirelessMicType },
  { relativePath: "showCrewNeeded", relativeMongoPath: "showCrewNeeded", kind: "append", normalize: crewRole },
];

const byRelativePath = new Map(MAPPINGS.map((mapping) => [mapping.relativePath, mapping]));

export const applyAllowlistedRelativePaths = Object.freeze(MAPPINGS.map((mapping) => mapping.relativePath));

export type NormalizedRoomWrite = { path: string; mongoPath: string; mongoValue: string; kind: "set" | "append"; roomIndex: number; relativeMongoPath: string };

/**
 * Resolve a full recommendation path ("/content/roomByRoom/2/wirelessMics/wirelessMicsQty")
 * into a validated Mongo write. Throws for any path outside the allowlist —
 * validation is never bypassed to make a recommendation applicable.
 */
export const normalizeRoomWrite = (path: string, value: unknown): NormalizedRoomWrite => {
  if (path.includes("__proto__") || path.includes("prototype") || path.includes("constructor") || path.includes("$") || path.includes("."))
    throw new RoomRecommendationError("RECOMMENDATION_PATH_DENIED", "Recommendation path is prohibited.", 403);
  const match = /^\/content\/roomByRoom\/(\d{1,3})\/(.+)$/.exec(path);
  if (!match) throw new RoomRecommendationError("RECOMMENDATION_PATH_DENIED", "Recommendation path is not a room path.", 403);
  const roomIndex = Number(match[1]);
  if (!Number.isInteger(roomIndex) || roomIndex < 0 || roomIndex > 199)
    throw new RoomRecommendationError("RECOMMENDATION_PATH_DENIED", "Recommendation room index is out of range.", 403);
  const mapping = byRelativePath.get(match[2]);
  if (!mapping) throw new RoomRecommendationError("RECOMMENDATION_PATH_DENIED", "Recommendation path is not approved for application.", 403);
  return {
    path,
    mongoPath: `roomByRoom.${roomIndex}.${mapping.relativeMongoPath}`,
    mongoValue: mapping.normalize(value),
    kind: mapping.kind,
    roomIndex,
    relativeMongoPath: mapping.relativeMongoPath,
  };
};

export const isApplyEligiblePath = (path: string): boolean => {
  const match = /^\/content\/roomByRoom\/\d{1,3}\/(.+)$/.exec(path);
  return match !== null && byRelativePath.has(match[1]);
};
