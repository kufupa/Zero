export type ReservationSplitType = 'individual' | 'group' | 'travelAgents';

export type InboundReservationSplit = {
  type: ReservationSplitType;
  inboundEmails: number;
  averageChainSize: number;
  draftedEmails: number;
  bookedEmails: number;
  totalRevenue: number;
};

export type PerformanceProfile = {
  responseTimeMinutes: number[];
  draftCreationMinutes: number[];
};

export type EmailAddressSeriesItem = {
  hotelId: string;
  emailAddress: string;
  hotelName: string;
  inboxName: string;
  isCentralReservations?: boolean;
  sent: number;
  automated: number;
  approvals: number;
  qualityScore: number;
  performance: PerformanceProfile;
  reservationSplits: InboundReservationSplit[];
};

export type TimelinePoint = {
  period: string;
  drafted: number;
  approved: number;
  edited: number;
};

export type DashboardKpi = {
  label: string;
  value: number;
  trend: 'up' | 'down' | 'flat';
  deltaPct: number;
};

export type InboundReservationSplitAggregate = {
  type: ReservationSplitType;
  inboundEmails: number;
  averageChainSize: number;
  draftedPercent: number;
  bookedPercent: number;
  totalRevenue: number;
};

export type AdminDashboardData = {
  generatedAt: string;
  totals: DashboardKpi[];
  emails: EmailAddressSeriesItem[];
  trend: TimelinePoint[];
};
