/**
 * maps.js — Google Maps Embed integration with geolocation
 * Medical Triage Assistant
 *
 * Google Services:
 *  - Google Maps Embed API — Geolocation-aware clinic finder
 *
 * Features:
 *  - Skeleton loading state while geolocation resolves
 *  - Graceful fallback if geolocation is denied/unavailable
 *  - Language-aware map queries
 */

"use strict";

import { mapContainer } from "../ui/chat.js";

/**
 * Returns the currently stored language preference.
 * @returns {string}
 */
function getLang() {
  try {
    return localStorage.getItem("mta-lang-v1") || "en";
  } catch {
    return "en";
  }
}

/**
 * Shows a map of nearby clinics/hospitals using Google Maps Embed API.
 * Attempts geolocation first; falls back to a keyword search.
 */
export function showNearbyClinicMap() {
  // Show skeleton loader while geolocation resolves
  mapContainer.innerHTML = "";
  const skeleton = document.createElement("div");
  skeleton.className = "map-skeleton";
  skeleton.setAttribute("aria-label", "Loading map…");
  skeleton.setAttribute("role", "status");
  skeleton.innerHTML = `<div class="map-skeleton-pulse"></div><p class="map-placeholder">📍 Finding your location…</p>`;
  mapContainer.appendChild(skeleton);

  if (!navigator.geolocation) {
    loadMapWithQuery("nearby clinic hospital urgent care");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords: { latitude: lat, longitude: lng } }) => {
      const lang = getLang();
      const src  = `https://www.google.com/maps/embed/v1/search?key=${CONFIG.GOOGLE_MAPS_API_KEY}&q=clinic+hospital+urgent+care&center=${lat},${lng}&zoom=13&language=${lang}`;
      renderMapIframe(src);
    },
    () => loadMapWithQuery("nearby clinic hospital urgent care"),
    { timeout: 8000 }
  );
}

/**
 * Loads the map using a text query (fallback when geolocation fails).
 * @param {string} query
 */
function loadMapWithQuery(query) {
  const lang = getLang();
  const src  = `https://www.google.com/maps/embed/v1/search?key=${CONFIG.GOOGLE_MAPS_API_KEY}&q=${encodeURIComponent(query)}&language=${lang}`;
  renderMapIframe(src);
}

/**
 * Renders a Google Maps Embed iframe in the map container.
 * @param {string} src - Full iframe URL
 */
function renderMapIframe(src) {
  mapContainer.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.src    = src;
  iframe.width  = "100%";
  iframe.height = "100%";
  iframe.style.border = "none";
  iframe.allow  = "geolocation";
  iframe.title  = "Map of nearby clinics and hospitals";
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("aria-label", "Nearby clinics and hospitals map");
  mapContainer.appendChild(iframe);
}
