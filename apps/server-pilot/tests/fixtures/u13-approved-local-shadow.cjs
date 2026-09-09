let transportCalls = 0;

const route = {
  routeId: 'u13-configured-shadow-route',
  purpose: 'shadow',
  protocol: 'in_process',
  access: 'current_app',
  egress: 'none',
  retention: 'bounded',
  usage: 'reported',
  modelId: 'u13-configured-shadow-model',
};

module.exports = {
  createShadowModelRoute() {
    return {
      route,
      async transport() {
        transportCalls += 1;
        return {
          output: {
            outcome: 'partial',
            asks: ['reservation_status'],
            facts: { reservationRef: 'U13-1234' },
            limitations: ['private shadow fixture'],
          },
          usage: { inputTokens: 12, outputTokens: 8, latencyMs: 2 },
        };
      },
    };
  },
  getTransportCalls() {
    return transportCalls;
  },
  resetTransportCalls() {
    transportCalls = 0;
  },
};
