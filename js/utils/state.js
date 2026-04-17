/**
 * state.js — Centralised application state
 * Medical Triage Assistant
 */

"use strict";

/**
 * Single source of truth for all mutable runtime state.
 * Kept in one place so every module reads/writes the same object.
 */
export const state = {
  conversationHistory: [],
  triageHistory:       [],
  calendarToken:       null,
  selectedSymptoms:    new Set(),
  isLoading:           false,
  lastUrgency:         null,
  currentAbortCtrl:    null,     // AbortController for in-flight Gemini request
  emergencyDismissed:  false,
  requestTimestamps:   [],       // kept in sync with localStorage for test compat
};
