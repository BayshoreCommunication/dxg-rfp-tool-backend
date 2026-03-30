import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import multer from "multer";
import OpenAI from "openai";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth") as {
  extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
};

/* ─── OpenAI client (lazy — created per-request so dotenv has loaded first) ─── */
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

/* ─── Extraction prompt ─── */
const EXTRACTION_PROMPT = `You are a document parser for an AV production proposal tool.

Extract the following fields from the document and return them as a single JSON object.
Only include fields you can confidently extract. If a field is not present, OMIT it entirely.
Do NOT invent or guess values. Return ONLY valid JSON — no explanation, no markdown fences.

Schema:
{
  "event": {
    "eventName": "string",
    "startDate": "YYYY-MM-DD",
    "endDate": "YYYY-MM-DD",
    "venue": "string",
    "attendees": "one of: < 100 | 100 - 150 | 200 - 500 | 500 - 1,000 | 1,000+",
    "eventFormat": "one of: In-Person | Hybrid | Virtual",
    "eventType": "one of: Conference | Meeting | Gala | Trade Show | Awards Show | Other",
    "eventTypeOther": "string (only if eventType is Other)"
  },
  "roomByRoom": {
    "roomFunction": "string",
    "numberOfRooms": "string",
    "ceilingHeight": "string",
    "roomSetup": "one of: Theatre | Classroom | Banquet Rounds | U-Shape | Boardroom | Cocktail | Custom",
    "decibelLimitation": "string",
    "avSpec": "one of: Basic | Standard | Premium | Custom",
    "avPa": "one of: Yes | No",
    "mainSound": "one of: L'Acoustics | d&b audiotechnik | Meyer Sound | QSC | JBL | Other",
    "mainSoundSize": "string",
    "hearingImpaired": "one of: Yes | No",
    "recordAudio": "one of: Yes | No | Multi-Track",
    "chairs": "string",
    "frontScreen": "one of: 16:9 | 4:3 | Custom Aspect | Curved | LED",
    "contentVideoNeeds": "string"
  },
  "production": {
    "scenicStageDesign": "one of: Yes | No",
    "unionLabor": "one of: Yes | No | Not Sure",
    "showCrewNeeded": "array of any matching: A1 (AUDIO) | V1 (VIDEO) | TD (TECHNICAL DIRECTOR) | GRAPHICS OP | CAMERA OPERATOR | SHOWCALLER | STAGE MANAGER | LIGHTING DIRECTOR",
    "otherRolesNeeded": "string"
  },
  "venue": {
    "needRiggingForFlown": "one of: YES | NO",
    "riggingPlotOrSpecs": "string",
    "needDedicatedPowerDrops": "one of: YES | NO",
    "standardAmpWall": "one of: 100A | 200A | 400A",
    "powerDropsHowMany": "string"
  },
  "budget": {
    "estimatedAvBudget": "one of: <$10K | $10-25K | $25-50K | $50-100K | $100K+ | Other",
    "proposalFormatPreferences": "array of any matching: GEAR ITEMIZATION | LABOR BREAKDOWN | ALL-IN ESTIMATE | ADD-ON OPTIONS",
    "timelineForProposal": "one of: Within 3 Business Days | 1 Week | 2 Weeks | Flexible",
    "callWithDxgProducer": "one of: YES | NO",
    "howDidYouHear": "one of: Referral | Venue | Google | Social Media | LinkedIn | Other",
    "howDidYouHearOther": "string (only if howDidYouHear is Other)"
  },
  "contact": {
    "contactFirstName": "string",
    "contactLastName": "string",
    "contactTitle": "string",
    "contactOrganization": "string",
    "contactEmail": "string",
    "contactPhone": "string",
    "anythingElse": "string"
  }
}`;

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

    const openai = getOpenAI();
    const { buffer, mimetype, originalname } = req.file;
    const isPdf = mimetype === "application/pdf";
    const isDocx =
      mimetype === "application/msword" ||
      mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    let rawContent: string;

    if (isPdf) {
      /* ── PDF: use OpenAI Responses API with native PDF support ── */
      const base64 = buffer.toString("base64");
      const dataUrl = `data:application/pdf;base64,${base64}`;

      const response = await openai.responses.create({
        model: "gpt-4o-mini",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_file",
                filename: originalname,
                file_data: dataUrl,
              } as never, // SDK type narrowing workaround
              {
                type: "input_text",
                text: EXTRACTION_PROMPT,
              } as never,
            ],
          },
        ],
      });

      rawContent = response.output_text ?? "";
    } else if (isDocx) {
      /* ── DOCX: extract plain text with mammoth, then call LLM ── */
      const { value: docText } = await mammoth.extractRawText({ buffer });
      if (!docText.trim()) {
        res.status(422).json({ success: false, message: "Document appears empty." });
        return;
      }
      const truncated = docText.slice(0, 12000);
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: `Document text:\n\n${truncated}` },
        ],
      });
      rawContent = completion.choices[0]?.message?.content ?? "";
    } else {
      /* ── TXT / CSV: read as UTF-8, then call LLM ── */
      const text = buffer.toString("utf-8").slice(0, 12000);
      if (!text.trim()) {
        res.status(422).json({ success: false, message: "Document appears empty." });
        return;
      }
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: `Document text:\n\n${text}` },
        ],
      });
      rawContent = completion.choices[0]?.message?.content ?? "";
    }

    /* ── Parse JSON from LLM response ── */
    let extracted: Record<string, unknown> = {};
    try {
      const cleaned = rawContent
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      if (cleaned) extracted = JSON.parse(cleaned);
    } catch {
      extracted = {};
    }

    res.status(200).json({
      success: true,
      message: "Document parsed successfully.",
      data: extracted,
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
