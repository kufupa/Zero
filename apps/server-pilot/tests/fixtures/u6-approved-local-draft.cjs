let transportCalls = 0;

const route = {
  routeId: 'u6-configured-draft-route',
  purpose: 'draft',
  protocol: 'in_process',
  access: 'current_app',
  egress: 'none',
  retention: 'bounded',
  usage: 'reported',
  modelId: 'u6-configured-draft-model',
};

module.exports = {
  createApprovedLocalDraftRoute() {
    return {
      route,
      async transport() {
        transportCalls += 1;
        return {
          output: {
            replyText:
              'We will confirm this shortly. [MISSING: reservation status | how: approved reservation read]',
          },
          usage: { inputTokens: 7, outputTokens: 9, latencyMs: 1 },
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
