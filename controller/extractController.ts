import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import multer from "multer";
import { extractProposalDocument } from "../src/modules/extraction/composition";

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
    const result = await extractProposalDocument({
      buffer,
      mimetype,
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
    res.status(500).json({
      success: false,
      message: "Error extracting proposal data from document.",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
