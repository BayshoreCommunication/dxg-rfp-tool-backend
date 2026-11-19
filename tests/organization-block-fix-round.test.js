require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startWorkerWithMongo, startupFailureLine, WorkerStartupError } = require("../src/modules/durableJobs/workerStartup");

// Fix round on the staff organization block (PR #151, security review). One section per finding.

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

// ---------------------------------------------------------------- F1: workers and MongoDB

test("F1 worker start-up: the BullMQ worker is created only after MongoDB is connected", async () => {
  const order = [];
  let connected;
  const connect = () => new Promise((resolve) => { connected = () => { order.push("connected"); resolve(); }; });
  const starting = startWorkerWithMongo({ name: "AI gateway worker", connect, createWorker: () => { order.push("worker"); return "worker"; }, env: { MONGODB_URL: "mongodb://x" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], "no worker while MongoDB is still connecting");
  connected();
  assert.equal(await starting, "worker");
  assert.deepEqual(order, ["connected", "worker"]);
});

test("F1 worker start-up: a missing MONGODB_URL fails with one line naming the cause; nothing connects and no worker is created", async () => {
  let touched = 0;
  const error = await startWorkerWithMongo({ name: "Durable worker", connect: async () => { touched += 1; }, createWorker: () => { touched += 1; }, env: {} }).catch((e) => e);
  assert.ok(error instanceof WorkerStartupError);
  assert.equal(touched, 0);
  const line = startupFailureLine(error);
  assert.match(line, /^Durable worker cannot start: MongoDB is required .* MONGODB_URL is not set\.$/);
  assert.ok(!line.includes("\n"));
});

test("F1 worker start-up: an unreachable MongoDB fails with one line naming the cause, without the connection string; no worker is created", async () => {
  let created = 0;
  const connect = async () => { throw new Error("getaddrinfo ENOTFOUND db.internal\n  at mongodb+srv://user:secret@db.internal/x"); };
  const error = await startWorkerWithMongo({ name: "AI gateway worker", connect, createWorker: () => { created += 1; }, env: { MONGODB_URL: "mongodb+srv://user:secret@db.internal/x" } }).catch((e) => e);
  assert.ok(error instanceof WorkerStartupError);
  assert.equal(created, 0);
  const line = startupFailureLine(error);
  assert.match(line, /^AI gateway worker cannot start: MongoDB is required .* could not be reached: getaddrinfo ENOTFOUND db\.internal/);
  assert.ok(!line.includes("\n") && !line.includes("secret"));
});

test("F1 both worker scripts start through startWorkerWithMongo, exit non-zero on failure, and neither fires connectDB without awaiting it", () => {
  for (const script of ["scripts/startAiGatewayWorker.ts", "scripts/startDurableWorker.ts"]) {
    const source = read(script);
    assert.match(source, /await startWorkerWithMongo\(\{[^}]*connect:connectDB,createWorker:/, script);
    assert.ok(!/void connectDB\(/.test(source), `${script} must await MongoDB`);
    assert.match(source, /console\.error\(startupFailureLine\(error\)\);process\.exit\(1\);/, script);
    // The worker constructor appears only inside the createWorker callback.
    assert.equal(source.match(/create(AiGateway|SourceSecurity)Worker\(/g).length, 1, script);
  }
  assert.match(read("docs/runbooks/PRODUCTION.md"), /Both workers[^\n]*require[^\n]*`MONGODB_URL`/);
});
