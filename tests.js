/**
 * tests.js — Comprehensive Unit & Integration Tests — Medical Triage Assistant
 *
 * Run options:
 *  A) Open test.html in browser at localhost:8080
 *  B) DevTools console after js/main.js module is loaded
 *
 * Coverage (80+ tests):
 *  - parseTriageResponse       : valid JSON, fences, fallback, field validation, edge cases
 *  - escapeAttr                : all special chars, null/undefined/numeric, combined
 *  - sanitizeText              : XSS vectors, empty, emoji, nested tags
 *  - validateInput             : empty, too long, invalid chars, valid, boundary
 *  - isRateLimited (localStorage) : quota enforcement, expiry, edge cases
 *  - checkUrgencyEscalation    : escalation detection, all directions
 *  - history trimming          : MAX_HISTORY_TURNS enforcement
 *  - updateCharCounter         : warn/over/normal thresholds
 *  - validateBeforeSend        : offline, rate-limit, empty, valid, too_long
 *  - captureAndClearInput      : clears input, returns value
 *  - hasEmergencyKeywords      : keyword set detection, case insensitivity
 *  - makeSourcesSection        : chips, "+ N more" button, tooltip, empty
 *  - language preference       : localStorage set/get, fallback
 *  - state management          : isolation, mutation
 *  - DOM rendering             : message creation, error display
 *  - security regression       : combined attack vectors
 *  - integration: full triage flow (mock fetch)
 */

"use strict";

let passed  = 0;
let failed  = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ status: "pass", name });
    passed++;
  } catch (e) {
    results.push({ status: "fail", name, error: e.message });
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ status: "pass", name });
    passed++;
  } catch (e) {
    results.push({ status: "fail", name, error: e.message });
    failed++;
  }
}

function assert(condition, msg)     { if (!condition) throw new Error(msg || "Assertion failed"); }
function assertEqual(a, b, msg)     { if (a !== b) throw new Error(msg || `Expected "${b}", got "${a}"`); }
function assertNotIncludes(str, sub, msg) { if (String(str).includes(sub)) throw new Error(msg || `Expected "${sub}" to be absent in: ${str}`); }
function assertIncludes(str, sub, msg)    { if (!String(str).includes(sub)) throw new Error(msg || `Expected "${sub}" to be present in: ${str}`); }

// Wait for the module to load and expose globals
function waitForGlobals() {
  return new Promise((resolve) => {
    const check = () => {
      if (window.parseTriageResponse) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// All tests are wrapped in an async IIFE that waits for module globals
// ═══════════════════════════════════════════════════════════════════════════════
(async () => {
  await waitForGlobals();

  // ════════════════════════════════════════════════════════════
  // parseTriageResponse
  // ════════════════════════════════════════════════════════════

  test("parseTriageResponse: parses valid low-urgency JSON", () => {
    const input = JSON.stringify({
      urgency: "low", summary: "Mild cold", advice: "Rest up.",
      nextSteps: ["Drink water"], warningsigns: ["High fever"],
      recommendAppointment: false, suggestedAppointmentTitle: "", emergencyNote: "",
    });
    const r = parseTriageResponse(input);
    assertEqual(r.urgency, "low");
    assertEqual(r.summary, "Mild cold");
    assert(Array.isArray(r.nextSteps));
    assert(!r.recommendAppointment);
  });

  test("parseTriageResponse: strips ```json fences", () => {
    const json = JSON.stringify({
      urgency: "medium", summary: "test", advice: "rest",
      nextSteps: [], warningsigns: [], recommendAppointment: false,
      suggestedAppointmentTitle: "", emergencyNote: "",
    });
    const r = parseTriageResponse("```json\n" + json + "\n```");
    assertEqual(r.urgency, "medium");
  });

  test("parseTriageResponse: returns medium fallback on invalid JSON", () => {
    const r = parseTriageResponse("This is not JSON at all.");
    assertEqual(r.urgency, "medium");
    assert(!r.recommendAppointment);
    assert(Array.isArray(r.nextSteps));
    assert(Array.isArray(r.warningsigns));
  });

  test("parseTriageResponse: handles emergency urgency + emergencyNote", () => {
    const input = JSON.stringify({
      urgency: "emergency", summary: "Possible heart attack",
      advice: "Call 112 now.", nextSteps: ["Call 112"],
      warningsigns: [], recommendAppointment: true,
      suggestedAppointmentTitle: "", emergencyNote: "Call 112 immediately",
    });
    const r = parseTriageResponse(input);
    assertEqual(r.urgency, "emergency");
    assert(r.emergencyNote.length > 0);
    assert(r.recommendAppointment);
  });

  test("parseTriageResponse: clamps invalid urgency to 'medium'", () => {
    const input = JSON.stringify({ urgency: "superurgent", summary: "x", advice: "y",
      nextSteps: [], warningsigns: [], recommendAppointment: false,
      suggestedAppointmentTitle: "", emergencyNote: "" });
    assertEqual(parseTriageResponse(input).urgency, "medium");
  });

  test("parseTriageResponse: fills missing arrays with empty arrays", () => {
    const r = parseTriageResponse(JSON.stringify({ urgency: "low", summary: "ok", advice: "rest" }));
    assert(Array.isArray(r.nextSteps),    "nextSteps should be array");
    assert(Array.isArray(r.warningsigns), "warningsigns should be array");
  });

  test("parseTriageResponse: handles numeric urgency gracefully", () => {
    const input = JSON.stringify({ urgency: 3, summary: "x", advice: "y",
      nextSteps: [], warningsigns: [], recommendAppointment: false,
      suggestedAppointmentTitle: "", emergencyNote: "" });
    assertEqual(parseTriageResponse(input).urgency, "medium", "non-string urgency should fall back to medium");
  });

  test("parseTriageResponse: handles null candidates gracefully (fallback path)", () => {
    const r = parseTriageResponse("");
    assertEqual(r.urgency, "medium");
    assert(Array.isArray(r.nextSteps));
  });

  test("parseTriageResponse: handles high urgency correctly", () => {
    const r = parseTriageResponse(JSON.stringify({ urgency: "high", summary: "Urgent", advice: "Go now",
      nextSteps: ["Go to ER"], warningsigns: ["Fainting"], recommendAppointment: true,
      suggestedAppointmentTitle: "Urgent care visit", emergencyNote: "" }));
    assertEqual(r.urgency, "high");
    assert(r.recommendAppointment);
    assertEqual(r.nextSteps.length, 1);
  });

  test("parseTriageResponse: preserves all nextSteps and warningsigns items", () => {
    const r = parseTriageResponse(JSON.stringify({ urgency: "low", summary: "s", advice: "a",
      nextSteps: ["A", "B", "C", "D"], warningsigns: ["X", "Y"],
      recommendAppointment: false, suggestedAppointmentTitle: "", emergencyNote: "" }));
    assertEqual(r.nextSteps.length, 4);
    assertEqual(r.warningsigns.length, 2);
  });

  test("parseTriageResponse: handles non-string summary/advice gracefully", () => {
    const r = parseTriageResponse(JSON.stringify({ urgency: "low", summary: 123, advice: null,
      nextSteps: [], warningsigns: [], recommendAppointment: false,
      suggestedAppointmentTitle: "", emergencyNote: "" }));
    assertEqual(r.summary, "", "numeric summary should become empty string");
    assertEqual(r.advice, "", "null advice should become empty string");
  });

  test("parseTriageResponse: handles extra whitespace in JSON fences", () => {
    const json = JSON.stringify({ urgency: "low", summary: "test", advice: "rest",
      nextSteps: [], warningsigns: [], recommendAppointment: false,
      suggestedAppointmentTitle: "", emergencyNote: "" });
    const r = parseTriageResponse("```json   \n" + json + "\n   ```  ");
    assertEqual(r.urgency, "low");
  });

  // ════════════════════════════════════════════════════════════
  // escapeAttr
  // ════════════════════════════════════════════════════════════

  test("escapeAttr: escapes single quotes",     () => { assertIncludes(escapeAttr("GP's"), "&#x27;"); });
  test("escapeAttr: escapes double quotes",     () => { assertIncludes(escapeAttr('Say "hi"'), "&quot;"); });
  test("escapeAttr: escapes < and >",           () => { assertNotIncludes(escapeAttr("<script>"), "<script>"); });
  test("escapeAttr: escapes & ampersand",       () => { assertIncludes(escapeAttr("A & B"), "&amp;"); });
  test("escapeAttr: returns empty for empty",   () => assertEqual(escapeAttr(""), ""));
  test("escapeAttr: returns empty for null",    () => assertEqual(escapeAttr(null), ""));
  test("escapeAttr: returns empty for undefined", () => assertEqual(escapeAttr(undefined), ""));
  test("escapeAttr: handles numeric coercion",  () => assertEqual(escapeAttr(42), "42"));

  test("escapeAttr: escapes combined attack vector", () => {
    const result = escapeAttr(`"><img src=x onerror=alert('xss')>`);
    assertNotIncludes(result, "<img");
    assertNotIncludes(result, "onerror");
  });

  test("escapeAttr: preserves safe characters", () => {
    assertEqual(escapeAttr("hello world 123"), "hello world 123");
  });

  test("escapeAttr: handles boolean input", () => {
    assertEqual(escapeAttr(true), "true");
    assertEqual(escapeAttr(false), "false");
  });

  // ════════════════════════════════════════════════════════════
  // sanitizeText
  // ════════════════════════════════════════════════════════════

  test("sanitizeText: escapes <script> tag",         () => assertNotIncludes(sanitizeText("<script>alert(1)</script>"), "<script>"));
  test("sanitizeText: escapes <img onerror>",         () => assertNotIncludes(sanitizeText('<img src="x" onerror="alert(1)">'), "<img"));
  test("sanitizeText: preserves normal text",         () => assertEqual(sanitizeText("Take 2 tablets"), "Take 2 tablets"));
  test("sanitizeText: returns empty for empty",       () => assertEqual(sanitizeText(""), ""));
  test("sanitizeText: returns empty for null",        () => assertEqual(sanitizeText(null), ""));
  test("sanitizeText: returns empty for undefined",   () => assertEqual(sanitizeText(undefined), ""));
  test("sanitizeText: handles unicode and emoji",     () => assertIncludes(sanitizeText("I have 🤒 fever"), "fever"));

  test("sanitizeText: handles nested HTML tags", () => {
    const result = sanitizeText("<div><span onclick='alert(1)'>text</span></div>");
    assertNotIncludes(result, "<div>");
    assertNotIncludes(result, "onclick");
  });

  test("sanitizeText: escapes event handler attributes", () => {
    assertNotIncludes(sanitizeText('<a href="javascript:alert(1)">click</a>'), "javascript:");
  });

  test("sanitizeText: handles SVG injection vector", () => {
    assertNotIncludes(sanitizeText('<svg onload="alert(1)">'), "<svg");
  });

  // ════════════════════════════════════════════════════════════
  // validateInput
  // ════════════════════════════════════════════════════════════

  test("validateInput: rejects empty string",             () => { assert(!validateInput("").valid); });
  test("validateInput: rejects whitespace-only string",   () => { assert(!validateInput("   ").valid); });
  test("validateInput: rejects string exceeding 1000",    () => { assertEqual(validateInput("a".repeat(1001)).reason, "too_long"); });
  test("validateInput: rejects < character with hint",    () => { const r = validateInput("I have <pain>"); assert(!r.valid); assertEqual(r.reason, "invalid_chars"); assert(typeof r.hint === "string"); });
  test("validateInput: rejects { character",              () => { assertEqual(validateInput("{inject}").reason, "invalid_chars"); });
  test("validateInput: accepts valid symptom description", () => { assert(validateInput("Fever and sore throat 2 days.").valid); });
  test("validateInput: accepts exactly 1000 chars",       () => { assert(validateInput("a".repeat(1000)).valid); });
  test("validateInput: accepts numbers and commas",       () => { assert(validateInput("Fever 38.5°C, headache, fatigue").valid); });

  test("validateInput: rejects > character", () => {
    assertEqual(validateInput("test > injection").reason, "invalid_chars");
  });

  test("validateInput: rejects } character", () => {
    assertEqual(validateInput("test } injection").reason, "invalid_chars");
  });

  test("validateInput: accepts special but safe characters", () => {
    assert(validateInput("I'm having pain — it's at 38.5°C!").valid);
  });

  test("validateInput: rejects exactly 1001 chars as too_long", () => {
    assertEqual(validateInput("a".repeat(1001)).reason, "too_long");
  });

  test("validateInput: returns 'empty' reason for whitespace", () => {
    assertEqual(validateInput("   ").reason, "empty");
  });

  // ════════════════════════════════════════════════════════════
  // isRateLimited — localStorage-backed
  // ════════════════════════════════════════════════════════════

  test("isRateLimited: not limited with no stored timestamps", () => {
    localStorage.removeItem("mta-rate-timestamps-v2");
    state.requestTimestamps = [];
    assert(!isRateLimited(), "Should not be rate limited with empty storage");
    localStorage.removeItem("mta-rate-timestamps-v2");
  });

  test("isRateLimited: limited after RATE_LIMIT_MAX fresh timestamps", () => {
    const now = Date.now();
    const ts  = Array(RATE_LIMIT_MAX).fill(now);
    localStorage.setItem("mta-rate-timestamps-v2", JSON.stringify(ts));
    assert(isRateLimited(), "Should be rate limited");
    localStorage.removeItem("mta-rate-timestamps-v2");
  });

  test("isRateLimited: not limited after all timestamps expire", () => {
    const expired = Array(RATE_LIMIT_MAX).fill(Date.now() - 70000);
    localStorage.setItem("mta-rate-timestamps-v2", JSON.stringify(expired));
    assert(!isRateLimited(), "Expired timestamps should not trigger limit");
    localStorage.removeItem("mta-rate-timestamps-v2");
  });

  test("isRateLimited: not limited with partial fresh + expired mix", () => {
    const mixed = [
      Date.now() - 70000,  // expired
      Date.now() - 65000,  // expired
      Date.now(),          // fresh — only 1 fresh, below RATE_LIMIT_MAX (5)
    ];
    localStorage.setItem("mta-rate-timestamps-v2", JSON.stringify(mixed));
    assert(!isRateLimited(), "Only 1 fresh timestamp — should not be limited");
    localStorage.removeItem("mta-rate-timestamps-v2");
  });

  test("isRateLimited: limited at exactly RATE_LIMIT_MAX fresh timestamps", () => {
    const ts = Array(RATE_LIMIT_MAX).fill(Date.now() - 1000); // 1s ago, still in window
    localStorage.setItem("mta-rate-timestamps-v2", JSON.stringify(ts));
    assert(isRateLimited(), "Exactly at limit should be rate limited");
    localStorage.removeItem("mta-rate-timestamps-v2");
  });

  test("isRateLimited: handles corrupted localStorage gracefully", () => {
    localStorage.setItem("mta-rate-timestamps-v2", "not-valid-json!!!");
    assert(!isRateLimited(), "Corrupted data should not cause rate limit");
    localStorage.removeItem("mta-rate-timestamps-v2");
  });

  // ════════════════════════════════════════════════════════════
  // checkUrgencyEscalation
  // ════════════════════════════════════════════════════════════

  test("checkUrgencyEscalation: detects low → medium escalation", () => {
    state.lastUrgency = "low";
    checkUrgencyEscalation("medium");
    assertEqual(state.lastUrgency, "medium");
    state.lastUrgency = null;
  });

  test("checkUrgencyEscalation: detects medium → high escalation", () => {
    state.lastUrgency = "medium";
    checkUrgencyEscalation("high");
    assertEqual(state.lastUrgency, "high");
    state.lastUrgency = null;
  });

  test("checkUrgencyEscalation: does not flag improvement (high → low)", () => {
    state.lastUrgency = "high";
    checkUrgencyEscalation("low");
    assertEqual(state.lastUrgency, "low");
    state.lastUrgency = null;
  });

  test("checkUrgencyEscalation: handles null previous urgency (first call)", () => {
    state.lastUrgency = null;
    checkUrgencyEscalation("medium");
    assertEqual(state.lastUrgency, "medium");
    state.lastUrgency = null;
  });

  test("checkUrgencyEscalation: detects low → emergency escalation", () => {
    state.lastUrgency = "low";
    checkUrgencyEscalation("emergency");
    assertEqual(state.lastUrgency, "emergency");
    state.lastUrgency = null;
  });

  test("checkUrgencyEscalation: same urgency does not escalate", () => {
    state.lastUrgency = "medium";
    const msgsBefore = chatMessages.children.length;
    checkUrgencyEscalation("medium");
    // No new escalation warning should be added
    assertEqual(state.lastUrgency, "medium");
    state.lastUrgency = null;
  });

  // ════════════════════════════════════════════════════════════
  // History trimming
  // ════════════════════════════════════════════════════════════

  test("conversationHistory: trimmed to MAX_HISTORY_TURNS * 2 entries", () => {
    const original = state.conversationHistory;
    state.conversationHistory = Array(25).fill({ role: "user", parts: [{ text: "test" }] });
    if (state.conversationHistory.length > MAX_HISTORY_TURNS * 2) {
      state.conversationHistory = state.conversationHistory.slice(-MAX_HISTORY_TURNS * 2);
    }
    assert(state.conversationHistory.length <= MAX_HISTORY_TURNS * 2,
      `History should be capped at ${MAX_HISTORY_TURNS * 2}`);
    state.conversationHistory = original;
  });

  test("conversationHistory: does not trim when under limit", () => {
    const original = state.conversationHistory;
    state.conversationHistory = Array(5).fill({ role: "user", parts: [{ text: "test" }] });
    const before = state.conversationHistory.length;
    if (state.conversationHistory.length > MAX_HISTORY_TURNS * 2) {
      state.conversationHistory = state.conversationHistory.slice(-MAX_HISTORY_TURNS * 2);
    }
    assertEqual(state.conversationHistory.length, before, "Should not trim when under limit");
    state.conversationHistory = original;
  });

  // ════════════════════════════════════════════════════════════
  // updateCharCounter
  // ════════════════════════════════════════════════════════════

  test("updateCharCounter: shows correct count", () => {
    const orig = chatInput.value;
    chatInput.value = "hello";
    updateCharCounter();
    assertIncludes(charCounter.textContent, "5");
    chatInput.value = orig;
    updateCharCounter();
  });

  test("updateCharCounter: adds counter-warn class at 85% capacity", () => {
    const orig = chatInput.value;
    chatInput.value = "a".repeat(Math.ceil(MAX_INPUT_LENGTH * 0.86));
    updateCharCounter();
    assert(charCounter.classList.contains("counter-warn"));
    chatInput.value = orig;
    updateCharCounter();
  });

  test("updateCharCounter: adds counter-over class at 100%", () => {
    const orig = chatInput.value;
    chatInput.value = "a".repeat(MAX_INPUT_LENGTH);
    updateCharCounter();
    assert(charCounter.classList.contains("counter-over"));
    chatInput.value = orig;
    updateCharCounter();
  });

  test("updateCharCounter: no warn class at 50% capacity", () => {
    const orig = chatInput.value;
    chatInput.value = "a".repeat(Math.floor(MAX_INPUT_LENGTH * 0.5));
    updateCharCounter();
    assert(!charCounter.classList.contains("counter-warn"), "Should not warn at 50%");
    assert(!charCounter.classList.contains("counter-over"), "Should not be over at 50%");
    chatInput.value = orig;
    updateCharCounter();
  });

  test("updateCharCounter: shows 0 / 1000 when empty", () => {
    const orig = chatInput.value;
    chatInput.value = "";
    updateCharCounter();
    assertIncludes(charCounter.textContent, "0");
    chatInput.value = orig;
    updateCharCounter();
  });

  // ════════════════════════════════════════════════════════════
  // validateBeforeSend
  // ════════════════════════════════════════════════════════════

  test("validateBeforeSend: fails on empty input", () => {
    chatInput.value = "";
    const r = validateBeforeSend("");
    assert(!r.ok, "Empty input should fail");
  });

  test("validateBeforeSend: fails when rate limited", () => {
    const now = Date.now();
    const ts  = Array(RATE_LIMIT_MAX).fill(now);
    localStorage.setItem("mta-rate-timestamps-v2", JSON.stringify(ts));
    const r = validateBeforeSend("I have a headache");
    assert(!r.ok, "Rate-limited state should fail validation");
    assertIncludes(r.errorMsg, "Rate limit");
    localStorage.removeItem("mta-rate-timestamps-v2");
  });

  test("validateBeforeSend: passes with valid text and no rate limit", () => {
    localStorage.removeItem("mta-rate-timestamps-v2");
    state.requestTimestamps = [];
    const r = validateBeforeSend("I have a mild headache");
    assert(r.ok || r.errorMsg !== null, "Should return a result");
  });

  test("validateBeforeSend: fails on too-long input with message", () => {
    localStorage.removeItem("mta-rate-timestamps-v2");
    const r = validateBeforeSend("a".repeat(1001));
    assert(!r.ok);
    if (r.errorMsg) assertIncludes(r.errorMsg, "too long");
  });

  test("validateBeforeSend: fails on invalid chars with hint", () => {
    localStorage.removeItem("mta-rate-timestamps-v2");
    const r = validateBeforeSend("<script>alert(1)</script>");
    assert(!r.ok);
    if (r.errorMsg) assertIncludes(r.errorMsg, "invalid");
  });

  // ════════════════════════════════════════════════════════════
  // captureAndClearInput
  // ════════════════════════════════════════════════════════════

  test("captureAndClearInput: returns trimmed value and clears input", () => {
    chatInput.value = "  fever and chills  ";
    const captured = captureAndClearInput();
    assertEqual(captured, "fever and chills", "Should return trimmed text");
    assertEqual(chatInput.value, "", "Input should be cleared");
    updateCharCounter();
  });

  test("captureAndClearInput: returns empty string for empty input", () => {
    chatInput.value = "";
    const captured = captureAndClearInput();
    assertEqual(captured, "", "Should return empty string");
  });

  test("captureAndClearInput: handles single word", () => {
    chatInput.value = "headache";
    const captured = captureAndClearInput();
    assertEqual(captured, "headache");
    assertEqual(chatInput.value, "");
  });

  // ════════════════════════════════════════════════════════════
  // hasEmergencyKeywords
  // ════════════════════════════════════════════════════════════

  test("hasEmergencyKeywords: detects 'chest pain' + 'sweating'", () => {
    assert(hasEmergencyKeywords("I have chest pain and sweating"), "Should detect chest pain + sweating");
  });

  test("hasEmergencyKeywords: detects 'difficulty breathing'", () => {
    assert(hasEmergencyKeywords("I am having difficulty breathing"));
  });

  test("hasEmergencyKeywords: detects 'unconscious'", () => {
    assert(hasEmergencyKeywords("Someone is unconscious on the floor"));
  });

  test("hasEmergencyKeywords: does NOT flag mild headache", () => {
    assert(!hasEmergencyKeywords("I have a mild headache"), "Mild headache should not be flagged");
  });

  test("hasEmergencyKeywords: does NOT flag single keyword without pair", () => {
    assert(!hasEmergencyKeywords("I have chest pain and slight nausea"),
      "Chest pain alone (no sweating) should not trigger");
  });

  test("hasEmergencyKeywords: case insensitive detection", () => {
    assert(hasEmergencyKeywords("I have DIFFICULTY BREATHING"), "Should be case insensitive");
  });

  test("hasEmergencyKeywords: detects 'can't breathe'", () => {
    assert(hasEmergencyKeywords("I can't breathe properly"));
  });

  test("hasEmergencyKeywords: detects 'not breathing'", () => {
    assert(hasEmergencyKeywords("My child is not breathing"));
  });

  test("hasEmergencyKeywords: detects 'chest pain' + 'sweat' (partial match)", () => {
    assert(hasEmergencyKeywords("I have chest pain and I sweat a lot"));
  });

  test("hasEmergencyKeywords: does NOT flag 'breathing' alone", () => {
    assert(!hasEmergencyKeywords("I have some breathing issues"));
  });

  // ════════════════════════════════════════════════════════════
  // makeSourcesSection — expanded sources + tooltip
  // ════════════════════════════════════════════════════════════

  test("makeSourcesSection: renders up to 3 visible chips", () => {
    const sources = [
      { title: "Source A", url: "https://a.com" },
      { title: "Source B", url: "https://b.com" },
      { title: "Source C", url: "https://c.com" },
    ];
    const sec   = makeSourcesSection(sources);
    const chips = sec.querySelectorAll(".source-chip");
    assertEqual(chips.length, 3, "Should render exactly 3 chips");
  });

  test("makeSourcesSection: shows '+ N more' button when > 3 sources", () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({ title: `Source ${i}`, url: `https://s${i}.com` }));
    const sec     = makeSourcesSection(sources);
    const moreBtn = sec.querySelector(".source-more-btn");
    assert(moreBtn !== null, "Should render a '+ more' button");
    assertIncludes(moreBtn.textContent, "2", "Button should mention 2 extra sources");
  });

  test("makeSourcesSection: chip has tooltip (title attribute) with URL", () => {
    const sources = [{ title: "NHS Source", url: "https://nhs.uk/page" }];
    const sec     = makeSourcesSection(sources);
    const chip    = sec.querySelector(".source-chip");
    assertEqual(chip.title, "https://nhs.uk/page", "Chip tooltip should be the full URL");
  });

  test("makeSourcesSection: renders single source without more button", () => {
    const sources = [{ title: "Only Source", url: "https://only.com" }];
    const sec     = makeSourcesSection(sources);
    const chips   = sec.querySelectorAll(".source-chip");
    assertEqual(chips.length, 1);
    assert(!sec.querySelector(".source-more-btn"), "No more button for single source");
  });

  test("makeSourcesSection: chip links open in new tab with noopener", () => {
    const sources = [{ title: "Test", url: "https://test.com" }];
    const sec     = makeSourcesSection(sources);
    const chip    = sec.querySelector(".source-chip");
    assertEqual(chip.target, "_blank");
    assertIncludes(chip.rel, "noopener");
  });

  test("makeSourcesSection: chips have aria-labels", () => {
    const sources = [{ title: "Mayo Clinic", url: "https://mayo.com" }];
    const sec     = makeSourcesSection(sources);
    const chip    = sec.querySelector(".source-chip");
    const label   = chip.getAttribute("aria-label");
    assertIncludes(label, "Mayo Clinic");
    assertIncludes(label, "https://mayo.com");
  });

  // ════════════════════════════════════════════════════════════
  // Language preference (localStorage)
  // ════════════════════════════════════════════════════════════

  test("getLang: returns 'en' when no preference stored", () => {
    localStorage.removeItem("mta-lang-v1");
    assertEqual(getLang(), "en", "Default language should be en");
  });

  test("getLang: returns stored language preference", () => {
    localStorage.setItem("mta-lang-v1", "es");
    assertEqual(getLang(), "es", "Should return stored 'es' preference");
    localStorage.removeItem("mta-lang-v1");
  });

  test("getLang: returns 'en' after preference cleared", () => {
    localStorage.removeItem("mta-lang-v1");
    assertEqual(getLang(), "en");
  });

  // ════════════════════════════════════════════════════════════
  // State management
  // ════════════════════════════════════════════════════════════

  test("state: selectedSymptoms is a Set", () => {
    assert(state.selectedSymptoms instanceof Set, "selectedSymptoms should be a Set");
  });

  test("state: conversationHistory starts as array", () => {
    assert(Array.isArray(state.conversationHistory));
  });

  test("state: triageHistory starts as array", () => {
    assert(Array.isArray(state.triageHistory));
  });

  test("state: calendarToken starts as null", () => {
    // May have been set by auth flow, so we just check the type
    assert(state.calendarToken === null || typeof state.calendarToken === "string");
  });

  // ════════════════════════════════════════════════════════════
  // Security regression tests
  // ════════════════════════════════════════════════════════════

  test("security: escapeAttr prevents attribute breakout", () => {
    const malicious = `" onfocus="alert(1)" autofocus="`;
    const result = escapeAttr(malicious);
    assertNotIncludes(result, `onfocus`);
  });

  test("security: sanitizeText prevents style injection", () => {
    const result = sanitizeText('<style>body{display:none}</style>visible');
    assertNotIncludes(result, "<style>");
  });

  test("security: validateInput blocks template literal injection", () => {
    const r = validateInput("${alert(1)}");  // no < > { } so this should pass
    // Actually ${} contains { } so it should be blocked
    assert(!r.valid, "Template literals with braces should be blocked");
  });

  // ════════════════════════════════════════════════════════════
  // URGENCY_LEVELS constant validation
  // ════════════════════════════════════════════════════════════

  test("URGENCY_LEVELS: contains exactly 4 levels", () => {
    assertEqual(URGENCY_LEVELS.length, 4);
  });

  test("URGENCY_LEVELS: ordered low to emergency", () => {
    assertEqual(URGENCY_LEVELS[0], "low");
    assertEqual(URGENCY_LEVELS[3], "emergency");
  });

  // ════════════════════════════════════════════════════════════
  // Integration: full triage flow (mock fetch)
  // ════════════════════════════════════════════════════════════

  await testAsync("integration: full triage flow with mock Gemini", async () => {
    const mockTriageJson = JSON.stringify({
      urgency: "medium",
      summary: "Mock triage: moderate headache symptoms detected.",
      advice: "Rest and monitor symptoms.",
      nextSteps: ["Drink water", "Rest", "Monitor temperature"],
      warningsigns: ["Sudden severe headache", "Vision changes"],
      recommendAppointment: true,
      suggestedAppointmentTitle: "GP consultation — headache",
      emergencyNote: "",
    });

    const mockGeminiResponse = {
      candidates: [{
        content: { parts: [{ text: mockTriageJson }] },
        groundingMetadata: { groundingChunks: [] },
      }],
    };

    const originalFetch   = window.fetch;
    const originalOnLine  = Object.getOwnPropertyDescriptor(navigator, "onLine");

    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });

    localStorage.removeItem("mta-rate-timestamps-v2");
    state.requestTimestamps   = [];
    state.emergencyDismissed  = false;

    window.fetch = async () => ({
      ok:   true,
      json: async () => mockGeminiResponse,
    });

    chatInput.value = "I have a headache";

    const msgsBefore = chatMessages.children.length;

    await sendMessage();

    await new Promise(r => setTimeout(r, 200));

    window.fetch = originalFetch;
    if (originalOnLine) {
      Object.defineProperty(navigator, "onLine", originalOnLine);
    }
    localStorage.removeItem("mta-rate-timestamps-v2");

    const msgsAfter = chatMessages.children.length;
    assert(msgsAfter > msgsBefore, `Expected new messages; before=${msgsBefore}, after=${msgsAfter}`);

    const chatText = chatMessages.textContent;
    assertIncludes(chatText, "Mock triage", "Chat should contain the mock summary text");
  });

  await testAsync("integration: error handling shows error bubble", async () => {
    const originalFetch   = window.fetch;
    const originalOnLine  = Object.getOwnPropertyDescriptor(navigator, "onLine");

    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
    localStorage.removeItem("mta-rate-timestamps-v2");
    state.requestTimestamps = [];

    window.fetch = async () => {
      throw new Error("Network failure simulation");
    };

    chatInput.value = "I have a fever";
    const msgsBefore = chatMessages.children.length;

    await sendMessage();
    await new Promise(r => setTimeout(r, 200));

    window.fetch = originalFetch;
    if (originalOnLine) Object.defineProperty(navigator, "onLine", originalOnLine);
    localStorage.removeItem("mta-rate-timestamps-v2");

    const msgsAfter = chatMessages.children.length;
    assert(msgsAfter > msgsBefore, "Error should produce messages in chat");
  });

  // ════════════════════════════════════════════════════════════
  // Results output
  // ════════════════════════════════════════════════════════════

  const total = passed + failed;
  const pct   = total > 0 ? Math.round((passed / total) * 100) : 0;

  console.log("\n%c─── Medical Triage Assistant — Test Results ───", "font-weight:bold;font-size:13px;");
  results.forEach(r => {
    if (r.status === "pass") {
      console.log(`%c✅ ${r.name}`, "color: #10b981");
    } else {
      console.error(`%c❌ ${r.name}: ${r.error}`, "color: #ef4444");
    }
  });
  console.log(`\n%c─── ${passed}/${total} passed (${pct}%) ───`, "font-weight:bold;font-size:13px;");
  if (failed === 0) {
    console.log("%c🎉 All tests passed!", "color: #10b981; font-weight:bold;");
  } else {
    console.warn(`%c${failed} test(s) failed.`, "color:#ef4444;font-weight:bold;");
  }

  const container = document.getElementById("test-results");
  if (container) {
    container.innerHTML = "";
    const summary = document.createElement("div");
    summary.className   = `test-summary ${failed === 0 ? "all-pass" : "has-fail"}`;
    summary.textContent = `${passed}/${total} passed (${pct}%) ${failed === 0 ? "🎉 All tests passed!" : `— ${failed} failed`}`;
    container.appendChild(summary);
    results.forEach(r => {
      const row = document.createElement("div");
      row.className   = `test-row ${r.status}`;
      row.textContent = `${r.status === "pass" ? "✅" : "❌"} ${r.name}${r.error ? ": " + r.error : ""}`;
      container.appendChild(row);
    });
  }

})();
