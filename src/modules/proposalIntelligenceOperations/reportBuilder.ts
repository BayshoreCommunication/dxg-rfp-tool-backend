/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export const REPORT_TYPES = ["executive_html", "executive_pdf", "comparison_xlsx", "evaluator_html", "decision_html", "clarification_html", "audit_json"] as const;
export type ReportType = typeof REPORT_TYPES[number];

type ReportInput = {
  reportType: ReportType;
  proposalTitle: string;
  workspace: any;
  clarifications: any[];
  audit: any;
};

export type BuiltReport = { body: Buffer; mediaType: string; filename: string; contentChecksum: string; reportManifest: Record<string, unknown> };

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character));
const label = (value: unknown) => String(value ?? "").replace(/_/g, " ").replace(/^./, (letter: string) => letter.toUpperCase());
const money = (amount: unknown, currency: unknown) => amount === null || amount === undefined ? "Not submitted" : `${String(currency || "USD")} ${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (value: unknown) => String(value ?? "").slice(0, 12);
const safeFilename = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "proposal";
const checksum = (body: Buffer) => crypto.createHash("sha256").update(body).digest("hex");

const manifest = (input: ReportInput) => ({
  schemaVersion: "proposal-intelligence-report.v1",
  reportType: input.reportType,
  generatedAt: new Date().toISOString(),
  proposalTitle: input.proposalTitle,
  runId: input.workspace.run.runId,
  comparisonStatus: input.workspace.run.status,
  comparisonCreatedAt: input.workspace.run.createdAt,
  comparisonCompletedAt: input.workspace.run.completedAt,
  manifestChecksum: input.workspace.manifest.checksum,
  requirementSetVersion: input.workspace.manifest.requirementSetVersion,
  evaluationMatrixVersion: input.workspace.manifest.evaluationMatrixVersion,
  freshness: input.workspace.freshness,
  permissions: { viewCommercial: input.workspace.intelligence.permissions.viewCommercial === true },
  policies: input.workspace.manifest.policies,
});

const style = `
  :root{color-scheme:light;font-family:Inter,Arial,sans-serif;color:#172033;background:#f6f8fb}
  *{box-sizing:border-box}body{margin:0;background:#f6f8fb}.page{max-width:1120px;margin:0 auto;padding:40px 28px 64px}
  .hero{background:#fff;border:1px solid #dce3eb;border-radius:22px;padding:30px}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-weight:800;font-size:11px;color:#0078b8}
  h1{font-size:32px;line-height:1.15;margin:8px 0 10px}h2{font-size:19px;margin:0 0 12px}h3{font-size:14px;margin:0 0 6px}.muted{color:#5d697a}.small{font-size:12px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:18px}.card,.section{background:#fff;border:1px solid #dce3eb;border-radius:16px;padding:18px}.card strong{display:block;font-size:24px;margin-top:8px}.section{margin-top:18px}
  table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:10px;border-bottom:1px solid #e5eaf0;text-align:left;vertical-align:top}th{background:#f6f8fb;font-size:11px}.badge{display:inline-block;border-radius:999px;padding:4px 8px;background:#e8f2f8;color:#075d87;font-size:10px;font-weight:800}.warn{background:#fff3cd;color:#7a5700}.danger{background:#fee7e7;color:#9a2727}.good{background:#e4f6ec;color:#19643a}.manifest{font-family:ui-monospace,monospace;word-break:break-all;background:#172033;color:#f7fbff;border-radius:14px;padding:14px;font-size:11px;line-height:1.6}.pagebreak{break-before:page}@media(max-width:760px){.grid{grid-template-columns:1fr 1fr}.page{padding:20px 12px}h1{font-size:25px}}@media print{body{background:#fff}.page{max-width:none;padding:0}.hero,.card,.section{break-inside:avoid}}
`;

const htmlDocument = (title: string, body: string, reportManifest: Record<string, unknown>) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${style}</style></head><body><main class="page">${body}<section class="section"><h2>Report provenance</h2><p class="small muted">This report is a deterministic projection of a frozen comparison. It does not rank vendors or recommend an award.</p><pre class="manifest">${escapeHtml(JSON.stringify(reportManifest, null, 2))}</pre></section></main></body></html>`;

const summaryCards = (workspace: any) => {
  const overview = workspace.intelligence.overview;
  return `<div class="grid">${[
    ["Responses", overview.responseCount], ["Approved requirements", overview.approvedRequirementCount], ["Mandatory gaps", overview.mandatoryGapCount], ["Unresolved reviews", overview.unresolvedReviewCount],
  ].map(([name, value]) => `<div class="card"><span class="small muted">${escapeHtml(name)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>`;
};

const vendorOverview = (workspace: any) => `<section class="section"><h2>Vendor comparison overview</h2><table><thead><tr><th>Vendor</th><th>Mandatory gaps</th><th>Review flags</th><th>Human contribution</th>${workspace.intelligence.permissions.viewCommercial ? "<th>Submitted price</th><th>Normalized price</th>" : ""}</tr></thead><tbody>${workspace.participants.map((participant: any) => {
  const requirements = workspace.intelligence.requirements.flatMap((requirement: any) => requirement.vendors.filter((vendor: any) => vendor.participantId === participant.participantId).map((vendor: any) => ({ requirement, vendor })));
  const mandatoryGaps = requirements.filter((item: any) => item.requirement.mandatoryStatus === "mandatory" && ["missing", "contradictory"].includes(item.vendor.verdict)).length;
  const reviews = requirements.filter((item: any) => item.vendor.needsHumanReview).length;
  const evaluation = workspace.intelligence.evaluation.find((item: any) => item.participantId === participant.participantId);
  const commercial = workspace.intelligence.commercial.find((item: any) => item.participantId === participant.participantId);
  return `<tr><td><strong>${escapeHtml(participant.vendorLabel)}</strong><br><span class="small muted">Version ${escapeHtml(short(participant.versionId))}</span></td><td>${mandatoryGaps}</td><td>${reviews}</td><td>${escapeHtml(evaluation?.weightedContributionTotal ?? 0)}</td>${workspace.intelligence.permissions.viewCommercial ? `<td>${escapeHtml(money(commercial?.submittedTotal, commercial?.submittedCurrency))}</td><td>${commercial?.comparable ? escapeHtml(money(commercial.normalizedTotal, commercial.normalizedCurrency)) : "Not comparable"}</td>` : ""}</tr>`;
}).join("")}</tbody></table></section>`;

const risks = (workspace: any) => `<section class="section"><h2>Evidence-backed risks and clarification candidates</h2>${workspace.intelligence.risks.length ? workspace.intelligence.risks.map((risk: any) => `<article class="card" style="margin-top:10px"><span class="badge ${risk.severity === "high" ? "danger" : risk.severity === "medium" ? "warn" : ""}">${escapeHtml(label(risk.severity))}</span> <span class="badge">${escapeHtml(label(risk.category))}</span><h3 style="margin-top:10px">${escapeHtml(risk.title)}</h3><p class="small muted">${escapeHtml(risk.vendorLabel)}</p><p>${escapeHtml(risk.basis)}</p>${risk.question ? `<p class="small"><strong>Clarification:</strong> ${escapeHtml(risk.question)}</p>` : ""}</article>`).join("") : "<p class=\"muted\">No persisted risk flags.</p>"}</section>`;

const decisions = (workspace: any) => `<section class="section"><h2>Human decision history</h2>${workspace.intelligence.decisions.length ? `<table><thead><tr><th>Recorded</th><th>Decision</th><th>Vendors</th><th>Rationale</th></tr></thead><tbody>${workspace.intelligence.decisions.map((decision: any) => `<tr><td>${escapeHtml(new Date(decision.createdAt).toISOString())}</td><td>${escapeHtml(label(decision.decisionType))}</td><td>${escapeHtml(decision.selectedParticipantIds.map((id: string) => workspace.participants.find((participant: any) => participant.participantId === id)?.vendorLabel ?? "Historical participant").join(", ") || "None")}</td><td>${escapeHtml(decision.rationale)}</td></tr>`).join("")}</tbody></table>` : "<p class=\"muted\">No human decision has been recorded.</p>"}</section>`;

const evaluations = (workspace: any) => `<section class="section"><h2>Human evaluation status</h2><table><thead><tr><th>Vendor</th><th>Weighted contribution</th><th>Submitted scores</th><th>Evaluator completion</th><th>Declared conflicts</th></tr></thead><tbody>${workspace.intelligence.evaluation.map((item: any) => `<tr><td>${escapeHtml(item.vendorLabel)}</td><td>${escapeHtml(Number(item.weightedContributionTotal).toFixed(2))}</td><td>${escapeHtml(item.submittedScores)}</td><td>${escapeHtml(item.completedEvaluatorCount)}/${escapeHtml(item.evaluatorCount)}</td><td>${escapeHtml(item.conflictCount)}</td></tr>`).join("")}</tbody></table><p class="small muted">Values are backend-owned human rubric contributions. Vendor order is the frozen manifest order, not a rank.</p></section>`;

const clarificationsHtml = (clarifications: any[]) => `<section class="section"><h2>Clarification sets</h2>${clarifications.length ? clarifications.map((set) => `<article class="card" style="margin-top:10px"><h3>Set ${escapeHtml(set.setVersion)} - ${escapeHtml(label(set.status))}</h3><p class="small muted">Checksum ${escapeHtml(set.contentChecksum)}</p><ol>${set.questions.filter((question: any) => question.disposition === "included").map((question: any) => `<li><strong>${escapeHtml(question.vendorLabel)}:</strong> ${escapeHtml(question.question)}</li>`).join("")}</ol></article>`).join("") : "<p class=\"muted\">No clarification set has been prepared.</p>"}</section>`;

const hero = (input: ReportInput, title: string) => `<header class="hero"><p class="eyebrow">RFPilot proposal intelligence</p><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(input.proposalTitle)} · Frozen run ${escapeHtml(input.workspace.run.runId)} · ${escapeHtml(label(input.workspace.freshness.state))}</p>${input.workspace.freshness.state === "stale" ? `<p><span class="badge warn">Historical - ${escapeHtml(input.workspace.freshness.reasons.map(label).join(", "))}</span></p>` : ""}</header>`;

const buildHtml = (input: ReportInput, reportManifest: Record<string, unknown>) => {
  let title = "Executive comparison report", content = `${summaryCards(input.workspace)}${vendorOverview(input.workspace)}${risks(input.workspace)}${evaluations(input.workspace)}${decisions(input.workspace)}${clarificationsHtml(input.clarifications)}`;
  if (input.reportType === "evaluator_html") { title = "Evaluator status report"; content = evaluations(input.workspace); }
  if (input.reportType === "decision_html") { title = "Human decision report"; content = `${vendorOverview(input.workspace)}${evaluations(input.workspace)}${decisions(input.workspace)}`; }
  if (input.reportType === "clarification_html") { title = "Clarification report"; content = `${risks(input.workspace)}${clarificationsHtml(input.clarifications)}`; }
  return htmlDocument(`${input.proposalTitle} - ${title}`, `${hero(input, title)}${content}`, reportManifest);
};

const wrap = (font: PDFFont, text: string, size: number, maxWidth: number) => {
  const words = text.replace(/[^\x20-\x7E]/g, " ").split(/\s+/).filter(Boolean), lines: string[] = []; let line = "";
  for (const word of words) { const candidate = line ? `${line} ${word}` : word; if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate; else { if (line) lines.push(line); line = word; } }
  if (line) lines.push(line); return lines.length ? lines : [""];
};

const buildPdf = async (input: ReportInput, reportManifest: Record<string, unknown>) => {
  const pdf = await PDFDocument.create(); const regular = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = 612, height = 792, margin = 48, contentWidth = width - (margin * 2); let page: PDFPage, y = 0, pageNumber = 0;
  const addPage = () => { page = pdf.addPage([width, height]); pageNumber += 1; y = height - margin; page.drawRectangle({ x: 0, y: height - 10, width, height: 10, color: rgb(0, 0.54, 0.82) }); page.drawText(`RFPilot Proposal Intelligence - ${input.proposalTitle}`.slice(0, 90), { x: margin, y: 22, size: 8, font: regular, color: rgb(.35, .4, .48) }); page.drawText(`Page ${pageNumber}`, { x: width - margin - 42, y: 22, size: 8, font: regular, color: rgb(.35, .4, .48) }); };
  const ensure = (space: number) => { if (y - space < 50) addPage(); };
  const text = (value: string, options: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; gap?: number } = {}) => { const size = options.size ?? 10, font = options.font ?? regular, lines = wrap(font, value, size, contentWidth); ensure((lines.length * (size + 4)) + (options.gap ?? 4)); for (const line of lines) { page.drawText(line, { x: margin, y, size, font, color: options.color ?? rgb(.12, .16, .23) }); y -= size + 4; } y -= options.gap ?? 4; };
  const heading = (value: string) => { ensure(34); y -= 6; text(value, { size: 16, font: bold, color: rgb(0, .38, .62), gap: 8 }); };
  addPage(); text("RFPILOT PROPOSAL INTELLIGENCE", { size: 10, font: bold, color: rgb(0, .46, .71), gap: 12 }); text("Executive comparison report", { size: 26, font: bold, gap: 10 }); text(input.proposalTitle, { size: 15, font: bold, gap: 12 }); text(`Frozen run ${input.workspace.run.runId}`, { size: 10 }); text(`Manifest checksum ${input.workspace.manifest.checksum}`, { size: 9 }); text(`Freshness: ${label(input.workspace.freshness.state)}${input.workspace.freshness.reasons.length ? ` - ${input.workspace.freshness.reasons.map(label).join(", ")}` : ""}`, { size: 10, color: input.workspace.freshness.state === "stale" ? rgb(.68, .38, 0) : rgb(.1, .48, .28), gap: 14 });
  text("This deterministic report presents persisted evidence and human evaluation state. It does not rank vendors or recommend an award.", { size: 11, gap: 18 });
  heading("Executive summary"); const overview = input.workspace.intelligence.overview; text(`${overview.responseCount} responses | ${overview.approvedRequirementCount} approved requirements | ${overview.mandatoryGapCount} mandatory gaps | ${overview.unresolvedReviewCount} unresolved reviews`, { size: 11 });
  heading("Vendor overview");
  for (const participant of input.workspace.participants) { ensure(46); const evaluation = input.workspace.intelligence.evaluation.find((item: any) => item.participantId === participant.participantId); const commercial = input.workspace.intelligence.commercial.find((item: any) => item.participantId === participant.participantId); text(participant.vendorLabel, { size: 12, font: bold, gap: 2 }); text(`Human weighted contribution: ${Number(evaluation?.weightedContributionTotal ?? 0).toFixed(2)} | Evaluators complete: ${evaluation?.completedEvaluatorCount ?? 0}/${evaluation?.evaluatorCount ?? 0}${input.workspace.intelligence.permissions.viewCommercial ? ` | Submitted: ${money(commercial?.submittedTotal, commercial?.submittedCurrency)} | Normalized: ${commercial?.comparable ? money(commercial?.normalizedTotal, commercial?.normalizedCurrency) : "Not comparable"}` : " | Commercial values sealed"}`, { size: 9, gap: 8 }); }
  heading("Evidence-backed risks"); if (!input.workspace.intelligence.risks.length) text("No persisted risk flags."); else for (const risk of input.workspace.intelligence.risks) { ensure(46); text(`${label(risk.severity)} - ${risk.vendorLabel} - ${risk.title}`, { size: 11, font: bold, gap: 2 }); text(risk.basis, { size: 9, gap: 6 }); }
  heading("Human decisions"); if (!input.workspace.intelligence.decisions.length) text("No human decision has been recorded."); else for (const decision of input.workspace.intelligence.decisions) { ensure(46); text(`${label(decision.decisionType)} - ${new Date(decision.createdAt).toISOString()}`, { size: 11, font: bold, gap: 2 }); text(decision.rationale, { size: 9, gap: 7 }); }
  heading("Clarification status"); if (!input.clarifications.length) text("No clarification set has been prepared."); else for (const set of input.clarifications) text(`Set ${set.setVersion} - ${label(set.status)} - ${set.questions.filter((question: any) => question.disposition === "included").length} included questions`, { size: 10 });
  heading("Report provenance"); for (const [key, value] of Object.entries(reportManifest)) text(`${label(key)}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`, { size: 8, gap: 1 });
  const bytes = Buffer.from(await pdf.save()); return bytes;
};

const buildWorkbook = async (input: ReportInput, reportManifest: Record<string, unknown>) => {
  const workbook = new ExcelJS.Workbook(); workbook.creator = "RFPilot"; workbook.title = `${input.proposalTitle} comparison`; workbook.subject = "Frozen proposal intelligence comparison"; workbook.created = new Date(String(reportManifest.generatedAt));
  const addSheet = (name: string, columns: Array<{ header: string; key: string; width: number }>) => { const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] }); sheet.columns = columns; sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0078B8" } }; sheet.autoFilter = { from: "A1", to: `${String.fromCharCode(64 + columns.length)}1` }; return sheet; };
  const requirements = addSheet("Requirements", [{ header: "Requirement", key: "requirement", width: 42 }, { header: "Kind", key: "kind", width: 18 }, { header: "Mandatory", key: "mandatory", width: 14 }, { header: "Vendor", key: "vendor", width: 28 }, { header: "Verdict", key: "verdict", width: 20 }, { header: "Human review", key: "review", width: 14 }, { header: "Rationale", key: "rationale", width: 65 }, { header: "Evidence sources", key: "evidence", width: 50 }]);
  for (const requirement of input.workspace.intelligence.requirements) for (const vendor of requirement.vendors) requirements.addRow({ requirement: requirement.title, kind: label(requirement.kind), mandatory: requirement.mandatoryStatus === "mandatory" ? "Yes" : "No", vendor: vendor.vendorLabel, verdict: label(vendor.verdict), review: vendor.needsHumanReview ? "Required" : "No", rationale: vendor.rationale, evidence: vendor.evidence.map((item: any) => `${item.sourceLabel} (${Object.entries(item.locator).map(([key, value]) => `${key}:${value}`).join(", ")})`).join("; ") });
  if (input.workspace.intelligence.permissions.viewCommercial) { const commercial = addSheet("Commercial", [{ header: "Vendor", key: "vendor", width: 28 }, { header: "Submitted total", key: "submitted", width: 20 }, { header: "Submitted currency", key: "submittedCurrency", width: 18 }, { header: "Comparable", key: "comparable", width: 14 }, { header: "Normalized total", key: "normalized", width: 20 }, { header: "Normalized currency", key: "normalizedCurrency", width: 18 }, { header: "Refusal codes", key: "refusal", width: 40 }, { header: "Policy", key: "policy", width: 28 }]); for (const item of input.workspace.intelligence.commercial) commercial.addRow({ vendor: item.vendorLabel, submitted: item.submittedTotal, submittedCurrency: item.submittedCurrency, comparable: item.comparable ? "Yes" : "No", normalized: item.normalizedTotal, normalizedCurrency: item.normalizedCurrency, refusal: item.refusalCodes.join(", "), policy: item.policyVersion }); }
  const riskSheet = addSheet("Risks", [{ header: "Vendor", key: "vendor", width: 28 }, { header: "Severity", key: "severity", width: 14 }, { header: "Category", key: "category", width: 24 }, { header: "Title", key: "title", width: 40 }, { header: "Basis", key: "basis", width: 70 }, { header: "Clarification", key: "question", width: 65 }]); for (const item of input.workspace.intelligence.risks) riskSheet.addRow({ vendor: item.vendorLabel, severity: label(item.severity), category: label(item.category), title: item.title, basis: item.basis, question: item.question });
  const evaluation = addSheet("Evaluation", [{ header: "Vendor", key: "vendor", width: 28 }, { header: "Weighted contribution", key: "contribution", width: 24 }, { header: "Submitted scores", key: "scores", width: 18 }, { header: "Completed evaluators", key: "completed", width: 20 }, { header: "Assigned evaluators", key: "assigned", width: 20 }, { header: "Conflicts", key: "conflicts", width: 14 }]); for (const item of input.workspace.intelligence.evaluation) evaluation.addRow({ vendor: item.vendorLabel, contribution: item.weightedContributionTotal, scores: item.submittedScores, completed: item.completedEvaluatorCount, assigned: item.evaluatorCount, conflicts: item.conflictCount });
  const decision = addSheet("Decisions", [{ header: "Recorded", key: "recorded", width: 28 }, { header: "Decision", key: "decision", width: 18 }, { header: "Vendors", key: "vendors", width: 40 }, { header: "Rationale", key: "rationale", width: 80 }, { header: "Stale acknowledged", key: "stale", width: 20 }]); for (const item of input.workspace.intelligence.decisions) decision.addRow({ recorded: item.createdAt, decision: label(item.decisionType), vendors: item.selectedParticipantIds.map((id: string) => input.workspace.participants.find((participant: any) => participant.participantId === id)?.vendorLabel ?? "Historical participant").join(", "), rationale: item.rationale, stale: item.staleAcknowledged ? "Yes" : "No" });
  const clarification = addSheet("Clarifications", [{ header: "Set version", key: "version", width: 15 }, { header: "Status", key: "status", width: 18 }, { header: "Vendor", key: "vendor", width: 28 }, { header: "Disposition", key: "disposition", width: 18 }, { header: "Question", key: "question", width: 90 }]); for (const set of input.clarifications) for (const item of set.questions) clarification.addRow({ version: set.setVersion, status: label(set.status), vendor: item.vendorLabel, disposition: label(item.disposition), question: item.question });
  const manifestSheet = addSheet("Manifest", [{ header: "Field", key: "field", width: 32 }, { header: "Value", key: "value", width: 110 }]); for (const [key, value] of Object.entries(reportManifest)) manifestSheet.addRow({ field: label(key), value: typeof value === "object" ? JSON.stringify(value) : String(value) });
  for (const sheet of workbook.worksheets) { sheet.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; }); }
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

export const buildProposalIntelligenceReport = async (input: ReportInput): Promise<BuiltReport> => {
  const reportManifest = manifest(input), base = `${safeFilename(input.proposalTitle)}-${short(input.workspace.run.runId)}`;
  let body: Buffer, mediaType: string, filename: string;
  if (input.reportType === "executive_pdf") { body = await buildPdf(input, reportManifest); mediaType = "application/pdf"; filename = `${base}-executive.pdf`; }
  else if (input.reportType === "comparison_xlsx") { body = await buildWorkbook(input, reportManifest); mediaType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; filename = `${base}-comparison.xlsx`; }
  else if (input.reportType === "audit_json") { body = Buffer.from(JSON.stringify({ reportManifest, audit: input.audit }, null, 2)); mediaType = "application/json; charset=utf-8"; filename = `${base}-audit.json`; }
  else { const html = buildHtml(input, reportManifest); body = Buffer.from(html); mediaType = "text/html; charset=utf-8"; filename = `${base}-${input.reportType.replace("_html", "")}.html`; }
  return { body, mediaType, filename, contentChecksum: checksum(body), reportManifest };
};
