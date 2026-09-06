// Local-only integration fixture. Never points at the production database or storage.
import "../config/env";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { PDFDocument } from "pdf-lib";
import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import Organization from "../modal/organizationModel";
import User from "../modal/userModel";
import Membership from "../modal/organizationMembershipModel";
import RefreshSession from "../modal/refreshSessionModel";

async function main() {
  assert.equal(process.env.MONGODB_URL, "mongodb://127.0.0.1:27017/rfpilot_product_updates_test");
  assert.equal(process.env.MONGODB_DB_NAME, "rfpilot_product_updates_test");
  assert.equal(process.env.ASSET_STORAGE_ENDPOINT, "http://127.0.0.1:9000");
  assert.equal(process.env.ASSET_STORAGE_BUCKET, "rfpilot-product-updates");
  assert.equal(process.env.VENDOR_UPLOAD_SCAN_REQUIRED, "true");
  const base = "http://127.0.0.1:8000";
  await mongoose.connect(process.env.MONGODB_URL);
  const organization = await Organization.findOneAndUpdate({ slug: "product-updates-qa" }, { $setOnInsert: { name: "Product Updates QA", status: "active" } }, { upsert: true, new: true });
  const email = "product-updates-qa@example.test";
  const password = "Local-product-updates-QA-2026!";
  const user = await User.findOne({ email }) || await User.create({ organizationId: organization._id, name: "Product Updates QA", email, password, role: "customer" });
  const membership = await Membership.findOneAndUpdate({ organizationId: organization._id, userId: user._id }, { $setOnInsert: { roles: ["planner"], status: "active", version: 1 } }, { upsert: true, new: true });
  const s3 = new S3Client({ endpoint: process.env.ASSET_STORAGE_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: process.env.ASSET_STORAGE_KEY!, secretAccessKey: process.env.ASSET_STORAGE_SECRET! } });
  try { await s3.send(new HeadBucketCommand({ Bucket: process.env.ASSET_STORAGE_BUCKET })); }
  catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
    await s3.send(new CreateBucketCommand({ Bucket: process.env.ASSET_STORAGE_BUCKET }));
  }
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const account = await login.json() as { accessToken: string; sessionId: string };
  assert.equal(login.status, 200, "local login");
  const headers = { Authorization: `Bearer ${account.accessToken}` };
  const ticketResponse = await fetch(`${base}/api/proposals/upload-ticket`, { method: "POST", headers });
  assert.equal(ticketResponse.status, 200, "ticket issuance");
  const { data: { ticket } } = await ticketResponse.json() as { data: { ticket: string } };
  const preflight = await fetch(`${base}/api/proposals/upload-files/direct`, { method: "OPTIONS", headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" } });
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal((await fetch(`${base}/api/proposals/upload-files/direct`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${base}/api/proposals`, { headers: { Authorization: `Bearer ${ticket}` } })).status, 401, "upload ticket cannot read proposals");

  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("Synthetic 12.7 MB brand guide — local upload QA only".replace("—", "-"));
  const small = Buffer.from(await pdf.save());
  const eof = small.lastIndexOf("%%EOF");
  const bytes = Buffer.concat([small.subarray(0, eof), Buffer.alloc(Math.round(12.7 * 1024 * 1024) - small.length, 32), small.subarray(eof)]);
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "product-updates-upload-"));
  const fixture = path.join(fixtureDirectory, "brand-guide-12.7mb.pdf");
  await fs.writeFile(fixture, bytes);
  const upload = (body: Uint8Array, name: string, authorization = ticket) => {
    const form = new FormData();
    form.append("supportDocuments", new Blob([new Uint8Array(body)], { type: "application/pdf" }), name);
    return fetch(`${base}/api/proposals/upload-files/direct`, { method: "POST", headers: { Authorization: `Bearer ${authorization}` }, body: form });
  };
  const uploaded = await upload(bytes, "brand-guide-12.7mb.pdf");
  const result = await uploaded.json() as { success: boolean; data: { url: string }[]; message?: string };
  assert.equal(uploaded.status, 200, result.message);
  assert.equal(result.success, true);
  const url = result.data[0].url;
  assert.equal((await fetch(url)).status, 403, "uploaded document remains private");
  const signed = await fetch(`${base}/api/proposals/file-url?url=${encodeURIComponent(url)}`, { headers });
  const signedBody = await signed.json() as { data: { url: string } };
  assert.equal(signed.status, 200);
  const download = await fetch(signedBody.data.url);
  assert.equal(download.status, 200, "private download");
  const downloaded = Buffer.from(await download.arrayBuffer());
  assert.equal(crypto.createHash("sha256").update(downloaded).digest("hex"), crypto.createHash("sha256").update(bytes).digest("hex"), "all uploaded bytes survive private storage and download");

  const infected = await upload(Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"), "antivirus-test.pdf");
  assert.equal(infected.status, 422, "scanner still rejects EICAR test signature");
  const proposalResponse = await fetch(`${base}/api/proposals`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({
    event: { eventName: "Product Updates QA Annual Meeting", eventType: { eventType: "Annual Meeting" }, eventFormat: "In-Person", attendees: "100", startDate: "2027-06-10", endDate: "2027-06-11", statementOfWork: "QA: Provide audiovisual support for a 100-person annual meeting." },
    venueSchedule: { venueName: "QA Conference Hall", venueCity: "Austin", venueState: "TX", timeZone: "America/Chicago", numberOfEventRooms: "1", venueType: "Hotel Ballroom", venueConfirmedStatus: "CONTRACT_SIGNED" },
    roomByRoom: [{ roomLocation: "Main Hall", roomFunction: "General Session", estimatedAttendeesInRoom: "100", scheduleDate: "2027-06-10", showStartDateTime: "2027-06-10T09:00", showEndDateTime: "2027-06-10T17:00", videoRecording: { videoRecording: "Yes", recordingCodec: "Vendor recommendation", recordIn4k: "No" } }],
    budget: { estimatedAvBudget: "Standard", vendorQuestionsDueDate: "2027-04-01", responseToVendorQuestionsDate: "2027-04-03", proposalSubmissionDueDate: "2027-04-10", shortlistNotificationDate: "2027-04-15", vendorPresentationOpportunity: "NO", vendorSelectionDate: "2027-04-20" },
    videoRecordingStep: { videoRecordingRequired: "YES", recordingCodec: "Vendor recommendation", recordIn4k: "NO" },
    uploads: { brandGuideFiles: [url] },
    contact: { contactFirstName: "Product", contactLastName: "QA", contactEmail: email, contactPhone: "5125550100", contactOrganization: "Local QA", organizationLegalName: "Local QA", contactTitle: "Event Planner", additionalContacts: [] },
    status: "unsubmitted", isDraft: true,
  }) });
  const created = await proposalResponse.json() as { data: { _id: string }; message?: string };
  assert.equal(proposalResponse.status, 201, JSON.stringify(created));
  const savedResponse = await fetch(`${base}/api/proposals/${created.data._id}`, { headers });
  const saved = await savedResponse.json() as { data: { roomByRoom: { videoRecording: { recordingCodec: string } }[]; videoRecordingStep: { recordingCodec: string }; uploads: { brandGuideFiles: string[] } } };
  assert.equal(saved.data.roomByRoom[0].videoRecording.recordingCodec, "Vendor recommendation");
  // The standalone recording step is retired by the current workflow flag;
  // room-level recording is the active editor and must survive persistence.
  assert.deepEqual(saved.data.uploads.brandGuideFiles, [url]);
  await Membership.updateOne({ _id: membership._id }, { $inc: { version: 1 } });
  try { assert.equal((await upload(small, "stale-membership.pdf")).status, 401); }
  finally { await Membership.updateOne({ _id: membership._id }, { $set: { version: membership.version } }); }
  await RefreshSession.updateOne({ sessionId: account.sessionId }, { $set: { status: "revoked" } });
  assert.equal((await upload(small, "revoked-session.pdf")).status, 403);
  s3.destroy();
  console.log(JSON.stringify({ result: "PASS", sizeBytes: bytes.length, privateRead: "blocked", downloadHash: "matches", malware: "blocked", staleMembership: "blocked", revokedSession: "blocked", savedRecordingChoice: "Vendor recommendation", browserProposal: `http://localhost:3000/proposals/proposal-edit?proposalId=${created.data._id}`, browserFixture: fixture, localEmail: email }, null, 2));
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => mongoose.disconnect());
