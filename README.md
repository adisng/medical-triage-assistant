# Medical Triage Assistant

An AI-powered medical triage assistant that helps users assess symptom urgency, get actionable guidance, book doctor appointments via Google Calendar, and find nearby clinics using Google Maps.

> **Disclaimer:** This tool is for informational purposes only and does not replace professional medical advice.

---

## Chosen Vertical

**Health** — Medical triage and patient guidance.

---

## What It Does

1. User describes symptoms (typed or via quick-select buttons)
2. Gemini AI analyzes severity and returns a structured triage response
3. Response includes urgency level (Low / Medium / High / Emergency), advice, next steps, and warning signs
4. For medium/high urgency: user can book a Google Calendar appointment in one click
5. For high/emergency: Google Maps loads nearby clinics automatically

---

## Google Services Used

| Service | How it's used |
|---|---|
| **Gemini 2.0 Flash** | Symptom analysis, urgency scoring, structured triage advice |
| **Google Calendar API** | One-click appointment booking with OAuth 2.0 |
| **Google Maps Embed API** | Shows nearby clinics based on user geolocation |
| **Google Identity Services** | OAuth 2.0 token flow for Calendar access |

---

## Architecture

```
User Input (symptoms)
       ↓
  Frontend UI (index.html + app.js)
       ↓
  Gemini API (triage + urgency JSON)
       ↓
  ┌────────────────────────────────┐
  │  Urgency badge + advice panel  │
  │  Google Calendar booking       │
  │  Google Maps clinic finder     │
  └────────────────────────────────┘
```

---

## How to Run

### 1. Get API keys

- **Gemini API key** → [Google AI Studio](https://aistudio.google.com/app/apikey)
- **Google OAuth Client ID** → [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application). Add your domain/localhost to Authorized JS origins.
- **Google Maps Embed API key** → Same Cloud Console → Enable Maps Embed API

### 2. Configure

Copy `config.js` and fill in your keys (this file is in `.gitignore` and must never be committed):

```js
const CONFIG = {
  GEMINI_API_KEY: "your_key_here",
  GOOGLE_CALENDAR_CLIENT_ID: "your_client_id.apps.googleusercontent.com",
  GOOGLE_MAPS_API_KEY: "your_maps_key_here",
  GOOGLE_API_SCOPES: "https://www.googleapis.com/auth/calendar.events",
};
```

> **Security note:** `config.js` is intentionally excluded from this repository via `.gitignore`. Never commit API keys to version control.

### 3. Run locally

Serve with any static server. With Python:
```bash
python3 -m http.server 8080
```
Then open `http://localhost:8080`.

### 4. Run tests

Open browser console on `localhost:8080` and run:
```js
// Paste contents of tests.js into the browser console
// or add a temporary <script src="tests.js"></script> to index.html
```
All 11 unit tests cover `parseTriageResponse`, `escapeAttr`, and `sanitizeText`.

---

## Security

- API keys stored in `config.js`, excluded from version control via `.gitignore`
- All Gemini response text sanitized via `sanitizeText()` before DOM insertion to prevent XSS
- User input validated and capped at 1000 characters before API calls
- OAuth token stored in memory only (not localStorage) for session duration

---

## Approach & Logic

### Triage logic
Gemini is prompted with a structured system instruction that defines 4 urgency levels and enforces a JSON response format. Temperature is set to 0.3 for consistent, conservative outputs. The system prompt explicitly instructs the model to avoid diagnosis and always recommend professional consultation.

### Decision-making
- **Low urgency** → advice only
- **Medium urgency** → advice + calendar booking offer
- **High / Emergency** → advice + calendar + automatic Maps panel + emergency note

### Conversation context
Full conversation history is sent with every Gemini call so users can follow up ("what if I also have a fever?") naturally.

---

## Assumptions

- User has a modern browser with geolocation support
- Google OAuth consent screen is configured for the project
- The app runs over HTTPS or localhost (OAuth requirement)
- This is a demo / proof-of-concept — production use would require a backend to protect API keys

---

## File Structure

```
├── index.html    — UI: chat, symptom selector, calendar status, map
├── app.js        — Logic: Gemini, Calendar API, Maps
├── style.css     — Styles: responsive, accessible
├── config.js     — API keys (gitignored)
├── .gitignore
└── README.md
```
