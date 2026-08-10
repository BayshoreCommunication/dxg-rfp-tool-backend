const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const ExcelJS = require("exceljs");
const { deterministicParser } = require("../src/modules/knowledgeIngestion/deterministicParser");
const {
  supplementExplicitAttendanceCounts,
  supplementExplicitDateRanges,
  supplementExplicitEventFormat,
} = require("../src/modules/liveAi/extractionPipeline");

const FACTS = {
  name: "Synthetic Format Summit",
  dates: "September 14–16, 2026",
  format: "In-person with a live virtual audience",
  attendance: "450 onsite and 300 joining remotely",
};

const textFixture = () => Buffer.from([
  `Event name: ${FACTS.name}`,
  `Event dates: ${FACTS.dates}`,
  `Event format: ${FACTS.format}`,
  `Expected attendance: ${FACTS.attendance}`,
].join("\n"));

const csvFixture = () => Buffer.from([
  "Event name,Event dates,Event format,Expected attendance",
  `"${FACTS.name}","${FACTS.dates}","${FACTS.format}","${FACTS.attendance}"`,
].join("\n"));

const xlsxFixture = async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Event Brief");
  sheet.addRow(["Event name", "Event dates", "Event format", "Expected attendance"]);
  sheet.addRow([FACTS.name, FACTS.dates, FACTS.format, FACTS.attendance]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const docxFixture = async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const paragraphs = [
    `Event name: ${FACTS.name}`,
    `Event dates: ${FACTS.dates}`,
    `Event format: ${FACTS.format}`,
    `Expected attendance: ${FACTS.attendance}`,
  ].map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join("");
  zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
};

const pdfFixture = () => {
  const lines = [
    `Event name: ${FACTS.name}`,
    "Event dates: September 14-16, 2026",
    `Event format: ${FACTS.format}`,
    `Expected attendance: ${FACTS.attendance}`,
  ].map((line) => line.replace(/([\\()])/g, "\\$1"));
  const stream = `BT /F1 10 Tf 40 720 Td (${lines[0]}) Tj 0 -18 Td (${lines[1]}) Tj 0 -18 Td (${lines[2]}) Tj 0 -18 Td (${lines[3]}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
};

const summarized = (fragments) => {
  const evidence = fragments.map((fragment, index) => ({ id: `e-${index}`, sourceKey: "source-0", text: fragment.content }));
  let candidates = supplementExplicitAttendanceCounts([], evidence);
  candidates = supplementExplicitDateRanges(candidates, evidence);
  candidates = supplementExplicitEventFormat(candidates, evidence);
  return new Map(candidates.map((candidate) => [candidate.path, candidate.value]));
};

test("equivalent TXT, PDF, DOCX, XLSX, and CSV facts retain labels and normalize consistently", async () => {
  const inputs = [
    ["TXT", textFixture(), "text/plain"],
    ["PDF", pdfFixture(), "application/pdf"],
    ["DOCX", await docxFixture(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["XLSX", await xlsxFixture(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["CSV", csvFixture(), "text/csv"],
  ];
  for (const [label, bytes, mimeType] of inputs) {
    const parsed = await deterministicParser.parse(bytes, mimeType);
    const content = parsed.fragments.map((fragment) => fragment.content).join("\n");
    assert.match(content, /Event name/i, `${label} lost the event-name label`);
    assert.match(content, /Expected attendance/i, `${label} lost the attendance label`);
    const values = summarized(parsed.fragments);
    assert.equal(values.get("/content/event/startDate"), "2026-09-14", label);
    assert.equal(values.get("/content/event/endDate"), "2026-09-16", label);
    assert.equal(values.get("/content/event/attendees"), "450", label);
    assert.equal(values.get("/content/hybridVirtual/virtualAttendeeEstimate"), "300", label);
    assert.equal(values.get("/content/event/eventFormat"), "Hybrid", label);
  }
});

test("spreadsheet calendar cells preserve the calendar day and carry column labels", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Schedule");
  sheet.addRow(["Event start", "Load-in", "Strike", "Proposal due"]);
  sheet.addRow([
    new Date("2026-09-14T00:00:00.000Z"),
    new Date("2026-09-13T00:00:00.000Z"),
    new Date("2026-09-16T00:00:00.000Z"),
    new Date("2026-08-07T00:00:00.000Z"),
  ]);
  const parsed = await deterministicParser.parse(Buffer.from(await workbook.xlsx.writeBuffer()), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const row = parsed.fragments.find((fragment) => fragment.coordinates.row === 2);
  assert.match(row.content, /Column 1 \(Event start\): 2026-09-14/);
  assert.match(row.content, /Column 2 \(Load-in\): 2026-09-13/);
  assert.match(row.content, /Column 3 \(Strike\): 2026-09-16/);
  assert.match(row.content, /Column 4 \(Proposal due\): 2026-08-07/);
});
