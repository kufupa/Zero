const route = {
  routeId: 'u2-configured-extraction-route',
  purpose: 'extraction',
  protocol: 'in_process',
  access: 'current_app',
  egress: 'none',
  retention: 'bounded',
  usage: 'reported',
  modelId: 'u2-configured-extraction-model',
};
let transportCalls = 0;

module.exports = {
  getTransportCalls() {
    return transportCalls;
  },
  resetTransportCalls() {
    transportCalls = 0;
  },
  createMailBaselineExtractionRoute() {
    return {
      route,
      transport: async (request) => {
        transportCalls += 1;
        const input = JSON.parse(request.userPrompt);
        return {
          output:
            input.direction === 'outbound'
              ? {
                  asks: [],
                  answers: [
                    {
                      askCode: 'reservation',
                      answerState: 'supported',
                      workState: 'complete',
                      substantive: true,
                    },
                  ],
                }
              : {
                  asks: [
                    {
                      askCode: 'reservation',
                      requiresHotelResponse: true,
                      requiresCustomerInformation: false,
                      noReplyRequired: false,
                      workState: 'open',
                    },
                  ],
                  answers: [],
                },
          usage: { inputTokens: 13, outputTokens: 9, latencyMs: 4 },
        };
      },
    };
  },
};
