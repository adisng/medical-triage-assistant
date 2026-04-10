/**
 * sw.js — Service Worker for Medical Triage Assistant
 *
 * Strategy:
 *  - Static assets: Cache-First (serve from cache, fallback to network, update in background)
 *  - Gemini/Google API calls: Network-First (never cache; always fresh)
 *
 * On install: pre-cache all static shell assets
 * On activate: delete old cache versions
 * On fetch: apply appropriate strategy per request type
 */

"use strict";

const CACHE_NAME   = "mta-cache-v3";
const STATIC_SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/style.css",
  "/test.html",
  "/tests.js",
  "/sw.js",
];

// External network origins that should never be cached
const NETWORK_ONLY_ORIGINS = [
  "generativelanguage.googleapis.com",
  "www.googleapis.com",
  "accounts.google.com",
  "apis.google.com",
];

// ─── Install ───────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.info("[SW] Pre-caching static shell");
      return cache.addAll(STATIC_SHELL);
    }).then(() => self.skipWaiting())
  );
});

// ─── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.info("[SW] Deleting old cache:", key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Always network for API calls and cross-origin resources
  if (NETWORK_ONLY_ORIGINS.some((origin) => url.hostname.includes(origin))) {
    event.respondWith(fetch(request));
    return;
  }

  // Only handle GET requests for caching
  if (request.method !== "GET") {
    event.respondWith(fetch(request));
    return;
  }

  // Cache-first with network fallback + background update (Stale-While-Revalidate)
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);

      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      // Return cache immediately if available; otherwise wait for network
      if (cached) {
        // Background update without blocking response
        networkFetch.catch(() => {});
        return cached;
      }

      const networkResponse = await networkFetch;
      if (networkResponse) return networkResponse;

      // Offline fallback for navigation requests
      if (request.mode === "navigate") {
        const fallback = await cache.match("/index.html");
        if (fallback) return fallback;
      }

      return new Response("Offline — content not available", {
        status:  503,
        headers: { "Content-Type": "text/plain" },
      });
    })
  );
});
