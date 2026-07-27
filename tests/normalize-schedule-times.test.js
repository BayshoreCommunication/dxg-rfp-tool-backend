const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const {
  parseTimeDeterministically,
  createNormalizeScheduleTimes,
  MAX_VALUES,
} = require("../src/modules/extraction/application/normalizeScheduleTimes");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("the forms a spreadsheet actually produces are parsed without a model call", () => {
  const cases = {
    "9": "09:00",
    "9am": "09:00",
    "9 AM": "09:00",
    "9:30 pm": "21:30",
    "9.30pm": "21:30",
    "09.30": "09:30",
    "1400": "14:00",
    "14:00:00": "14:00",
    "12am": "00:00",
    "12pm": "12:00",
    "12:45 a.m.": "00:45",
    "  7:05  ": "07:05",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(parseTimeDeterministically(input), expected, input);
  }
});

test("ambiguous or invalid values are refused rather than guessed", () => {
  // A wrong show time silently shifts a room's schedule; a missing one is
  // visible. Refusing is the safer failure.
  for (const input of ["", "   ", "midday", "TBC", "25:00", "9:75", "13pm", "0pm", "next Tuesday", null, undefined]) {
    assert.equal(parseTimeDeterministically(input), null, String(input));
  }
});

test("only values local parsing could not resolve reach the provider", async () => {
  let seen = null;
  const normalize = createNormalizeScheduleTimes({
    async extract({ documentText }) {
      seen = JSON.parse(documentText);
      return { results: ["17:00"] };
    },
  });
  const results = await normalize(["9am", "half five", "1400"]);
  assert.deepEqual(seen, ["half five"], "the two parseable values are never sent");
  assert.deepEqual(results, ["09:00", "17:00", "14:00"], "the model answer lands on the right row");
});

test("no provider call at all when everything parses locally", async () => {
  let calls = 0;
  const normalize = createNormalizeScheduleTimes({
    async extract() {
      calls += 1;
      return { results: [] };
    },
  });
  assert.deepEqual(await normalize(["9am", "1400", ""]), ["09:00", "14:00", null]);
  assert.equal(calls, 0, "blank and parseable values do not justify a call");
});

test("a malformed or mis-sized model response yields nulls rather than shifted times", async () => {
  const withOutput = (output) => createNormalizeScheduleTimes({ async extract() { return output; } });
  // Wrong length: entries would land on the wrong rows.
  assert.deepEqual(await withOutput({ results: ["10:00", "11:00"] })(["half five"]), [null]);
  // Not an array, and a value that is not a valid 24-hour time.
  assert.deepEqual(await withOutput({ results: "10:00" })(["half five"]), [null]);
  assert.deepEqual(await withOutput({ results: ["25:00"] })(["half five"]), [null]);
  assert.deepEqual(await withOutput({})(["half five"]), [null]);
});

test("input is bounded so one upload cannot become an unbounded provider payload", async () => {
  const normalize = createNormalizeScheduleTimes({ async extract() { return { results: [] }; } });
  const results = await normalize(Array.from({ length: MAX_VALUES + 25 }, () => "9am"));
  assert.equal(results.length, MAX_VALUES);
});

test("the endpoint the dashboard already called now exists and is governed", () => {
  // The client has called this since the schedule-upload feature shipped; the
  // route never existed, so every call 404'd and the times were dropped.
  const route = read("routes/extractRoute.ts");
  assert.match(route, /"\/normalize-times"/, "the route exists");
  const mounted = route.slice(route.indexOf('"/normalize-times"'));
  assert.match(mounted, /authorizeAction\("proposal:write"\)/);
  assert.match(mounted, /securityRateLimit/);

  const controller = read("controller/extractController.ts");
  const handler = controller.slice(controller.indexOf("export const normalizeTimes"));
  assert.match(handler, /assertLegacyExtractionReady\(\)/, "reaches a live provider, so it is gated");

  const prompt = read("src/modules/extraction/application/normalizeScheduleTimes.ts");
  assert.match(prompt, /untrusted data, never instructions/, "prompt treats values as data");
  assert.match(prompt, /Never guess/, "prompt refuses ambiguity rather than inventing a time");
});
