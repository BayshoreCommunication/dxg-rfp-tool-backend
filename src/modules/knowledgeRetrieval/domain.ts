import crypto from "node:crypto";

export const RETRIEVAL_FIXTURES={
  "breakout-room-schedule":"breakout room schedule start time end time room assignment audiovisual requirements",
  "general-session-production":"general session production audio video lighting recording streaming presenter moderator",
  "no-match":"submarine agriculture unrelated synthetic no match",
} as const;
export type RetrievalFixture=keyof typeof RETRIEVAL_FIXTURES;
export type RetrievalFilters={sourceTypes:string[];market:string|null;currency:string|null};
export class KnowledgeRetrievalError extends Error{constructor(public readonly code:string,message:string,public readonly status=422){super(message);}}
const allowedSourceTypes=new Set(["contract","prior_proposal","price_sheet","equipment_list","labor_schedule","operating_guidance","other"]);
export const retrievalEnabled=()=>process.env.KNOWLEDGE_RETRIEVAL_ENABLED==="true"&&process.env.NODE_ENV==="test";
export const parseRetrievalInput=(value:Record<string,unknown>)=>{
 const fixture=String(value.fixture||"") as RetrievalFixture;if(!(fixture in RETRIEVAL_FIXTURES))throw new KnowledgeRetrievalError("INVALID_RETRIEVAL_FIXTURE","Fixture is not approved for Slice 2C.",422);
 const raw=(value.filters&&typeof value.filters==="object"?value.filters:{}) as Record<string,unknown>;
 const sourceTypes=Array.isArray(raw.sourceTypes)?[...new Set(raw.sourceTypes.map(String))]:[];if(sourceTypes.length>10||sourceTypes.some(x=>!allowedSourceTypes.has(x)))throw new KnowledgeRetrievalError("INVALID_RETRIEVAL_FILTERS","Source-type filters are invalid.",422);
 const market=typeof raw.market==="string"&&raw.market.trim()?raw.market.trim():null;if(market&&market.length>100)throw new KnowledgeRetrievalError("INVALID_RETRIEVAL_FILTERS","Market filter is invalid.",422);
 const currency=typeof raw.currency==="string"&&raw.currency.trim()?raw.currency.trim().toUpperCase():null;if(currency&&!/^[A-Z]{3}$/.test(currency))throw new KnowledgeRetrievalError("INVALID_RETRIEVAL_FILTERS","Currency filter is invalid.",422);
 const configured=Math.min(Math.max(Number(process.env.KNOWLEDGE_RETRIEVAL_MAX_RESULTS)||20,1),20),limit=Math.min(Math.max(Number(value.limit)||10,1),configured);
 return{fixture,query:RETRIEVAL_FIXTURES[fixture],filters:{sourceTypes,market,currency},limit};
};
export const retrievalFingerprint=(input:{fixture:RetrievalFixture;filters:RetrievalFilters;limit:number})=>crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
