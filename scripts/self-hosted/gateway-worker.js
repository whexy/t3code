/* global GATEWAY_UPSTREAMS, toGatewayUrl */
// Service worker that sends every request for an allowlisted backend through
// the gateway on this origin, including ones the app makes without fetch, such
// as images, video and event streams. gateway.ts serves it after the constants
// above.

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const target = toGatewayUrl(event.request.url, self.location.href, GATEWAY_UPSTREAMS);
  if (target !== null) event.respondWith(forward(event.request, target));
});

async function forward(request, target) {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await fetch(target, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    // The app calls backends without credentials, but the access proxy in
    // front of this origin admits only requests that carry its cookie.
    credentials: "same-origin",
    signal: request.signal,
  });
  // A new Response keeps response.url at the backend URL the app asked for.
  // Firefox gives bodiless statuses such as an upload's 204 an empty body
  // stream, which the Response constructor rejects for those statuses.
  const bodiless = response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(bodiless ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
