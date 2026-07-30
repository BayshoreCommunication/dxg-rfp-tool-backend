import crypto from "crypto";
import fs from "fs";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

import Organization from "./modal/organizationModel";
import OrganizationMembership from "./modal/organizationMembershipModel";
import User from "./modal/userModel";

const main = async () => {
  const marker = crypto.randomBytes(6).toString("hex");
  const email = `codex-rfpilot-${marker}@example.test`;
  const password = `Synthetic-${crypto.randomBytes(12).toString("base64url")}!`;

  await mongoose.connect(process.env.MONGODB_URL as string);
  const organization = await Organization.create({
    name: `Codex RFPilot ${marker}`,
    slug: `codex-rfpilot-${marker}`,
    status: "active",
  });
  const user = await User.create({
    organizationId: organization._id,
    name: "Synthetic Event Planner",
    email,
    password,
    company: "Synthetic Events",
    role: "customer",
  });
  await OrganizationMembership.create({
    organizationId: organization._id,
    userId: user._id,
    roles: ["planner", "organization_admin"],
    status: "active",
    version: 1,
    activatedAt: new Date(),
  });
  fs.writeFileSync("/tmp/rfpilot-browser-credentials.json", JSON.stringify({
    email,
    password,
    userId: String(user._id),
    organizationId: String(organization._id),
  }), { mode: 0o600 });
  await mongoose.disconnect();
};

void main();
