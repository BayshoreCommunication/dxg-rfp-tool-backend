import { escapeHtml, formatMoney, renderExportPage } from "../shared/exportHtml";
import { InvestmentError } from "./domain";

/**
 * Render an investment estimate as a standalone budget document.
 *
 * The estimate is what a planner takes to the person who approves the money,
 * and that person does not have a login. Without an export the ranges were
 * retyped into a spreadsheet, which dropped the assumptions and the refusals —
 * exactly the parts that stop a range being read as a quote.
 *
 * IMPORTANT: this renders only what the planner already sees on screen. The
 * per-line provenance (pricing record ids, rule ids, driver weights) is
 * deliberately NOT included: it is the shape of the proprietary pricing
 * workbook, and this file is meant to leave the building.
 */

export const investmentExportEnabled = (): boolean =>
  process.env.INVESTMENT_EXPORT_ENABLED === "true";

export type ExportLineItem = {
  category: string;
  label: string;
  lowMinor: number;
  midMinor: number;
  highMinor: number;
  quantity: number;
  unitLabel: string | null;
  implied: boolean;
};
export type ExportRefusal = { category: string; reason: string; ask: string };
export type ExportAssumption = { key: string; label: string; note: string };
export type ExportScenario = { key: string; label: string; lowMinor: number; midMinor: number; highMinor: number; basis: string };
export type ExportAncillary = { factor: string; status: string; note: string };

const ANCILLARY_STATUS: Record<string, string> = {
  estimated: "Estimated",
  venue_dependent: "Ask the venue",
  no_data: "No data",
};

export const renderInvestmentExport = (input: {
  eventName?: unknown;
  currency: string | null;
  totalLowMinor: number | null;
  totalMidMinor: number | null;
  totalHighMinor: number | null;
  lineItems: ExportLineItem[];
  refusals: ExportRefusal[];
  ancillary: ExportAncillary[];
  assumptions: ExportAssumption[];
  scenarios: ExportScenario[];
  confidence: string;
  generatedAt: Date;
}): string => {
  if (!input.lineItems.length)
    throw new InvestmentError(
      "NO_LINE_ITEMS",
      "This estimate has no line items to export.",
      409,
    );

  const money = (minor: number | null | undefined) => formatMoney(minor, input.currency);

  const totals = `<section>
<h2>Estimated range</h2>
<table>
<thead><tr><th>Scenario</th><th class="num">Low</th><th class="num">Mid</th><th class="num">High</th></tr></thead>
<tbody>
<tr><td><strong>This proposal</strong></td><td class="num">${escapeHtml(money(input.totalLowMinor))}</td><td class="num">${escapeHtml(money(input.totalMidMinor))}</td><td class="num">${escapeHtml(money(input.totalHighMinor))}</td></tr>
${input.scenarios
  .map(
    (scenario) =>
      `<tr><td>${escapeHtml(scenario.label)}<br><span class="meta">${escapeHtml(scenario.basis)}</span></td>` +
      `<td class="num">${escapeHtml(money(scenario.lowMinor))}</td><td class="num">${escapeHtml(money(scenario.midMinor))}</td><td class="num">${escapeHtml(money(scenario.highMinor))}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table>
</section>`;

  const lines = `<section>
<h2>What is in the estimate</h2>
<table>
<thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Low</th><th class="num">Mid</th><th class="num">High</th></tr></thead>
<tbody>
${input.lineItems
  .map(
    (item) =>
      `<tr><td>${escapeHtml(item.label)}${item.implied ? " <em>(assumed)</em>" : ""}</td>` +
      `<td class="num">${escapeHtml(item.quantity)}${item.unitLabel ? ` ${escapeHtml(item.unitLabel)}` : ""}</td>` +
      `<td class="num">${escapeHtml(money(item.lowMinor))}</td><td class="num">${escapeHtml(money(item.midMinor))}</td><td class="num">${escapeHtml(money(item.highMinor))}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table>
</section>`;

  // The refusals and ancillary items are the reason a range is not a quote.
  // Dropping them is how an estimate gets read as a commitment, so they ship
  // with it rather than being an in-app-only caveat.
  const notCovered = input.refusals.length || input.ancillary.length
    ? `<section class="note">
<h2>Not covered by this estimate</h2>
<ul>
${input.refusals.map((r) => `<li><strong>${escapeHtml(r.category)}:</strong> ${escapeHtml(r.reason)} ${escapeHtml(r.ask)}</li>`).join("\n")}
${input.ancillary.map((a) => `<li><strong>${escapeHtml(a.factor)}</strong> (${escapeHtml(ANCILLARY_STATUS[a.status] ?? a.status)}): ${escapeHtml(a.note)}</li>`).join("\n")}
</ul>
</section>`
    : "";

  const assumptions = input.assumptions.length
    ? `<section>
<h2>Assumptions</h2>
<ul>${input.assumptions.map((a) => `<li><strong>${escapeHtml(a.label)}:</strong> ${escapeHtml(a.note)}</li>`).join("")}</ul>
</section>`
    : "";

  const event = String(input.eventName ?? "").trim();
  return renderExportPage({
    title: event ? `Investment estimate — ${event}` : "Investment estimate",
    subtitle: `Generated ${input.generatedAt.toISOString().slice(0, 10)} · ${input.lineItems.length} line item${input.lineItems.length === 1 ? "" : "s"} · ${escapeHtml(input.confidence)} confidence`,
    body: [totals, lines, notCovered, assumptions].filter(Boolean).join("\n"),
    footer:
      "An estimated range produced from this proposal's recorded details, not a quote and not an offer. " +
      "Actual vendor pricing depends on the items listed as not covered above.",
  });
};
