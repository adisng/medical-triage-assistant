// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  conversationHistory: [],
  calendarToken: null,
  selectedSymptoms: new Set(),
  isLoading: false,
};

// ─── DOM refs ────────────────────────────────────────────────────────────────
const chatMessages    = document.getElementById("chat-messages");
const chatInput       = document.getElementById("chat-input");
const sendBtn         = document.getElementById("send-btn");
const calendarStatus  = document.getElementById("calendar-status");
const mapContainer    = document.getElementById("map-container");
const themeToggle     = document.getElementById("theme-toggle");
const clearChatBtn    = document.getElementById("clear-chat-btn");

// ─── Symptom quick-select ─────────────────────────────────────────────────────
document.querySelectorAll(".symptom-tag").forEach((tag) => {
  tag.addEventListener("click", () => {
    const symptom = tag.dataset.symptom;
    tag.classList.toggle("selected");
    if (state.selectedSymptoms.has(symptom)) {
      state.selectedSymptoms.delete(symptom);
    } else {
      state.selectedSymptoms.add(symptom);
    }
  });
});

document.getElementById("use-selected-btn").addEventListener("click", () => {
  if (state.selectedSymptoms.size === 0) return;
  const list = [...state.selectedSymptoms].join(", ");
  chatInput.value = `I'm experiencing: ${list}`;
  chatInput.focus();
});

// ─── Send message ─────────────────────────────────────────────────────────────
async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || state.isLoading) return;
  if (text.length > 1000) {
    appendMessage("assistant", "Please keep your message under 1000 characters for best results.");
    return;
  }

  chatInput.value = "";
  appendMessage("user", text);
  state.conversationHistory.push({ role: "user", parts: [{ text }] });

  setLoading(true);
  try {
    const result = await callGemini(state.conversationHistory);
    const parsed = parseTriageResponse(result);
    appendTriageMessage(parsed);
    state.conversationHistory.push({ role: "model", parts: [{ text: result }] });

    if (parsed.urgency === "high" || parsed.urgency === "emergency") {
      showNearbyClinicMap();
    }
  } catch (err) {
    appendMessage("assistant", "Sorry, something went wrong. Please try again.");
    console.error(err);
  } finally {
    setLoading(false);
  }
}

sendBtn.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ─── Gemini API ───────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a medical triage assistant. Your role is to assess symptom severity and guide users to appropriate care — you do NOT diagnose or prescribe.

Always respond in this EXACT JSON format (no markdown, no extra text):
{
  "urgency": "low|medium|high|emergency",
  "summary": "One sentence summary of the situation",
  "advice": "2-4 sentences of general guidance",
  "nextSteps": ["step 1", "step 2", "step 3"],
  "warningsigns": ["sign to watch for 1", "sign to watch for 2"],
  "recommendAppointment": true|false,
  "suggestedAppointmentTitle": "e.g. GP appointment - headache follow-up",
  "emergencyNote": "Only filled if emergency, e.g. Call 112 immediately"
}

Urgency guide:
- low: self-care at home (cold, minor cuts, mild headache)
- medium: see a doctor within 1-3 days
- high: see a doctor today / urgent care
- emergency: call emergency services immediately

Always remind users this is not a substitute for professional medical advice.`;

async function callGemini(history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: history,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || "Gemini API error");
  }

  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

// ─── Parse Gemini JSON response ───────────────────────────────────────────────
function parseTriageResponse(raw) {
  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return {
      urgency: "medium",
      summary: raw.substring(0, 100),
      advice: raw,
      nextSteps: [],
      warningsigns: [],
      recommendAppointment: false,
      suggestedAppointmentTitle: "",
      emergencyNote: "",
    };
  }
}

// ─── Render triage response ───────────────────────────────────────────────────
function appendTriageMessage(parsed) {
  const urgencyLabels = { low: "Low urgency", medium: "Medium urgency", high: "High urgency", emergency: "Emergency" };
  const urgencyIcons  = { low: "●", medium: "●", high: "●", emergency: "▲" };

  let html = `
    <span class="urgency-badge urgency-${parsed.urgency}">
      ${urgencyIcons[parsed.urgency] || "●"} ${urgencyLabels[parsed.urgency] || parsed.urgency}
    </span>`;

  if (parsed.emergencyNote) {
    html += `<div class="emergency-note">⚠ ${sanitizeText(parsed.emergencyNote)}</div>`;
  }

  if (parsed.summary) {
    html += `<div class="triage-section"><p>${sanitizeText(parsed.summary)}</p></div>`;
  }

  if (parsed.advice) {
    html += `<div class="triage-section"><h4>Advice</h4><p>${sanitizeText(parsed.advice)}</p></div>`;
  }

  if (parsed.nextSteps?.length) {
    html += `<div class="triage-section"><h4>Next steps</h4><ul>`;
    parsed.nextSteps.forEach((s) => { html += `<li>${sanitizeText(s)}</li>`; });
    html += `</ul></div>`;
  }

  if (parsed.warningsigns?.length) {
    html += `<div class="triage-section"><h4>Watch out for</h4><ul>`;
    parsed.warningsigns.forEach((s) => { html += `<li>${sanitizeText(s)}</li>`; });
    html += `</ul></div>`;
  }

  html += `<p style="font-size:12px;color:#718096;margin-top:10px;">This is not medical advice. Always consult a qualified healthcare professional.</p>`;

  if (parsed.recommendAppointment) {
    html += `<div class="action-buttons">
      <button class="btn btn-green" onclick="bookCalendarEvent('${escapeAttr(parsed.suggestedAppointmentTitle)}')">
        📅 Book appointment in Google Calendar
      </button>
      <button class="btn btn-outline" onclick="showNearbyClinicMap()">
        📍 Find nearby clinics
      </button>
    </div>`;
  }

  appendMessage("assistant", html, true);
}

function escapeAttr(str) {
  return (str || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

// Sanitize text before inserting into innerHTML to prevent XSS
function sanitizeText(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ─── Chat UI helpers ──────────────────────────────────────────────────────────
function appendMessage(role, content, isHTML = false) {
  const div = document.createElement("div");
  div.className = `message ${role}`;

  const initials = role === "user" ? "You" : "AI";
  const avatarDiv = `<div class="avatar">${initials}</div>`;
  const bubbleDiv = document.createElement("div");
  bubbleDiv.className = "bubble";
  if (isHTML) bubbleDiv.innerHTML = content;
  else bubbleDiv.textContent = content;

  if (role === "user") {
    div.innerHTML = avatarDiv;
    div.appendChild(bubbleDiv);
  } else {
    div.innerHTML = avatarDiv;
    div.insertBefore(bubbleDiv, div.firstChild);
    div.appendChild(div.querySelector(".avatar"));
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "message assistant";
  div.id = "typing-indicator";
  div.innerHTML = `
    <div class="avatar">AI</div>
    <div class="bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeTyping() {
  document.getElementById("typing-indicator")?.remove();
}

function setLoading(val) {
  state.isLoading = val;
  sendBtn.disabled = val;
  chatInput.disabled = val;
  if (val) showTyping();
  else removeTyping();
}

// ─── Google Calendar ──────────────────────────────────────────────────────────
function initGoogleAuth() {
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  document.head.appendChild(script);
}

function getCalendarToken(callback) {
  if (state.calendarToken) { callback(); return; }

  const client = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CALENDAR_CLIENT_ID,
    scope: CONFIG.GOOGLE_API_SCOPES,
    callback: (tokenResponse) => {
      if (tokenResponse.access_token) {
        state.calendarToken = tokenResponse.access_token;
        callback();
      } else {
        updateCalendarStatus("error", "Authorization failed. Please try again.");
      }
    },
  });
  client.requestAccessToken();
}

async function bookCalendarEvent(title) {
  getCalendarToken(async () => {
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(10, 0, 0, 0);
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + 30);

    const event = {
      summary: title || "Doctor appointment",
      description: "Booked via Medical Triage Assistant",
      start: { dateTime: start.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      end:   { dateTime: end.toISOString(),   timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
    };

    try {
      updateCalendarStatus("loading", "Booking appointment...");
      const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.calendarToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
      });

      if (!res.ok) throw new Error("Calendar API error");
      const data = await res.json();
      updateCalendarStatus("success", `Appointment booked for tomorrow at 10:00 AM. <a href="${data.htmlLink}" target="_blank" style="color:inherit;text-decoration:underline">View in Calendar</a>`);
    } catch (err) {
      updateCalendarStatus("error", "Could not book appointment. Please try again.");
      console.error(err);
    }
  });
}

function updateCalendarStatus(type, message) {
  calendarStatus.className = `calendar-status ${type === "success" ? "success" : type === "error" ? "error" : ""}`;
  calendarStatus.innerHTML = message;
}

// ─── Google Maps ──────────────────────────────────────────────────────────────
function showNearbyClinicMap() {
  mapContainer.innerHTML = "";
  if (!navigator.geolocation) {
    mapContainer.textContent = "Geolocation not available.";
    return;
  }

  mapContainer.textContent = "Finding your location...";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      const src = `https://www.google.com/maps/embed/v1/search?key=${CONFIG.GOOGLE_MAPS_API_KEY}&q=clinic+hospital+doctor+near+me&center=${lat},${lng}&zoom=13`;
      const iframe = document.createElement("iframe");
      iframe.src = src;
      iframe.width = "100%";
      iframe.height = "100%";
      iframe.style.border = "none";
      iframe.allow = "geolocation";
      iframe.title = "Nearby clinics map";
      mapContainer.innerHTML = "";
      mapContainer.appendChild(iframe);
    },
    () => {
      const src = `https://www.google.com/maps/embed/v1/search?key=${CONFIG.GOOGLE_MAPS_API_KEY}&q=nearby+clinic+hospital`;
      mapContainer.innerHTML = `<iframe src="${src}" width="100%" height="100%" style="border:none" title="Clinics map" allow="geolocation"></iframe>`;
    }
  );
}

// ─── Usability & Core Features ────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "dark" ? "☀️" : "🌓";
}

themeToggle.addEventListener("click", () => {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const newTheme = isDark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", newTheme);
  localStorage.setItem("theme", newTheme);
  themeToggle.textContent = newTheme === "dark" ? "☀️" : "🌓";
});

chatInput.addEventListener("input", function() {
  this.style.height = "auto";
  const newHeight = this.scrollHeight;
  this.style.height = newHeight + "px";
  this.style.overflowY = newHeight > 140 ? "auto" : "hidden";
});

clearChatBtn.addEventListener("click", () => {
  state.conversationHistory = [];
  chatMessages.innerHTML = '';
  chatInput.style.height = "auto";
  appendGreeting();
});

function appendGreeting() {
  appendMessage(
    "assistant",
    "Hello! I'm your medical triage assistant. Describe your symptoms and I'll help assess how urgent they are and what to do next. Remember: this does not replace professional medical advice.",
    false
  );
}

// ─── Init ─────────────────────────────────────────────────────────────────────
initTheme();
initGoogleAuth();
appendGreeting();

