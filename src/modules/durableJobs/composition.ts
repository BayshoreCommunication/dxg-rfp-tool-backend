import mongoose from "mongoose";
import {blockedOrganizationIds} from "../organizationBlock/organizationBlockGate";
import {createDispatcher} from "./dispatcher";
import {postgresJobRepository} from "./postgresJobRepository";
export const durableJobRepository=postgresJobRepository;
/* The dispatcher works from PostgreSQL and Redis and does not need MongoDB. When its process has a
   MongoDB connection (scripts/startDurableDispatcher.ts connects when MONGODB_URL is set) reconcile
   leaves blocked organizations' jobs out of its batch; without one it reconciles every
   organization, as before (dispatcher.ts). Read only while connected, so nothing waits on MongoDB. */
export const durableJobDispatcher=createDispatcher(postgresJobRepository,undefined,async()=>mongoose.connection.readyState===1?blockedOrganizationIds():[]);
