import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";

/**
 * Conversational requirement extraction.
 *
 * Typed messages were stored as history and nothing else: a planner who
 * described their whole event in chat recorded zero structured data, and the
 * only route from conversation into MongoDB was the 14 guided questions, which
 * ask from scratch without reading what was written.
 *
 * Extraction structurally requires a stored, scanned, parsed source, so turns
 * are batched into a transcript segment and materialised through the same
 * private-source boundary as a pasted note. Batching is not an optimisation —
 * it is what makes corrections safe. "300 attendees", then "sorry, 350" two
 * messages later, must land in ONE extraction run so the existing intra-run
 * conflict detector raises a CROSS_SOURCE_CONFLICT the planner can resolve.
 * Extracting per message would put them in separate runs, where the second
 * silently fails to apply (its target field is no longer empty) and no conflict
 * is ever reported.
 */
export const conversationExtractionEnabled = (): boolean =>
  aiRuntimeAuthorized() && process.env.CONVERSATION_EXTRACTION_ENABLED === "true";

export const IDLE_MS = Math.max(5_000, Number(process.env.CONVERSATION_EXTRACT_IDLE_MS) || 45_000);
export const MAX_TURNS = Math.max(1, Math.min(Number(process.env.CONVERSATION_EXTRACT_MAX_TURNS) || 6, 25));

/**
 * Minimum substance before a segment is worth a provider call, counted with
 * whitespace stripped. Low deliberately: one clear requirement sentence — "We
 * need 6 breakout rooms at the Chicago Hilton with audio and projection" — is
 * about 67 dense characters and must qualify. The keyword/digit test below is
 * what actually distinguishes a requirement from chatter; this only keeps very
 * short filler out.
 */
export const MIN_SEGMENT_CHARS = 40;

// Words that indicate event requirements rather than conversational filler.
// Deliberately broad and cheap: this only decides whether a segment is worth
// extracting, and a false positive costs one call while a false negative loses
// the planner's words. Never a model call.
//
// Note the trailing \w* is applied per-alternative, not to the group: "av" must
// stand alone or it matches "available", "average", and most of a thank-you.
const REQUIREMENT_HINTS = new RegExp(
  "\\b(?:" +
    [
      "attend", "room", "venue", "stage", "screen", "audio", "video", "record",
      "stream", "hybrid", "virtual", "rig", "power", "budget", "union",
      "breakout", "keynote", "session", "load[- ]?in", "strike", "camera",
      "caption", "mic", "projector", "lighting", "crew", "date", "deadline",
    ]
      .map((word) => `${word}\\w*`)
      .join("|") +
    "|av)\\b",
  "i",
);

export type SegmentTurn = { id: string; content: string; createdAt: Date };
export type SegmentReason = "idle" | "turns" | "explicit";
export type SegmentDecision =
  | { extract: false; reason: "disabled" | "empty" | "insufficient" | "open" }
  | { extract: true; reason: SegmentReason; turns: SegmentTurn[]; text: string; idempotencyKey: string };

/** Text a segment contributes, ignoring whitespace-only turns. */
export const segmentText = (turns: SegmentTurn[]): string =>
  turns
    .map((turn) => turn.content.trim())
    .filter(Boolean)
    .join("\n\n");

/**
 * Worth extracting? Length alone is a poor signal — a long anecdote is not a
 * requirement — so a segment must also mention something the schema can hold.
 */
export const isSubstantive = (text: string): boolean => {
  const dense = text.replace(/\s+/g, "");
  if (dense.length < MIN_SEGMENT_CHARS) return false;
  return /\d/.test(text) || REQUIREMENT_HINTS.test(text);
};

/**
 * Decide whether the accumulated turns should close into a segment.
 *
 * `now` and `explicit` are passed in rather than read here so the rule stays a
 * pure function: the caller owns the clock and the user's intent.
 */
export const evaluateSegment = (input: {
  turns: SegmentTurn[];
  now: Date;
  explicit?: boolean;
}): SegmentDecision => {
  if (!conversationExtractionEnabled()) return { extract: false, reason: "disabled" };
  const turns = input.turns.filter((turn) => turn.content.trim());
  if (!turns.length) return { extract: false, reason: "empty" };

  const text = segmentText(turns);
  // An explicit "use what I've told you" still refuses an empty or trivial
  // segment rather than spending a call to extract nothing.
  if (!isSubstantive(text)) return { extract: false, reason: "insufficient" };

  const last = turns[turns.length - 1];
  const idleFor = input.now.getTime() - last.createdAt.getTime();
  const reason: SegmentReason | null = input.explicit
    ? "explicit"
    : turns.length >= MAX_TURNS
      ? "turns"
      : idleFor >= IDLE_MS
        ? "idle"
        : null;
  if (!reason) return { extract: false, reason: "open" };

  return {
    extract: true,
    reason,
    turns,
    text,
    // Keyed on the closing message so a replayed request cannot mint a second
    // source for the same segment.
    idempotencyKey: `conversation-segment:${last.id}`,
  };
};

/** Human-readable source title, stable per segment for the sources rail. */
export const segmentTitle = (ordinal: number): string => `Conversation notes ${ordinal}`;
