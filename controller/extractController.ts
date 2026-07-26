import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import multer from "multer";
import OpenAI from "openai";
import { extractProposalDocument } from "../src/modules/extraction/composition";
import { safeLog } from "../src/shared/observability/safeTelemetry";

/* Lazy so environment loading completes before a request creates the client. */
const getOpenAI = () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ─── Multer — memory storage (no disk writes) ─── */
export const extractUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
      "text/csv",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type. Please upload PDF, DOC, DOCX, TXT, or CSV."));
    }
  },
});

/* ─── POST /api/extract-proposal ─── */
export const extractProposal = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: "No file uploaded." });
      return;
    }

    const { buffer, mimetype } = req.file;
    const startedAt = Date.now();
    const result = await extractProposalDocument({
      buffer,
      mimetype,
    });
    safeLog("info", "legacy_extraction_completed", {
      outcome: result.kind,
      durationMs: Date.now() - startedAt,
      provider: "openai",
      model: "gpt-4o",
    });
    if (result.kind === "empty_document") {
      res.status(422).json({ success: false, message: result.message });
      return;
    }
    if (result.kind === "invalid_output") {
      res.status(502).json({
        success: false,
        message: "AI extraction returned an invalid response. Please try again.",
        errorCode: "INVALID_EXTRACTION_OUTPUT",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Document parsed successfully.",
      data: result.data,
      extraction: {
        promptVersion: result.promptVersion,
        schemaId: result.schemaId,
      },
    });
  } catch (error) {
    console.error("Extract proposal error:", error);
    safeLog("error", "legacy_extraction_failed", { provider: "openai", model: "gpt-4o" });
    res.status(500).json({
      success: false,
      message: "Error extracting proposal data from document.",
    });
  }
};

/* ─── Schedule time normalization ─────────────────────────────────────────
   Fallback for messy time-of-day values a spreadsheet parser can't confidently
   read on its own (typos like "11;15 AM", unusual notation, etc.). Only called
   for the handful of values the client-side regex parser already gave up on —
   not for every cell — to keep this cheap and fast. */
const NORMALIZE_TIME_PROMPT = `You are a data-cleaning assistant for messy spreadsheet values.

You will receive a JSON array of raw strings that are each meant to represent a single time of day, taken from an Excel schedule. They may contain typos (e.g. a semicolon instead of a colon), inconsistent spacing, or unusual notation.

For each string, return its time of day in 24-hour "HH:MM" format if you can confidently determine one — correcting obvious typos (e.g. "11;15 AM" -> "11:15", "2.30pm" -> "14:30"). If a value is empty, clearly not a time, or too ambiguous to confidently resolve, return null for that entry.

Return ONLY a JSON object of the form {"results": [...]} — an array of strings or nulls, the same length and in the same order as the input array. No explanation, no markdown fences.`;

const MAX_NORMALIZE_VALUES = 200;

/* ─── POST /api/extract-proposal/normalize-times ─── */
export const normalizeScheduleTimes = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { values } = req.body as { values?: unknown };

    if (!Array.isArray(values) || values.length === 0) {
      res.status(400).json({ success: false, message: "values must be a non-empty array of strings." });
      return;
    }
    if (values.length > MAX_NORMALIZE_VALUES) {
      res.status(400).json({ success: false, message: `Too many values in one request (max ${MAX_NORMALIZE_VALUES}).` });
      return;
    }
    const inputs = values.map((value) => (typeof value === "string" ? value.slice(0, 100) : ""));

    const completion = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: NORMALIZE_TIME_PROMPT },
        { role: "user", content: JSON.stringify(inputs) },
      ],
    });

    const rawContent = completion.choices[0]?.message?.content ?? "{}";
    let results: unknown[] = [];
    try {
      const cleaned = rawContent
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      const parsed = cleaned ? JSON.parse(cleaned) : {};
      if (Array.isArray(parsed.results)) results = parsed.results;
    } catch {
      results = [];
    }

    const normalized: (string | null)[] = inputs.map((_, index) => {
      const value = results[index];
      return typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value.trim())
        ? value.trim()
        : null;
    });

    res.status(200).json({ success: true, data: { results: normalized } });
  } catch (error) {
    console.error("Normalize schedule times error:", error);
    res.status(500).json({
      success: false,
      message: "Error normalizing schedule time values.",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
