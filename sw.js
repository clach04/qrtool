/* =============================================================================
 * sw.js — service worker for Scan & Create
 *
 * Strategy: precache the whole app shell on install, then serve everything
 * cache-first. The app is a single offline page with no runtime network calls,
 * so a plain cache-first shell is enough — no runtime request routing needed.
 *
 * Bump APP_VERSION whenever any precached file changes, otherwise clients keep
 * the stale shell forever.
 * ========================================================================== */
'use strict';

var APP_VERSION = 'qrtool-v1';
var SHELL_CACHE = APP_VERSION + '-shell';

/* Every path is relative to this worker's scope, so "./" resolves correctly
 * whether the app is served from a domain root or a subdirectory. */
var SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-maskable.svg',
  './vendor/jsQR.js',
  './vendor/qrcode.js',
  './vendor/JsBarcode.all.min.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (cache) { return cache.addAll(SHELL_FILES); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          if (key !== SHELL_CACHE) return caches.delete(key);
          return null;
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only handle same-origin GETs; never intercept anything else.
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        // Cache successful same-origin responses as they are discovered.
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // Offline and not cached: fall back to the shell so navigation still
        // renders something rather than a network error page.
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});