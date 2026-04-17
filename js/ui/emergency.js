/**
 * emergency.js — Emergency mode detection and full-screen overlay UI
 * Medical Triage Assistant
 *
 * Features:
 *  - Pre-AI keyword-based emergency detection (client-side safety net)
 *  - Full-screen alertdialog overlay with pulsing icon
 *  - One-tap call to 112, hospital map trigger
 *  - Double-confirm dismiss to prevent accidental closure
 *  - Focus trap + assertive live-region announcement
 */

"use strict";

import { URGENCY_LEVELS, EMERGENCY_KEYWORD_SETS } from "../utils/constants.js";
import { state } from "../utils/state.js";
import { announceAssertive } from "../utils/helpers.js";

/**
 * Returns true if the message text matches any known emergency keyword set.
 * This is a pre-AI client-side safety net — AI urgency is the primary signal.
 * @param {string} text
 * @returns {boolean}
 */
export function hasEmergencyKeywords(text) {
  const lower = text.toLowerCase();
  return EMERGENCY_KEYWORD_SETS.some(set => set.every(kw => lower.includes(kw)));
}

/**
 * Checks if urgency has escalated compared to the last triage result.
 * Shows a warning banner if symptoms are worsening.
 * @param {string}      newUrgency
 * @param {HTMLElement}  chatMessages - Chat container to append warning to
 * @param {Function}     scrollToBottom - Scroll helper
 */
export function checkUrgencyEscalation(newUrgency, chatMessages, scrollToBottom) {
  const prev = state.lastUrgency;
  if (prev && URGENCY_LEVELS.indexOf(newUrgency) > URGENCY_LEVELS.indexOf(prev)) {
    showEscalationWarning(prev, newUrgency, chatMessages, scrollToBottom);
  }
  state.lastUrgency = newUrgency;
}

/**
 * Renders an escalation warning bubble in the chat.
 * @param {string}      from
 * @param {string}      to
 * @param {HTMLElement}  chatMessages
 * @param {Function}     scrollToBottom
 */
function showEscalationWarning(from, to, chatMessages, scrollToBottom) {
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

/**
 * Activates the full-screen Emergency Mode overlay.
 * @param {string}   summary       - 1–2 line AI summary (or pre-AI fallback)
 * @param {Function} showNearbyMap - Callback to trigger map display
 * @param {Function} trapFocusFn   - Focus trap utility
 */
export function activateEmergencyMode(summary, showNearbyMap, trapFocusFn) {
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
    showNearbyMap();
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
  trapFocusFn(overlay);
  callBtn.focus();
}

/** Removes the emergency mode overlay and resets the class. */
export function deactivateEmergencyMode() {
  document.getElementById("emergency-overlay")?.remove();
  document.documentElement.classList.remove("emergency-mode");
  state.emergencyDismissed = true;
}
