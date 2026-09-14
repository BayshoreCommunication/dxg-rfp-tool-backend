import type { VendorSubmissionTimelineVersion } from "../domain/ports/vendorResponseReadRepository";

const escapeHtml = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const money = (amountMinor: number, currency: string, precision: number) => {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).format(amountMinor / (10 ** precision));
  } catch {
    return `${currency} ${(amountMinor / (10 ** precision)).toFixed(precision)}`;
  }
};

const row = (label: string, value: unknown, provenance: string) =>
  `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td><td><span class="source ${provenance}">${escapeHtml(provenance.replace(/_/g, " "))}</span></td></tr>`;

const section = (title: string, body: string) =>
  `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;

export const vendorResponseExportPayload = (input: {
  proposalTitle: string;
  version: VendorSubmissionTimelineVersion;
}) => ({
  exportSchemaVersion: "vendor-response-export.v1",
  exportedAt: new Date().toISOString(),
  proposalTitle: input.proposalTitle,
  submissionVersion: {
    versionId: input.version.versionId,
    versionNumber: input.version.versionNumber,
    parentVersionId: input.version.parentVersionId,
    format: input.version.format,
    receivedAt: input.version.receivedAt,
    manifestChecksum: input.version.manifestChecksum,
  },
  provenanceVocabulary: {
    vendor_stated: "Entered directly by the vendor in the structured response.",
    server_calculated: "Calculated and frozen by the server when this version was submitted.",
    document_extracted: "Read from an attached document and may require planner confirmation.",
    planner_confirmed: "Reviewed or corrected by an authenticated planner.",
  },
  questionnaire: input.version.questionnaire,
  structuredResponse: input.version.structuredResponse,
  calculationSnapshot: input.version.calculationSnapshot,
  documents: input.version.documents.map(({ url: _url, ...document }) => document),
  retiredDocuments: input.version.retiredDocuments,
  legacy: input.version.format === "legacy_unstructured"
    ? { message: input.version.message }
    : null,
});

export const renderVendorResponsePrintHtml = (input: {
  proposalTitle: string;
  version: VendorSubmissionTimelineVersion;
}) => {
  const { version } = input;
  const questionnaire = version.questionnaire;
  const response = version.structuredResponse;
  const calculation = version.calculationSnapshot;
  const precision = questionnaire?.context.decimalPrecision ?? 2;
  const currency = calculation?.currency ?? questionnaire?.context.currency ?? "USD";
  const roomById = new Map(questionnaire?.rooms.map((room) => [room.roomId, room]) ?? []);
  const roleById = new Map(questionnaire?.crew.roles.map((role) => [role.id, role.label]) ?? []);
  const purposeById = new Map(questionnaire?.documents.categories.map((item) => [item.purposeId, item.label]) ?? []);

  const overview = [
    row("Vendor", version.vendorName, "vendor_stated"),
    row("Submitted by", version.submittedBy, "vendor_stated"),
    row("Received", version.receivedAt, "server_calculated"),
    row("Response format", version.format, "server_calculated"),
    row("Submission version", version.versionNumber, "server_calculated"),
    row("Questionnaire version", questionnaire?.questionnaireVersion ?? "Legacy", "server_calculated"),
    row("Manifest checksum", version.manifestChecksum, "server_calculated"),
  ].join("");

  const calculations = calculation
    ? [
        row("Grand total", money(calculation.grandTotalMinor, currency, precision), "server_calculated"),
        row("Equipment", money(calculation.equipmentSubtotalMinor, currency, precision), "server_calculated"),
        row("Labor", money(calculation.laborSubtotalMinor, currency, precision), "server_calculated"),
        row("Travel", money(calculation.travelSubtotalMinor, currency, precision), "server_calculated"),
        row("Fees and tax", money(calculation.feeSubtotalMinor + calculation.taxSubtotalMinor, currency, precision), "server_calculated"),
        row("Discount", money(calculation.discountMinor, currency, precision), "server_calculated"),
        row("Specifications answered", `${calculation.specCounts.answered} of ${calculation.specCounts.total}`, "server_calculated"),
        row("Comply / substitute / exception", `${calculation.specCounts.comply} / ${calculation.specCounts.substitute} / ${calculation.specCounts.exception}`, "server_calculated"),
        row("Requested room nights", calculation.requestedRoomNights, "server_calculated"),
        row("Required completion", `${calculation.completion.percent}%`, "server_calculated"),
      ].join("")
    : row("Commercial total", "Not available for this legacy response", "document_extracted");

  const roomSections = response?.rooms.map((roomResponse) => {
    const room = roomById.get(roomResponse.roomId);
    const roomTotal = calculation?.roomTotals.find((item) => item.roomId === roomResponse.roomId);
    const specs = roomResponse.specResponses.map((spec) => {
      const definition = room?.specs.find((item) => item.specId === spec.specId);
      return `<li><strong>${escapeHtml(definition?.label ?? spec.specId)}</strong>: ${escapeHtml(spec.status)}${spec.note ? ` — ${escapeHtml(spec.note)}` : ""} <span class="source vendor_stated">vendor stated</span></li>`;
    }).join("");
    const labor = roomResponse.laborLines.map((line) =>
      `<li>${escapeHtml(roleById.get(line.roleId) ?? line.roleId)}: ${line.days} day(s), ${line.regularHours} regular hour(s), ${line.overtimeHours} overtime hour(s)${line.travel ? ", travel required" : ""}</li>`,
    ).join("");
    return `<article class="room"><h3>${escapeHtml(room?.name ?? roomResponse.roomId)}</h3>${roomTotal ? `<p class="total">${escapeHtml(money(roomTotal.roomTotalMinor, currency, precision))} <span class="source server_calculated">server calculated</span></p>` : ""}<h4>Specifications</h4><ul>${specs || "<li>None</li>"}</ul><h4>Labor</h4><ul>${labor || "<li>None</li>"}</ul></article>`;
  }).join("") ?? "<p>Legacy response: structured room answers were not collected.</p>";

  const acknowledgements = response?.acknowledgements.map((answer) => {
    const definition = questionnaire?.acknowledgements.find((item) => item.acknowledgementId === answer.acknowledgementId);
    return `<li><strong>${answer.accepted ? "Accepted" : "Not accepted"}</strong> — ${escapeHtml(definition?.text ?? answer.acknowledgementId)}${answer.acceptedAt ? ` at ${escapeHtml(answer.acceptedAt)}` : ""}</li>`;
  }).join("") ?? "<li>Not captured for this legacy response.</li>";

  const crew = response?.crew.map((member) =>
    `<li><strong>${escapeHtml(member.name)}</strong> — ${escapeHtml(roleById.get(member.roleId) ?? member.roleId)}<br>${escapeHtml(member.bio)}</li>`,
  ).join("") ?? "";
  const references = response?.references.map((reference) =>
    `<li><strong>${escapeHtml(reference.clientName)}</strong> — ${escapeHtml(reference.eventName)}; ${escapeHtml(reference.servicesProvided)}${reference.comparable ? "; comparable event" : ""}</li>`,
  ).join("") ?? "";
  const alternates = response?.alternates.map((alternate) =>
    `<li><strong>${escapeHtml(alternate.title)}</strong> — ${escapeHtml(alternate.tradeoff)}; ${escapeHtml(money(alternate.costDelta.amountMinor, currency, precision))}${alternate.recommended ? "; vendor recommended" : ""}</li>`,
  ).join("") ?? "";
  const documents = version.documents.map((document) =>
    `<li><strong>${escapeHtml(document.name)}</strong> — ${escapeHtml(purposeById.get(document.purposeId ?? "") ?? document.purposeId ?? "Legacy attachment")}; ${escapeHtml(document.versionDisposition)}; ${escapeHtml(document.scanStatus)}</li>`,
  ).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(version.vendorName)} — ${escapeHtml(input.proposalTitle)}</title><style>
    :root{font-family:Arial,sans-serif;color:#16283c;background:#eef3f6}*{box-sizing:border-box}body{margin:0}.page{max-width:980px;margin:24px auto;background:#fff;padding:42px;border:1px solid #dce4eb}h1{margin:0;font-size:30px}h2{margin:32px 0 12px;padding-bottom:8px;border-bottom:2px solid #2fc6f5;font-size:19px}h3{margin:0;font-size:16px}h4{margin:14px 0 4px;font-size:12px;text-transform:uppercase;color:#607487}p,li,td,th{font-size:13px;line-height:1.55}.eyebrow{text-transform:uppercase;letter-spacing:.12em;color:#0075b4;font-weight:700;font-size:11px}.meta{color:#607487}table{width:100%;border-collapse:collapse}th,td{padding:9px;text-align:left;border-bottom:1px solid #e6edf2;vertical-align:top}th{width:26%;color:#52687b}.source{display:inline-block;border-radius:999px;padding:2px 7px;font-size:9px;text-transform:uppercase;font-weight:700;white-space:nowrap}.vendor_stated{background:#e8f6fd;color:#0069a0}.server_calculated{background:#ecfdf5;color:#047857}.document_extracted{background:#fff7ed;color:#9a3412}.room{break-inside:avoid;border:1px solid #dce4eb;border-radius:10px;padding:16px;margin:12px 0}.total{font-weight:700}ul{padding-left:20px}.footer{margin-top:36px;border-top:1px solid #dce4eb;padding-top:14px;color:#718496;font-size:11px}@media print{body{background:#fff}.page{border:0;margin:0;max-width:none;padding:12mm}.no-print{display:none}}
  </style></head><body><main class="page"><p class="eyebrow">RFPilot immutable response record</p><h1>${escapeHtml(version.vendorName)}</h1><p class="meta">${escapeHtml(input.proposalTitle)} · Version ${version.versionNumber}</p>${section("Record overview", `<table>${overview}</table>`)}${section("Frozen calculation", `<table>${calculations}</table>`)}${section("Acknowledgments", `<ul>${acknowledgements}</ul>`)}${section("Room responses", roomSections)}${section("Crew and travel", `<ul>${crew || "<li>No crew was listed.</li>"}</ul>${response ? `<p>Requested room nights: <strong>${calculation?.requestedRoomNights ?? 0}</strong> <span class="source server_calculated">server calculated</span></p>` : ""}`)}${section("Alternates", `<ul>${alternates || "<li>No alternates were listed.</li>"}</ul>`)}${section("References", `<ul>${references || "<li>No structured references were listed.</li>"}</ul>`)}${section("Documents", `<ul>${documents || "<li>No files were attached.</li>"}</ul>`)}${response ? section("Value-adds", `<p>${escapeHtml(response.valueAdds || "None provided.")} <span class="source vendor_stated">vendor stated</span></p>`) : section("Legacy response message", `<p>${escapeHtml(version.message || "No message was included.")}</p>`)}<p class="footer">This export is a deterministic view of immutable submission version ${escapeHtml(version.versionId)}. Structured vendor-entered values and frozen server calculations are labeled separately from document-extracted or planner-confirmed values.</p></main></body></html>`;
};
