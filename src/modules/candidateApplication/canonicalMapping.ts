import{CandidateApplicationError}from"./domain";
type Mapping={canonicalPath:string;mongoPath:string;normalize:(value:unknown)=>unknown;mongoValue:(value:unknown)=>unknown};
const text=(max:number)=>(value:unknown)=>{if(typeof value!=="string"||!value.trim()||value.trim().length>max)throw new CandidateApplicationError("INVALID_CANDIDATE_VALUE","Candidate text is invalid.");return value.trim();};
const mappings:Record<string,Mapping>={
 "/content/event/eventName":{canonicalPath:"/content/event/name",mongoPath:"event.eventName",normalize:text(300),mongoValue:value=>value},
 "/content/event/eventFormat":{canonicalPath:"/content/event/format",mongoPath:"event.eventFormat",normalize:value=>{const key=String(value).toLowerCase().replace(/[- ]/g,"_");if(!["in_person","hybrid","virtual"].includes(key))throw new CandidateApplicationError("INVALID_CANDIDATE_VALUE","Event format is invalid.");return key;},mongoValue:value=>({in_person:"In-Person",hybrid:"Hybrid",virtual:"Virtual"}[String(value)]!)},
 "/content/event/eventObjectives":{canonicalPath:"/content/event/objectives",mongoPath:"event.eventObjectives",normalize:text(10000),mongoValue:value=>value},
 "/content/venueSchedule/numberOfEventRooms":{canonicalPath:"/content/venueSchedule/roomCount",mongoPath:"venueSchedule.numberOfEventRooms",normalize:value=>{const n=Number(value);if(!Number.isInteger(n)||n<1||n>200)throw new CandidateApplicationError("INVALID_CANDIDATE_VALUE","Room count must be between 1 and 200.");return n;},mongoValue:value=>String(value)},
};
export type NormalizedCandidate={sourcePath:string;canonicalPath:string;mongoPath:string;canonicalValue:unknown;mongoValue:unknown};
export const normalizeCandidate=(path:string,value:unknown):NormalizedCandidate=>{if(path.includes("__proto__")||path.includes("prototype")||path.includes("constructor")||path.includes("$")||path.includes("."))throw new CandidateApplicationError("CANDIDATE_PATH_DENIED","Candidate path is prohibited.",403);const mapping=mappings[path];if(!mapping)throw new CandidateApplicationError("CANDIDATE_PATH_DENIED","Candidate path is not approved for Slice 2E.",403);const canonicalValue=mapping.normalize(value);return{sourcePath:path,canonicalPath:mapping.canonicalPath,mongoPath:mapping.mongoPath,canonicalValue,mongoValue:mapping.mongoValue(canonicalValue)};};
export const approvedCandidatePaths=Object.freeze(Object.keys(mappings));
