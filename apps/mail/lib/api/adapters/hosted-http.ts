import type { FrontendApi } from '../contract';
import { UnsupportedFeatureError } from '../errors';

export function createHostedHttpAdapter(): FrontendApi {
  const capabilities = { mode: 'hosted' as const };

  const reject =
    (feature: string) =>
    async (..._args: unknown[]) => {
      throw new UnsupportedFeatureError(feature, 'hosted');
    };

  return new Proxy({} as FrontendApi, {
    get(_target, prop: string | symbol) {
      if (prop === 'capabilities') {
        return capabilities;
      }
      if (typeof prop !== 'string') {
        return undefined;
      }
      return new Proxy(
        {},
        {
          get(_inner, method: string | symbol) {
            if (typeof method !== 'string') {
              return undefined;
            }
            return reject(`${prop}.${method}`);
          },
        },
      );
    },
  });
}
