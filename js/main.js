/**
 * main.js — Application entry point and orchestrator
 * Medical Triage Assistant — Google Hackathon 2025
 *
 * This module imports all feature modules and wires up event listeners.
 * It is loaded as type="module" from index.html.
 *
 * Google Services:
 *  1. Gemini 2.0 Flash          — symptom analysis + structured triage JSON
 *  2. Gemini Search Grounding   — AI responses backed by live Google Search
 *  3. Google Calendar API       — OAuth 2.0 appointment booking (3-slot picker)
 *  4. Google Maps Embed API     — geolocation-aware nearby clinic finder
 *  5. Google Identity Services  — OAuth 2.0 token flow (in-memory only)
 *
 * Architecture:
 *  js/utils/constants.js  — Named constants (no magic numbers)
 *  js/utils/state.js      — Centralised mutable state
 *  js/utils/security.js   — XSS prevention: escapeAttr, sanitizeText, validateInput
 *  js/utils/helpers.js    — debounce, sleep, SR announcements
 *  js/api/gemini.js       — Gemini API client, retry, response parsing
 *  js/ui/chat.js          — Chat rendering, triage cards, source chips, focus trap
 *  js/ui/emergency.js     — Emergency keyword detection + full-screen overlay
 *  js/services/calendar.js— Google Calendar OAuth + booking + slot picker
 *  js/services/maps.js    — Google Maps Embed with geolocation fallback
 *  js/main.js             — This file: orchestrator + event wiring
 */

"use strict";

// ─── Module imports ────────────────────────────────────────────────────────────
import {
  MAX_INPUT_LENGTH, MAX_HISTORY_TURNS, RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW, RATE_LIMIT_STORAGE_KEY, THEME_STORAGE_KEY,
  LANG_STORAGE_KEY, URGENCY_LEVELS,
} from "./utils/constants.js";

import { state } from "./utils/state.js";

import { escapeAttr, sanitizeText, validateInput } from "./utils/security.js";

import { debounce, sleep, announce, announceAssertive } from "./utils/helpers.js";

import { callGeminiWithRetry, parseTriageResponse } from "./api/gemini.js";

import {
  chatMessages, chatInput, sendBtn, calendarStatus, mapContainer,
  themeToggle, clearChatBtn, charCounter, historyBtn, historyModal,
  closeModalBtn, offlineBanner, historyList, historyPanel, voiceBtn,
  scrollToBottom, appendMessage, appendBubble, showErrorWithRetry,
  showError, setLoading, updateCharCounter, appendTriageMessage,
  makeSection, makeListSection, makeSourcesSection, trapFocus,
  URGENCY_META,
} from "./ui/chat.js";

import {
  hasEmergencyKeywords, checkUrgencyEscalation,
  activateEmergencyMode, deactivateEmergencyMode,
} from "./ui/emergency.js";

import {
  initGoogleAuth, bookCalendarEvent, showCalendarSlotPicker, updateSidePanel,
} from "./services/calendar.js";

import { showNearbyClinicMap } from "./services/maps.js";

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
 * @returns {boolean}
 */
function isRateLimited() {
  const ts = getStoredTimestamps();
  state.requestTimestamps = ts;
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
  checkUrgencyEscalation(newUrgency, chatMessages, scrollToBottom);
  if (newUrgency === "emergency" && !state.emergencyDismissed) {
    activateEmergencyMode(summary, showNearbyClinicMap, trapFocus);
  }
}

/**
 * Step 6: Render triage result in the chat.
 */
function renderTriageResult(parsed, sources) {
  appendTriageMessage(parsed, sources, showCalendarSlotPicker, showNearbyClinicMap);
}

/**
 * Step 7: Update sidebar calendar panel and show map if needed.
 * @param {object} parsed
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
    activateEmergencyMode("Emergency symptoms detected in your message. Please call emergency services immediately.", showNearbyClinicMap, trapFocus);
  }

  const text = captureAndClearInput();
  appendUserMessage(text);
  setLoading(true, state);
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
    showErrorWithRetry(msg, sendMessage);
    console.error("[Triage] API error:", err);
  } finally {
    setLoading(false, state);
  }
}

sendBtn?.addEventListener("click", sendMessage);
chatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ─── Char counter auto-resize ──────────────────────────────────────────────────
chatInput?.addEventListener("input", function () {
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

document.getElementById("use-selected-btn")?.addEventListener("click", () => {
  if (state.selectedSymptoms.size === 0) {
    announce("No symptoms selected. Please tap one or more symptoms first.");
    return;
  }
  const list = [...state.selectedSymptoms].join(", ");
  if (chatInput) {
    chatInput.value = `I'm experiencing: ${list}`;
    updateCharCounter();
    chatInput.focus();
  }
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
  recognition.lang            = navigator.language || "en-US";
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
historyBtn?.addEventListener("click", () => {
  if (state.triageHistory.length === 0) {
    announce("No triage history yet. Start a conversation first.");
    return;
  }
  const body = document.getElementById("modal-body");
  if (!body) return;
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
  if (historyModal) {
    historyModal.showModal();
    historyBtn?.setAttribute("aria-expanded", "true");
    trapFocus(historyModal);
  }
});

closeModalBtn?.addEventListener("click", () => {
  historyModal?.close();
  historyBtn?.setAttribute("aria-expanded", "false");
  historyBtn?.focus();
});

historyModal?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") historyBtn?.setAttribute("aria-expanded", "false");
});

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

themeToggle?.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});

// ─── Clear chat ────────────────────────────────────────────────────────────────
clearChatBtn?.addEventListener("click", () => {
  if (state.conversationHistory.length === 0 && (!chatMessages || chatMessages.children.length === 0)) return;
  state.conversationHistory = [];
  state.lastUrgency         = null;
  state.emergencyDismissed  = false;
  if (chatMessages) chatMessages.innerHTML = "";
  if (chatInput) chatInput.style.height = "auto";
  saveTimestamps([]);
  state.requestTimestamps   = [];
  deactivateEmergencyMode();
  appendGreeting();
  announce("Chat cleared.");
});

// ─── Offline detection ─────────────────────────────────────────────────────────
function syncOnlineStatus() {
  if (offlineBanner) offlineBanner.hidden = navigator.onLine;
}
window.addEventListener("online",  syncOnlineStatus);
window.addEventListener("offline", syncOnlineStatus);

// ─── Greeting ──────────────────────────────────────────────────────────────────
function appendGreeting() {
  if (!chatMessages) return; // skip for tests
  const lang  = getLang();
  const greet = lang === "es"
    ? "¡Hola! Soy tu asistente de triaje médico con IA, impulsado por Gemini AI con búsqueda en vivo de Google. Describe tus síntomas y te ayudaré a evaluar la urgencia y guiarte. Recuerda: esta herramienta no reemplaza el consejo médico profesional."
    : "Hello! I'm your AI medical triage assistant powered by Gemini AI with live Google Search grounding. Describe your symptoms and I'll help assess urgency and guide your next steps. Remember: this tool does not replace professional medical advice.";
  appendMessage("assistant", greet);
}

// ─── Service Worker registration ───────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      .then(reg => console.info("[SW] Registered, scope:", reg.scope))
      .catch(err => console.warn("[SW] Registration failed:", err));
  });
}

// ─── Expose globals for test.html compatibility ────────────────────────────────
// Tests run as non-module scripts and expect these on window.
window.state                  = state;
window.parseTriageResponse    = parseTriageResponse;
window.escapeAttr             = escapeAttr;
window.sanitizeText           = sanitizeText;
window.validateInput          = validateInput;
window.isRateLimited          = isRateLimited;
window.validateBeforeSend     = validateBeforeSend;
window.captureAndClearInput   = captureAndClearInput;
window.hasEmergencyKeywords   = hasEmergencyKeywords;
window.checkUrgencyEscalation = (u) => checkUrgencyEscalation(u, chatMessages, scrollToBottom);
window.makeSourcesSection     = makeSourcesSection;
window.updateCharCounter      = updateCharCounter;
window.getLang                = getLang;
window.sendMessage            = sendMessage;
window.announce               = announce;
window.trapFocus              = trapFocus;

// Also expose constants needed by tests
window.MAX_INPUT_LENGTH  = MAX_INPUT_LENGTH;
window.MAX_HISTORY_TURNS = MAX_HISTORY_TURNS;
window.RATE_LIMIT_MAX    = RATE_LIMIT_MAX;
window.URGENCY_LEVELS    = URGENCY_LEVELS;

// Expose DOM refs for tests
window.chatMessages = chatMessages;
window.chatInput    = chatInput;
window.charCounter  = charCounter;
window.sendBtn      = sendBtn;

// ─── Init ──────────────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  initTheme();
  initGoogleAuth();
  initVoiceInput();
  syncOnlineStatus();
  appendGreeting();
}
