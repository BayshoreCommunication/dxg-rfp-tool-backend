import "../config/env";
import {closePostgres} from "../config/postgres";
import {durableJobDispatcher} from "../src/modules/durableJobs/composition";
import {closeQueue} from "../src/modules/durableJobs/queue";
import {durableJobsEnabled} from "../src/modules/durableJobs/redis";
if(!durableJobsEnabled())throw new Error("DURABLE_JOBS_ENABLED must be true to start the dispatcher");
let stopping=false;const tick=async()=>{if(!stopping)await durableJobDispatcher.dispatch(50);};const reconcile=async()=>{if(!stopping)await durableJobDispatcher.reconcile(200);};
// A failed pass must never kill the process (the unprotected initial tick
// did exactly that when the schema had not been migrated yet), and failures
// must be visible to operators rather than swallowed.
const logged=(label:string)=>(error:unknown)=>{console.error(`[dispatcher] ${label} failed:`,error instanceof Error?error.message:error);};
const dispatchTimer=setInterval(()=>{void tick().catch(logged("dispatch"));},1000);const reconcileTimer=setInterval(()=>{void reconcile().catch(logged("reconcile"));},30000);void tick().catch(logged("dispatch"));
const shutdown=async()=>{stopping=true;clearInterval(dispatchTimer);clearInterval(reconcileTimer);await closeQueue();await closePostgres();process.exit(0);};
process.on("SIGTERM",()=>{void shutdown();});process.on("SIGINT",()=>{void shutdown();});console.log("Durable-job dispatcher started");
