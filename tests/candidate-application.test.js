const fs = require("node:fs"), path = require("node:path");
const test=require("node:test"),assert=require("node:assert/strict");const{normalizeCandidate,approvedCandidatePaths,extractionPathEnum}=require("../src/modules/candidateApplication/canonicalMapping");const{parseReview,parseApplication,CandidateApplicationError,candidateApplicationEnabled}=require("../src/modules/candidateApplication/domain");
const {requiresOverwriteConfirmation}=require("../src/modules/candidateApplication/postgresCandidateApplicationRepository");
test("legacy-shaped fixture candidates normalize to canonical and allowlisted Mongo paths",()=>{assert.deepEqual(normalizeCandidate("/content/event/eventName"," Test "),{sourcePath:"/content/event/eventName",canonicalPath:"/content/event/name",mongoPath:"event.eventName",canonicalValue:"Test",mongoValue:"Test"});assert.equal(normalizeCandidate("/content/event/eventFormat","Hybrid").canonicalValue,"hybrid");assert.equal(normalizeCandidate("/content/venueSchedule/numberOfEventRooms","6").canonicalValue,6);for(const path of["/content/event/eventName","/content/event/eventFormat","/content/event/eventObjectives","/content/venueSchedule/numberOfEventRooms"])assert.ok(approvedCandidatePaths.includes(path));});
test("unapproved, operator and prototype paths fail closed",()=>{for(const path of["/content/event/theme","/content/$where","/content/__proto__/x","event.eventName"])assert.throws(()=>normalizeCandidate(path,"x"),CandidateApplicationError);});
test("canonical values are field bounded",()=>{assert.throws(()=>normalizeCandidate("/content/event/eventName",""));assert.throws(()=>normalizeCandidate("/content/event/eventFormat","onsite"));assert.throws(()=>normalizeCandidate("/content/venueSchedule/numberOfEventRooms",201));});
test("reviews allow partial decisions and optional rejection reason",()=>{const x=parseReview({revision:0,decisions:[{operationId:"019f7e39-7f34-7091-b415-6a57c06e7de1",decision:"rejected"}]});assert.equal(x.decisions[0].reason,null);assert.throws(()=>parseReview({revision:0,decisions:[{operationId:"019f7e39-7f34-7091-b415-6a57c06e7de1",decision:"modified"}]}));});
test("applications require bounded unique selections and scoped overwrite confirmations",()=>{const id="019f7e39-7f34-7091-b415-6a57c06e7de1",x=parseApplication({expectedProposalVersion:1,operationIds:[id,id],overwriteConfirmedOperationIds:[id]});assert.deepEqual(x.operationIds,[id]);assert.throws(()=>parseApplication({expectedProposalVersion:1,operationIds:[id],overwriteConfirmedOperationIds:["119f7e39-7f34-7091-b415-6a57c06e7de2"]}));});
test("idempotent candidate values do not require overwrite confirmation",()=>{
 assert.equal(requiresOverwriteConfirmation("USD","USD",false),false);
 assert.equal(requiresOverwriteConfirmation("In-Person","Hybrid",false),true);
 assert.equal(requiresOverwriteConfirmation("In-Person","Hybrid",true),false);
 assert.equal(requiresOverwriteConfirmation("","Hybrid",false),false);
 assert.equal(requiresOverwriteConfirmation("Untitled proposal","Atlas Innovation Forum 2027",false),false);
});
test("candidate application is test-only and explicitly gated",()=>{const old={n:process.env.NODE_ENV,f:process.env.CANDIDATE_APPLICATION_ENABLED};process.env.NODE_ENV="production";process.env.CANDIDATE_APPLICATION_ENABLED="true";assert.equal(candidateApplicationEnabled(),false);process.env.NODE_ENV="test";assert.equal(candidateApplicationEnabled(),true);old.n===undefined?delete process.env.NODE_ENV:process.env.NODE_ENV=old.n;old.f===undefined?delete process.env.CANDIDATE_APPLICATION_ENABLED:process.env.CANDIDATE_APPLICATION_ENABLED=old.f;});
test("legacy slice 2E mappings still round-trip byte-identically",()=>{
 assert.deepEqual(normalizeCandidate("/content/event/eventName"," Annual Summit "),{sourcePath:"/content/event/eventName",canonicalPath:"/content/event/name",mongoPath:"event.eventName",canonicalValue:"Annual Summit",mongoValue:"Annual Summit"});
 assert.deepEqual(normalizeCandidate("/content/event/eventFormat","in-person"),{sourcePath:"/content/event/eventFormat",canonicalPath:"/content/event/format",mongoPath:"event.eventFormat",canonicalValue:"in_person",mongoValue:"In-Person"});
 assert.equal(normalizeCandidate("/content/event/eventFormat","Hybrid").mongoValue,"Hybrid");
 assert.deepEqual(normalizeCandidate("/content/event/eventObjectives","Grow pipeline."),{sourcePath:"/content/event/eventObjectives",canonicalPath:"/content/event/objectives",mongoPath:"event.eventObjectives",canonicalValue:"Grow pipeline.",mongoValue:"Grow pipeline."});
 assert.deepEqual(normalizeCandidate("/content/venueSchedule/numberOfEventRooms","6"),{sourcePath:"/content/venueSchedule/numberOfEventRooms",canonicalPath:"/content/venueSchedule/roomCount",mongoPath:"venueSchedule.numberOfEventRooms",canonicalValue:6,mongoValue:"6"});
 assert.throws(()=>normalizeCandidate("/content/venueSchedule/numberOfEventRooms",0),CandidateApplicationError);
});
test("text mappings trim and enforce contract max lengths",()=>{
 assert.deepEqual(normalizeCandidate("/content/venueSchedule/venueName","  Aria Ballroom  "),{sourcePath:"/content/venueSchedule/venueName",canonicalPath:"/content/venueSchedule/venueName",mongoPath:"venueSchedule.venueName",canonicalValue:"Aria Ballroom",mongoValue:"Aria Ballroom"});
 assert.throws(()=>normalizeCandidate("/content/venueSchedule/venueName","x".repeat(301)),CandidateApplicationError);
 assert.equal(normalizeCandidate("/content/contentCreative/presentationTemplateDesign","AV Vendor").mongoValue,"AV Vendor");
 assert.throws(()=>normalizeCandidate("/content/contentCreative/presentationTemplateDesign","x".repeat(101)),CandidateApplicationError);
});
test("enum mappings accept case/space/hyphen-insensitive input and reject unknown values",()=>{
 const status=normalizeCandidate("/content/venueSchedule/venueConfirmedStatus","Contract Signed");
 assert.equal(status.canonicalValue,"contract_signed");assert.equal(status.mongoValue,"CONTRACT_SIGNED");
 assert.equal(normalizeCandidate("/content/venueSchedule/venueConfirmedStatus","VERBAL_CONFIRM").canonicalValue,"verbal_confirmation");
 assert.equal(normalizeCandidate("/content/venueSchedule/venueConfirmedStatus","strong-preference").mongoValue,"STRONG_PREF");
 assert.throws(()=>normalizeCandidate("/content/venueSchedule/venueConfirmedStatus","maybe"),CandidateApplicationError);
 const caption=normalizeCandidate("/content/hybridVirtual/closedCaptions/captionType","AI");
 assert.equal(caption.canonicalValue,"ai");assert.equal(caption.mongoValue,"AI");
 assert.equal(normalizeCandidate("/content/hybridVirtual/closedCaptions/captionType","human").mongoValue,"Human");
 assert.throws(()=>normalizeCandidate("/content/hybridVirtual/closedCaptions/captionType","unknown"),CandidateApplicationError);
});
test("boolean-or-null mappings mirror the legacy wizard YES/NO/NOT_SURE storage",()=>{
 assert.deepEqual(normalizeCandidate("/content/venue/riggingRequired","yes"),{sourcePath:"/content/venue/riggingRequired",canonicalPath:"/content/venueTechnical/riggingRequired",mongoPath:"venue.riggingRequired",canonicalValue:true,mongoValue:"YES"});
 assert.equal(normalizeCandidate("/content/venue/riggingRequired",false).mongoValue,"NO");
 assert.equal(normalizeCandidate("/content/uploads/ndaRequired","No").mongoValue,"NO");
 const unsure=normalizeCandidate("/content/venueSchedule/isUnionVenue","not sure");
 assert.equal(unsure.canonicalValue,null);assert.equal(unsure.mongoValue,"NOT_SURE");
 assert.equal(normalizeCandidate("/content/hybridVirtual/remoteSpeakers/remoteSpeakers","YES").canonicalValue,true);
 assert.throws(()=>normalizeCandidate("/content/venue/riggingRequired","probably"),CandidateApplicationError);
});
test("date and time mappings validate ISO formats",()=>{
 assert.deepEqual(normalizeCandidate("/content/venueSchedule/loadInDate","2026-09-12"),{sourcePath:"/content/venueSchedule/loadInDate",canonicalPath:"/content/venueSchedule/loadIn/date",mongoPath:"venueSchedule.loadInDate",canonicalValue:"2026-09-12",mongoValue:"2026-09-12"});
 assert.throws(()=>normalizeCandidate("/content/venueSchedule/loadInDate","2026-02-30"),CandidateApplicationError);
 assert.throws(()=>normalizeCandidate("/content/budget/decisionDate","09/12/2026"),CandidateApplicationError);
 assert.equal(normalizeCandidate("/content/venueSchedule/loadInTime","07:30").mongoValue,"07:30");
 assert.throws(()=>normalizeCandidate("/content/venueSchedule/loadInTime","25:00"),CandidateApplicationError);
 assert.throws(()=>normalizeCandidate("/content/venueSchedule/loadInTime","7:30 AM"),CandidateApplicationError);
});
test("integer mappings enforce bounds and store legacy counts as strings",()=>{
 const attendees=normalizeCandidate("/content/hybridVirtual/virtualAttendeeEstimate","250");
 assert.equal(attendees.canonicalValue,250);assert.equal(attendees.mongoValue,"250");
 assert.throws(()=>normalizeCandidate("/content/hybridVirtual/virtualAttendeeEstimate",-1),CandidateApplicationError);
 assert.throws(()=>normalizeCandidate("/content/videoRecordingStep/numberOfCameras",100001),CandidateApplicationError);
 assert.throws(()=>normalizeCandidate("/content/budget/numberOfProposals","3.5"),CandidateApplicationError);
});
test("budget money mappings validate integer minor units and ISO currency",()=>{
 const amount=normalizeCandidate("/content/budget/amountMinor",1250000);
 assert.equal(amount.canonicalValue,1250000);assert.equal(amount.mongoValue,1250000);assert.equal(amount.canonicalPath,"/content/budgetPreferences/budget/amountMinor");
 assert.throws(()=>normalizeCandidate("/content/budget/amountMinor",12.5),CandidateApplicationError);
 assert.equal(normalizeCandidate("/content/budget/currency","usd").mongoValue,"USD");
 assert.throws(()=>normalizeCandidate("/content/budget/currency","US"),CandidateApplicationError);
});
test("email and amperage mappings reverse the legacy adapter faithfully",()=>{
 assert.equal(normalizeCandidate("/content/venue/venueAvContactEmail"," av@venue.com ").mongoValue,"av@venue.com");
 assert.throws(()=>normalizeCandidate("/content/venue/venueAvContactEmail","not-an-email"),CandidateApplicationError);
 const amperage=normalizeCandidate("/content/venue/powerDropAmperage",200);
 assert.deepEqual(amperage.canonicalValue,{value:200,unit:"amp"});assert.equal(amperage.mongoValue,"200A");
 assert.equal(normalizeCandidate("/content/venue/powerDropAmperage","400A").mongoValue,"400A");
 assert.throws(()=>normalizeCandidate("/content/venue/powerDropAmperage","lots"),CandidateApplicationError);
});
test("prototype-pollution and operator guards still fail closed on the expanded allowlist",()=>{
 for(const path of["/content/venueSchedule/__proto__","/content/venue/constructor","/content/budget/$where","venueSchedule.loadInDate","/content/event/theme","/content/rooms/0/function"])assert.throws(()=>normalizeCandidate(path,"x"),CandidateApplicationError);
});
test("expanded allowlist covers the full scalar contract without duplicates",()=>{
 assert.ok(approvedCandidatePaths.length>=100,`expected >=100 paths, found ${approvedCandidatePaths.length}`);
 assert.equal(new Set(approvedCandidatePaths).size,approvedCandidatePaths.length);
 assert.deepEqual(extractionPathEnum,approvedCandidatePaths);
 for(const path of approvedCandidatePaths)assert.match(path,/^\/content(?:\/[A-Za-z0-9_~-]+)+$/);
});
test("every mapping normalizes at least one valid sample end to end",()=>{
 const samples=[true,"3","2026-05-01","14:30","USD","user@example.com","Hybrid","CONTRACT_SIGNED","AI","Sample text",120000];
 for(const path of approvedCandidatePaths){
  let normalized=null;
  for(const sample of samples){try{normalized=normalizeCandidate(path,sample);break;}catch(error){if(!(error instanceof CandidateApplicationError))throw error;}}
  assert.ok(normalized,`no valid sample found for ${path}`);
  assert.equal(normalized.sourcePath,path);
  assert.ok(normalized.canonicalPath.startsWith("/content/"),path);
  assert.ok(normalized.mongoPath.length>0,path);
  assert.notEqual(normalized.mongoValue,undefined,path);
 }
});

test("review read survives candidates whose value the mapping rejects", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "controller", "candidateApplicationController.ts"), "utf8");
  // One unusable model value must not fail the whole review: normalization is
  // per-operation and failures are reported as invalidOperations.
  assert.ok(source.includes("invalidOperations"), "failures must be reported to the client");
  assert.ok(source.includes("catch(error)"), "normalization must be guarded per operation");
  const normalizeAt = source.indexOf("normalizeCandidate(operation.path");
  const catchAt = source.indexOf("catch(error)", normalizeAt);
  assert.ok(normalizeAt > -1 && catchAt > normalizeAt, "the guard must wrap the normalize call");
  assert.ok(source.includes("usable.map(x=>x.mongoPath)"), "the snapshot must only request paths that normalized");
});

test("enum fields accept the prose an extraction actually returns", () => {
  const { normalizeCandidate } = require("../src/modules/candidateApplication/canonicalMapping");
  const cases = [
    ["/content/venueSchedule/venueConfirmedStatus", "Confirmed", "CONTRACT_SIGNED"],
    ["/content/venueSchedule/venueConfirmedStatus", "Contract signed", "CONTRACT_SIGNED"],
    ["/content/venueSchedule/venueConfirmedStatus", "verbal confirmation", "VERBAL_CONFIRM"],
    ["/content/hybridVirtual/closedCaptions/captionType", "Human captioner preferred", "Human"],
    ["/content/hybridVirtual/closedCaptions/captionType", "AI", "AI"],
  ];
  for (const [path, value, expected] of cases)
    assert.equal(normalizeCandidate(path, value).mongoValue, expected, `${value} -> ${expected}`);
  // Ambiguous or unrelated prose must still be rejected rather than guessed.
  assert.throws(() => normalizeCandidate("/content/venueSchedule/venueConfirmedStatus", "maybe next year"), /invalid/i);
});

const { AUTO_APPLY_MIN_CONFIDENCE } = require("../src/modules/candidateApplication/domain");

test("automatic application is confidence-gated on the server, not just in the browser", () => {
  // The dashboard implemented the whole auto-apply policy: confidence >= 0.8,
  // empty target, one candidate per path. Empty-target is enforced by the
  // overwrite guard and one-per-path by CONFLICTING_APPLICATION_SELECTION, but
  // confidence was checked nowhere on the server — so any caller could
  // auto-apply a 0.05-confidence candidate while AI_LAYER.md described the
  // threshold as a guarantee.
  assert.equal(AUTO_APPLY_MIN_CONFIDENCE, 0.8);

  const fs = require("node:fs"), path = require("node:path");
  const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const repo = read("src/modules/candidateApplication/postgresCandidateApplicationRepository.ts");
  assert.match(repo, /o\.confidence FROM/, "the selection carries confidence");
  assert.match(repo, /if \(input\.automatic\)/, "the gate applies only to unattended applications");
  assert.match(repo, /AUTO_APPLY_CONFIDENCE_TOO_LOW/, "a weak candidate is refused with its own code");

  // A person who reviewed a low-confidence candidate and accepted it is still
  // allowed through: the threshold governs what the system may do unattended.
  const gate = repo.slice(repo.indexOf("if (input.automatic)"), repo.indexOf("const appId"));
  assert.ok(!/decision/.test(gate), "the gate does not second-guess a human decision");

  const domain = read("src/modules/candidateApplication/domain.ts");
  assert.match(domain, /automatic:value\.automatic===true/, "the flag is parsed, defaulting to attended");
});

test("successful field application records an append-only content-free audit event", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "src",
      "modules",
      "candidateApplication",
      "postgresCandidateApplicationRepository.ts",
    ),
    "utf8",
  );
  assert.match(source, /candidate_fields_applied/);
  assert.match(source, /fromProposalVersion/);
  assert.match(source, /resultingProposalVersion/);
  assert.match(source, /beforeChecksumRecorded/);
  assert.match(source, /afterChecksumRecorded/);
  assert.doesNotMatch(source, /audit_events[\s\S]{0,500}(modified_value|mongoValue)/);
});

test("application read supplies manual recovery information without an automatic undo", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "src",
      "modules",
      "candidateApplication",
      "postgresCandidateApplicationRepository.ts",
    ),
    "utf8",
  );
  assert.match(source, /mode: "manual_restore"/);
  assert.match(source, /fromProposalVersion/);
  assert.match(source, /resultingProposalVersion/);
  assert.doesNotMatch(source, /automatic_undo|undoCandidateApplication/);
});
