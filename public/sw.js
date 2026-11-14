// Minimal service worker: gör att sajten går att installera som app. Allt hämtas från nätet som vanligt,
// så att man alltid får senaste versionen; bara om nätet är nere visas ett kort meddelande.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response('<meta charset="utf-8"><body style="font-family:serif;padding:2rem;background:#e6dac0"><h1>Schack Online</h1><p>Ingen anslutning till servern just nu. Försök igen om en stund.</p></body>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
