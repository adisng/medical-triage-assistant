/**
 * chat.js — Chat UI rendering, message bubbles, triage cards, and source chips
 * Medical Triage Assistant
 *
 * All DOM manipulation uses createElement + textContent (never raw innerHTML
 * from user data) to prevent XSS.
 */

"use strict";

import { MAX_INPUT_LENGTH } from "../utils/constants.js";
import { debounce } from "../utils/helpers.js";

// ─── Urgency display metadata ──────────────────────────────────────────────────
export const URGENCY_META = {
  low:       { label: "Low urgency",    icon: "🟢", cls: "urgency-low"       },
  medium:    { label: "Medium urgency", icon: "🟡", cls: "urgency-medium"    },
  high:      { label: "High urgency",   icon: "🔴", cls: "urgency-high"      },
  emergency: { label: "Emergency",      icon: "🚨", cls: "urgency-emergency" },
};

// ─── DOM element references (null-safe for test environment) ──────────────────
/** @param {string} id @returns {HTMLElement|null} */
const el = (id) => document.getElementById(id);

export const chatMessages   = el("chat-messages");
export const chatInput      = el("chat-input");
export const sendBtn        = el("send-btn");
export const calendarStatus = el("calendar-status");
export const mapContainer   = el("map-container");
export const themeToggle    = el("theme-toggle");
export const clearChatBtn   = el("clear-chat-btn");
export const charCounter    = el("char-counter");
export const historyBtn     = el("history-btn");
export const historyModal   = el("history-modal");
export const closeModalBtn  = el("close-modal-btn");
export const offlineBanner  = el("offline-banner");
export const historyList    = el("history-list");
export const historyPanel   = el("history-panel");
export const voiceBtn       = el("voice-btn");

// ─── Debounced scroll ──────────────────────────────────────────────────────────
export const scrollToBottom = debounce(() => {
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: prefersReduced ? "auto" : "smooth" });
}, 50);

// ─── Message rendering ────────────────────────────────────────────────────────
/**
 * Appends a simple text message bubble to the chat.
 * @param {"user"|"assistant"} role
 * @param {string}             content
 */
export function appendMessage(role, content) {
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

/**
 * Appends a pre-built bubble element to the chat as an assistant message.
 * @param {"user"|"assistant"} role
 * @param {HTMLElement}        bubbleEl
 */
export function appendBubble(role, bubbleEl) {
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
 * Shows an error message with an inline Retry button.
 * @param {string}   msg
 * @param {Function} retryCb - Callback invoked on retry click
 */
export function showErrorWithRetry(msg, retryCb) {
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
    retryCb();
  });
  bubble.appendChild(retryBtn);
  el.appendChild(bubble);
  chatMessages.appendChild(el);
  scrollToBottom();
}

/**
 * Shows a simple error message (no retry).
 * @param {string} msg
 */
export function showError(msg) {
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

/** Shows the typing indicator while AI is processing. */
export function showTyping() {
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

/** Removes the typing indicator from the chat. */
export function removeTyping() {
  document.getElementById("typing-indicator")?.remove();
}

/**
 * Sets the loading state — disables input and shows/hides typing indicator.
 * @param {boolean} val
 * @param {object}  appState - The shared state object
 */
export function setLoading(val, appState) {
  appState.isLoading = val;
  sendBtn.disabled    = val;
  chatInput.disabled  = val;
  sendBtn.setAttribute("aria-busy", val ? "true" : "false");
  if (val) showTyping(); else removeTyping();
}

// ─── Character counter ─────────────────────────────────────────────────────────
/**
 * Updates the character counter display below the input.
 * Toggles warn/over CSS classes near the limit.
 */
export function updateCharCounter() {
  const len = chatInput.value.length;
  charCounter.textContent = `${len} / ${MAX_INPUT_LENGTH}`;
  charCounter.classList.toggle("counter-warn", len > MAX_INPUT_LENGTH * 0.85);
  charCounter.classList.toggle("counter-over", len >= MAX_INPUT_LENGTH);
}

// ─── Triage card builder ───────────────────────────────────────────────────────
/**
 * Builds and appends a full triage result bubble to the chat.
 * @param {object}                 parsed  - Normalised triage object
 * @param {Array<{title,url}>}     sources - Grounding sources
 * @param {Function}               onBookCb - Callback for "Book appointment"
 * @param {Function}               onMapCb  - Callback for "Find clinics"
 */
export function appendTriageMessage(parsed, sources = [], onBookCb, onMapCb) {
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
      calBtn.addEventListener("click", () => onBookCb(parsed.suggestedAppointmentTitle));
      actions.appendChild(calBtn);
    }

    const mapBtnEl = document.createElement("button");
    mapBtnEl.className = "btn btn-outline";
    mapBtnEl.setAttribute("aria-label", "Find nearby clinics on map");
    mapBtnEl.textContent = "📍 Find nearby clinics";
    mapBtnEl.addEventListener("click", onMapCb);
    actions.appendChild(mapBtnEl);

    bubble.appendChild(actions);
  }

  appendBubble("assistant", bubble);
}

// ─── Section builders ──────────────────────────────────────────────────────────
/** @param {string|null} heading @param {string} bodyText @returns {HTMLElement} */
export function makeSection(heading, bodyText) {
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
export function makeListSection(heading, items) {
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
 * @returns {HTMLElement}
 */
export function makeSourcesSection(sources) {
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

// ─── Focus trap ────────────────────────────────────────────────────────────────
/**
 * Traps keyboard focus within an element (for modals and overlays).
 * @param {HTMLElement} element
 */
export function trapFocus(element) {
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
