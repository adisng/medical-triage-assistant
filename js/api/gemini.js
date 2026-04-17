/**
 * gemini.js — Gemini API client with retry logic and response parsing
 * Medical Triage Assistant
 *
 * Google Services:
 *  - Gemini 2.0 Flash — symptom analysis + structured triage JSON
 *  - Gemini Search Grounding — AI responses backed by live Google Search
 */

"use strict";

import { GEMINI_MODEL, URGENCY_LEVELS } from "../utils/constants.js";
import { sanitizeText } from "../utils/security.js";
import { sleep } from "../utils/helpers.js";

// ─── System prompt ─────────────────────────────────────────────────────────────
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
 * Returns the currently stored language (default: en).
 * @returns {string}
 */
function getLangForApi() {
  try {
    return localStorage.getItem("mta-lang-v1") || "en";
  } catch {
    return "en";
  }
}

/**
 * Exponential backoff retry wrapper for Gemini API calls.
 * Retries up to 2 additional times on retryable errors.
 * @param {Array}       history  - Conversation history
 * @param {number}      attempt  - Current attempt index (0-based)
 * @param {AbortSignal} signal   - AbortController signal to cancel in-flight
 * @returns {Promise<{raw: string, sources: Array}>}
 */
export async function callGeminiWithRetry(history, attempt = 0, signal) {
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
 * @param {Array}       history - Conversation turns
 * @param {AbortSignal} signal  - Cancellation signal
 * @returns {Promise<{raw: string, sources: Array<{title:string, url:string}>}>}
 */
async function callGemini(history, signal) {
  const lang = getLangForApi();
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

/**
 * Parses the raw Gemini response text into a validated triage object.
 * Handles JSON fences, invalid JSON gracefully with safe defaults.
 * @param {string} raw - Raw text from Gemini
 * @returns {object} Normalised triage result
 */
export function parseTriageResponse(raw) {
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
