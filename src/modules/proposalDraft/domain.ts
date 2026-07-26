import {aiRuntimeAuthorized} from "../../../config/aiEnvironment";
export class ProposalDraftError extends Error{constructor(public readonly code:string,message:string,public readonly status=422){super(message);}}
export const proposalDraftEnabled=()=>aiRuntimeAuthorized()&&process.env.PROPOSAL_DRAFT_ENABLED==="true";
export const parseDraftInput=(value:Record<string,unknown>)=>{const expectedProposalVersion=Number(value.expectedProposalVersion),fixture=String(value.fixture||"");if(!Number.isInteger(expectedProposalVersion)||expectedProposalVersion<1)throw new ProposalDraftError("INVALID_PROPOSAL_VERSION","Expected proposal version is required.");if(fixture!=="synthetic-proposal-draft")throw new ProposalDraftError("INVALID_DRAFT_FIXTURE","Only the approved synthetic draft fixture is allowed.");return{expectedProposalVersion,fixture};};
export type DraftParagraph={text:string;evidencePaths:string[]};export type DraftSection={key:string;heading:string;paragraphs:DraftParagraph[]};
// Kept in lockstep with the JSON-schema enum in liveAi/operations.ts and both
// section-key CHECK constraints (migrations 018 + 026). Adding a key needs all
// three; a code-only addition fails at insert, not at request validation.
export const DRAFT_SECTION_KEYS=["event_overview","objectives_audience","format_experience","venue_schedule","production_scope","known_requirements","information_gaps","budget_procurement","room_requirements","venue_technical","vendor_terms"]as const;
export type DraftSectionKey=typeof DRAFT_SECTION_KEYS[number];
export const parseSectionKey=(value:unknown):DraftSectionKey=>{const key=String(value||"");if(!DRAFT_SECTION_KEYS.includes(key as DraftSectionKey))throw new ProposalDraftError("INVALID_SECTION_KEY","Draft section was not found.",404);return key as DraftSectionKey;};
export const parseSectionDecision=(value:Record<string,unknown>)=>{const decision=String(value.decision||"");if(!["accepted","rejected"].includes(decision))throw new ProposalDraftError("INVALID_SECTION_DECISION","Section decision must be accepted or rejected.");const reason=typeof value.reason==="string"?value.reason.trim():"";if(reason.length>500)throw new ProposalDraftError("INVALID_SECTION_DECISION","Section decision reason is too long.");return{decision:decision as "accepted"|"rejected",reason};};
