# Medical Triage Assistant

> An AI-powered symptom triage tool that helps users assess urgency, get actionable guidance backed by live Google Search sources, book doctor appointments via Google Calendar, and find nearby clinics via Google Maps — with a full-screen Emergency Mode for critical situations.

**⚠ Disclaimer:** This tool provides general health guidance only and does not replace professional medical advice. In an emergency, call 112 / 911 immediately.

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/your-username/medical-triage-assistant

# 2. Set up API keys
cp config.js.template config.js
# Edit config.js and fill in GEMINI_API_KEY, GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_MAPS_API_KEY

# 3a. Run locally (Python static server)
python3 -m http.server 8080
# Open http://localhost:8080

# 3b. Run with Docker
docker build -t triage . && docker run -p 8080:8080 -v $(pwd)/config.js:/usr/share/nginx/html/config.js triage

# 4. Run tests
# Open http://localhost:8080/test.html
# All 55 unit + integration tests render in the browser with pass/fail status
```

---

## Chosen Vertical

**Health** — Medical triage and patient guidance.

---

## Problem Statement

1 in 3 people delay seeking medical care because they don't know if their symptoms are serious enough. Medical triage is typically gated behind a phone call or clinic visit. This tool brings intelligent, grounded triage to anyone with a smartphone — in seconds.

---

## Architecture

```
User Input (typed / voice 🎤 / quick-select tags / language selector)
        │
        ▼
  validateBeforeSend()  ──  offline check, rate limit (localStorage), input validation
        │
        ▼
  hasEmergencyKeywords()  ──  client-side pre-AI emergency keyword detection
        │
        ▼
  callGeminiWithRetry()  ←── Multi-turn history (capped at 10 turns)
    Gemini Flash-Lite API  +  Google Search Grounding
    (AbortController cancels stale requests)
        │
        ▼
  parseTriageResponse()  ──  JSON validation + safe defaults
        │
        ├── handleUrgencyEscalation()  ──  worsening detection + Emergency Mode trigger
        │
        ├── renderTriageResult()  ──  urgency badge, advice, steps, warnings, source chips
        │
        ├── updateSidebarAndMap()  ──  Calendar panel / Google Maps Embed
        │
        └── recordInHistory()  ──  session history + sidebar

Emergency Mode (if urgency = "emergency" OR keyword match):
        └── activateEmergencyMode()
              ├── Full-screen dark-red overlay (role="alertdialog")
              ├── Pulsing 🚨 icon + urgency label
              ├── [📞 Call Emergency (112)] — tel: link
              ├── [📍 Find Nearby Hospitals] — triggers Maps
              └── [Dismiss] — requires double-tap confirmation
```

---

## Google Services

| Service | How it's used |
|---|---|
| **Gemini Flash-Lite** | Core AI triage engine — structured JSON triage output, safety filters, multi-turn context |
| **Gemini Search Grounding** | Backs AI responses with live Google Search; citation chips rendered in UI (with tooltip showing full URL; "+" expand for >3 sources) |
| **Google Calendar API** | OAuth 2.0 appointment booking with 3-slot time picker, email + popup reminders |
| **Google Maps Embed API** | Geolocation-aware clinic finder with skeleton loader and graceful fallback |
| **Google Identity Services** | OAuth 2.0 token flow for Calendar — in-memory only, auto-cleared after 1 hour |

---

## Key Features

### 🚨 Emergency Mode
Full-screen takeover activated when urgency = "emergency" OR when the user's message contains emergency keyword combinations (e.g. "chest pain + sweating", "difficulty breathing", "unconscious"). Features a pulsing 🚨 icon, bold urgency messaging, a one-tap emergency call button (tel:112), a hospital map trigger, and a double-confirm dismiss to prevent accidents.

### Gemini Search Grounding
Responses are backed by live Google Search. Citation chips appear below each triage card, linking to the sources Gemini used. Source chips show a tooltip with the full URL, and a "+ N more" button expands additional sources.

**Note:** `responseMimeType: "application/json"` is intentionally omitted when `tools: [{ googleSearch: {} }]` is active — these are mutually exclusive in the Gemini API. Structured JSON is parsed from the text response using `parseTriageResponse()`.

### Symptom Worsening Detection
The app tracks urgency across conversation turns. If symptoms escalate (e.g. Low → High), a prominent warning banner is shown.

### Voice Input
Tap the 🎤 button to speak your symptoms using the Web Speech API. Language is set dynamically from `navigator.language`. Zero dependencies added.

### Service Worker (PWA)
Stale-while-revalidate caching for static assets; network-only for API calls. Enables offline fallback. App is installable as a PWA.

### Language Selector
Language preference (English / Español) stored in localStorage. Affects Maps language parameter and greeting message.

### Calendar Slot Picker
Users choose from 3 suggested time slots. Each books a 30-minute Google Calendar event with email + popup reminders.

### localStorage Rate Limiting
Rate limit (5 requests / 60s) persists across page refreshes — using localStorage timestamps instead of in-memory only. Clear chat button also resets the rate limit store.

### Retry Button
When a Gemini API call fails, an inline "↩ Retry" button appears in the error bubble. Clicking it re-runs the last request without the user needing to retype.

### AbortController
Any in-flight Gemini request is cancelled when a new message is sent, preventing race conditions and stale responses.

---

## Security & Privacy

- **XSS prevention**: All user/AI text rendered via `textContent`, never raw `innerHTML`
- **Attribute injection**: `escapeAttr()` used for every HTML attribute built from data
- **CSP**: `Content-Security-Policy` meta tag restricts scripts, styles, connections, frames
- **Input validation**: rejects empty, oversized (>1000 chars), and injection-pattern inputs
- **Rate limiting**: max 5 requests per 60 seconds (localStorage-persisted)
- **OAuth token**: stored in-memory only — never `localStorage` — auto-cleared after 1 hour
- **API keys**: stored in `config.js`, excluded via `.gitignore`; `config.js.template` provided
- **Nginx headers**: `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `HSTS`, `Permissions-Policy`
- **Gemini safety filters**: `BLOCK_MEDIUM_AND_ABOVE` for harassment, hate speech, dangerous content
- **Production note**: In production, proxy Gemini and Calendar calls through a serverless backend (Firebase Functions or similar) so API keys are never exposed to the client.

---

## Accessibility Statement (WCAG 2.1 AA)

- Semantic HTML5 landmarks: `<header>`, `<main>`, `<aside>`, `<section>`, `<dialog>`
- All interactive elements have `aria-label` or `aria-labelledby`
- Skip-to-content link for keyboard users
- `role="log"` on chat container (correct ARIA role for chat streams)
- `role="alertdialog"` + `aria-modal="true"` on Emergency Mode overlay
- `aria-live="polite"` on chat log and calendar status
- `aria-live="assertive"` on offline banner and emergency announcements
- `role="alert"` on emergency note and error messages
- `aria-pressed` on symptom toggle buttons and voice button
- `aria-expanded` on history modal trigger
- `aria-busy` on send button during loading
- Character counter with `aria-live` for screen reader updates
- Focus trap inside modal dialog and Emergency Mode overlay
- Voice input with spoken announcements via `announce()`
- Keyboard navigation: Enter to send, Escape to close modal
- Visible `:focus-visible` focus rings throughout
- High-contrast mode via `@media (forced-colors: active)`
- `prefers-reduced-motion` respected — all animations disabled when requested

---

## Testing

55 tests across unit + integration coverage in `tests.js`, rendered in `test.html`:

| Area | Tests |
|---|---|
| `parseTriageResponse` | Valid JSON, markdown fences, fallback, urgency clamping, missing arrays |
| `escapeAttr` | Single/double quotes, `<>`, `&`, empty, null, undefined, numeric coercion |
| `sanitizeText` | `<script>`, `<img onerror>`, normal text, empty, null, emoji |
| `validateInput` | Empty, whitespace, too long, invalid chars, valid, edge cases |
| `isRateLimited` (localStorage) | Under limit, at limit, expired, mixed expired+fresh |
| `validateBeforeSend` | Offline, rate-limited, empty, valid |
| `captureAndClearInput` | Returns trimmed value, clears input field |
| `hasEmergencyKeywords` | Positive matches, negative cases, single-keyword no-match |
| `checkUrgencyEscalation` | Low→Medium, Medium→High, improvement, null previous |
| `makeSourcesSection` | 3 visible chips, "+ N more" button, tooltip with URL |
| Language preference | localStorage get/set, default fallback |
| `conversationHistory` | Trimmed to MAX_HISTORY_TURNS × 2 |
| `updateCharCounter` | Correct count, counter-warn, counter-over |
| **Integration** | Full triage flow with mock fetch — asserts DOM update with mock summary |

---

## Code Quality

- `"use strict"` enforced throughout
- Full JSDoc on every exported/key function
- Named constants for all magic values
- Zero `innerHTML` from untrusted data — all DOM via `createElement` / `textContent`
- `sendMessage()` refactored into 8 single-responsibility steps (each independently testable)
- `debounce()` on `scrollToBottom` to avoid layout thrashing
- `AbortController` cancels stale in-flight requests
- `announce()` deduplication prevents stacking SR live-region elements
- History list uses O(1) prepend strategy

---

## File Structure

```
├── index.html            — Semantic HTML5 UI: chat, symptom selector, calendar, map, modal, lang selector
├── app.js                — Core logic: Gemini, Grounding, Calendar, Maps, voice, emergency mode
├── style.css             — Design system: tokens, responsive layout, emergency mode, accessibility
├── sw.js                 — Service Worker: stale-while-revalidate caching, offline fallback
├── manifest.json         — PWA manifest
├── config.js             — API keys (gitignored — never committed)
├── config.js.template    — Template for setup (safe to commit)
├── tests.js              — 55 unit + integration tests
├── test.html             — Browser-based test runner
├── Dockerfile            — nginx:alpine container with health check
├── nginx.conf            — Gzip, caching, SW-safe headers, security headers
├── .gitignore            — Excludes config.js and OS/editor artifacts
└── README.md             — This file
```

---

## Assumptions

- User has a modern browser (Chrome/Edge/Firefox/Safari 2022+)
- Web Speech API for voice input (Chrome/Edge; graceful fallback otherwise)
- Google OAuth consent screen configured for the project
- `config.js` provided at runtime and not committed to version control
- App runs over HTTPS or `localhost` (OAuth and Service Worker requirement)
