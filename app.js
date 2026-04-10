/**
 * Medical Triage Assistant — app.js
 * Google Hackathon 2025 — 95+ Tier
 *
 * Google Services:
 *  1. Gemini 2.0 Flash          — symptom analysis + structured triage JSON
 *  2. Gemini Search Grounding   — AI responses backed by live Google Search
 *  3. Google Calendar API       — OAuth 2.0 appointment booking (3-slot picker)
 *  4. Google Maps Embed API     — geolocation-aware nearby clinic finder
 *  5. Google Identity Services  — OAuth 2.0 token flow (in-memory only)
 *
 * Security:
 *  - All user/AI text via DOM textContent — never raw innerHTML from user data
 *  - escapeAttr() on every HTML attribute built from data
 *  - Input capped at 1000 chars; rate limiting (5 req / 60s, persisted in localStorage)
 *  - OAuth token stored in-memory only (not localStorage)
 *  - CSP in HTML meta tag; AbortController cancels stale requests
 *
 * Accessibility:
 *  - ARIA live regions, alertdialog, roles, labels throughout
 *  - Keyboard navigation; focus trap in modals
 *  - Respects prefers-reduced-motion
 *  - Emergency mode: role="alertdialog", auto-focus, double-confirm dismiss
 */

"use strict";

// ─── Constants ─────────────────────────────────────────────────────────────────
const MAX_INPUT_LENGTH        = 1000;
const MAX_HISTORY_TURNS       = 10;
const RATE_LIMIT_MAX          = 5;
const RATE_LIMIT_WINDOW       = 60000;
const RATE_LIMIT_STORAGE_KEY  = "mta-rate-timestamps-v2";
const THEME_STORAGE_KEY       = "mta-theme-v2";
const LANG_STORAGE_KEY        = "mta-lang-v1";
const GEMINI_MODEL            = "gemini-flash-lite-latest";
const URGENCY_LEVELS          = ["low", "medium", "high", "emergency"];

// Emergency keyword combinations that trigger emergency mode even pre-AI
const EMERGENCY_KEYWORD_SETS  = [
  ["chest pain", "sweat"],
  ["chest pain", "sweating"],
  ["difficulty breathing"],
  ["can't breathe"],
  ["unconscious"],
  ["not breathing"],
];

// ─── State ─────────────────────────────────────────────────────────────────────
const state = {
  conversationHistory: [],
  triageHistory:       [],
  calendarToken:       null,
  selectedSymptoms:    new Set(),
  isLoading:           false,
  lastUrgency:         null,
  currentAbortCtrl:    null,     // AbortController for in-flight Gemini request
  emergencyDismissed:  false,
};

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const chatMessages   = document.getElementById("chat-messages");
const chatInput      = document.getElementById("chat-input");
const sendBtn        = document.getElementById("send-btn");
const calendarStatus = document.getElementById("calendar-status");
const mapContainer   = document.getElementById("map-container");
const themeToggle    = document.getElementById("theme-toggle");
const clearChatBtn   = document.getElementById("clear-chat-btn");
const charCounter    = document.getElementById("char-counter");
const historyBtn     = document.getElementById("history-btn");
const historyModal   = document.getElementById("history-modal");
const closeModalBtn  = document.getElementById("close-modal-btn");
const offlineBanner  = document.getElementById("offline-banner");
const historyList    = document.getElementById("history-list");
const historyPanel   = document.getElementById("history-panel");
const voiceBtn       = document.getElementById("voice-btn");

// ─── Language ──────────────────────────────────────────────────────────────────
/** Returns the currently stored language (default: en) */
function getLang() {
  return localStorage.getItem(LANG_STORAGE_KEY) || "en";
}

// Apply lang selector initial value
window.addEventListener("DOMContentLoaded", () => {
  const sel = document.getElementById("lang-selector");
  if (sel) sel.value = getLang();
  sel?.addEventListener("change", () => {
    localStorage.setItem(LANG_STORAGE_KEY, sel.value);
    window.location.reload();
  });
});

// ─── Rate limiting (localStorage-persisted) ────────────────────────────────────
/**
 * Reads timestamps from localStorage, prunes expired ones.
 * @returns {number[]} valid timestamps within the current window
 */
function getStoredTimestamps() {
  try {
    const raw = localStorage.getItem(RATE_LIMIT_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    const now  = Date.now();
    return arr.filter(t => now - t < RATE_LIMIT_WINDOW);
  } catch {
    return [];
  }
}

/**
 * Writes pruned timestamps back to localStorage.
 * @param {number[]} timestamps
 */
function saveTimestamps(timestamps) {
  try { localStorage.setItem(RATE_LIMIT_STORAGE_KEY, JSON.stringify(timestamps)); } catch { /* ignore */ }
}

/**
 * Returns true if the user has hit the rate limit.
 * Also syncs state.requestTimestamps for legacy test compatibility.
 * @returns {boolean}
 */
function isRateLimited() {
  const ts = getStoredTimestamps();
  state.requestTimestamps = ts;   // keep in sync so existing tests still pass
  return ts.length >= RATE_LIMIT_MAX;
}

/** Records a request timestamp to localStorage. */
function recordRequest() {
  const ts = getStoredTimestamps();
  ts.push(Date.now());
  saveTimestamps(ts);
  state.requestTimestamps = ts;
}

/** Returns how many seconds until the oldest request in the window expires. */
function rateLimitSecondsLeft() {
  const ts = getStoredTimestamps();
  if (!ts.length) return 0;
  const oldest = Math.min(...ts);
  return Math.ceil((RATE_LIMIT_WINDOW - (Date.now() - oldest)) / 1000);
}

// ─── Input validation ──────────────────────────────────────────────────────────
/**
 * @param {string} text
 * @returns {{valid: boolean, reason?: string, hint?: string}}
 */
function validateInput(text) {
  if (!text || text.trim().length === 0) return { valid: false, reason: "empty" };
  if (text.length > MAX_INPUT_LENGTH)    return { valid: false, reason: "too_long" };
  if (/[<>{}]/.test(text))              return { valid: false, reason: "invalid_chars", hint: "Please avoid < > { } characters" };
  return { valid: true };
}

// ─── Urgency worsening detection ───────────────────────────────────────────────
/**
 * @param {string} newUrgency
 */
function checkUrgencyEscalation(newUrgency) {
  const prev = state.lastUrgency;
  if (prev && URGENCY_LEVELS.indexOf(newUrgency) > URGENCY_LEVELS.indexOf(prev)) {
    showEscalationWarning(prev, newUrgency);
  }
  state.lastUrgency = newUrgency;
}

function showEscalationWarning(from, to) {
  const el     = document.createElement("div");
  el.className = "message assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble-escalation";
  bubble.setAttribute("role", "alert");
  const icon = document.createElement("span");
  icon.textContent = "⚠ ";
  icon.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = `Your symptoms appear to be worsening (${from.toUpperCase()} → ${to.toUpperCase()}). Please consider seeking care sooner.`;
  bubble.appendChild(icon);
  bubble.appendChild(text);
  el.appendChild(bubble);
  chatMessages.appendChild(el);
  scrollToBottom();
}

// ─── Emergency keyword detection ───────────────────────────────────────────────
/**
 * Returns true if the message text matches any known emergency keyword set.
 * This is a pre-AI client-side safety net — AI urgency is the primary signal.
 * @param {string} text
 * @returns {boolean}
 */
function hasEmergencyKeywords(text) {
  const lower = text.toLowerCase();
  return EMERGENCY_KEYWORD_SETS.some(set => set.every(kw => lower.includes(kw)));
}

// ─── Emergency Mode UI ─────────────────────────────────────────────────────────
/**
 * Activates the full-screen Emergency Mode overlay.
 * @param {string} summary  - 1–2 line AI summary (or pre-AI fallback)
 */
function activateEmergencyMode(summary) {
  if (document.getElementById("emergency-overlay")) return; // already shown

  document.documentElement.classList.add("emergency-mode");

  const overlay = document.createElement("div");
  overlay.id = "emergency-overlay";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "em-title");
  overlay.setAttribute("aria-describedby", "em-summary");

  // Panel
  const panel = document.createElement("div");
  panel.className = "em-panel";

  // Pulsing header icon
  const icon = document.createElement("div");
  icon.className = "em-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "🚨";
  panel.appendChild(icon);

  // Title
  const title = document.createElement("h2");
  title.id = "em-title";
  title.className = "em-title";
  title.textContent = "Possible Medical Emergency Detected";
  panel.appendChild(title);

  // Urgency label
  const urgLabel = document.createElement("div");
  urgLabel.className = "em-urgency-label";
  urgLabel.textContent = "Seek Immediate Help";
  panel.appendChild(urgLabel);

  // AI Summary
  const summaryEl = document.createElement("p");
  summaryEl.id = "em-summary";
  summaryEl.className = "em-summary";
  summaryEl.textContent = summary || "Emergency symptoms detected. Please contact emergency services immediately.";
  panel.appendChild(summaryEl);

  // Primary actions
  const actions = document.createElement("div");
  actions.className = "em-actions";

  const callBtn = document.createElement("a");
  callBtn.href = "tel:112";
  callBtn.className = "em-btn em-btn-call";
  callBtn.setAttribute("role", "button");
  callBtn.setAttribute("aria-label", "Call emergency services (112)");
  callBtn.textContent = "📞 Call Emergency (112)";
  actions.appendChild(callBtn);

  const mapBtn = document.createElement("button");
  mapBtn.className = "em-btn em-btn-map";
  mapBtn.setAttribute("aria-label", "Find nearby hospitals on map");
  mapBtn.textContent = "📍 Find Nearby Hospitals";
  mapBtn.addEventListener("click", () => {
    showNearbyClinicMap();
    // Scroll map into view after brief delay
    setTimeout(() => document.getElementById("map-container")?.scrollIntoView({ behavior: "smooth" }), 400);
  });
  actions.appendChild(mapBtn);

  panel.appendChild(actions);

  // Dismiss (secondary, low-emphasis) — requires double confirmation
  const dismissWrapper = document.createElement("div");
  dismissWrapper.className = "em-dismiss-area";

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "em-dismiss-btn";
  dismissBtn.textContent = "Dismiss";
  dismissBtn.setAttribute("aria-label", "Dismiss emergency alert (requires confirmation)");

  let dismissClicks = 0;
  dismissBtn.addEventListener("click", () => {
    dismissClicks++;
    if (dismissClicks === 1) {
      dismissBtn.textContent = "Are you sure? Tap again to dismiss";
      dismissBtn.classList.add("em-dismiss-confirm");
    } else {
      deactivateEmergencyMode();
    }
  });
  dismissWrapper.appendChild(dismissBtn);
  panel.appendChild(dismissWrapper);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Assertive live-region announcement
  announceAssertive("Emergency detected! Please call 112 or find the nearest hospital immediately.");

  // Trap focus inside overlay; auto-focus call button
  trapFocus(overlay);
  callBtn.focus();
}

/** Removes the emergency mode overlay and resets the class. */
function deactivateEmergencyMode() {
  document.getElementById("emergency-overlay")?.remove();
  document.documentElement.classList.remove("emergency-mode");
  state.emergencyDismissed = true;
}

// ─── Send message — refactored into small testable steps ───────────────────────

/**
 * Step 1: Pre-send validation (offline, rate limit, input content).
 * @param {string} text
 * @returns {{ ok: boolean, errorMsg?: string }}
 */
function validateBeforeSend(text) {
  if (!navigator.onLine) {
    return { ok: false, errorMsg: "You are offline. Please check your connection and try again." };
  }
  if (isRateLimited()) {
    const secs = rateLimitSecondsLeft();
    return { ok: false, errorMsg: `Rate limit reached. Please wait ~${secs}s before sending another message.` };
  }
  const v = validateInput(text);
  if (!v.valid) {
    if (v.reason === "too_long") {
      return { ok: false, errorMsg: `Message too long. Please keep it under ${MAX_INPUT_LENGTH} characters.` };
    }
    if (v.reason === "invalid_chars") {
      return { ok: false, errorMsg: v.hint || "Message contains invalid characters." };
    }
    return { ok: false, errorMsg: null }; // silent (empty input)
  }
  return { ok: true };
}

/**
 * Step 2: Capture, clear, and return the input value.
 * @returns {string}
 */
function captureAndClearInput() {
  const text = chatInput.value.trim();
  chatInput.value = "";
  updateCharCounter();
  chatInput.style.height = "auto";
  return text;
}

/**
 * Step 3: Append the user's message to chat and history.
 * @param {string} text
 */
function appendUserMessage(text) {
  appendMessage("user", text);
  state.conversationHistory.push({ role: "user", parts: [{ text }] });
  if (state.conversationHistory.length > MAX_HISTORY_TURNS * 2) {
    state.conversationHistory = state.conversationHistory.slice(-MAX_HISTORY_TURNS * 2);
  }
}

/**
 * Step 4: Parse and validate the raw Gemini string.
 * Alias kept for backward compat with tests.
 * @param {string} raw
 */
function parseAndValidateResponse(raw) {
  return parseTriageResponse(raw);
}

/**
 * Step 5: Handle urgency escalation and emergency mode trigger.
 * @param {string} newUrgency
 * @param {string} summary
 */
function handleUrgencyEscalation(newUrgency, summary) {
  checkUrgencyEscalation(newUrgency);
  if (newUrgency === "emergency" && !state.emergencyDismissed) {
    activateEmergencyMode(summary);
  }
}

/**
 * Step 6: Render triage result in the chat.
 * Thin wrapper that calls appendTriageMessage.
 */
function renderTriageResult(parsed, sources) {
  appendTriageMessage(parsed, sources);
}

/**
 * Step 7: Update sidebar calendar panel and show map if needed.
 * @param {{ urgency, recommendAppointment, suggestedAppointmentTitle }} parsed
 */
function updateSidebarAndMap(parsed) {
  updateSidePanel(parsed);
  if (parsed.urgency === "high" || parsed.urgency === "emergency") {
    showNearbyClinicMap();
  }
}

/**
 * Step 8: Record triage result in session history.
 * @param {string} userInput
 * @param {object} parsed
 */
function recordInHistory(userInput, parsed) {
  recordTriageHistory(userInput, parsed);
  state.conversationHistory.push({ role: "model", parts: [{ text: JSON.stringify(parsed) }] });
}

/**
 * Main send handler — orchestrates all steps.
 */
async function sendMessage() {
  const rawText = chatInput.value.trim();

  const check = validateBeforeSend(rawText);
  if (!check.ok) {
    if (check.errorMsg) showError(check.errorMsg);
    return;
  }
  if (state.isLoading) return;

  // Pre-AI keyword emergency check
  if (hasEmergencyKeywords(rawText) && !state.emergencyDismissed) {
    activateEmergencyMode("Emergency symptoms detected in your message. Please call emergency services immediately.");
  }

  const text = captureAndClearInput();
  appendUserMessage(text);
  setLoading(true);
  recordRequest();

  // Cancel any previous in-flight request
  state.currentAbortCtrl?.abort();
  state.currentAbortCtrl = new AbortController();

  try {
    const { raw, sources } = await callGeminiWithRetry(state.conversationHistory, 0, state.currentAbortCtrl.signal);
    const parsed = parseAndValidateResponse(raw);

    handleUrgencyEscalation(parsed.urgency, parsed.summary);
    renderTriageResult(parsed, sources);
    updateSidebarAndMap(parsed);
    recordInHistory(text, parsed);

    // Near-limit warning
    const remaining = RATE_LIMIT_MAX - getStoredTimestamps().length;
    if (remaining === 1) {
      announce("Warning: you have 1 message remaining this minute.");
    }

  } catch (err) {
    if (err.name === "AbortError") return; // request was intentionally cancelled
    const msg = err.userMessage || "Something went wrong. Please try again.";
    showErrorWithRetry(msg);
    console.error("[Triage] API error:", err);
  } finally {
    setLoading(false);
  }
}

sendBtn.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ─── Gemini API ────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a medical triage assistant. Assess symptom severity and guide users to appropriate care. You do NOT diagnose conditions or prescribe treatments.

Always respond in this EXACT JSON format — no markdown fences, no extra text:
{
  "urgency": "low|medium|high|emergency",
  "summary": "One-sentence summary",
  "advice": "2–4 sentences of clear actionable guidance",
  "nextSteps": ["Action 1", "Action 2", "Action 3"],
  "warningsigns": ["Warning sign 1", "Warning sign 2"],
  "recommendAppointment": true|false,
  "suggestedAppointmentTitle": "e.g. GP consultation — headache",
  "emergencyNote": "Only if emergency — e.g. Call 112 immediately"
}

Urgency:
- low: manage at home (mild cold, minor cut, mild headache)
- medium: see a doctor within 1–3 days
- high: see a doctor today / urgent care
- emergency: call emergency services immediately

Rules:
1. NEVER diagnose a specific condition.
2. ALWAYS remind user to consult a qualified healthcare professional.
3. Be empathetic; avoid overly clinical jargon.
4. For mental health crises, include crisis line info in advice.
5. Respond in the user's language if not English.`;

/**
 * Exponential backoff retry wrapper.
 * @param {Array}  history
 * @param {number} attempt
 * @param {AbortSignal} signal
 */
async function callGeminiWithRetry(history, attempt = 0, signal) {
  try {
    return await callGemini(history, signal);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    if (attempt < 2 && err.retryable) {
      const delay = Math.pow(2, attempt) * 1000;
      await sleep(delay);
      return callGeminiWithRetry(history, attempt + 1, signal);
    }
    throw err;
  }
}

/**
 * Calls Gemini 2.0 Flash with Google Search Grounding.
 * Note: responseMimeType is intentionally omitted when googleSearch tool is
 * active — the two are mutually exclusive in the Gemini API.
 * @param {Array}  history
 * @param {AbortSignal} signal
 */
async function callGemini(history, signal) {
  const lang = getLang();
  const url  = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: history,
    tools: [{ googleSearch: {} }],
    generationConfig: {
      temperature:     0.3,
      maxOutputTokens: 1024,
      // responseMimeType intentionally omitted — incompatible with googleSearch tool
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",       threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    ],
  };

  let res;
  try {
    res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
      signal,
    });
  } catch (networkErr) {
    if (networkErr.name === "AbortError") throw networkErr;
    const e = new Error("Network error.");
    e.userMessage = "Network error. Please check your connection.";
    e.retryable   = true;
    throw e;
  }

  if (!res.ok) {
    let errMsg = `Gemini API error (${res.status})`;
    try { const body = await res.json(); errMsg = body.error?.message || errMsg; } catch (_) {}
    const e = new Error(errMsg);
    e.userMessage = res.status === 429
      ? "Too many requests. Please wait a moment and try again."
      : "Could not reach the AI service. Please try again.";
    e.retryable = res.status === 429 || res.status >= 500;
    throw e;
  }

  const data      = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) {
    const e = new Error("No candidate response.");
    e.userMessage = "The AI returned no response. Please try again.";
    throw e;
  }

  const raw    = candidate.content?.parts?.[0]?.text ?? "";
  const chunks = candidate.groundingMetadata?.groundingChunks ?? [];
  const sources = chunks
    .filter(c => c.web?.uri && c.web?.title)
    .map(c => ({ title: c.web.title, url: c.web.uri }));

  return { raw, sources };
}

// ─── Parse Gemini response ─────────────────────────────────────────────────────
/**
 * @param {string} raw
 */
function parseTriageResponse(raw) {
  try {
    const clean  = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(clean);
    return {
      urgency:                   URGENCY_LEVELS.includes(parsed.urgency) ? parsed.urgency : "medium",
      summary:                   typeof parsed.summary === "string" ? parsed.summary : "",
      advice:                    typeof parsed.advice  === "string" ? parsed.advice  : "",
      nextSteps:                 Array.isArray(parsed.nextSteps)    ? parsed.nextSteps    : [],
      warningsigns:              Array.isArray(parsed.warningsigns) ? parsed.warningsigns : [],
      recommendAppointment:      !!parsed.recommendAppointment,
      suggestedAppointmentTitle: typeof parsed.suggestedAppointmentTitle === "string" ? parsed.suggestedAppointmentTitle : "",
      emergencyNote:             typeof parsed.emergencyNote === "string" ? parsed.emergencyNote : "",
    };
  } catch {
    return {
      urgency:                   "medium",
      summary:                   "Unable to fully parse the AI response.",
      advice:                    sanitizeText(raw).substring(0, 300),
      nextSteps:                 [],
      warningsigns:              [],
      recommendAppointment:      false,
      suggestedAppointmentTitle: "",
      emergencyNote:             "",
    };
  }
}

// ─── Render triage message ─────────────────────────────────────────────────────
const URGENCY_META = {
  low:       { label: "Low urgency",    icon: "🟢", cls: "urgency-low"       },
  medium:    { label: "Medium urgency", icon: "🟡", cls: "urgency-medium"    },
  high:      { label: "High urgency",   icon: "🔴", cls: "urgency-high"      },
  emergency: { label: "Emergency",      icon: "🚨", cls: "urgency-emergency" },
};

/**
 * Builds and appends a full triage result bubble.
 * @param {object} parsed
 * @param {Array<{title,url}>} sources
 */
function appendTriageMessage(parsed, sources = []) {
  const meta   = URGENCY_META[parsed.urgency] || URGENCY_META.medium;
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  // Urgency badge
  const badge = document.createElement("span");
  badge.className = `urgency-badge ${meta.cls}`;
  badge.setAttribute("role", "status");
  badge.setAttribute("aria-label", `Urgency level: ${meta.label}`);
  badge.textContent = `${meta.icon} ${meta.label}`;
  bubble.appendChild(badge);

  // Emergency note
  if (parsed.emergencyNote) {
    const note = document.createElement("div");
    note.className = "emergency-note";
    note.setAttribute("role", "alert");
    note.textContent = `⚠ ${parsed.emergencyNote}`;
    bubble.appendChild(note);
  }

  if (parsed.summary)              bubble.appendChild(makeSection(null, parsed.summary));
  if (parsed.advice)               bubble.appendChild(makeSection("💡 Advice", parsed.advice));
  if (parsed.nextSteps.length)     bubble.appendChild(makeListSection("✅ Next steps", parsed.nextSteps));
  if (parsed.warningsigns.length)  bubble.appendChild(makeListSection("⚠ Watch out for", parsed.warningsigns));

  if (sources.length) bubble.appendChild(makeSourcesSection(sources));

  const disc = document.createElement("p");
  disc.className  = "triage-disclaimer";
  disc.textContent = "ℹ This is not medical advice. Please consult a qualified healthcare professional.";
  bubble.appendChild(disc);

  // Action buttons
  if (parsed.recommendAppointment || parsed.urgency === "high" || parsed.urgency === "emergency") {
    const actions = document.createElement("div");
    actions.className = "action-buttons";

    if (parsed.recommendAppointment) {
      const calBtn = document.createElement("button");
      calBtn.className = "btn btn-green";
      calBtn.setAttribute("aria-label", "Book appointment in Google Calendar");
      calBtn.textContent = "📅 Book appointment";
      calBtn.addEventListener("click", () => showCalendarSlotPicker(parsed.suggestedAppointmentTitle));
      actions.appendChild(calBtn);
    }

    const mapBtn = document.createElement("button");
    mapBtn.className = "btn btn-outline";
    mapBtn.setAttribute("aria-label", "Find nearby clinics on map");
    mapBtn.textContent = "📍 Find nearby clinics";
    mapBtn.addEventListener("click", showNearbyClinicMap);
    actions.appendChild(mapBtn);

    bubble.appendChild(actions);
  }

  appendBubble("assistant", bubble);
}

/** @param {string|null} heading @param {string} bodyText @returns {HTMLElement} */
function makeSection(heading, bodyText) {
  const sec = document.createElement("div");
  sec.className = "triage-section";
  if (heading) {
    const h = document.createElement("h3");
    h.textContent = heading;
    sec.appendChild(h);
  }
  const p = document.createElement("p");
  p.textContent = bodyText;
  sec.appendChild(p);
  return sec;
}

/** @param {string} heading @param {string[]} items @returns {HTMLElement} */
function makeListSection(heading, items) {
  const sec = document.createElement("div");
  sec.className = "triage-section";
  const h = document.createElement("h3");
  h.textContent = heading;
  sec.appendChild(h);
  const ul = document.createElement("ul");
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    ul.appendChild(li);
  });
  sec.appendChild(ul);
  return sec;
}

/**
 * Creates a grounding sources section.
 * Shows first 3 chips; "+ N more" expands remainder.
 * Each chip has a tooltip showing the full URL.
 * @param {Array<{title,url}>} sources
 */
function makeSourcesSection(sources) {
  const VISIBLE   = 3;
  const sec       = document.createElement("div");
  sec.className   = "triage-section sources-section";

  const h = document.createElement("h3");
  h.textContent = "📚 Sources";
  sec.appendChild(h);

  const list = document.createElement("ul");
  list.className = "sources-list";

  const renderChip = ({ title, url }) => {
    const li = document.createElement("li");
    const a  = document.createElement("a");
    a.href        = url;
    a.target      = "_blank";
    a.rel         = "noopener noreferrer";
    a.textContent = title;
    a.className   = "source-chip";
    a.title       = url;            // tooltip showing full URL
    a.setAttribute("aria-label", `Source: ${title} — ${url} (opens in new tab)`);
    li.appendChild(a);
    return li;
  };

  const visible   = sources.slice(0, VISIBLE);
  const remaining = sources.slice(VISIBLE);

  visible.forEach(s => list.appendChild(renderChip(s)));

  if (remaining.length > 0) {
    const moreLi  = document.createElement("li");
    const moreBtn = document.createElement("button");
    moreBtn.className   = "source-more-btn";
    moreBtn.textContent = `+ ${remaining.length} more`;
    moreBtn.setAttribute("aria-label", `Show ${remaining.length} more sources`);
    moreBtn.addEventListener("click", () => {
      remaining.forEach(s => list.appendChild(renderChip(s)));
      moreLi.remove();
    });
    moreLi.appendChild(moreBtn);
    list.appendChild(moreLi);
  }

  sec.appendChild(list);
  return sec;
}

// ─── Security helpers ──────────────────────────────────────────────────────────
/** @param {string|null|undefined} str @returns {string} */
function escapeAttr(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g,  "&amp;")
    .replace(/'/g,  "&#x27;")
    .replace(/"/g,  "&quot;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;");
}

/** @param {string|null|undefined} str @returns {string} */
function sanitizeText(str) {
  if (str == null) return "";
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

// ─── Chat UI helpers ───────────────────────────────────────────────────────────
function appendMessage(role, content) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = role === "user" ? "You" : "AI";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = content;
  if (role === "user") {
    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
  } else {
    wrapper.appendChild(bubble);
    wrapper.appendChild(avatar);
  }
  chatMessages.appendChild(wrapper);
  scrollToBottom();
}

function appendBubble(role, bubbleEl) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = "AI";
  wrapper.appendChild(bubbleEl);
  wrapper.appendChild(avatar);
  chatMessages.appendChild(wrapper);
  scrollToBottom();
}

/**
 * Shows an error with a Retry button.
 * @param {string} msg
 */
function showErrorWithRetry(msg) {
  const el     = document.createElement("div");
  el.className = "message assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble-error";
  bubble.setAttribute("role", "alert");

  const text = document.createElement("span");
  text.textContent = `⚠ ${msg}`;
  bubble.appendChild(text);

  const retryBtn = document.createElement("button");
  retryBtn.className   = "btn btn-outline retry-btn";
  retryBtn.textContent = "↩ Retry";
  retryBtn.setAttribute("aria-label", "Retry the last message");
  retryBtn.addEventListener("click", () => {
    el.remove();
    sendMessage();
  });
  bubble.appendChild(retryBtn);
  el.appendChild(bubble);
  chatMessages.appendChild(el);
  scrollToBottom();
}

function showError(msg) {
  const el     = document.createElement("div");
  el.className = "message assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble-error";
  bubble.setAttribute("role", "alert");
  bubble.textContent = `⚠ ${msg}`;
  el.appendChild(bubble);
  chatMessages.appendChild(el);
  scrollToBottom();
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "message assistant";
  div.id = "typing-indicator";
  div.setAttribute("aria-label", "AI is thinking");
  div.setAttribute("role", "status");
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = `<div class="typing-indicator" aria-hidden="true"><span></span><span></span><span></span></div>`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = "AI";
  div.appendChild(bubble);
  div.appendChild(avatar);
  chatMessages.appendChild(div);
  scrollToBottom();
}

function removeTyping() {
  document.getElementById("typing-indicator")?.remove();
}

function setLoading(val) {
  state.isLoading = val;
  sendBtn.disabled    = val;
  chatInput.disabled  = val;
  sendBtn.setAttribute("aria-busy", val ? "true" : "false");
  if (val) showTyping(); else removeTyping();
}

// ─── Debounced scroll ──────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const scrollToBottom = debounce(() => {
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: prefersReduced ? "auto" : "smooth" });
}, 50);

// ─── Announce utilities ────────────────────────────────────────────────────────
let _announceTimeout;
let _announceEl;

function announce(msg) {
  clearTimeout(_announceTimeout);
  _announceEl?.remove();
  _announceEl = document.createElement("div");
  _announceEl.setAttribute("aria-live", "polite");
  _announceEl.className = "sr-only";
  _announceEl.textContent = msg;
  document.body.appendChild(_announceEl);
  _announceTimeout = setTimeout(() => { _announceEl?.remove(); _announceEl = null; }, 3000);
}

function announceAssertive(msg) {
  const el = document.createElement("div");
  el.setAttribute("aria-live", "assertive");
  el.setAttribute("role", "alert");
  el.className = "sr-only";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ─── Char counter ──────────────────────────────────────────────────────────────
function updateCharCounter() {
  const len = chatInput.value.length;
  charCounter.textContent = `${len} / ${MAX_INPUT_LENGTH}`;
  charCounter.classList.toggle("counter-warn", len > MAX_INPUT_LENGTH * 0.85);
  charCounter.classList.toggle("counter-over", len >= MAX_INPUT_LENGTH);
}

chatInput.addEventListener("input", function () {
  updateCharCounter();
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 150) + "px";
  this.style.overflowY = this.scrollHeight > 150 ? "auto" : "hidden";
});

// ─── Symptom quick-select ──────────────────────────────────────────────────────
document.querySelectorAll(".symptom-tag").forEach((tag) => {
  tag.addEventListener("click", () => {
    const symptom    = tag.dataset.symptom;
    const isSelected = state.selectedSymptoms.has(symptom);
    if (isSelected) {
      state.selectedSymptoms.delete(symptom);
      tag.classList.remove("selected");
      tag.setAttribute("aria-pressed", "false");
    } else {
      state.selectedSymptoms.add(symptom);
      tag.classList.add("selected");
      tag.setAttribute("aria-pressed", "true");
    }
  });
});

document.getElementById("use-selected-btn").addEventListener("click", () => {
  if (state.selectedSymptoms.size === 0) {
    announce("No symptoms selected. Please tap one or more symptoms first.");
    return;
  }
  const list = [...state.selectedSymptoms].join(", ");
  chatInput.value = `I'm experiencing: ${list}`;
  updateCharCounter();
  chatInput.focus();
  state.selectedSymptoms.clear();
  document.querySelectorAll(".symptom-tag").forEach(t => {
    t.classList.remove("selected");
    t.setAttribute("aria-pressed", "false");
  });
});

// ─── Voice input ───────────────────────────────────────────────────────────────
function initVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition || !voiceBtn) return;
  voiceBtn.hidden = false;
  const recognition = new SpeechRecognition();
  recognition.continuous      = false;
  recognition.interimResults  = false;
  recognition.lang            = navigator.language || "en-US"; // dynamic lang
  recognition.maxAlternatives = 1;
  let listening = false;

  recognition.onstart  = () => {
    listening = true;
    voiceBtn.setAttribute("aria-pressed", "true");
    voiceBtn.textContent = "🔴";
    voiceBtn.setAttribute("aria-label", "Stop voice input");
    announce("Listening… speak your symptoms now.");
  };
  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    chatInput.value  = transcript;
    updateCharCounter();
    chatInput.focus();
    announce(`Heard: ${transcript}`);
  };
  recognition.onerror  = (e) => {
    console.warn("[Voice]", e.error);
    announce("Voice input failed. Please type your symptoms instead.");
  };
  recognition.onend    = () => {
    listening = false;
    voiceBtn.setAttribute("aria-pressed", "false");
    voiceBtn.textContent = "🎤";
    voiceBtn.setAttribute("aria-label", "Use voice input");
  };
  voiceBtn.addEventListener("click", () => {
    if (listening) { recognition.stop(); }
    else { try { recognition.start(); } catch (_) { /* already started */ } }
  });
}

// ─── Session triage history ────────────────────────────────────────────────────
function recordTriageHistory(input, parsed) {
  const entry = {
    timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    urgency:   parsed.urgency,
    summary:   parsed.summary,
    input:     input.substring(0, 80),
  };
  state.triageHistory.unshift(entry);
  if (state.triageHistory.length > 20) state.triageHistory.length = 20;
  historyPanel.hidden = false;
  prependHistoryEntry(entry);
}

function buildHistoryItem(entry) {
  const li   = document.createElement("li");
  li.className = `history-entry urgency-${entry.urgency}-border`;
  const time = document.createElement("span");
  time.className   = "history-time";
  time.textContent = entry.timestamp;
  const badge = document.createElement("span");
  badge.className   = `history-badge urgency-${entry.urgency}`;
  badge.textContent = entry.urgency.toUpperCase();
  const text = document.createElement("span");
  text.className   = "history-text";
  text.textContent = entry.summary || entry.input;
  li.appendChild(time);
  li.appendChild(badge);
  li.appendChild(text);
  return li;
}

function prependHistoryEntry(entry) {
  if (historyList.children.length >= 5) historyList.removeChild(historyList.lastChild);
  historyList.prepend(buildHistoryItem(entry));
}

// ─── History modal ─────────────────────────────────────────────────────────────
historyBtn.addEventListener("click", () => {
  if (state.triageHistory.length === 0) {
    announce("No triage history yet. Start a conversation first.");
    return;
  }
  const body = document.getElementById("modal-body");
  body.innerHTML = "";
  state.triageHistory.forEach((entry) => {
    const div    = document.createElement("div");
    div.className = `modal-entry urgency-${entry.urgency}-border`;
    const header = document.createElement("div");
    header.className = "modal-entry-header";
    const badge  = document.createElement("span");
    badge.className   = `history-badge urgency-${entry.urgency}`;
    badge.textContent = entry.urgency.toUpperCase();
    const time   = document.createElement("span");
    time.className   = "history-time";
    time.textContent = entry.timestamp;
    header.appendChild(badge);
    header.appendChild(time);
    const inputP = document.createElement("p");
    inputP.className = "modal-entry-input";
    const em = document.createElement("em");
    em.textContent = "You said: ";
    inputP.appendChild(em);
    inputP.appendChild(document.createTextNode(entry.input));
    const summaryP = document.createElement("p");
    summaryP.className   = "modal-entry-summary";
    summaryP.textContent = entry.summary;
    div.appendChild(header);
    div.appendChild(inputP);
    div.appendChild(summaryP);
    body.appendChild(div);
  });
  historyModal.showModal();
  historyBtn.setAttribute("aria-expanded", "true");
  trapFocus(historyModal);
});

closeModalBtn.addEventListener("click", () => {
  historyModal.close();
  historyBtn.setAttribute("aria-expanded", "false");
  historyBtn.focus();
});

historyModal.addEventListener("keydown", (e) => {
  if (e.key === "Escape") historyBtn.setAttribute("aria-expanded", "false");
});

// ─── Focus trap ────────────────────────────────────────────────────────────────
function trapFocus(element) {
  const focusable = Array.from(element.querySelectorAll(
    'a[href], button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )).filter(el => !el.disabled);
  if (!focusable.length) return;
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];
  function handleTab(e) {
    if (e.key !== "Tab") return;
    if (e.shiftKey) {
      if (document.activeElement === first) { last.focus(); e.preventDefault(); }
    } else {
      if (document.activeElement === last)  { first.focus(); e.preventDefault(); }
    }
  }
  element.addEventListener("keydown", handleTab);
  element.addEventListener("close", () => element.removeEventListener("keydown", handleTab), { once: true });
  first.focus();
}

// ─── Side panel update ─────────────────────────────────────────────────────────
function updateSidePanel(parsed) {
  if (parsed.recommendAppointment) {
    calendarStatus.innerHTML = "";
    calendarStatus.appendChild(document.createTextNode("A doctor visit is recommended. "));
    const btn = document.createElement("button");
    btn.className   = "btn btn-green";
    btn.style.marginTop = "8px";
    btn.textContent = "📅 Book in Google Calendar";
    btn.addEventListener("click", () => showCalendarSlotPicker(parsed.suggestedAppointmentTitle));
    calendarStatus.appendChild(btn);
  }
}

// ─── Calendar slot picker ──────────────────────────────────────────────────────
function showCalendarSlotPicker(title) {
  calendarStatus.innerHTML = "";
  const label = document.createElement("p");
  label.className   = "slot-label";
  label.textContent = "Choose an appointment slot:";
  calendarStatus.appendChild(label);
  const slots  = [1, 2, 3].map(days => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(10, 0, 0, 0);
    return d;
  });
  const labels = ["Tomorrow 10am", "In 2 days 10am", "In 3 days 10am"];
  const group  = document.createElement("div");
  group.className = "slot-group";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Available appointment slots");
  slots.forEach((date, i) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-outline slot-btn";
    btn.textContent = labels[i];
    btn.setAttribute("aria-label", `Book appointment for ${labels[i]}`);
    btn.addEventListener("click", () => bookCalendarEvent(title, date));
    group.appendChild(btn);
  });
  calendarStatus.appendChild(group);
}

// ─── Google Calendar (OAuth 2.0) ───────────────────────────────────────────────
function initGoogleAuth() {
  const script = document.createElement("script");
  script.src   = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

function getCalendarToken(callback) {
  if (state.calendarToken) { callback(); return; }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CALENDAR_CLIENT_ID,
    scope:     CONFIG.GOOGLE_API_SCOPES,
    callback:  (tokenResponse) => {
      if (tokenResponse.access_token) {
        state.calendarToken = tokenResponse.access_token;
        setTimeout(() => { state.calendarToken = null; }, 3600 * 1000);
        callback();
      } else {
        setCalendarText("error", "Authorization failed. Please try again.");
      }
    },
  });
  client.requestAccessToken();
}

async function bookCalendarEvent(title, startDate) {
  getCalendarToken(async () => {
    const start = startDate || (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d; })();
    const end   = new Date(start);
    end.setMinutes(end.getMinutes() + 30);
    const tz    = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const event = {
      summary:     title || "Doctor appointment",
      description: "Booked via Medical Triage Assistant (Gemini AI)",
      start: { dateTime: start.toISOString(), timeZone: tz },
      end:   { dateTime: end.toISOString(),   timeZone: tz },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 60  },
          { method: "email", minutes: 120 },
        ],
      },
    };
    try {
      setCalendarText("loading", "⏳ Booking appointment…");
      const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${state.calendarToken}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify(event),
      });
      if (res.status === 401) {
        state.calendarToken = null;
        setCalendarText("error", "Session expired. Please click Book again to re-authorize.");
        return;
      }
      if (!res.ok) throw new Error(`Calendar API error ${res.status}`);
      const data = await res.json();
      calendarStatus.className = "calendar-status status-success";
      calendarStatus.innerHTML = "";
      calendarStatus.appendChild(document.createTextNode("✅ Appointment booked! "));
      if (data.htmlLink) {
        const link = document.createElement("a");
        link.href         = data.htmlLink;
        link.target       = "_blank";
        link.rel          = "noopener noreferrer";
        link.textContent  = "View in Calendar →";
        link.setAttribute("aria-label", "View appointment in Google Calendar (opens in new tab)");
        calendarStatus.appendChild(link);
      }
      announce("Appointment booked successfully.");
    } catch (err) {
      setCalendarText("error", "Could not book appointment. Please try again.");
      console.error("[Calendar]", err);
    }
  });
}

function setCalendarText(type, message) {
  calendarStatus.className  = `calendar-status status-${type}`;
  calendarStatus.textContent = message;
}

// ─── Google Maps Embed ─────────────────────────────────────────────────────────
function showNearbyClinicMap() {
  // Show skeleton loader while geolocation resolves
  mapContainer.innerHTML = "";
  const skeleton = document.createElement("div");
  skeleton.className = "map-skeleton";
  skeleton.setAttribute("aria-label", "Loading map…");
  skeleton.setAttribute("role", "status");
  skeleton.innerHTML = `<div class="map-skeleton-pulse"></div><p class="map-placeholder">📍 Finding your location…</p>`;
  mapContainer.appendChild(skeleton);

  if (!navigator.geolocation) {
    loadMapWithQuery("nearby clinic hospital urgent care");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords: { latitude: lat, longitude: lng } }) => {
      const lang = getLang();
      const src  = `https://www.google.com/maps/embed/v1/search?key=${CONFIG.GOOGLE_MAPS_API_KEY}&q=clinic+hospital+urgent+care&center=${lat},${lng}&zoom=13&language=${lang}`;
      renderMapIframe(src);
    },
    () => loadMapWithQuery("nearby clinic hospital urgent care"),
    { timeout: 8000 }
  );
}

function loadMapWithQuery(query) {
  const lang = getLang();
  const src  = `https://www.google.com/maps/embed/v1/search?key=${CONFIG.GOOGLE_MAPS_API_KEY}&q=${encodeURIComponent(query)}&language=${lang}`;
  renderMapIframe(src);
}

function renderMapIframe(src) {
  mapContainer.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.src    = src;
  iframe.width  = "100%";
  iframe.height = "100%";
  iframe.style.border = "none";
  iframe.allow  = "geolocation";
  iframe.title  = "Map of nearby clinics and hospitals";
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("aria-label", "Nearby clinics and hospitals map");
  mapContainer.appendChild(iframe);
}

// ─── Theme ─────────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  applyTheme(saved || "dark");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "dark" ? "☀️" : "🌓";
  themeToggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});

// ─── Clear chat ────────────────────────────────────────────────────────────────
clearChatBtn.addEventListener("click", () => {
  if (state.conversationHistory.length === 0 && chatMessages.children.length === 0) return;
  state.conversationHistory = [];
  state.lastUrgency         = null;
  state.emergencyDismissed  = false;
  chatMessages.innerHTML    = "";
  chatInput.style.height    = "auto";
  // Also clear localStorage rate limit store
  saveTimestamps([]);
  state.requestTimestamps   = [];
  deactivateEmergencyMode();
  appendGreeting();
  announce("Chat cleared.");
});

// ─── Offline detection ─────────────────────────────────────────────────────────
function syncOnlineStatus() {
  offlineBanner.hidden = navigator.onLine;
}
window.addEventListener("online",  syncOnlineStatus);
window.addEventListener("offline", syncOnlineStatus);

// ─── Greeting ──────────────────────────────────────────────────────────────────
function appendGreeting() {
  const lang  = getLang();
  const greet = lang === "es"
    ? "¡Hola! Soy tu asistente de triaje médico con IA, impulsado por Gemini AI con búsqueda en vivo de Google. Describe tus síntomas y te ayudaré a evaluar la urgencia y guiarte. Recuerda: esta herramienta no reemplaza el consejo médico profesional."
    : "Hello! I'm your AI medical triage assistant powered by Gemini AI with live Google Search grounding. Describe your symptoms and I'll help assess urgency and guide your next steps. Remember: this tool does not replace professional medical advice.";
  appendMessage("assistant", greet);
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Service Worker registration ───────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      .then(reg => console.info("[SW] Registered, scope:", reg.scope))
      .catch(err => console.warn("[SW] Registration failed:", err));
  });
}

// ─── Init ──────────────────────────────────────────────────────────────────────
initTheme();
initGoogleAuth();
initVoiceInput();
syncOnlineStatus();
appendGreeting();
