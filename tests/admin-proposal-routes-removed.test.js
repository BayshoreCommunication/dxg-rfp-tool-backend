require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const express = require("express");

// 2026-11-17: GET /api/admin/proposals and GET /api/admin/proposals/:id are removed. RFPilot
// staff read customer proposals only under a support access grant
// (/api/v1/admin/support-access/*). These tests fail if either path is routed again. The proof
// with real staff and customer sessions is tests-integration/admin-client-list.test.ts.

const repoRoot = path.join(__dirname, "..");
const adminRouter = require("../routes/adminRoute").default;

const routesOf = (router) =>
  router.stack.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods).join(",").toUpperCase()} ${layer.route.path}`);

test("the /api/admin router serves the overview and no proposal route", () => {
  assert.deepEqual(routesOf(adminRouter), ["GET /overview"]);
});

test("the removed proposal paths answer the API's 404 whoever asks", async () => {
  const app = express();
  app.use("/api/admin", adminRouter);
  // server.ts ends with this handler.
  app.use((_req, res) => res.status(404).json({ success: false, message: "Route not found" }));
  const server = http.createServer(app).listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const callers = { staff: "Bearer staff-session-token", customer: "Bearer customer-session-token", anonymous: undefined };
    for (const [caller, authorization] of Object.entries(callers)) {
      for (const target of ["/api/admin/proposals", "/api/admin/proposals?view=published&search=gala", "/api/admin/proposals/6adf186c99740ffeab7ac9f6"]) {
        const res = await fetch(`${base}${target}`, { headers: authorization ? { authorization } : {} });
        assert.equal(res.status, 404, `${caller} ${target}`);
        assert.deepEqual(await res.json(), { success: false, message: "Route not found" }, `${caller} ${target}`);
      }
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("nothing in the API source still defines or imports the removed proposal directory", () => {
  for (const gone of [
    "src/modules/admin/application/listAdminProposals.ts",
    "src/modules/admin/domain/ports/adminProposalRepository.ts",
    "src/modules/admin/infrastructure/mongo/mongoAdminProposalRepository.ts",
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, gone)), false, gone);
  }
  for (const file of ["controller/adminController.ts", "routes/adminRoute.ts", "src/modules/admin/composition.ts"]) {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(source, /getAdminProposal|listAdminProposals|AdminProposalRepository/, file);
  }
  // /api/admin is mounted once more, for legacy-customer placement; no other router adds a proposal path under it.
  const server = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
  assert.deepEqual(
    [...server.matchAll(/app\.use\("(\/api\/admin[^"]*)"/g)].map((match) => match[1]).sort(),
    ["/api/admin", "/api/admin-user", "/api/admin/legacy-customers"],
  );
});
