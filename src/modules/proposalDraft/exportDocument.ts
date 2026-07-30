import { DRAFT_SECTION_KEYS, ProposalDraftError } from "./domain";

/**
 * Render a reviewed draft as a standalone RFP document.
 *
 * The draft was previously a dead end: accepted prose became a decision row and
 * expired after 30 days, and there was no way to get an RFP out of the
 * authenticated app at all — a planner had to publish, open the public share
 * link, and use the browser print dialog.
 *
 * Rather than merge generated prose back into the proposal, the draft IS the
 * document. The proposal holds structured questionnaire answers; the draft
 * holds narrative. Only three of the eleven draft sections have a
 * corresponding proposal field, so promoting prose into that model would
 * silently drop most of it or write it into fields that mean something else.
 *
 * HTML rather than PDF deliberately: it needs no new rendering dependency,
 * prints to PDF from any browser, and is trivially diffable in tests. A
 * server-rendered PDF is a follow-up, not a prerequisite.
 */

export const proposalExportEnabled = (): boolean =>
  process.env.PROPOSAL_EXPORT_ENABLED === "true";

export type ExportSection = {
  key: string;
  heading: string;
  decision: "accepted" | "rejected" | null;
  paragraphs: Array<{ text: string }>;
};
export type ExportGap = { code: string };

/**
 * Everything below is model output or planner input rendered into markup, so
 * every interpolation is escaped. An unescaped apostrophe is cosmetic; an
 * unescaped tag in a generated paragraph is stored XSS in a file the planner
 * forwards to vendors.
 */
const escape = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const humanizeGap = (code: string): string =>
  code.replace(/^MISSING_/, "").replace(/_/g, " ").toLowerCase();

export const renderProposalExport = (input: {
  eventName?: unknown;
  sections: ExportSection[];
  gaps?: ExportGap[];
  generatedAt: Date;
}): string => {
  // Only what a human explicitly accepted goes into the document. Undecided
  // sections are omitted rather than included-by-default: an export is the
  // artifact that leaves the building, so silence must mean "not approved".
  const accepted = input.sections.filter((section) => section.decision === "accepted");
  if (!accepted.length)
    throw new ProposalDraftError(
      "NO_ACCEPTED_SECTIONS",
      "Accept at least one draft section before exporting.",
      409,
    );

  const order = new Map<string, number>(DRAFT_SECTION_KEYS.map((key, index) => [key as string, index]));
  const ordered = [...accepted].sort(
    (a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999),
  );

  const title = String(input.eventName ?? "").trim() || "Request for Proposal";
  const body = ordered
    .map(
      (section) =>
        `<section>\n<h2>${escape(section.heading)}</h2>\n` +
        section.paragraphs.map((p) => `<p>${escape(p.text)}</p>`).join("\n") +
        `\n</section>`,
    )
    .join("\n");

  // Outstanding gaps are listed for the planner's own review copy. They are
  // what the draft could not support from the proposal, so shipping the file
  // without them would hide the document's known holes.
  const gaps = (input.gaps ?? []).length
    ? `<section class="gaps">\n<h2>Outstanding information</h2>\n<ul>` +
      (input.gaps ?? []).map((gap) => `<li>${escape(humanizeGap(gap.code))}</li>`).join("") +
      `</ul>\n</section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(title)}</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;max-width:52rem;margin:3rem auto;padding:0 1.5rem;color:#0f172a}
h1{font-size:1.75rem;margin-bottom:.25rem}
h2{font-size:1.15rem;margin-top:2rem}
.meta,.footer{color:#475569;font-size:.85rem}
.gaps{border-left:3px solid #cbd5e1;padding-left:1rem}
.footer{margin-top:3rem;border-top:1px solid #e2e8f0;padding-top:1rem}
@media print{body{margin:0;max-width:none}.gaps{page-break-inside:avoid}}
</style>
</head>
<body>
<h1>${escape(title)}</h1>
<p class="meta">Generated ${escape(input.generatedAt.toISOString().slice(0, 10))} · ${ordered.length} reviewed section${ordered.length === 1 ? "" : "s"}</p>
${body}
${gaps}
<p class="footer">Drafted with AI assistance from this proposal's recorded details and reviewed by a person before export. Only sections a reviewer accepted are included.</p>
</body>
</html>
`;
};
