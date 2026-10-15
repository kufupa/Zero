/** Echo predicted ops. No LLM. No cloud. */
export default {
  id: 'echo-predicted',
  async callApi(_prompt, context) {
    const predicted = context?.vars?.predicted;
    if (predicted && typeof predicted === 'object' && 'predicted' in predicted) {
      return { output: predicted.predicted };
    }
    return { output: predicted };
  },
};
