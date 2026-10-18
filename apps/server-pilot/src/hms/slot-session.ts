export type SlotSessionPhase = 'ready' | 'recovering' | 'down';

export type SlotOwner = {
  login: () => Promise<void>;
  wipeProfile: () => Promise<void>;
};

/** In-flight slot work that must not succeed after recover/reset. */
export class SlotSessionClosedError extends Error {
  readonly payload = undefined;

  constructor(message = 'slot session closed during read') {
    super(message);
    this.name = 'SlotSessionClosedError';
  }
}

export type SlotSession = {
  readonly phase: SlotSessionPhase;
  recover: () => Promise<void>;
  reset: () => Promise<void>;
  withRead: <T>(run: () => Promise<T>) => Promise<T>;
};

export function createSlotSession(input: { owner: SlotOwner }): SlotSession {
  let phase: SlotSessionPhase = 'down';
  let generation = 0;

  const session: SlotSession = {
    get phase() {
      return phase;
    },
    async recover() {
      phase = 'recovering';
      generation += 1;
      const started = generation;
      try {
        await input.owner.login();
      } catch (error) {
        if (generation === started) phase = 'down';
        throw error;
      }
      if (generation !== started) return;
      phase = 'ready';
    },
    async reset() {
      phase = 'recovering';
      generation += 1;
      try {
        await input.owner.wipeProfile();
      } catch (error) {
        phase = 'down';
        throw error;
      }
      await session.recover();
    },
    async withRead(run) {
      if (phase !== 'ready') throw new SlotSessionClosedError();
      const started = generation;
      const result = await run();
      if (generation !== started || phase !== 'ready') throw new SlotSessionClosedError();
      return result;
    },
  };
  return session;
}
