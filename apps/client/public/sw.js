// This is a retirement worker for historical Ash Atlas PWA installations.
// The current client does not register a service worker.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(async (name) => {
      try {
        await caches.delete(name);
      } catch {
        // One inaccessible cache must not prevent worker retirement.
      }
    }));
    await self.registration.unregister();
    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });
    await Promise.allSettled(windows.map((client) => client.navigate(client.url)));
  })());
});
