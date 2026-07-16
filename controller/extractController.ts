import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import multer from "multer";
import OpenAI from "openai";
import { PDFParse } from "pdf-parse";

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
const EXTRACTION_PROMPT = `You are a document parser for an AV production RFP tool.

Extract ALL fields you can find in the document and return them as a single JSON object.
Only include fields you can confidently extract — OMIT fields that are not present.
Do NOT invent or guess values. Return ONLY valid JSON — no explanation, no markdown fences.

Schema:
{
  "event": {
    "eventName": "string — full official event name",
    "editionYear": "string — e.g. '12th Annual' or '2026' (omit if not mentioned)",
    "eventTheme": "string — event theme or tagline (omit if not mentioned)",
    "eventWebsite": "string — event website URL (omit if not mentioned)",
    "startDate": "YYYY-MM-DD",
    "endDate": "YYYY-MM-DD",
    "attendees": "one of: < 100 | 100 - 150 | 200 - 500 | 500 - 1,000 | 1,000+",
    "eventFormat": "one of: In-Person | Hybrid | Virtual",
    "eventType": "one of: Corporate Conference | User / Customer Summit | Sales Kickoff (SKO) | Annual Meeting / Shareholder Event | Product Launch | Awards Show / Gala | Trade Show / Exhibition | Internal Town Hall | Training / Certification Event | Association / Member Conference | Industry Symposium | Hybrid Broadcast / Studio Production | Other",
    "eventTypeOther": "string (only if eventType is Other)",
    "primaryAudience": "array of any matching: C-Suite Executives | Senior Leadership / VPs | Sales Team / Field Reps | Customers / End Users | Prospects / Leads | Partners / Channel / Resellers | Employees (All-Hands) | Investors / Shareholders | Press / Media / Analysts | Industry Professionals | Developers / Technical | Members (Association) | Students / Academic | General Public",
    "eventObjectives": "string — 2-4 sentences describing event goals",
    "sacredConstraints": "string — non-negotiable requirements or special considerations",
    "aboutOrganization": "string — background on the requesting organization (omit if not mentioned)",
    "statementOfWork": "string — scope of work requested from vendors (omit if not mentioned)",
    "eventProfile": "string — history/significance/stature of the event (omit if not mentioned)",
    "rfpTimeline": "string — key RFP process dates/milestones as free text (omit if not mentioned)"
  },
  "venueSchedule": {
    "venueName": "string — full official venue name",
    "venueCity": "string — city name only",
    "venueState": "string — 2-letter US state code (e.g. NV, CA) or OTHER",
    "venueAddress": "string — full street address",
    "venueType": "one of: Convention Center | Hotel Ballroom | Resort / Conference Center | Theater / Performing Arts Venue | Arena / Stadium | Corporate Campus / HQ | Outdoor Venue / Tent | Broadcast Studio | Restaurant / Private Event Space | Cruise Ship | Other",
    "venueConfirmedStatus": "one of: CONTRACT_SIGNED | VERBAL_CONFIRM | STRONG_PREF | NOT_SELECTED",
    "isUnionVenue": "one of: YES | NO | NOT_SURE — whether the venue contract requires Union, Teamster, or in-house labor",
    "unionJurisdictions": "array of any matching: IATSE (Stage Labor) | IBEW (Electrical) | Teamsters (Freight) | Carpenters Union | Local Stagehands Union | Other",
    "unionLaborDetails": "string — specific union/contract details (only if isUnionVenue is YES)",
    "loadInDate": "YYYY-MM-DD",
    "loadInTime": "HH:MM in 24-hour format (e.g. 07:00)",
    "rehearsalDate": "YYYY-MM-DD",
    "rehearsalTime": "HH:MM in 24-hour format",
    "showStartDate": "YYYY-MM-DD",
    "showStartTime": "HH:MM in 24-hour format",
    "showEndDate": "YYYY-MM-DD",
    "showEndTime": "HH:MM in 24-hour format",
    "strikeDate": "YYYY-MM-DD",
    "strikeTime": "HH:MM in 24-hour format",
    "numberOfEventRooms": "string — numeric count of rooms requiring AV",
    "timeZone": "one of: Eastern Time (ET) | Central Time (CT) | Mountain Time (MT) | Pacific Time (PT) | Alaska Time (AKT) | Hawaii Time (HT) | Other / International"
  },
  "roomByRoom": {
    "roomFunction": "string — e.g. General Session, Breakout, VIP Lounge",
    "roomLocation": "string — physical room/space name, if different from roomFunction",
    "roomSetup": "one of: Round of 8 | Rounds of 10 | Classroom | Theater",
    "scheduleDate": "YYYY-MM-DD — the date this room is in use",
    "scheduleDay": "string — day of week (omit if not mentioned; can be derived from scheduleDate)",
    "estimatedAttendeesInRoom": "string",
    "loadInDateTime": "ISO datetime string",
    "rehearsalDateTime": "ISO datetime string",
    "showStartDateTime": "ISO datetime string",
    "showEndDateTime": "ISO datetime string",
    "podiumMic": "one of: Yes | No",
    "podiumMicQty": "string (only if podiumMic is Yes)",
    "wirelessMics": "one of: Yes | No",
    "wirelessMicsQty": "string (only if wirelessMics is Yes)",
    "wirelessMicsType": "one of: Handhelds | Headset Mics | Lavalier (Lav) Mics | Both | Other",
    "wirelessMicsTypeOther": "string (only if wirelessMicsType is Other)",
    "audioRecording": "one of: Yes | No",
    "largeMonitorsOrScreenProjector": "one of: Yes | No",
    "numberOfMonitors": "string — numeric (only if largeMonitorsOrScreenProjector is Yes)",
    "numberOfScreens": "string — numeric (only if largeMonitorsOrScreenProjector is Yes)",
    "monitorSize": "one of: 40 inch | 43 inch | 50 inch | 55 inch | 60 inch | 65 inch | 70 inch (only if numberOfMonitors > 0)",
    "screenSize": "one of: 8' Tripod | 10' Wide Fastfold | 12' Wide Fastfold | 14' Wide Fastfold | 16' Wide Fastfold | 18' Wide Fastfold | 20' Wide Fastfold | 24' Wide Fastfold | 32' Wide Fastfold (only if numberOfScreens > 0)",
    "ledWall": "one of: Yes | No",
    "ledWallWidth": "string — width in feet (only if ledWall is Yes)",
    "ledWallHeight": "string — height in feet (only if ledWall is Yes)",
    "ledWallPixelPitch": "string — pixel pitch in mm (only if ledWall is Yes)",
    "ledWallSwitcher": "one of: Barco E2/E3 | Spyder X80 | Pixelhue P20/80/Q8 | Millumin | Vendor Recommendation (only if ledWall is Yes)",
    "presentationLaptops": "one of: Yes | No",
    "presentationLaptopQty": "string (only if presentationLaptops is Yes)",
    "videoPlayback": "one of: Yes | No",
    "videoPlaybackCount": "string (only if videoPlayback is Yes)",
    "videoPlaybackFormat": "one of: 4:3 | 16:9 | Custom Wide Screen (only if videoPlayback is Yes)",
    "videoFormatAspectRatio": "one of: 16:9 format | Unique Aspect Ratio | Both",
    "audienceQa": "one of: Yes | No",
    "audienceQaMethod": "one of: Via an App | Passing a Microphone | Both",
    "cameras": "one of: Yes | No",
    "camerasQty": "string (only if cameras is Yes)",
    "videoRecording": "one of: Yes | No",
    "videoRecordingType": "one of: Camera Feed Only | Presentation Only | Side by Side (Camera and Presentation) | All The Above",
    "stageWashLighting": "one of: Yes | No",
    "stageWashLightingStageSize": "string (only if stageWashLighting is Yes)",
    "backlightingFor": "one of: Yes | No",
    "drapeOrScenicUplighting": "one of: Yes | No",
    "audienceLighting": "one of: Yes | No",
    "programConfidenceMonitor": "one of: Yes | No",
    "programConfidenceMonitorQty": "string (only if programConfidenceMonitor is Yes)",
    "notesConfidenceMonitor": "one of: Yes | No",
    "notesConfidenceMonitorQty": "string (only if notesConfidenceMonitor is Yes)",
    "speakerTimer": "one of: Yes | No",
    "teleprompterNeeded": "one of: Yes | No",
    "teleprompterBilingual": "one of: Yes | No",
    "teleprompterLanguages": "array of language strings (only if teleprompterNeeded is Yes)",
    "scenicStageDesign": "one of: Yes | No",
    "showCrewNeeded": "array of any matching: A1 (AUDIO) | A2 (AUDIO ASSIST) | V1 (VIDEO) | V2 (VIDEO ASSIST) | TD (TECHNICAL DIRECTOR) | L1 (LIGHTING) | GRAPHICS OP | CAMERA OPERATOR | SHOWCALLER | STAGE MANAGER | PRODUCER | TELEPROMPTER OP | RIGGER | STAGEHAND",
    "otherRolesNeeded": "string"
  },
  "production": {
    "scenicStageDesign": "one of: Yes | No",
    "showCrewNeeded": "array of any matching: A1 (AUDIO) | A2 (AUDIO ASSIST) | V1 (VIDEO) | V2 (VIDEO ASSIST) | TD (TECHNICAL DIRECTOR) | L1 (LIGHTING) | GRAPHICS OP | CAMERA OPERATOR | SHOWCALLER | STAGE MANAGER | PRODUCER | TELEPROMPTER OP | RIGGER | STAGEHAND",
    "otherRolesNeeded": "string"
  },
  "hybridVirtual": {
    "virtualAttendeeEstimate": "string — numeric estimate of virtual attendees",
    "streamingPlatform": "one of: Zoom | Teams | Hopin | vMix | StreamYard | Webex | Other",
    "streamingPlatformOther": "string (only if streamingPlatform is Other)",
    "platformIntegrationWithAv": "one of: YES | NO",
    "streamOwnership": "one of: Client | AV Vendor | TBD",
    "remoteSpeakers": {
      "remoteSpeakers": "one of: YES | NO",
      "howManyRemoteSpeakers": "string",
      "remoteFeedPlatform": "string — e.g. Zoom Webinar",
      "techRehearsalOwner": "one of: Client | AV Vendor"
    },
    "liveVirtualQa": "one of: YES | NO",
    "virtualOnlyBreakouts": "one of: YES | NO",
    "dedicatedVirtualProducer": "one of: YES | NO",
    "closedCaptions": {
      "closedCaptions": "one of: YES | NO",
      "captionLanguages": "array of language strings",
      "captionType": "one of: AI | Human"
    },
    "onDemandRecording": "one of: YES | NO",
    "sponsorOverlays": "one of: YES | NO",
    "virtualNetworking": "one of: YES | NO"
  },
  "contentCreative": {
    "contentServicesNeeded": "one of: YES | NO",
    "presentationTemplateDesign": "one of: Client / Internal Team | AV Vendor | TBD | N/A",
    "speakerSlideCollection": "one of: Client / Internal Team | AV Vendor | TBD | N/A",
    "motionGraphicsOpenerVideo": "one of: Client / Internal Team | AV Vendor | TBD | N/A",
    "lowerThirdsNameSupers": "one of: Client / Internal Team | AV Vendor | TBD | N/A",
    "sizzleRecapVideo": "one of: Client / Internal Team | AV Vendor | TBD | N/A",
    "liveDataFeeds": {
      "needed": "one of: YES | NO",
      "ownership": "one of: Client / Internal Team | AV Vendor | TBD | N/A"
    },
    "sponsorRecognitionContent": "one of: Client / Internal Team | AV Vendor | TBD | N/A",
    "socialMediaContentCapture": "one of: Client / Internal Team | AV Vendor | TBD | N/A",
    "creativeDirectionNotes": "string — theme, colour palette, brand constraints"
  },
  "videoRecordingStep": {
    "videoRecordingRequired": "one of: YES | NO",
    "numberOfCameras": "string — numeric",
    "cameraPositions": "array of strings — e.g. Stage Wide, Speaker Close-Up, Audience Reaction, Roaming",
    "imagRequired": "one of: YES | NO",
    "cameraOperators": "string — numeric count",
    "isoRecordings": "string — e.g. All cameras ISO",
    "recordingResolution": "string — e.g. 4K, 1080p",
    "recordingMedia": "string — e.g. SSD, NVMe",
    "editedDeliverable": {
      "needed": "one of: YES | NO",
      "deliverableType": "array of any matching: Highlight Reel | Full Edit | Speaker Cuts",
      "turnaroundTime": "string — e.g. 5 Business Days",
      "reelLengthPreference": "string — e.g. 2-3 min"
    },
    "rawFootageTurnover": "one of: YES | NO",
    "deliverableFormat": "array of strings — e.g. H.264 MP4",
    "deliveryMethod": "array of any matching: WeTransfer | Dropbox | Hard Drive | USB | Cloud Link | FTP"
  },
  "venue": {
    "venueAvContactName": "string — in-house AV contact name at the venue",
    "venueAvContactPhone": "string",
    "venueAvContactEmail": "string",
    "inHouseAvCompanyName": "string — e.g. PSAV, Encore",
    "riggingRequired": "one of: YES | NO",
    "riggingPlotOrSpecs": "string",
    "trussAndMotorsProvidedByVenue": "one of: YES | NO (only if riggingRequired is YES)",
    "liftsProvidedByVenue": "one of: YES | NO (only if riggingRequired is YES)",
    "powerDropsRequired": "one of: YES | NO",
    "powerDropAmperage": "one of: 100A | 200A | 400A",
    "numberOfPowerDrops": "string — numeric",
    "wirelessInternetRequired": "one of: YES | NO",
    "internetUseCases": "array of strings — e.g. Livestream, Remote Speakers, Signage",
    "coiRequirements": "string — insurance requirements",
    "venueAccessRequirements": "string — access hours, dock procedures"
  },
  "budget": {
    "estimatedAvBudget": "one of: Essential | Standard | Production | Premium | Enterprise | Signature | Not Yet Determined",
    "proposalFormatPreferences": "array of any matching: Itemized Gear List | Labor Breakdown | All-In Total Estimate | Alternate / Value-Engineered Option | Creative / Scenic Approach Narrative | Crew Bios | References | LED Wall Line-Itemed Separately",
    "sustainabilityDeiNotes": "string — sustainability or DEI requirements/preferences (omit if not mentioned)",
    "vendorQuestionsDueDate": "YYYY-MM-DD",
    "responseToVendorQuestionsDate": "YYYY-MM-DD",
    "proposalSubmissionDueDate": "YYYY-MM-DD",
    "shortlistNotificationDate": "YYYY-MM-DD",
    "vendorPresentationOpportunity": "one of: YES | NO — whether shortlisted vendors present before final selection",
    "vendorPresentationDate": "YYYY-MM-DD (only if vendorPresentationOpportunity is YES)",
    "vendorSelectionDate": "YYYY-MM-DD",
    "decisionDate": "YYYY-MM-DD",
    "competitiveBid": "one of: YES | NO",
    "numberOfProposals": "string — numeric count of vendors being asked",
    "callWithDxgProducer": "one of: YES | NO",
    "howDidYouHear": "one of: Referral | Venue | Google | Social Media | LinkedIn | Other",
    "howDidYouHearOther": "string (only if howDidYouHear is Other)"
  },
  "uploads": {
    "brandGuideUrl": "string — URL to brand guide (omit if not mentioned)",
    "referenceUrls": "array of { url: string, label: string } — reference links (Vimeo, YouTube, Behance, etc.)",
    "ndaRequired": "one of: YES | NO",
    "ndaType": "string — e.g. Mutual NDA (only if ndaRequired is YES)",
    "coVendors": {
      "inHouseVenueAv": { "companyName": "string", "contactName": "string", "contactEmail": "string", "contactPhone": "string", "status": "string — e.g. Confirmed, In Discussion, TBD, Not Applicable", "notes": "string" },
      "eventDecorator": { "companyName": "string", "contactName": "string", "contactEmail": "string", "contactPhone": "string", "status": "string", "notes": "string" },
      "registrationTech": { "companyName": "string", "contactName": "string", "contactEmail": "string", "contactPhone": "string", "status": "string", "notes": "string" },
      "agencyOfRecord": { "companyName": "string", "contactName": "string", "contactEmail": "string", "contactPhone": "string", "status": "string", "notes": "string" },
      "photographer": { "companyName": "string", "contactName": "string", "contactEmail": "string", "contactPhone": "string", "status": "string", "notes": "string" }
    }
  },
  "contact": {
    "contactFirstName": "string",
    "contactLastName": "string",
    "contactTitle": "string — job title",
    "contactOrganization": "string — display name of the organization",
    "organizationLegalName": "string — legal entity name if different",
    "contactEmail": "string",
    "contactPhone": "string",
    "contactPhoneExt": "string",
    "preferredContactMethod": "one of: Email | Phone | Either",
    "bestTimeToReach": "string — e.g. Weekdays 9-5 PT",
    "anythingElse": "string — any additional notes",
    "additionalContacts": "array of { fullName: string, titleAndRole: string, email: string, phone: string, role: one of: cc_all | technical_av | legal_contracts | creative_approvals | onsite_dayof | executive_sponsor } — omit if none mentioned"
  }
}`;

const TEXT_LIMIT = 40000;

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
    const { buffer, mimetype } = req.file;
    const isPdf = mimetype === "application/pdf";
    const isDocx =
      mimetype === "application/msword" ||
      mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    let docText = "";

    if (isPdf) {
      /* ── PDF: extract text with pdf-parse, then call LLM ── */
      const parser = new PDFParse({ data: buffer });
      try {
        const parsed = await parser.getText();
        docText = parsed.text?.trim() ?? "";
      } finally {
        await parser.destroy();
      }
      if (!docText) {
        res.status(422).json({ success: false, message: "PDF appears to have no extractable text. Try a text-based PDF or DOCX." });
        return;
      }
    } else if (isDocx) {
      /* ── DOCX/DOC: extract plain text with mammoth ── */
      const { value } = await mammoth.extractRawText({ buffer });
      docText = value?.trim() ?? "";
      if (!docText) {
        res.status(422).json({ success: false, message: "Document appears empty." });
        return;
      }
    } else {
      /* ── TXT / CSV: read as UTF-8 ── */
      docText = buffer.toString("utf-8").trim();
      if (!docText) {
        res.status(422).json({ success: false, message: "Document appears empty." });
        return;
      }
    }

    const truncated = docText.slice(0, TEXT_LIMIT);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: `Document text:\n\n${truncated}` },
      ],
    });

    const rawContent = completion.choices[0]?.message?.content ?? "";

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

/* ─── Schedule time normalization ─────────────────────────────────────────
   Fallback for messy time-of-day values a spreadsheet parser can't confidently
   read on its own (typos like "11;15 AM", unusual notation, etc.). Only called
   for the handful of values the client-side regex parser already gave up on —
   not for every cell — to keep this cheap and fast. */
const NORMALIZE_TIME_PROMPT = `You are a data-cleaning assistant for messy spreadsheet values.

You will receive a JSON array of raw strings that are each meant to represent a single time of day, taken from an Excel schedule. They may contain typos (e.g. a semicolon instead of a colon), inconsistent spacing, or unusual notation.

For each string, return its time of day in 24-hour "HH:MM" format if you can confidently determine one — correcting obvious typos (e.g. "11;15 AM" -> "11:15", "2.30pm" -> "14:30"). If a value is empty, clearly not a time, or too ambiguous to confidently resolve, return null for that entry.

Return ONLY a JSON object of the form {"results": [...]}  — an array of strings or nulls, the same length and in the same order as the input array. No explanation, no markdown fences.`;

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
    const inputs = values.map((v) => (typeof v === "string" ? v.slice(0, 100) : ""));

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
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

    const normalized: (string | null)[] = inputs.map((_, i) => {
      const v = results[i];
      return typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim() : null;
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
