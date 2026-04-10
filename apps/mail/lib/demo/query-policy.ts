import { isFrontendOnlyDemo } from './runtime';

export type DemoQueryPolicy = {
  shouldHydratePersistedQueries: boolean;
  shouldInvalidateHydratedThreadQueries: boolean;
};

type ResolveDemoQueryPolicyInput = {
  frontendOnlyDemo?: boolean;
};

export function shouldHydratePersistedQueries(frontendOnlyDemo = isFrontendOnlyDemo()): boolean {
  return !frontendOnlyDemo;
}

export function shouldInvalidateHydratedThreadQueries(
  frontendOnlyDemo = isFrontendOnlyDemo(),
): boolean {
  return !frontendOnlyDemo;
}

export function resolveDemoQueryPolicy(
  input: ResolveDemoQueryPolicyInput = {},
): DemoQueryPolicy {
  const frontendOnlyDemo = input.frontendOnlyDemo ?? isFrontendOnlyDemo();
  return {
    shouldHydratePersistedQueries: shouldHydratePersistedQueries(frontendOnlyDemo),
    shouldInvalidateHydratedThreadQueries:
      shouldInvalidateHydratedThreadQueries(frontendOnlyDemo),
  };
}
