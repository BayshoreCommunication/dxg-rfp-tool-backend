/**
 * Shared pieces for the standalone HTML documents this app hands to a planner.
 *
 * The RFP export proved the shape: HTML rather than PDF needs no rendering
 * dependency, prints to PDF from any browser, and is diffable in tests. The
 * escaping and the page chrome were about to be copied a third time, so they
 * live here instead.
 */

/**
 * Every interpolation in an exported document is escaped. Almost all of it is
 * model output or vendor-supplied text, and an unescaped tag in a file the
 * planner forwards to a vendor is stored XSS in an attachment.
 */
export const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const EXPORT_STYLES = `
body{font:16px/1.6 system-ui,sans-serif;max-width:52rem;margin:3rem auto;padding:0 1.5rem;color:#0f172a}
h1{font-size:1.75rem;margin-bottom:.25rem}
h2{font-size:1.15rem;margin-top:2rem}
.meta,.footer{color:#475569;font-size:.85rem}
table{border-collapse:collapse;width:100%;margin-top:.75rem}
th,td{border-bottom:1px solid #e2e8f0;padding:.5rem .6rem;text-align:left;vertical-align:top;font-size:.9rem}
th{color:#475569;font-weight:600}
td.num{text-align:right;white-space:nowrap}
blockquote{margin:.4rem 0 .4rem 0;padding-left:.75rem;border-left:3px solid #cbd5e1;color:#334155;font-size:.85rem}
.note{border-left:3px solid #cbd5e1;padding-left:1rem}
.footer{margin-top:3rem;border-top:1px solid #e2e8f0;padding-top:1rem}
@media print{body{margin:0;max-width:none}table,section{page-break-inside:avoid}}
`;

export const renderExportPage = (input: {
  title: string;
  subtitle: string;
  body: string;
  footer: string;
}): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.title)}</title>
<style>${EXPORT_STYLES}</style>
</head>
<body>
<h1>${escapeHtml(input.title)}</h1>
<p class="meta">${escapeHtml(input.subtitle)}</p>
${input.body}
<p class="footer">${escapeHtml(input.footer)}</p>
</body>
</html>
`;

/** Minor units to a readable amount. Currency stays a plain code rather than a
 * symbol: these documents cross borders and "$" is ambiguous. */
export const formatMoney = (minor: number | null | undefined, currency: string | null): string => {
  if (typeof minor !== "number" || !Number.isFinite(minor)) return "—";
  const amount = (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return currency ? `${amount} ${currency.toUpperCase()}` : amount;
};

/** A filename safe in a Content-Disposition header on every platform. */
export const exportFilename = (label: unknown, suffix: string, generatedAt: Date): string => {
  const base = String(label ?? "").trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${base || "proposal"}-${suffix}-${generatedAt.toISOString().slice(0, 10)}.html`;
};
