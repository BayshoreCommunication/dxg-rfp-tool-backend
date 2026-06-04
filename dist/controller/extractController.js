"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractProposal = exports.extractUpload = void 0;
const multer_1 = __importDefault(require("multer"));
const openai_1 = __importDefault(require("openai"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");
/* ─── OpenAI client (lazy — created per-request so dotenv has loaded first) ─── */
const getOpenAI = () => new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
/* ─── Multer — memory storage (no disk writes) ─── */
exports.extractUpload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
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
        }
        else {
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
    "startDate": "YYYY-MM-DD",
    "endDate": "YYYY-MM-DD",
    "attendees": "one of: < 100 | 100 - 150 | 200 - 500 | 500 - 1,000 | 1,000+",
    "eventFormat": "one of: In-Person | Hybrid | Virtual",
    "eventType": "one of: Corporate Conference | User / Customer Summit | Sales Kickoff (SKO) | Annual Meeting / Shareholder Event | Product Launch | Awards Show / Gala | Trade Show / Exhibition | Internal Town Hall | Training / Certification Event | Association / Member Conference | Industry Symposium | Hybrid Broadcast / Studio Production | Other",
    "eventTypeOther": "string (only if eventType is Other)",
    "primaryAudience": "array of any matching: C-Suite Executives | Senior Leadership / VPs | Sales Team / Field Reps | Customers / End Users | Prospects / Leads | Partners / Channel / Resellers | Employees (All-Hands) | Investors / Shareholders | Press / Media / Analysts | Industry Professionals | Developers / Technical | Members (Association) | Students / Academic | General Public",
    "eventObjectives": "string — 2-4 sentences describing event goals",
    "sacredConstraints": "string — non-negotiable requirements or special considerations"
  },
  "venueSchedule": {
    "venueName": "string — full official venue name",
    "venueCity": "string — city name only",
    "venueState": "string — 2-letter US state code (e.g. NV, CA) or OTHER",
    "venueAddress": "string — full street address",
    "venueType": "one of: Convention Center | Hotel Ballroom | Resort / Conference Center | Theater / Performing Arts Venue | Arena / Stadium | Corporate Campus / HQ | Outdoor Venue / Tent | Broadcast Studio | Restaurant / Private Event Space | Cruise Ship | Other",
    "venueConfirmedStatus": "one of: CONTRACT_SIGNED | VERBAL_CONFIRM | STRONG_PREF | NOT_SELECTED",
    "isUnionVenue": "one of: YES | NO | NOT_SURE",
    "unionJurisdictions": "array of any matching: IATSE (Stage Labor) | IBEW (Electrical) | Teamsters (Freight) | Carpenters Union | Local Stagehands Union | Other",
    "loadInDate": "YYYY-MM-DD",
    "loadInTime": "HH:MM in 24-hour format (e.g. 07:00)",
    "rehearsalDate": "YYYY-MM-DD",
    "rehearsalTime": "HH:MM in 24-hour format",
    "strikeDate": "YYYY-MM-DD",
    "strikeTime": "HH:MM in 24-hour format",
    "numberOfEventRooms": "string — numeric count of rooms requiring AV",
    "timeZone": "one of: Eastern Time (ET) | Central Time (CT) | Mountain Time (MT) | Pacific Time (PT) | Alaska Time (AKT) | Hawaii Time (HT) | Other / International"
  },
  "roomByRoom": {
    "roomFunction": "string — e.g. General Session, Breakout, VIP Lounge",
    "estimatedAttendeesInRoom": "string",
    "showStartDateTime": "ISO datetime string",
    "showEndDateTime": "ISO datetime string",
    "podiumMic": "one of: Yes | No",
    "podiumMicQty": "string (only if podiumMic is Yes)",
    "wirelessMics": "one of: Yes | No",
    "wirelessMicsQty": "string (only if wirelessMics is Yes)",
    "wirelessMicsType": "one of: Handhelds | Headset Mics",
    "audioRecording": "one of: Yes | No",
    "largeMonitorsOrScreenProjector": "one of: Yes | No",
    "largeMonitorsQty": "string (only if largeMonitorsOrScreenProjector is Yes)",
    "ledWall": "one of: Yes | No",
    "presentationLaptops": "one of: Yes | No",
    "presentationLaptopQty": "string (only if presentationLaptops is Yes)",
    "videoPlayback": "one of: Yes | No",
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
    "scenicStageDesign": "one of: Yes | No",
    "teleprompterNeeded": "one of: Yes | No",
    "unionLabor": "one of: Yes | No | Not Sure",
    "showCrewNeeded": "array of any matching: A1 (AUDIO) | A2 (AUDIO ASSIST) | V1 (VIDEO) | V2 (VIDEO ASSIST) | TD (TECHNICAL DIRECTOR) | L1 (LIGHTING) | GRAPHICS OP | CAMERA OPERATOR | SHOWCALLER | STAGE MANAGER | PRODUCER | TELEPROMPTER OP | RIGGER | STAGEHAND",
    "otherRolesNeeded": "string"
  },
  "production": {
    "scenicStageDesign": "one of: Yes | No",
    "unionLabor": "one of: Yes | No | Not Sure",
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
    "maxWeightPerRiggingPoint": "string — e.g. 500 lbs",
    "numberOfRiggingPoints": "string — numeric",
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
    "proposalFormatPreferences": "array of any matching: GEAR ITEMIZATION | LABOR BREAKDOWN | ALL-IN ESTIMATE | ADD-ON OPTIONS",
    "timelineForProposal": "one of: Within 24 Hours | Within 3 Business Days | 1 Week | 2 Weeks | Flexible",
    "decisionDate": "YYYY-MM-DD",
    "competitiveBid": "one of: YES | NO",
    "numberOfProposals": "string — numeric count of vendors being asked",
    "callWithDxgProducer": "one of: YES | NO",
    "howDidYouHear": "one of: Referral | Venue | Google | Social Media | LinkedIn | Other",
    "howDidYouHearOther": "string (only if howDidYouHear is Other)"
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
    "anythingElse": "string — any additional notes"
  }
}`;
/* ─── POST /api/extract-proposal ─── */
const extractProposal = async (req, res) => {
    try {
        if (!req.file) {
            res.status(400).json({ success: false, message: "No file uploaded." });
            return;
        }
        const openai = getOpenAI();
        const { buffer, mimetype, originalname } = req.file;
        const isPdf = mimetype === "application/pdf";
        const isDocx = mimetype === "application/msword" ||
            mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        let rawContent;
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
                            }, // SDK type narrowing workaround
                            {
                                type: "input_text",
                                text: EXTRACTION_PROMPT,
                            },
                        ],
                    },
                ],
            });
            rawContent = response.output_text ?? "";
        }
        else if (isDocx) {
            /* ── DOCX: extract plain text with mammoth, then call LLM ── */
            const { value: docText } = await mammoth.extractRawText({ buffer });
            if (!docText.trim()) {
                res.status(422).json({ success: false, message: "Document appears empty." });
                return;
            }
            const truncated = docText.slice(0, 24000);
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                temperature: 0,
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: EXTRACTION_PROMPT },
                    { role: "user", content: `Document text:\n\n${truncated}` },
                ],
            });
            rawContent = completion.choices[0]?.message?.content ?? "";
        }
        else {
            /* ── TXT / CSV: read as UTF-8, then call LLM ── */
            const text = buffer.toString("utf-8").slice(0, 24000);
            if (!text.trim()) {
                res.status(422).json({ success: false, message: "Document appears empty." });
                return;
            }
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                temperature: 0,
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: EXTRACTION_PROMPT },
                    { role: "user", content: `Document text:\n\n${text}` },
                ],
            });
            rawContent = completion.choices[0]?.message?.content ?? "";
        }
        /* ── Parse JSON from LLM response ── */
        let extracted = {};
        try {
            const cleaned = rawContent
                .replace(/^```json\s*/i, "")
                .replace(/^```\s*/i, "")
                .replace(/```\s*$/i, "")
                .trim();
            if (cleaned)
                extracted = JSON.parse(cleaned);
        }
        catch {
            extracted = {};
        }
        res.status(200).json({
            success: true,
            message: "Document parsed successfully.",
            data: extracted,
        });
    }
    catch (error) {
        console.error("Extract proposal error:", error);
        res.status(500).json({
            success: false,
            message: "Error extracting proposal data from document.",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.extractProposal = extractProposal;
//# sourceMappingURL=extractController.js.map