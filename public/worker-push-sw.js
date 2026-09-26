/* NEØ worker alerts. No private guest, financial, or staff information is sent to a lock screen. */
self.addEventListener("push", (event) => {
  let notificationId = "";
  try {
    notificationId = String(event.data?.json()?.notificationId || "");
  } catch {
    // A malformed payload still opens the inbox rather than crashing the worker.
  }
  event.waitUntil(
    self.registration.showNotification("NEØ · New work alert", {
      body: "Open your work inbox to review the latest update.",
      icon: "/pwa-192x192.png",
      badge: "/favicon-32x32.png",
      tag: notificationId ? `neo-${notificationId}` : "neo-work-alert",
      data: { url: "/notifications" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data?.url || "/notifications", self.location.origin);
    if (url.origin !== self.location.origin) return;
    const clientsInScope = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clientsInScope.find((client) => new URL(client.url).origin === url.origin);
    if (existing) {
      await existing.navigate(url.href);
      return existing.focus();
    }
    return self.clients.openWindow(url.href);
  })());
});
