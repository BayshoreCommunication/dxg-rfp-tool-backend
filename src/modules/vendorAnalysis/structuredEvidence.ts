import type { VendorResponseCalculationV1 } from "../../../contracts/generated/vendor-response-calculation-v1";
import type { VendorResponseQuestionnaireV1 } from "../../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseV1 } from "../../../contracts/generated/vendor-response-v1";

/**
 * Evidence rendered from a structured vendor submission.
 *
 * Ids are assigned by the caller so structured and document evidence share one
 * numbering scheme and citations stay stable across both.
 */
export type StructuredEvidenceFragment = {
  text: string;
  origin: string;
  locator: Record<string, unknown>;
};

type Money = { amountMinor: number; currency: string } | null | undefined;

const money = (value: Money, fallbackCurrency = "USD"): string => {
  const minor = Number(value?.amountMinor ?? 0);
  const currency = value?.currency || fallbackCurrency;
  if (!Number.isFinite(minor)) return `${currency} 0.00`;
  return `${currency} ${(minor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const clean = (value: unknown): string => String(value ?? "").trim();

/** Drop sections the vendor left empty rather than citing a blank heading. */
const paragraph = (heading: string, lines: Array<unknown>) => {
  const body = lines.map(clean).filter(Boolean);
  return body.length ? `${heading}\n${body.join("\n")}` : "";
};

const labelIndex = (
  entries: ReadonlyArray<{ id?: string; specId?: string; roomId?: string; label?: string; name?: string }> | undefined,
): Map<string, string> => {
  const index = new Map<string, string>();
  for (const entry of entries ?? []) {
    const key = entry.id ?? entry.specId ?? entry.roomId;
    const label = entry.label ?? entry.name;
    if (key && label) index.set(key, label);
  }
  return index;
};

export const buildStructuredVendorEvidence = (input: {
  response?: VendorResponseV1 | null;
  questionnaire?: VendorResponseQuestionnaireV1 | null;
  calculation?: VendorResponseCalculationV1 | null;
}): StructuredEvidenceFragment[] => {
  const response = input.response;
  if (!response) return [];
  const questionnaire = input.questionnaire ?? null;
  const fragments: StructuredEvidenceFragment[] = [];

  const push = (text: string, origin: string, locator: Record<string, unknown>) => {
    const body = clean(text);
    if (body) fragments.push({ text: body, origin, locator });
  };

  const roomLabels = labelIndex(questionnaire?.rooms);
  const crewRoleLabels = labelIndex(questionnaire?.crew?.roles);
  const categoryLabels = labelIndex(questionnaire?.pricing?.equipmentCategories);
  const specLabels = new Map<string, string>();
  const specRequirements = new Map<string, string>();
  for (const room of questionnaire?.rooms ?? []) {
    for (const spec of room.specs ?? []) {
      if (!spec?.specId) continue;
      if (spec.label) specLabels.set(spec.specId, spec.label);
      if (spec.requirementText) specRequirements.set(spec.specId, spec.requirementText);
    }
  }

  const identity = response.identity;
  const profile = response.companyProfile;
  push(
    paragraph("Vendor identity and company profile", [
      identity?.vendorName && `Vendor: ${identity.vendorName}`,
      identity?.submittedBy && `Submitted by: ${identity.submittedBy}`,
      profile?.legalName && `Legal company name: ${profile.legalName}`,
      profile?.headquarters && `Headquarters: ${profile.headquarters}`,
      profile?.yearsInBusiness != null && `Years in business: ${profile.yearsInBusiness}`,
      profile?.staffCount != null && `Full-time staff: ${profile.staffCount}`,
      profile?.largestComparableEvent && `Largest comparable event: ${profile.largestComparableEvent}`,
      (profile?.clientMix ?? []).length
        ? `Client mix: ${(profile?.clientMix ?? [])
            .map((entry) => `${entry.categoryId} ${entry.percent}%`)
            .join(", ")}`
        : "",
    ]),
    "structured:company-profile",
    { kind: "structured", path: "/companyProfile" },
  );

  for (const room of response.rooms ?? []) {
    const roomName = roomLabels.get(room.roomId) ?? room.roomId;

    // Each verdict carries the client's own requirement text alongside the
    // vendor's answer, so a reader sees what was asked and what was promised.
    const verdicts = (room.specResponses ?? []).map((spec) => {
      const label = specLabels.get(spec.specId) ?? spec.specId;
      const requirement = specRequirements.get(spec.specId);
      const note = clean(spec.note);
      return [
        `${label}: ${String(spec.status ?? "").toUpperCase()}`,
        requirement ? `  Client requirement: ${requirement}` : "",
        note ? `  Vendor note: ${note}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    });
    push(
      paragraph(`Room ${roomName} — specification verdicts`, verdicts),
      `structured:room:${room.roomId}:specs`,
      { kind: "structured", path: `/rooms/${room.roomId}/specResponses` },
    );

    const equipment = (room.equipmentLines ?? []).map((line) => {
      const category = categoryLabels.get(line.categoryId) ?? line.categoryId;
      return `${category} x${line.quantity}: ${clean(line.description)}`;
    });
    const categoryTotals = (room.categoryTotals ?? []).map(
      (total) => `${categoryLabels.get(total.categoryId) ?? total.categoryId} subtotal: ${money(total.amount)}`,
    );
    push(
      paragraph(`Room ${roomName} — equipment proposed`, [...equipment, ...categoryTotals]),
      `structured:room:${room.roomId}:equipment`,
      { kind: "structured", path: `/rooms/${room.roomId}/equipmentLines` },
    );

    const labor = (room.laborLines ?? []).map((line) => {
      const role = crewRoleLabels.get(line.roleId) ?? line.roleId;
      const notes = clean(line.notes);
      return `${role}: ${line.days} day(s), ${line.regularHours} regular hours, ${line.overtimeHours} overtime hours${
        line.travel ? ", requires travel" : ""
      }${notes ? ` — ${notes}` : ""}`;
    });
    push(
      paragraph(`Room ${roomName} — labor proposed`, [
        ...labor,
        `Room labor subtotal: ${money(room.laborSubtotal)}`,
      ]),
      `structured:room:${room.roomId}:labor`,
      { kind: "structured", path: `/rooms/${room.roomId}/laborLines` },
    );

    push(
      paragraph(`Room ${roomName} — streaming delivery`, [
        room.hybrid?.feedHandoff && `Stream feed handoff: ${room.hybrid.feedHandoff}`,
        room.hybrid?.redundancy && `Broadcast redundancy: ${room.hybrid.redundancy}`,
        room.hybrid?.virtualAudienceExperience &&
          `Virtual audience experience: ${room.hybrid.virtualAudienceExperience}`,
      ]),
      `structured:room:${room.roomId}:hybrid`,
      { kind: "structured", path: `/rooms/${room.roomId}/hybrid` },
    );
  }

  push(
    paragraph(
      "Event-wide platform integration plan",
      [response.platformIntegrationPlan],
    ),
    "structured:platform-integration",
    { kind: "structured", path: "/platformIntegrationPlan" },
  );

  push(
    paragraph(
      "Proposed crew",
      (response.crew ?? []).map((member) => {
        const role = crewRoleLabels.get(member.roleId) ?? member.roleId;
        return `${clean(member.name)} — ${role}\n  ${clean(member.bio)}`;
      }),
    ),
    "structured:crew",
    { kind: "structured", path: "/crew" },
  );

  push(
    paragraph(
      "Comparable references",
      (response.references ?? []).map((reference) => {
        const dates = [reference.startDate, reference.endDate].filter(Boolean).join(" to ");
        return [
          `${clean(reference.clientName)} — ${clean(reference.eventName)}`,
          reference.attendance != null ? `  Attendance: ${reference.attendance}` : "",
          dates ? `  Dates: ${dates}` : "",
          reference.currentStatus ? `  Status: ${clean(reference.currentStatus)}` : "",
          reference.comparable ? "  Marked as a comparable event" : "",
          reference.servicesProvided ? `  Services provided: ${clean(reference.servicesProvided)}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }),
    ),
    "structured:references",
    { kind: "structured", path: "/references" },
  );

  // Pricing comes from the frozen server calculation rather than the vendor's
  // own arithmetic, and is rendered as text so it can be cited like any other
  // evidence. Without this the commercial criterion has nothing to read and
  // scores every vendor at zero.
  const calculation = input.calculation ?? null;
  const currency = calculation?.currency || "USD";
  const roomTotals = (calculation?.roomTotals ?? []).map(
    (total) =>
      `Room ${roomLabels.get(total.roomId) ?? total.roomId} total: ${money(
        { amountMinor: total.roomTotalMinor, currency },
        currency,
      )}`,
  );
  push(
    paragraph("Pricing", [
      calculation
        ? `Grand total: ${money({ amountMinor: calculation.grandTotalMinor, currency }, currency)}`
        : "",
      calculation
        ? `Equipment subtotal: ${money({ amountMinor: calculation.equipmentSubtotalMinor, currency }, currency)}`
        : "",
      calculation
        ? `Labor subtotal: ${money({ amountMinor: calculation.laborSubtotalMinor, currency }, currency)}`
        : "",
      calculation
        ? `Travel subtotal: ${money({ amountMinor: calculation.travelSubtotalMinor, currency }, currency)}`
        : "",
      calculation ? `Fees: ${money({ amountMinor: calculation.feeSubtotalMinor, currency }, currency)}` : "",
      calculation ? `Tax: ${money({ amountMinor: calculation.taxSubtotalMinor, currency }, currency)}` : "",
      calculation ? `Discount: ${money({ amountMinor: calculation.discountMinor, currency }, currency)}` : "",
      ...roomTotals,
      (response.pricing?.assumptionsExclusions ?? []).length
        ? `Assumptions and exclusions:\n${(response.pricing?.assumptionsExclusions ?? [])
            .map((entry) => `  - ${clean(entry)}`)
            .join("\n")}`
        : "",
    ]),
    "structured:pricing",
    { kind: "structured", path: "/pricing" },
  );

  push(
    paragraph(
      "Alternates proposed",
      (response.alternates ?? []).map((alternate) =>
        [clean(alternate.title), clean(alternate.tradeoff)].filter(Boolean).join("\n  "),
      ),
    ),
    "structured:alternates",
    { kind: "structured", path: "/alternates" },
  );

  push(paragraph("Value adds", [response.valueAdds]), "structured:value-adds", {
    kind: "structured",
    path: "/valueAdds",
  });

  return fragments;
};
