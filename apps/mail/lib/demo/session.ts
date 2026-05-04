export type DemoSession = {
  session: {
    id: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    token: string;
    userId: string;
  };
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    phoneNumber: string | null;
    phoneNumberVerified: boolean;
  };
};

const nowIso = new Date().toISOString();
const expiresIso = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();

const DEMO_SESSION: DemoSession = {
  session: {
    id: 'demo-session',
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt: expiresIso,
    token: 'demo-token',
    userId: 'demo-user',
  },
  user: {
    id: 'demo-user',
    name: 'Centurion Ops',
    email: 'centurion@legacyhotels.co.za',
    image: null,
    phoneNumber: null,
    phoneNumberVerified: true,
  },
};

export function getDemoSession(): DemoSession {
  return DEMO_SESSION;
}
