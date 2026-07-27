import { escapeHtml, renderExportPage } from "../shared/exportHtml";
import { VendorAnalysisError } from "./domain";

/**
 * Render a completed vendor analysis as a standalone comparison document.
 *
 * The analysis was readable only inside the app, one vendor at a time. The
 * decision it feeds — which vendor to shortlist — is made in a meeting, by
 * people who do not have logins, from a document someone circulates. Without an
 * export the planner retyped the verdicts into a spreadsheet, which is where
 * the cited passages stopped travelling with the claims.
 *
 * So the citations come with it. A verdict of "partial" means little on its
 * own; the sentence it was drawn from is what a reader can argue with.
 */

export const vendorAnalysisExportEnabled = (): boolean =>
  process.env.VENDOR_ANALYSIS_EXPORT_ENABLED === "true";

export type ExportFinding = {
  ordinal: number;
  kind: string;
  requirementLabel: string | null;
  requirementPath: string | null;
  verdict: string | null;
  message: string;
  needsHumanReview: boolean;
  citations: string[];
};
export type ExportEvidence = { fragmentId: string; origin: string; excerpt: string };

const VERDICT_LABELS: Record<string, string> = {
  addressed: "Addressed",
  partial: "Partial",
  missing: "Missing",
  not_applicable: "N/A",
};

const originLabel = (origin: string): string =>
  origin === "message" ? "the vendor’s message" : origin.split("/").pop() || "an attached document";

const citationBlock = (finding: ExportFinding, evidence: Map<string, ExportEvidence>): string => {
  const resolved = finding.citations.flatMap((id) => {
    const item = evidence.get(id);
    return item ? [item] : [];
  });
  // A citation that resolves to nothing is dropped rather than printed as an
  // empty quote: runs from before the evidence table exist, and an empty
  // blockquote reads as "the vendor said nothing" rather than "not recorded".
  return resolved
    .map(
      (item) =>
        `<blockquote>${escapeHtml(item.excerpt)}<br><em>— ${escapeHtml(originLabel(item.origin))}</em></blockquote>`,
    )
    .join("");
};

export const renderVendorAnalysisExport = (input: {
  eventName?: unknown;
  vendorName?: unknown;
  findings: ExportFinding[];
  evidence: ExportEvidence[];
  generatedAt: Date;
}): string => {
  if (!input.findings.length)
    throw new VendorAnalysisError(
      "NO_FINDINGS",
      "This analysis produced no findings to export.",
      409,
    );

  const evidence = new Map(input.evidence.map((item) => [item.fragmentId, item]));
  const compliance = input.findings.filter((f) => f.kind === "compliance");
  const flags = input.findings.filter((f) => f.kind === "pricing_flag" || f.kind === "production_flag");
  const questions = input.findings.filter((f) => f.kind === "vendor_question");

  const complianceTable = compliance.length
    ? `<section>
<h2>Requirement coverage</h2>
<table>
<thead><tr><th>Requirement</th><th>Verdict</th><th>Finding</th></tr></thead>
<tbody>
${compliance
  .map(
    (finding) =>
      `<tr><td>${escapeHtml(finding.requirementLabel ?? finding.requirementPath ?? "—")}</td>` +
      `<td>${escapeHtml(VERDICT_LABELS[finding.verdict ?? ""] ?? "Unrated")}${finding.needsHumanReview ? " (review recommended)" : ""}</td>` +
      `<td>${escapeHtml(finding.message)}${citationBlock(finding, evidence)}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table>
</section>`
    : "";

  const flagList = flags.length
    ? `<section>
<h2>Flags</h2>
<ul>
${flags
  .map(
    (finding) =>
      `<li><strong>${escapeHtml(finding.kind === "pricing_flag" ? "Pricing" : "Production")}:</strong> ` +
      `${escapeHtml(finding.message)}${citationBlock(finding, evidence)}</li>`,
  )
  .join("\n")}
</ul>
</section>`
    : "";

  const questionList = questions.length
    ? `<section class="note">
<h2>Questions to put back to the vendor</h2>
<ul>${questions.map((finding) => `<li>${escapeHtml(finding.message)}</li>`).join("")}</ul>
</section>`
    : "";

  const vendor = String(input.vendorName ?? "").trim();
  const event = String(input.eventName ?? "").trim();
  const counts = [
    `${compliance.length} requirement${compliance.length === 1 ? "" : "s"}`,
    flags.length ? `${flags.length} flag${flags.length === 1 ? "" : "s"}` : "",
    questions.length ? `${questions.length} question${questions.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);

  return renderExportPage({
    title: vendor ? `Vendor response review — ${vendor}` : "Vendor response review",
    subtitle: `${event ? `${event} · ` : ""}Generated ${input.generatedAt.toISOString().slice(0, 10)} · ${counts.join(" · ")}`,
    body: [complianceTable, flagList, questionList].filter(Boolean).join("\n"),
    footer:
      "Assessed with AI assistance against this proposal's recorded requirements, quoting the vendor's own words. " +
      "Verdicts are a starting point for review, not a scoring decision.",
  });
};
