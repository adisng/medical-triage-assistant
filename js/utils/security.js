/**
 * security.js — Input validation and sanitisation utilities
 * Medical Triage Assistant
 *
 * XSS prevention:
 *  - escapeAttr() for HTML attribute injection
 *  - sanitizeText() for safe text rendering
 *  - validateInput() for input content checks
 */

"use strict";

import { MAX_INPUT_LENGTH } from "./constants.js";

/**
 * Escapes special characters for safe use inside HTML attributes.
 * @param {string|null|undefined} str
 * @returns {string}
 */
export function escapeAttr(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g,  "&amp;")
    .replace(/'/g,  "&#x27;")
    .replace(/"/g,  "&quot;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;");
}

/**
 * Sanitises a string for safe rendering as text content.
 * Uses the browser's own escaping via textContent → innerHTML.
 * @param {string|null|undefined} str
 * @returns {string}
 */
export function sanitizeText(str) {
  if (str == null) return "";
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

/**
 * Validates raw user input before submission.
 * @param {string} text
 * @returns {{valid: boolean, reason?: string, hint?: string}}
 */
export function validateInput(text) {
  if (!text || text.trim().length === 0) return { valid: false, reason: "empty" };
  if (text.length > MAX_INPUT_LENGTH)    return { valid: false, reason: "too_long" };
  if (/[<>{}]/.test(text))              return { valid: false, reason: "invalid_chars", hint: "Please avoid < > { } characters" };
  return { valid: true };
}
