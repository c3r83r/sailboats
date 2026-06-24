export const environment = {
  production: false,
  // Explicit URL for local development against the simulation-service on port 8083.
  simulationWsUrl: 'ws://localhost:8083/ws/simulation',
  // REST base for auth-service in local development.
  apiBaseUrl: 'http://localhost:8084',
};
