import type { VendorResponseQuestionnaireV1 } from "../../../../contracts/generated/vendor-response-questionnaire-v1";

/**
 * Turn a flattened structured field into a line a reader — or a model — can
 * interpret without the schema in front of them.
 *
 * The provenance flattener records one fragment per leaf with a JSON-pointer
 * path, which is exactly right for citation but opaque as evidence:
 * `/calculation/grandTotalMinor: 7670000` carries no label, no currency and no
 * hint that it is a price. This resolves questionnaire labels, formats minor
 * units as money, and attaches the client requirement to a spec verdict, so the
 * same fragment reads as `Grand total: USD 76,700.00`.
 *
 * The path is untouched — only the rendered text changes.
 */

export type StructuredFragmentLabels = {
  rooms: Map<string, string>;
  specs: Map<string, { label: string; requirementText: string; roomId: string }>;
  roles: Map<string, string>;
  categories: Map<string, string>;
  currency: string;
};

const pointerSegments = (path: string): string[] =>
  path
    .split("/")
    .filter(Boolean)
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));

/** `grandTotalMinor` -> `Grand total`, `legalName` -> `Legal name`. */
const humanize = (segment: string): string => {
  const words = segment
    .replace(/Minor$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : segment;
};

const isMinorUnits = (segment: string): boolean => /Minor$/.test(segment);

const money = (value: unknown, currency: string): string => {
  const minor = Number(value);
  if (!Number.isFinite(minor)) return String(value);
  return `${currency} ${(minor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

export const structuredFragmentLabels = (
  questionnaire: VendorResponseQuestionnaireV1 | null | undefined,
  currency?: string | null,
): StructuredFragmentLabels => {
  const rooms = new Map<string, string>();
  const specs = new Map<string, { label: string; requirementText: string; roomId: string }>();
  const roles = new Map<string, string>();
  const categories = new Map<string, string>();
  for (const room of questionnaire?.rooms ?? []) {
    if (room?.roomId) rooms.set(room.roomId, room.name || room.roomId);
    for (const spec of room?.specs ?? []) {
      if (!spec?.specId) continue;
      specs.set(spec.specId, {
        label: spec.label || spec.specId,
        requirementText: spec.requirementText || "",
        roomId: room?.roomId ?? "",
      });
    }
  }
  for (const role of questionnaire?.crew?.roles ?? []) {
    if (role?.id) roles.set(role.id, role.label || role.id);
  }
  for (const category of questionnaire?.pricing?.equipmentCategories ?? []) {
    if (category?.id) categories.set(category.id, category.label || category.id);
  }
  return {
    rooms,
    specs,
    roles,
    categories,
    currency: currency || questionnaire?.pricing?.currency || "USD",
  };
};

/** Prefix a line with the room it belongs to, when the path names one. */
const roomPrefix = (segments: string[], labels: StructuredFragmentLabels): string => {
  const roomsIndex = segments.indexOf("rooms");
  const candidate = roomsIndex >= 0 ? segments[roomsIndex + 1] : "";
  const roomTotalsIndex = segments.indexOf("roomTotals");
  const totalsCandidate = roomTotalsIndex >= 0 ? segments[roomTotalsIndex + 1] : "";
  const roomId = candidate || totalsCandidate;
  if (!roomId) return "";
  return `Room ${labels.rooms.get(roomId) ?? roomId} — `;
};

export const describeStructuredFragment = (input: {
  path: string;
  value: string | number | boolean;
  provenance: "vendor_stated" | "server_calculated";
  labels: StructuredFragmentLabels;
}): string => {
  const { path, value, labels } = input;
  const segments = pointerSegments(path);
  const leaf = segments[segments.length - 1] ?? path;
  const prefix = roomPrefix(segments, labels);

  // A spec verdict is the single most consequential structured field: it is the
  // vendor answering a specific client requirement. Rendered alone as
  // `status: exception` it is unusable, so it carries its requirement with it.
  const specIndex = segments.indexOf("specResponses");
  if (specIndex >= 0) {
    const specId = segments[specIndex + 1] ?? "";
    const spec = labels.specs.get(specId);
    const specLabel = spec?.label ?? specId;
    if (leaf === "status") {
      const requirement = spec?.requirementText ? ` (client requirement: ${spec.requirementText})` : "";
      return `${prefix}${specLabel} verdict: ${String(value).toUpperCase()}${requirement}`;
    }
    if (leaf === "note") {
      return `${prefix}${specLabel} — vendor note: ${String(value)}`;
    }
    return `${prefix}${specLabel} ${humanize(leaf).toLowerCase()}: ${String(value)}`;
  }

  if (isMinorUnits(leaf)) {
    return `${prefix}${humanize(leaf)}: ${money(value, labels.currency)}`;
  }

  if (leaf === "roleId") {
    return `${prefix}Role: ${labels.roles.get(String(value)) ?? String(value)}`;
  }
  if (leaf === "categoryId") {
    return `${prefix}Category: ${labels.categories.get(String(value)) ?? String(value)}`;
  }
  if (leaf === "roomId") {
    return `Room: ${labels.rooms.get(String(value)) ?? String(value)}`;
  }

  return `${prefix}${humanize(leaf)}: ${String(value)}`;
};
