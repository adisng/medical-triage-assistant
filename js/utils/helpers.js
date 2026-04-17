/**
 * helpers.js — General-purpose utility functions
 * Medical Triage Assistant
 */

"use strict";

/**
 * Returns a debounced version of `fn` that fires after `ms` milliseconds
 * of inactivity. Prevents layout thrashing on high-frequency events.
 * @param {Function} fn
 * @param {number}   ms
 * @returns {Function}
 */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Promise-based sleep.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Screen-reader announcements ───────────────────────────────────────────────
let _announceTimeout;
let _announceEl;

/**
 * Creates a polite live-region announcement for screen readers.
 * De-duplicates by removing any previous announcement first.
 * @param {string} msg
 */
export function announce(msg) {
  clearTimeout(_announceTimeout);
  _announceEl?.remove();
  _announceEl = document.createElement("div");
  _announceEl.setAttribute("aria-live", "polite");
  _announceEl.className = "sr-only";
  _announceEl.textContent = msg;
  document.body.appendChild(_announceEl);
  _announceTimeout = setTimeout(() => { _announceEl?.remove(); _announceEl = null; }, 3000);
}

/**
 * Creates an assertive live-region announcement for urgent screen reader alerts.
 * @param {string} msg
 */
export function announceAssertive(msg) {
  const el = document.createElement("div");
  el.setAttribute("aria-live", "assertive");
  el.setAttribute("role", "alert");
  el.className = "sr-only";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
