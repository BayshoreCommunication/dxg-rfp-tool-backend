import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import multer from "multer";
import { extractProposalDocument, normalizeScheduleTimes } from "../src/modules/extraction/composition";
import { MAX_VALUES } from "../src/modules/extraction/application/normalizeScheduleTimes";
import {
  assertLegacyExtractionReady,
  LegacyExtractionError,
  LEGACY_EXTRACTION_MODEL,
} from "../src/modules/extraction/domain/policy";
import { safeLog } from "../src/shared/observability/safeTelemetry";

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
    // Deny by default, and stoppable: this path calls a live provider, so it
    // is gated by AI_ENVIRONMENT, its own flag, and the kill switch before any
    // file is read.
    assertLegacyExtractionReady();
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
      model: LEGACY_EXTRACTION_MODEL,
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
    // A governance refusal is a deliberate, safe outcome — surface its code and
    // status rather than collapsing it into a generic 500.
    if (error instanceof LegacyExtractionError) {
      safeLog("info", "legacy_extraction_denied", { outcome: error.code });
      res.status(error.status).json({
        success: false,
        message: error.message,
        errorCode: error.code,
      });
      return;
    }
    console.error("Extract proposal error:", error);
    safeLog("error", "legacy_extraction_failed", { provider: "openai", model: LEGACY_EXTRACTION_MODEL });
    res.status(500).json({
      success: false,
      message: "Error extracting proposal data from document.",
    });
  }
};

/* POST /api/extract-proposal/normalize-times
   The dashboard has called this since the schedule-upload feature shipped and
   the route never existed, so every call 404'd and the client silently dropped
   the times it could not parse locally. Governed like the extraction endpoint:
   it can reach a live provider. */
export const normalizeTimes = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    assertLegacyExtractionReady();
    const values = (req.body as { values?: unknown })?.values;
    if (!Array.isArray(values)) {
      res.status(422).json({ success: false, message: "values must be an array of time strings." });
      return;
    }
    if (values.length > MAX_VALUES) {
      res.status(422).json({ success: false, message: "Send at most " + MAX_VALUES + " values." });
      return;
    }
    const results = await normalizeScheduleTimes(values);
    safeLog("info", "normalize_times_completed", {
      outcome: "success",
      provider: "openai",
      model: LEGACY_EXTRACTION_MODEL,
    });
    res.status(200).json({ success: true, data: { results } });
  } catch (error) {
    if (error instanceof LegacyExtractionError) {
      res.status(error.status).json({ success: false, message: error.message, errorCode: error.code });
      return;
    }
    safeLog("error", "normalize_times_failed", { outcome: "failure" });
    res.status(500).json({ success: false, message: "Times could not be normalized." });
  }
};
