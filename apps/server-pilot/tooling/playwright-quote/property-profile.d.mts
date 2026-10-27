export declare const PROFILE_SALES_STRATEGY_CODES: readonly [
  'BAR',
  'PROMO',
  'PRESET',
  'WS',
  'NC',
  'GOV',
  'AIR',
  'DOML',
  'OTHER',
];

export declare const BOOK_NATIVE_FIELDS: readonly ['marketsegment', 'guestoptin4'];

export type ProfileBoardBase = 'room_only' | 'breakfast' | 'dinner_bed_breakfast';
export type ProfileRateScope = 'public' | 'government' | 'contextual' | 'unknown';
export type ProfileStrategyScope = 'agency' | 'company' | 'public';

export type PropertyProfile = {
  propertyCode: string;
  publishedRooms: number;
  building: string;
  roomCapacity: Record<string, number>;
  requiredCreateFields: string[];
  salesStrategies?: Array<{ value: string; display: string }>;
  rooms?: Record<string, { label: string; aliases?: string[] }>;
  ratePlans?: Record<string, {
    label: string;
    board: string;
    contract?: boolean;
    government?: boolean;
    event?: boolean;
  }>;
  rates?: {
    public?: string[];
    publicStrategies?: string[];
    government?: { codes?: string[]; labelPattern?: string };
    strategies?: Record<string, { plans: string[]; scope: ProfileStrategyScope }>;
  };
  boards?: Record<string, ProfileBoardBase> | string[];
  letter?: { hotel: string; confirmation: string };
  cancellation?: { noticeHours: number };
  createForm?: {
    requiredMarkers?: Record<string, { required?: boolean }>;
    options?: Record<string, {
      choices?: Array<{ value: string; display: string; marketSegment?: string }>;
    }>;
  };
  digest: string;
  classifyRate: (
    code: string,
    strategy?: string | null,
    isNegotiatedRate?: boolean,
    label?: string,
  ) => ProfileRateScope;
};

export declare function getProfileRates(propertyCode: string): NonNullable<PropertyProfile['rates']>;
export declare function getProfileBoards(propertyCode: string): Record<string, ProfileBoardBase>;
export declare function getProfileLetter(propertyCode: string): { hotel: RegExp; confirmation: RegExp };
export declare function getProfileCancellation(propertyCode: string): { noticeHours: number };

export declare function validateProfile(raw: unknown, propertyCode: string): PropertyProfile;
export declare function profileFor(propertyCode: string): PropertyProfile | null;
export type BookFieldProfile = {
  createForm?: PropertyProfile['createForm'];
};

export declare function requiredBookNativeFields(profile: BookFieldProfile | null | undefined): string[];
export declare function marketSegmentOptions(profile: BookFieldProfile | null | undefined): string[] | null;
export declare function stayBookFieldRefusal(
  stay: { marketSegment?: string; guestoptin4?: boolean } | null | undefined,
  profile: BookFieldProfile | null | undefined,
): string | null;
export declare function amendRoomTypes(propertyCode: string): string[];
export declare function parseStayProperty(argv: string[]):
  | { ok: true; propertyCode: string; rest: string[] }
  | { ok: false; exitCode: number; error: string };
export declare function propertySecretRefusal(
  secret: { expectedPropertyCode?: string } | null | undefined,
  propertyCode: string,
): string | null;
