/* global GATEWAY_UPSTREAMS, GATEWAY_WORKER_PATH, toGatewayUrl */
// Runs in the app shell before the app's own scripts. gateway.ts inlines it
// after the constants above.
//
// Service workers never see WebSockets, so this shim sends the app's sockets
// to the gateway itself. The app looks up the global constructor each time it
// connects.
const NativeWebSocket = window.WebSocket;
window.WebSocket = class GatewayWebSocket extends NativeWebSocket {
  constructor(url, protocols) {
    super(toGatewayUrl(String(url), location.href, GATEWAY_UPSTREAMS) ?? url, protocols);
  }
};

if ("serviceWorker" in navigator) {
  const reloadKey = "t3code:gateway-reload";
  navigator.serviceWorker
    .register(GATEWAY_WORKER_PATH, { scope: "/" })
    .catch((error) => console.error("T3 Code gateway: service worker registration failed.", error));
  if (navigator.serviceWorker.controller !== null) {
    sessionStorage.removeItem(reloadKey);
  } else {
    // A first visit or a hard reload leaves this page outside the worker, so
    // its backend requests would go straight to the tailnet. A normal reload
    // puts it under the active worker. The key stops a loop where the browser
    // never lets the worker control pages.
    void navigator.serviceWorker.ready.then(() => {
      if (sessionStorage.getItem(reloadKey) !== null) return;
      sessionStorage.setItem(reloadKey, "1");
      location.reload();
    });
  }
}
