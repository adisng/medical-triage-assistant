/**
 * calendar.js — Google Calendar integration (OAuth 2.0)
 * Medical Triage Assistant
 *
 * Google Services:
 *  - Google Identity Services — OAuth 2.0 token flow (in-memory only)
 *  - Google Calendar API — Appointment booking with 3-slot picker
 *
 * Security:
 *  - OAuth token stored in-memory only (never localStorage)
 *  - Auto-cleared after 1 hour
 */

"use strict";

import { state } from "../utils/state.js";
import { announce } from "../utils/helpers.js";
import { calendarStatus } from "../ui/chat.js";

/**
 * Loads the Google Identity Services library asynchronously.
 */
export function initGoogleAuth() {
  const script = document.createElement("script");
  script.src   = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

/**
 * Obtains a Google Calendar OAuth token (prompts if needed).
 * Token is stored in-memory only and auto-cleared after 1 hour.
 * @param {Function} callback - Called after token is obtained
 */
function getCalendarToken(callback) {
  if (state.calendarToken) { callback(); return; }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CALENDAR_CLIENT_ID,
    scope:     CONFIG.GOOGLE_API_SCOPES,
    callback:  (tokenResponse) => {
      if (tokenResponse.access_token) {
        state.calendarToken = tokenResponse.access_token;
        setTimeout(() => { state.calendarToken = null; }, 3600 * 1000);
        callback();
      } else {
        setCalendarText("error", "Authorization failed. Please try again.");
      }
    },
  });
  client.requestAccessToken();
}

/**
 * Books a 30-minute Google Calendar event with email + popup reminders.
 * @param {string} title     - Event title
 * @param {Date}   startDate - Start time
 */
export async function bookCalendarEvent(title, startDate) {
  getCalendarToken(async () => {
    const start = startDate || (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d; })();
    const end   = new Date(start);
    end.setMinutes(end.getMinutes() + 30);
    const tz    = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const event = {
      summary:     title || "Doctor appointment",
      description: "Booked via Medical Triage Assistant (Gemini AI)",
      start: { dateTime: start.toISOString(), timeZone: tz },
      end:   { dateTime: end.toISOString(),   timeZone: tz },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 60  },
          { method: "email", minutes: 120 },
        ],
      },
    };
    try {
      setCalendarText("loading", "⏳ Booking appointment…");
      const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${state.calendarToken}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify(event),
      });
      if (res.status === 401) {
        state.calendarToken = null;
        setCalendarText("error", "Session expired. Please click Book again to re-authorize.");
        return;
      }
      if (!res.ok) throw new Error(`Calendar API error ${res.status}`);
      const data = await res.json();
      calendarStatus.className = "calendar-status status-success";
      calendarStatus.innerHTML = "";
      calendarStatus.appendChild(document.createTextNode("✅ Appointment booked! "));
      if (data.htmlLink) {
        const link = document.createElement("a");
        link.href         = data.htmlLink;
        link.target       = "_blank";
        link.rel          = "noopener noreferrer";
        link.textContent  = "View in Calendar →";
        link.setAttribute("aria-label", "View appointment in Google Calendar (opens in new tab)");
        calendarStatus.appendChild(link);
      }
      announce("Appointment booked successfully.");
    } catch (err) {
      setCalendarText("error", "Could not book appointment. Please try again.");
      console.error("[Calendar]", err);
    }
  });
}

/**
 * Renders a 3-slot appointment time picker in the calendar panel.
 * @param {string} title - Suggested appointment title from triage
 */
export function showCalendarSlotPicker(title) {
  calendarStatus.innerHTML = "";
  const label = document.createElement("p");
  label.className   = "slot-label";
  label.textContent = "Choose an appointment slot:";
  calendarStatus.appendChild(label);
  const slots  = [1, 2, 3].map(days => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(10, 0, 0, 0);
    return d;
  });
  const labels = ["Tomorrow 10am", "In 2 days 10am", "In 3 days 10am"];
  const group  = document.createElement("div");
  group.className = "slot-group";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Available appointment slots");
  slots.forEach((date, i) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-outline slot-btn";
    btn.textContent = labels[i];
    btn.setAttribute("aria-label", `Book appointment for ${labels[i]}`);
    btn.addEventListener("click", () => bookCalendarEvent(title, date));
    group.appendChild(btn);
  });
  calendarStatus.appendChild(group);
}

/**
 * Updates the side-panel calendar section based on triage result.
 * @param {object} parsed - Normalised triage result
 */
export function updateSidePanel(parsed) {
  if (parsed.recommendAppointment) {
    calendarStatus.innerHTML = "";
    calendarStatus.appendChild(document.createTextNode("A doctor visit is recommended. "));
    const btn = document.createElement("button");
    btn.className   = "btn btn-green";
    btn.style.marginTop = "8px";
    btn.textContent = "📅 Book in Google Calendar";
    btn.addEventListener("click", () => showCalendarSlotPicker(parsed.suggestedAppointmentTitle));
    calendarStatus.appendChild(btn);
  }
}

/**
 * Sets calendar status text with a type class.
 * @param {"loading"|"error"|"success"} type
 * @param {string} message
 */
function setCalendarText(type, message) {
  calendarStatus.className  = `calendar-status status-${type}`;
  calendarStatus.textContent = message;
}
