type DemoSession = {
  user: {
    id: string;
    email: string;
    name: string;
    image?: string | null;
  };
  session: {
    id: string;
    userId: string;
    token: string;
    expiresAt: string;
  };
};

/**
 * Temporary demo-mode shim for Task 1.
 * Demo mode only activates when ZERO_DEMO_MODE is exactly "1".
 */
const getDemoModeValue = (): string | undefined => {
  const viteMode = (import.meta as unknown as { env?: { ZERO_DEMO_MODE?: string } }).env
    ?.ZERO_DEMO_MODE;
  if (viteMode) return viteMode;

  if (typeof process !== 'undefined') {
    return process.env.ZERO_DEMO_MODE;
  }

  return undefined;
};

export const isDemoMode = (): boolean => getDemoModeValue() === '1';

export const getDemoUser = () => ({
  id: 'demo-user',
  email: 'centurion@legacyhotels.com',
  name: 'The Centurion',
});

export const getDemoSession = (): DemoSession => {
  const demoUser = getDemoUser();
  return {
    user: {
      ...demoUser,
      image: null,
    },
    session: {
      id: 'demo-session',
      userId: demoUser.id,
      token: 'demo-session-token',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
    },
  };
};
