/**
 * constants.js — Shared constants and configuration values
 * Medical Triage Assistant
 */

"use strict";

export const MAX_INPUT_LENGTH        = 1000;
export const MAX_HISTORY_TURNS       = 10;
export const RATE_LIMIT_MAX          = 5;
export const RATE_LIMIT_WINDOW       = 60000;
export const RATE_LIMIT_STORAGE_KEY  = "mta-rate-timestamps-v2";
export const THEME_STORAGE_KEY       = "mta-theme-v2";
export const LANG_STORAGE_KEY        = "mta-lang-v1";
export const GEMINI_MODEL            = "gemini-flash-lite-latest";
export const URGENCY_LEVELS          = ["low", "medium", "high", "emergency"];

/** Emergency keyword combinations that trigger emergency mode even pre-AI */
export const EMERGENCY_KEYWORD_SETS  = [
  ["chest pain", "sweat"],
  ["chest pain", "sweating"],
  ["difficulty breathing"],
  ["can't breathe"],
  ["unconscious"],
  ["not breathing"],
];
