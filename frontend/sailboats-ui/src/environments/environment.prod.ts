export const environment = {
  production: true,
  // Empty => derive the WebSocket URL from the page origin at runtime
  // (wss://<host>/ws/simulation behind TLS). Keeps the build domain-agnostic.
  simulationWsUrl: '',
};
