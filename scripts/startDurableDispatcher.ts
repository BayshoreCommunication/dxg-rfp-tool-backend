import "../config/env";
import mongoose from "mongoose";
import connectDB from "../config/db";
import {closePostgres} from "../config/postgres";
import {durableJobDispatcher} from "../src/modules/durableJobs/composition";
import {createOptionalMongoReconnect} from "../src/modules/durableJobs/optionalMongoReconnect";
import {closeQueue} from "../src/modules/durableJobs/queue";
import {durableJobsEnabled} from "../src/modules/durableJobs/redis";
if(!durableJobsEnabled())throw new Error("DURABLE_JOBS_ENABLED must be true to start the dispatcher");
let stopping=false;const tick=async()=>{if(!stopping)await durableJobDispatcher.dispatch(50);};
// If MongoDB was unreachable at boot (below) nothing else retries it. Each reconcile pass starts a
// reconnect when one is needed: not awaited, never throws, logs at most once a minute
// (optionalMongoReconnect.ts). Reconcile itself runs at once either way.
const reconnectMongo=createOptionalMongoReconnect({configured:()=>Boolean(process.env.MONGODB_URL||process.env.MONGO_URL),readyState:()=>mongoose.connection.readyState,connect:()=>connectDB({quietFailure:true}),log:line=>{console.error(line);}});
const reconcile=async()=>{if(stopping)return;reconnectMongo();await durableJobDispatcher.reconcile(200);};
// A failed pass must never kill the process (the unprotected initial tick
// did exactly that when the schema had not been migrated yet), and failures
// must be visible to operators rather than swallowed.
const logged=(label:string)=>(error:unknown)=>{console.error(`[dispatcher] ${label} failed:`,error instanceof Error?error.message:error);};
// MongoDB is OPTIONAL here, and only for fairness: with it, reconcile leaves the queued jobs of
// organizations RFPilot staff blocked out of its batch so they cannot starve the others
// (durableJobs/composition.ts). Without it, or while it is unreachable, the dispatcher runs as it
// always did. Never awaited and never fatal: outbox dispatch must not wait on MongoDB.
if(process.env.MONGODB_URL||process.env.MONGO_URL)void connectDB().catch(logged("mongodb (optional, reconcile fairness only)"));
const dispatchTimer=setInterval(()=>{void tick().catch(logged("dispatch"));},1000);const reconcileTimer=setInterval(()=>{void reconcile().catch(logged("reconcile"));},30000);void tick().catch(logged("dispatch"));
const shutdown=async()=>{stopping=true;clearInterval(dispatchTimer);clearInterval(reconcileTimer);await closeQueue();await closePostgres();if(mongoose.connection.readyState!==0)await mongoose.disconnect().catch(()=>undefined);process.exit(0);};
process.on("SIGTERM",()=>{void shutdown();});process.on("SIGINT",()=>{void shutdown();});console.log("Durable-job dispatcher started");
