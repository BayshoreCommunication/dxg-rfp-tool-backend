import {aiRuntimeAuthorized} from "../../../config/aiEnvironment";
import {activeCandidatePaths} from "../candidateApplication/canonicalMapping";

export class VendorAnalysisError extends Error{
 constructor(public readonly code:string,message:string,public readonly status=422,public readonly retryable=false){super(message);}
}

export const vendorAnalysisEnabled=()=>aiRuntimeAuthorized()&&process.env.VENDOR_ANALYSIS_ENABLED==="true";

export type VendorRequirement={path:string;label:string;value:string};

// Sections most relevant to vendor compliance review keep priority when the
// requirement list is capped; everything else follows in whitelist order.
const SECTION_PRIORITY=["event","venueSchedule","videoRecordingStep","venue","hybridVirtual"] as const;
const MAX_REQUIREMENTS=80;

const segmentsOf=(path:string)=>path.replace(/^\/content\//,"").split("/");
const humanizeSegment=(segment:string)=>{
 const spaced=segment.replace(/([a-z0-9])([A-Z])/g,"$1 $2").replace(/[_-]+/g," ").toLowerCase().trim();
 return spaced?spaced.charAt(0).toUpperCase()+spaced.slice(1):segment;
};
const resolveDotPath=(proposal:Record<string,unknown>,segments:string[])=>segments.reduce<unknown>((current,segment)=>current!==null&&typeof current==="object"?(current as Record<string,unknown>)[segment]:undefined,proposal);
const filled=(value:unknown)=>value!==undefined&&value!==null&&String(value).trim()!=="";

// Derives the deterministic RFP requirement list from a proposal: every filled
// approved candidate path (resolved via the "/content/x/y" -> "x.y" dot-path
// convention) plus one entry per room-by-room specification.
export const buildRequirements=(proposal:Record<string,unknown>):VendorRequirement[]=>{
 const rank=(path:string)=>{
  const index=(SECTION_PRIORITY as readonly string[]).indexOf(segmentsOf(path)[0]);
  return index===-1?SECTION_PRIORITY.length:index;
 };
 const requirements=activeCandidatePaths
  .map((path,order)=>({path,order,value:resolveDotPath(proposal,segmentsOf(path))}))
  .filter(entry=>filled(entry.value))
  .sort((a,b)=>rank(a.path)-rank(b.path)||a.order-b.order)
  .slice(0,MAX_REQUIREMENTS)
  .map(entry=>({path:entry.path,label:humanizeSegment(segmentsOf(entry.path).slice(-1)[0]),value:String(entry.value).slice(0,300)}));
 const rooms=Array.isArray(proposal.roomByRoom)?proposal.roomByRoom:[];
 return[...requirements,...rooms.map((room,index)=>({path:`/content/roomByRoom/${index}`,label:`Room ${index+1} specifications`,value:JSON.stringify(room).slice(0,300)}))];
};
