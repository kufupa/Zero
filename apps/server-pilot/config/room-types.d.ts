export declare const ROOM_TYPE_NAMES: {
  readonly STWN: string;
  readonly STQN: string;
  readonly SKNG: string;
  readonly EXKNG: string;
  readonly DLXTWN: string;
  readonly DLXQN: string;
  readonly DLXKNG: string;
  readonly LUXKNG: string;
  readonly SUITE: string;
};

export type RoomTypeCode = keyof typeof ROOM_TYPE_NAMES;

export declare const ROOM_WORD_ALIASES: Readonly<Record<string, readonly RoomTypeCode[]>>;

export declare const ROOM_ABBREVIATIONS: Readonly<Record<string, string>>;
