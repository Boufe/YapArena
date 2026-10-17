// /sw.js is registered only as a service worker, so self has its specialized scope.
// The installed public shell supplies OFFLINE for navigation failures.
/* global self, caches */
const CACHE = "yaparena-public-shell-v1";
const OFFLINE = "/assets/offline.html";

(self as WorkerGlobalScope as ServiceWorkerGlobalScope).addEventListener(
  "install",
  (event) => {
    event.waitUntil(
      caches
        .open(CACHE)
        .then((cache) => cache.addAll([OFFLINE, "/assets/site.css"])),
    );
    (self as WorkerGlobalScope as ServiceWorkerGlobalScope).skipWaiting();
  },
);

(self as WorkerGlobalScope as ServiceWorkerGlobalScope).addEventListener(
  "activate",
  (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) =>
                  key.startsWith("yaparena-public-shell-") && key !== CACHE,
              )
              .map((key) => caches.delete(key)),
          ),
        ),
    );
    (self as WorkerGlobalScope as ServiceWorkerGlobalScope).clients.claim();
  },
);

(self as WorkerGlobalScope as ServiceWorkerGlobalScope).addEventListener(
  "fetch",
  (event) => {
    if (event.request.mode !== "navigate") return;
    event.respondWith(
      fetch(event.request).catch(
        () => caches.match(OFFLINE) as Promise<Response>,
      ),
    );
  },
);
