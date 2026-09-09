const probeKey = '__u2InitializationBoundaryProbe';

function state() {
  if (!globalThis[probeKey]) {
    globalThis[probeKey] = {
      imports: 0,
      factoryCalls: 0,
      clientInitializations: 0,
      transportCalls: 0,
    };
  }
  return globalThis[probeKey];
}

state().imports += 1;

const route = {
  routeId: 'u2-initialization-probe-route',
  purpose: 'extraction',
  protocol: 'in_process',
  access: 'current_app',
  egress: 'none',
  retention: 'bounded',
  usage: 'reported',
  modelId: 'u2-initialization-probe-model',
};

module.exports = {
  createMailBaselineExtractionRoute() {
    state().factoryCalls += 1;
    state().clientInitializations += 1;
    return {
      route,
      transport: async () => {
        state().transportCalls += 1;
        return {
          output: {},
          usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
        };
      },
    };
  },
};
