const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createDeleteOwnedVendorResponse,
  createDeleteSelectedOwnedVendorResponses,
} = require("../src/modules/vendorResponses/application/deleteVendorResponses");
const fs = require("node:fs");
const path = require("node:path");

const target = (responseId, proposalId = "proposal-001") => ({
  responseId,
  proposalId,
  organizationId: "organization-001",
  ownerUserId: "planner-001",
  submissionId: `submission-${responseId}`,
  versionIds: [`version-${responseId}`],
  objectKeys: [`private/${responseId}.pdf`],
  sourceIds: [`source-${responseId}`],
});

test("single vendor-response deletion purges artifacts before deleting the owned record", async () => {
  const order = [];
  const expected = target("response-001");
  const remove = createDeleteOwnedVendorResponse(
    {
      findOwnedDeletionTarget: async (input) => {
        assert.deepEqual(input, {
          responseId: "response-001",
          ownerUserId: "planner-001",
        });
        return expected;
      },
      deleteOwnedTargets: async (input) => {
        order.push("delete");
        assert.deepEqual(input, {
          ownerUserId: "planner-001",
          targets: [expected],
        });
        return 1;
      },
    },
    async (targets) => {
      order.push("purge");
      assert.deepEqual(targets, [expected]);
    },
  );

  const result = await remove({
    responseId: "response-001",
    ownerUserId: "planner-001",
  });

  assert.deepEqual(order, ["purge", "delete"]);
  assert.deepEqual(result, { kind: "deleted", deletedCount: 1 });
});

test("single deletion does not purge when the response is not owned", async () => {
  let purgeCalled = false;
  let deleteCalled = false;
  const remove = createDeleteOwnedVendorResponse(
    {
      findOwnedDeletionTarget: async () => null,
      deleteOwnedTargets: async () => {
        deleteCalled = true;
        return 0;
      },
    },
    async () => {
      purgeCalled = true;
    },
  );

  assert.deepEqual(
    await remove({ responseId: "response-002", ownerUserId: "planner-001" }),
    { kind: "not_found" },
  );
  assert.equal(purgeCalled, false);
  assert.equal(deleteCalled, false);
});

test("selected deletion scopes target discovery to the planner and requested ids", async () => {
  const targets = [target("response-001"), target("response-002")];
  let repositoryInput;
  const removeSelected = createDeleteSelectedOwnedVendorResponses(
    {
      listOwnedDeletionTargets: async (input) => {
        repositoryInput = input;
        return targets;
      },
      deleteOwnedTargets: async ({ targets: requestedTargets }) =>
        requestedTargets.length,
    },
    async (requestedTargets) => assert.deepEqual(requestedTargets, targets),
  );

  const result = await removeSelected({
    ownerUserId: "planner-001",
    responseIds: ["response-001", "response-002"],
  });

  assert.deepEqual(repositoryInput, {
    ownerUserId: "planner-001",
    responseIds: ["response-001", "response-002"],
  });
  assert.deepEqual(result, { kind: "deleted", deletedCount: 2 });
});

test("selected deletion fails closed when any requested response is not owned", async () => {
  let deleteCalled = false;
  const removeSelected = createDeleteSelectedOwnedVendorResponses(
    {
      listOwnedDeletionTargets: async () => [],
      deleteOwnedTargets: async () => {
        deleteCalled = true;
        return 0;
      },
    },
    async () => assert.fail("purge must not run for an empty target set"),
  );

  assert.deepEqual(
    await removeSelected({
      ownerUserId: "planner-001",
      responseIds: ["response-other-owner"],
    }),
    { kind: "not_found" },
  );
  assert.equal(deleteCalled, false);
});

test("destructive vendor-response routes require write authorization and validation", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../routes/vendorResponseRoute.ts"),
    "utf8",
  );
  assert.match(
    source,
    /router\.delete\(\s*"\/",\s*authenticate,\s*authorizeAction\("vendor-response:write"\),\s*plannerWriteLimit,\s*deleteSelectedVendorResponses/,
  );
  assert.match(
    source,
    /router\.delete\(\s*"\/:id",\s*authenticate,\s*authorizeAction\("vendor-response:write"\),\s*plannerWriteLimit,\s*validateResponseId,\s*deleteVendorResponse/,
  );
});
