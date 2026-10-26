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

export type PropertyProfile = {
  propertyCode: string;
  publishedRooms: number;
  building: string;
  roomCapacity: Record<string, number>;
  requiredCreateFields: string[];
  salesStrategies?: Array<{ value: string; display: string }>;
  rooms?: Record<string, { label: string }>;
  ratePlans?: Record<string, {
    label: string;
    board: string;
    contract?: boolean;
    government?: boolean;
    event?: boolean;
  }>;
  digest: string;
};

export declare function validateProfile(raw: unknown, propertyCode: string): PropertyProfile;
export declare function profileFor(propertyCode: string): PropertyProfile | null;
export declare function amendRoomTypes(propertyCode: string): string[];
export declare function parseStayProperty(argv: string[]):
  | { ok: true; propertyCode: string; rest: string[] }
  | { ok: false; exitCode: number; error: string };
export declare function propertySecretRefusal(
  secret: { expectedPropertyCode?: string } | null | undefined,
  propertyCode: string,
): string | null;
