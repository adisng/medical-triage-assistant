// tests.js — Unit tests for Medical Triage Assistant
// Run in browser console or with a test runner

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`);
}

// ─── parseTriageResponse ──────────────────────────────────────────────────────

test("parseTriageResponse: parses valid JSON", () => {
  const input = JSON.stringify({
    urgency: "low",
    summary: "Mild cold symptoms",
    advice: "Rest and drink fluids.",
    nextSteps: ["Stay hydrated"],
    warningsigns: ["High fever"],
    recommendAppointment: false,
    suggestedAppointmentTitle: "",
    emergencyNote: "",
  });
  const result = parseTriageResponse(input);
  assertEqual(result.urgency, "low");
  assertEqual(result.summary, "Mild cold symptoms");
  assert(Array.isArray(result.nextSteps));
});

test("parseTriageResponse: strips markdown fences", () => {
  const input = "```json\n{\"urgency\":\"medium\",\"summary\":\"test\",\"advice\":\"rest\",\"nextSteps\":[],\"warningsigns\":[],\"recommendAppointment\":false,\"suggestedAppointmentTitle\":\"\",\"emergencyNote\":\"\"}\n```";
  const result = parseTriageResponse(input);
  assertEqual(result.urgency, "medium");
});

test("parseTriageResponse: returns fallback on invalid JSON", () => {
  const result = parseTriageResponse("This is not JSON at all.");
  assertEqual(result.urgency, "medium");
  assert(!result.recommendAppointment);
});

test("parseTriageResponse: handles emergency urgency", () => {
  const input = JSON.stringify({
    urgency: "emergency",
    summary: "Possible heart attack",
    advice: "Call emergency services.",
    nextSteps: ["Call 112"],
    warningsigns: [],
    recommendAppointment: true,
    suggestedAppointmentTitle: "",
    emergencyNote: "Call 112 immediately",
  });
  const result = parseTriageResponse(input);
  assertEqual(result.urgency, "emergency");
  assert(result.emergencyNote.length > 0);
});

// ─── escapeAttr ───────────────────────────────────────────────────────────────

test("escapeAttr: escapes single quotes", () => {
  const result = escapeAttr("GP's appointment");
  assert(!result.includes("'"), "Should not contain raw single quotes");
});

test("escapeAttr: escapes double quotes", () => {
  const result = escapeAttr('Say "hello"');
  assert(!result.includes('"'), "Should not contain raw double quotes");
});

test("escapeAttr: handles empty string", () => {
  assertEqual(escapeAttr(""), "");
});

test("escapeAttr: handles null/undefined gracefully", () => {
  assertEqual(escapeAttr(null), "");
  assertEqual(escapeAttr(undefined), "");
});

// ─── sanitizeText ─────────────────────────────────────────────────────────────

test("sanitizeText: escapes script tags", () => {
  const result = sanitizeText("<script>alert('xss')</script>");
  assert(!result.includes("<script>"), "Should not contain raw script tag");
});

test("sanitizeText: preserves normal text", () => {
  const result = sanitizeText("Take 2 paracetamol tablets");
  assertEqual(result, "Take 2 paracetamol tablets");
});

test("sanitizeText: handles empty input", () => {
  assertEqual(sanitizeText(""), "");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───`);
if (failed === 0) console.log("All tests passed! ✅");
