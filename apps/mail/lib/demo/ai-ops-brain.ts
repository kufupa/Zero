import type { CenturionMailCategory } from '@/types';

export type AiOpsBrainWorkflowKey = CenturionMailCategory | 'urgent';

export type AiOpsBrainWorkflowNode = {
  id: string;
  label: string;
  detail: string;
  status: 'live' | 'review' | 'learned';
};

export type AiOpsBrainWorkflow = {
  id: string;
  key: AiOpsBrainWorkflowKey;
  title: string;
  categoryLabel: string;
  owner: string;
  confidence: number;
  automationRate: number;
  reviewLoad: string;
  impact: string;
  plan: string;
  humanReason: string;
  learnedEdit: string;
  nextAction: string;
  apiIntegrations: string[];
  sources: string[];
  nodes: AiOpsBrainWorkflowNode[];
};

export type AiOpsBrainGraphCategory = CenturionMailCategory | 'spam';
export type AiOpsBrainNodeKind =
  | 'trigger'
  | 'extract'
  | 'classifier'
  | 'api'
  | 'rule'
  | 'task'
  | 'approval'
  | 'draft'
  | 'learn'
  | 'safety';
export type AiOpsBrainNodeStatus = 'live' | 'suggested' | 'weak-signal' | 'risk' | 'muted';
export type AiOpsBrainEdgeStatus = 'live' | 'suggested' | 'weakSignal' | 'blocked' | 'riskAlert';

export type AiOpsBrainGraphLane = {
  category: AiOpsBrainGraphCategory;
  title: string;
  subtitle: string;
  color: string;
  bg: string;
  y: number;
};

export type AiOpsBrainGraphNode = {
  id: string;
  kind: AiOpsBrainNodeKind;
  category: AiOpsBrainGraphCategory | 'core';
  label: string;
  shortReason: string;
  status: AiOpsBrainNodeStatus;
  position: { x: number; y: number };
  badges: string[];
  confidence: number;
  hotelScope: string;
  focus?: 'hero' | 'context';
  input: string[];
  reason: string[];
  output: string[];
  sources: string[];
  apiConfig?: {
    title: string;
    recommended: string;
    fallback: string;
    fields: string[];
    usedFor: string[];
  };
};

export type AiOpsBrainGraphEdge = {
  id: string;
  source: string;
  target: string;
  status: AiOpsBrainEdgeStatus;
  label?: string;
};

export type AiOpsBrainGraphOverlay = {
  id: 'urgent' | 'needs-approval' | 'api-required' | 'risk-alert' | 'learning-signal';
  label: string;
  detail: string;
};

export type AiOpsBrainEvidenceKind = 'email' | 'draft' | 'edit' | 'weak-signal' | 'promotion' | 'internal-alert';

export type AiOpsBrainEvidenceEvent = {
  id: string;
  kind: AiOpsBrainEvidenceKind;
  hotel: string;
  actor: string;
  action: string;
  timestamp: string;
  signalStrength?: 'weak' | 'medium' | 'strong';
  relatedNodeIds: string[];
  detail: string;
};

export type AiOpsBrainRiskAlert = {
  id: string;
  title: string;
  severity: 'medium' | 'high';
  sourceCategory: AiOpsBrainGraphCategory;
  affectedCategory: AiOpsBrainGraphCategory;
  affectedNodeIds: string[];
  detail: string;
  recommendedAction: string;
};

export type AiOpsBrainGraph = {
  id: string;
  hotel: string;
  title: string;
  focusPathId: string;
  lanes: AiOpsBrainGraphLane[];
  overlays: AiOpsBrainGraphOverlay[];
  nodes: AiOpsBrainGraphNode[];
  edges: AiOpsBrainGraphEdge[];
  evidence: AiOpsBrainEvidenceEvent[];
  riskAlerts: AiOpsBrainRiskAlert[];
};

export const AI_OPS_BRAIN_WORKFLOWS: Record<AiOpsBrainWorkflowKey, AiOpsBrainWorkflow> = {
  individual: {
    id: 'individual-booking',
    key: 'individual',
    title: 'Individual booking request',
    categoryLabel: 'Individual Room Bookings',
    owner: 'Reservations',
    confidence: 94,
    automationRate: 78,
    reviewLoad: '12 approvals/day',
    impact: 'Replies under 4 min for direct guest enquiries',
    plan: 'Confirm room availability, preserve flexible rate rules, draft a warm direct-booking reply, and hold the room if the guest asks for confirmation.',
    humanReason: 'Approval only when rate wording changes, loyalty status is unclear, or guest asks for exception handling.',
    learnedEdit: 'Tone edit saved: shorter greeting, quote B&B before policy notes, keep cancellation line last.',
    nextAction: 'Send draft after human confirms direct rate and breakfast inclusion.',
    apiIntegrations: ['Outlook inbox', 'PMS availability', 'Rate table', 'Guest profile'],
    sources: [
      'Previous Centurion direct booking replies',
      'Rate card: Standard Queen B&B',
      'Cancellation policy: 24-hour direct bookings',
      'Guest profile and stay history',
    ],
    nodes: [
      {
        id: 'trigger',
        label: 'New direct guest email',
        detail: 'Detects room dates, guests, breakfast, and urgency.',
        status: 'live',
      },
      {
        id: 'availability',
        label: 'Check PMS availability',
        detail: 'Reads open room types and flags overbooking risk.',
        status: 'live',
      },
      {
        id: 'draft',
        label: 'Draft guest reply',
        detail: 'Uses Centurion tone examples and direct-booking policy.',
        status: 'learned',
      },
      {
        id: 'approval',
        label: 'Human approval',
        detail: 'Only required for rate exceptions or ambiguous dates.',
        status: 'review',
      },
    ],
  },
  group: {
    id: 'group-quote-builder',
    key: 'group',
    title: 'Group quote builder',
    categoryLabel: 'Group Bookings',
    owner: 'Events + Reservations',
    confidence: 88,
    automationRate: 61,
    reviewLoad: '7 approvals/day',
    impact: 'Cuts first group quote from 28 min to 3 min',
    plan: 'Extract room block, dates, meal basis, event context, and release window, then build a provisional quote with revenue impact and approval checkpoints.',
    humanReason: 'Human review stays on because group rates affect inventory, VAT wording, and event upsell timing.',
    learnedEdit: 'Workflow change detected: add 48-hour release clause before total price on overflow requests.',
    nextAction: 'Approve provisional 20-room quote and add banquet upsell note.',
    apiIntegrations: ['Outlook inbox', 'PMS inventory', 'Group rate sheet', 'Banqueting calendar'],
    sources: [
      'Kleinkaap overflow room request',
      'Historical group quote format',
      'April room inventory snapshot',
      'Finance VAT and release-clause policy',
    ],
    nodes: [
      {
        id: 'trigger',
        label: 'Group request arrives',
        detail: 'Identifies room count, dates, meal basis, and event type.',
        status: 'live',
      },
      {
        id: 'rate',
        label: 'Price room block',
        detail: 'Calculates subtotal, VAT, and provisional total.',
        status: 'live',
      },
      {
        id: 'policy',
        label: 'Apply release clause',
        detail: 'Adds 48-hour hold and subject-to-availability language.',
        status: 'learned',
      },
      {
        id: 'approval',
        label: 'Manager review',
        detail: 'Required when room block exceeds 10 rooms.',
        status: 'review',
      },
    ],
  },
  'travel-agents': {
    id: 'travel-agent-rate-check',
    key: 'travel-agents',
    title: 'Travel agent rate check',
    categoryLabel: 'Travel Agents',
    owner: 'Sales Desk',
    confidence: 91,
    automationRate: 73,
    reviewLoad: '5 approvals/day',
    impact: 'Keeps partner replies consistent across agent channels',
    plan: 'Match agency identity, verify negotiated rate, check allocation, and draft a reply that protects partner terms without exposing internal margin.',
    humanReason: 'Escalates when the agent asks for override pricing or missing voucher details.',
    learnedEdit: 'Brand rule saved: never mention margin, always ask for IATA or voucher number before confirmation.',
    nextAction: 'Request voucher number and hold negotiated rate pending partner verification.',
    apiIntegrations: ['Outlook inbox', 'CRM account lookup', 'Agency contract table', 'PMS allocation'],
    sources: [
      'Agency contract terms',
      'Partner profile in CRM',
      'Allocation by room class',
      'Prior travel-agent confirmations',
    ],
    nodes: [
      {
        id: 'identify',
        label: 'Identify agency',
        detail: 'Matches sender domain and account owner.',
        status: 'live',
      },
      {
        id: 'contract',
        label: 'Check contract rate',
        detail: 'Finds negotiated rate and voucher requirements.',
        status: 'live',
      },
      {
        id: 'draft',
        label: 'Draft partner reply',
        detail: 'Protects rate terms and asks for missing fields.',
        status: 'learned',
      },
      {
        id: 'handoff',
        label: 'Sales exception',
        detail: 'Routes override requests to Sales Desk.',
        status: 'review',
      },
    ],
  },
  internal: {
    id: 'internal-ops-router',
    key: 'internal',
    title: 'Internal ops router',
    categoryLabel: 'Internal Mail',
    owner: 'Hotel Ops',
    confidence: 86,
    automationRate: 69,
    reviewLoad: '4 approvals/day',
    impact: 'Routes operational noise before it hits reservations',
    plan: 'Classify staff requests, attach policy context, draft concise internal answers, and route HR or maintenance exceptions to the correct owner.',
    humanReason: 'Review required when staff policy, payroll, or maintenance liability is mentioned.',
    learnedEdit: 'Routing edge case added: HR roster questions go to Duty Manager before Reservations sees them.',
    nextAction: 'Route staff policy question to Duty Manager with source policy attached.',
    apiIntegrations: ['Outlook inbox', 'Staff directory', 'Policy docs', 'Task board'],
    sources: [
      'Staff directory',
      'Reservation desk SOP',
      'Internal policy snippets',
      'Recent duty-manager replies',
    ],
    nodes: [
      {
        id: 'classify',
        label: 'Classify staff request',
        detail: 'Separates HR, maintenance, and reservations ops.',
        status: 'live',
      },
      {
        id: 'policy',
        label: 'Attach policy source',
        detail: 'Finds SOP paragraph before drafting.',
        status: 'live',
      },
      {
        id: 'route',
        label: 'Route to owner',
        detail: 'Creates task when email should not stay in inbox.',
        status: 'learned',
      },
      {
        id: 'approve',
        label: 'Sensitive approval',
        detail: 'Requires manager sign-off for HR language.',
        status: 'review',
      },
    ],
  },
  urgent: {
    id: 'urgent-guest-recovery',
    key: 'urgent',
    title: 'Urgent guest recovery',
    categoryLabel: 'Urgent',
    owner: 'Duty Manager',
    confidence: 82,
    automationRate: 44,
    reviewLoad: 'Always review',
    impact: 'Stops urgent threads from waiting behind normal bookings',
    plan: 'Detect guest impact, summarize risk, pull stay context, draft apology or resolution options, and keep the Duty Manager in the loop.',
    humanReason: 'Always human-in-loop because guest recovery changes trust, refunds, and operational commitments.',
    learnedEdit: 'Escalation rule added: service failure plus same-day stay pages Duty Manager instantly.',
    nextAction: 'Approve resolution option, then send apology and create follow-up task.',
    apiIntegrations: ['Outlook inbox', 'Guest stay record', 'Duty manager pager', 'Task board'],
    sources: [
      'Latest guest complaint',
      'Stay record and booking channel',
      'Service recovery policy',
      'Duty Manager escalation notes',
    ],
    nodes: [
      {
        id: 'detect',
        label: 'Detect guest impact',
        detail: 'Flags same-day stays, complaint language, and revenue risk.',
        status: 'live',
      },
      {
        id: 'options',
        label: 'Generate resolution options',
        detail: 'Suggests apology, comp, or manager callback.',
        status: 'review',
      },
      {
        id: 'notify',
        label: 'Notify Duty Manager',
        detail: 'Pages owner before draft is sent.',
        status: 'live',
      },
      {
        id: 'learn',
        label: 'Learn recovery rule',
        detail: 'Converts approved resolution into future playbook.',
        status: 'learned',
      },
    ],
  },
};

const AI_OPS_BRAIN_GRAPH: AiOpsBrainGraph = {
  id: 'centurion-ai-ops-brain',
  hotel: 'The Centurion',
  title: 'The Centurion AI Ops Brain',
  focusPathId: 'volleyball-group-booking',
  lanes: [
    {
      category: 'internal',
      title: 'Internal Ops',
      subtitle: 'Handovers, maintenance, VIP readiness',
      color: '#60A5FA',
      bg: 'rgba(37, 99, 235, 0.12)',
      y: 120,
    },
    {
      category: 'individual',
      title: 'Individual Booking',
      subtitle: 'Direct, government, invoice requests',
      color: '#34D399',
      bg: 'rgba(22, 163, 74, 0.12)',
      y: 310,
    },
    {
      category: 'group',
      title: 'Group Booking',
      subtitle: 'Room blocks, events, team logistics',
      color: '#FB923C',
      bg: 'rgba(249, 115, 22, 0.14)',
      y: 500,
    },
    {
      category: 'travel-agents',
      title: 'Travel Agents',
      subtitle: 'Agency rates, transfers, partner terms',
      color: '#A78BFA',
      bg: 'rgba(124, 58, 237, 0.13)',
      y: 690,
    },
    {
      category: 'spam',
      title: 'Spam / Safety',
      subtitle: 'Vendor spam and unsafe requests',
      color: '#F43F5E',
      bg: 'rgba(244, 63, 94, 0.1)',
      y: 880,
    },
  ],
  overlays: [
    {
      id: 'urgent',
      label: 'Urgent',
      detail: 'Time-sensitive work floats above category lanes.',
    },
    {
      id: 'needs-approval',
      label: 'Approval',
      detail: 'Human sign-off for money, exceptions, or risk.',
    },
    {
      id: 'api-required',
      label: 'API',
      detail: 'Workflow depends on PMS, calendar, CRM, or task source.',
    },
    {
      id: 'risk-alert',
      label: 'Risk',
      detail: 'Internal ops updates can block or warn guest drafts.',
    },
    {
      id: 'learning-signal',
      label: 'Learning',
      detail: 'Skipped edits still strengthen suggested branches.',
    },
  ],
  nodes: [
    {
      id: 'email-received',
      kind: 'trigger',
      category: 'core',
      label: 'Email received',
      shortReason: 'new mail -> parse',
      status: 'live',
      position: { x: 0, y: 500 },
      badges: ['Outlook'],
      confidence: 99,
      hotelScope: 'The Centurion',
      focus: 'context',
      input: ['Centurion inbox mail from Outlook or Google.'],
      reason: ['if mail arrives:', '  normalize sender, subject, body'],
      output: ['Clean thread object for classification.'],
      sources: ['Outlook inbox', 'Demo corpus'],
    },
    {
      id: 'extract-facts',
      kind: 'extract',
      category: 'core',
      label: 'Extract facts',
      shortReason: 'dates, rooms, guests',
      status: 'live',
      position: { x: 250, y: 500 },
      badges: ['LLM'],
      confidence: 94,
      hotelScope: 'The Centurion',
      focus: 'context',
      input: ['Raw email body and prior thread messages.'],
      reason: ['pull dates', 'pull room count', 'pull guest names', 'pull constraints'],
      output: ['Structured facts for routing and pricing.'],
      sources: ['Thread text', 'Historical replies'],
    },
    {
      id: 'classify-category',
      kind: 'classifier',
      category: 'core',
      label: 'Classify category',
      shortReason: 'route to lane',
      status: 'live',
      position: { x: 500, y: 500 },
      badges: ['5 lanes'],
      confidence: 91,
      hotelScope: 'The Centurion',
      focus: 'context',
      input: ['Structured facts, sender domain, subject, urgency labels.'],
      reason: ['if staff domain -> internal', 'if room block -> group', 'if agency -> travel agent'],
      output: ['Internal, individual, group, travel agent, or spam lane.'],
      sources: ['Centurion category model', 'Demo folder map'],
    },
    {
      id: 'internal-handover',
      kind: 'task',
      category: 'internal',
      label: 'Ops handover',
      shortReason: 'staff mail -> task',
      status: 'muted',
      position: { x: 780, y: 120 },
      badges: ['Task'],
      confidence: 86,
      hotelScope: 'The Centurion',
      input: ['VIP arrivals and internal staff handovers.'],
      reason: ['if internal ops note:', '  attach to affected stay or team'],
      output: ['Task for Front Office or Duty Manager.'],
      sources: ['Thabo VIP handover', 'Internal policy snippets'],
    },
    {
      id: 'internal-risk-alert',
      kind: 'rule',
      category: 'internal',
      label: 'Ops risk alert',
      shortReason: 'leak -> block rooms',
      status: 'risk',
      position: { x: 1040, y: 120 },
      badges: ['Risk', 'Rooms'],
      confidence: 79,
      hotelScope: 'The Centurion',
      input: ['Internal maintenance email: third-floor leak.'],
      reason: ['if room impacted:', '  block affected floor', '  warn related drafts'],
      output: ['Floor 3 excluded from group allocation suggestions.'],
      sources: ['Internal maintenance email', 'Room plan API'],
    },
    {
      id: 'individual-rate',
      kind: 'api',
      category: 'individual',
      label: 'Rate + invoice check',
      shortReason: 'guest -> quote',
      status: 'muted',
      position: { x: 780, y: 310 },
      badges: ['PMS', 'Rates'],
      confidence: 90,
      hotelScope: 'The Centurion',
      input: ['One guest, government DBB, direct booking, invoice requests.'],
      reason: ['if government rate:', '  verify credentials', '  price DBB'],
      output: ['Quote or invoice escalation draft.'],
      sources: ['Besty Travel booking', 'Ntswaki Morake quote', 'Urgent tax invoice'],
    },
    {
      id: 'individual-approval',
      kind: 'approval',
      category: 'individual',
      label: 'Finance approval',
      shortReason: 'invoice -> finance',
      status: 'muted',
      position: { x: 1040, y: 310 },
      badges: ['Finance'],
      confidence: 84,
      hotelScope: 'The Centurion',
      input: ['Urgent tax invoice request or missing folio reference.'],
      reason: ['if invoice urgent:', '  route finance', '  promise 24 business hours'],
      output: ['Finance handoff and guest draft.'],
      sources: ['Leelyn urgent tax invoice thread'],
    },
    {
      id: 'group-availability',
      kind: 'api',
      category: 'group',
      label: 'Check availability',
      shortReason: '20+ rooms -> PMS',
      status: 'live',
      position: { x: 780, y: 500 },
      badges: ['PMS'],
      confidence: 88,
      hotelScope: 'The Centurion',
      focus: 'hero',
      input: ['22 rooms, two U16 girls volleyball teams, April 12-14.'],
      reason: ['if rooms > 10:', '  check inventory', '  hold provisional block'],
      output: ['Available room types and provisional hold.'],
      sources: ['Kleinkaap overflow request', 'Volleyball demo edit', 'PMS inventory'],
    },
    {
      id: 'group-room-plan',
      kind: 'api',
      category: 'group',
      label: 'Room plan API',
      shortReason: 'teams -> nearby rooms',
      status: 'suggested',
      position: { x: 1040, y: 500 },
      badges: ['PMS', 'Map'],
      confidence: 74,
      hotelScope: 'The Centurion',
      focus: 'hero',
      input: ['Two teams want rooms near each other. Third-floor leak may affect allocation.'],
      reason: ['if youth sports:', '  keep rooms same floor/wing', 'if floor blocked:', '  exclude floor'],
      output: ['Room adjacency suggestion and affected-floor warning.'],
      sources: ['Volleyball group email', 'Room plan API', 'Third-floor leak alert'],
      apiConfig: {
        title: 'Connect room-plan source',
        recommended: 'PMS room allocation API',
        fallback: 'Upload room map CSV',
        fields: ['room_id', 'floor', 'wing', 'room_type', 'status', 'adjacent_rooms'],
        usedFor: ['Keep teams near each other', 'Avoid blocked rooms', 'Explain allocation constraints'],
      },
    },
    {
      id: 'group-youth-sports',
      kind: 'rule',
      category: 'group',
      label: 'Youth sports branch',
      shortReason: 'kids team -> upsell',
      status: 'weak-signal',
      position: { x: 1300, y: 500 },
      badges: ['Learning'],
      confidence: 61,
      hotelScope: 'The Centurion',
      focus: 'hero',
      input: ['Girls volleyball teams, school-age players, April weekend.'],
      reason: ['if group_type = youth_sports:', '  ask room proximity', '  flag snack revenue'],
      output: ['Gelato opportunity, F&B task, GM approval path.'],
      sources: ['Sarah edit', 'Prior youth group note', 'Ops memory'],
    },
    {
      id: 'group-gelato',
      kind: 'task',
      category: 'group',
      label: 'Gelato opportunity',
      shortReason: 'players -> F&B profit',
      status: 'suggested',
      position: { x: 1560, y: 420 },
      badges: ['F&B', 'Upsell'],
      confidence: 68,
      hotelScope: 'The Centurion',
      focus: 'hero',
      input: ['42 players, 6 staff, warm April stay window.'],
      reason: ['if youth_sports && April:', '  gelato stand likely sells', '  ask F&B capacity'],
      output: ['Notify F&B Manager about gelato stand option.'],
      sources: ['Human edit', 'Gelato stand anecdote', 'F&B calendar'],
    },
    {
      id: 'group-calendar',
      kind: 'task',
      category: 'group',
      label: 'F&B calendar hold',
      shortReason: 'plan stand -> calendar',
      status: 'suggested',
      position: { x: 1820, y: 420 },
      badges: ['Calendar'],
      confidence: 64,
      hotelScope: 'The Centurion',
      focus: 'hero',
      input: ['Potential gelato stand needs setup and staffing.'],
      reason: ['if F&B upsell proposed:', '  create tentative hold', '  ask yes/no + why'],
      output: ['Calendar hold: Gelato stand review.'],
      sources: ['F&B calendar', 'Group booking workflow'],
      apiConfig: {
        title: 'Connect F&B calendar',
        recommended: 'Google Calendar or Microsoft 365 calendar',
        fallback: 'Create internal task only',
        fields: ['title', 'owner', 'date', 'attendees', 'decision_needed'],
        usedFor: ['Schedule F&B review', 'Prevent missed upsell', 'Track approval outcome'],
      },
    },
    {
      id: 'group-gm-approval',
      kind: 'approval',
      category: 'group',
      label: 'GM approval',
      shortReason: 'non-standard setup',
      status: 'suggested',
      position: { x: 1820, y: 580 },
      badges: ['Approval'],
      confidence: 72,
      hotelScope: 'The Centurion',
      focus: 'hero',
      input: ['Non-standard concession stand and youth group logistics.'],
      reason: ['if new stand opens:', '  GM approves before guest promise'],
      output: ['Approved, rejected, or hold for F&B details.'],
      sources: ['Manager approval SOP', 'Sarah edit'],
    },
    {
      id: 'group-draft',
      kind: 'draft',
      category: 'group',
      label: 'Draft guest reply',
      shortReason: 'quote + ops notes',
      status: 'live',
      position: { x: 2080, y: 500 },
      badges: ['Draft'],
      confidence: 83,
      hotelScope: 'The Centurion',
      focus: 'hero',
      input: ['Availability, quote, room plan constraints, approval state.'],
      reason: ['guest sees quote', 'internal team sees ops tasks', 'do not promise unapproved stand'],
      output: ['Guest reply plus internal handoff tasks.'],
      sources: ['Historical group quote format', 'Finance VAT policy', 'Room plan API'],
    },
    {
      id: 'group-learn',
      kind: 'learn',
      category: 'group',
      label: 'Learn from edit',
      shortReason: 'edit -> branch strength',
      status: 'weak-signal',
      position: { x: 2340, y: 500 },
      badges: ['Teach Nava'],
      confidence: 58,
      hotelScope: 'The Centurion',
      focus: 'hero',
      input: ['Sarah chose Just this once after adding gelato and room proximity.'],
      reason: ['if skipped edit repeats:', '  thicken branch', '  ask user to promote'],
      output: ['Weak signal saved with actor, hotel, and affected nodes.'],
      sources: ['Draft diff', 'Human explanation'],
    },
    {
      id: 'travel-agent-contract',
      kind: 'api',
      category: 'travel-agents',
      label: 'Agency contract',
      shortReason: 'agent -> terms',
      status: 'muted',
      position: { x: 780, y: 690 },
      badges: ['CRM', 'Rates'],
      confidence: 89,
      hotelScope: 'The Centurion',
      input: ['FlyNow, AfDB, or Phophi Travel agency request.'],
      reason: ['if agency sender:', '  verify account', '  protect partner terms'],
      output: ['Partner-safe quote and missing info request.'],
      sources: ['FlyNow SADTU booking', 'AfDB travel info', 'Phophi quote'],
    },
    {
      id: 'travel-agent-transfer',
      kind: 'task',
      category: 'travel-agents',
      label: 'Transfer manifest',
      shortReason: 'flight -> concierge',
      status: 'muted',
      position: { x: 1040, y: 690 },
      badges: ['Concierge'],
      confidence: 78,
      hotelScope: 'The Centurion',
      input: ['Arrival flight KQ 762 and departure KQ 761.'],
      reason: ['if transfer requested:', '  price sedan', '  ask daily transfer yes/no'],
      output: ['Concierge manifest task and guest clarification.'],
      sources: ['AfDB travel information thread'],
    },
    {
      id: 'spam-quarantine',
      kind: 'safety',
      category: 'spam',
      label: 'Quarantine spam',
      shortReason: 'junk -> no reply',
      status: 'muted',
      position: { x: 780, y: 880 },
      badges: ['Safety'],
      confidence: 96,
      hotelScope: 'The Centurion',
      input: ['Vendor solicitation, reward scam, SEO spam.'],
      reason: ['if solicitation or scam:', '  quarantine', '  no guest draft'],
      output: ['Spam folder only.'],
      sources: ['Virtual concierge spam', 'Reward scam', 'SEO services spam'],
    },
  ],
  edges: [
    { id: 'e-email-extract', source: 'email-received', target: 'extract-facts', status: 'live' },
    { id: 'e-extract-classify', source: 'extract-facts', target: 'classify-category', status: 'live' },
    { id: 'e-classify-internal', source: 'classify-category', target: 'internal-handover', status: 'live' },
    { id: 'e-internal-risk', source: 'internal-handover', target: 'internal-risk-alert', status: 'riskAlert' },
    { id: 'e-risk-room-plan', source: 'internal-risk-alert', target: 'group-room-plan', status: 'riskAlert' },
    { id: 'e-classify-individual', source: 'classify-category', target: 'individual-rate', status: 'live' },
    { id: 'e-individual-approval', source: 'individual-rate', target: 'individual-approval', status: 'live' },
    { id: 'e-classify-group', source: 'classify-category', target: 'group-availability', status: 'live' },
    { id: 'e-group-room-plan', source: 'group-availability', target: 'group-room-plan', status: 'suggested' },
    { id: 'e-room-plan-youth', source: 'group-room-plan', target: 'group-youth-sports', status: 'weakSignal' },
    { id: 'e-youth-gelato', source: 'group-youth-sports', target: 'group-gelato', status: 'suggested' },
    { id: 'e-gelato-calendar', source: 'group-gelato', target: 'group-calendar', status: 'suggested' },
    { id: 'e-gelato-approval', source: 'group-gelato', target: 'group-gm-approval', status: 'suggested' },
    { id: 'e-calendar-draft', source: 'group-calendar', target: 'group-draft', status: 'suggested' },
    { id: 'e-approval-draft', source: 'group-gm-approval', target: 'group-draft', status: 'suggested' },
    { id: 'e-draft-learn', source: 'group-draft', target: 'group-learn', status: 'weakSignal' },
    { id: 'e-classify-agent', source: 'classify-category', target: 'travel-agent-contract', status: 'live' },
    { id: 'e-agent-transfer', source: 'travel-agent-contract', target: 'travel-agent-transfer', status: 'live' },
    { id: 'e-classify-spam', source: 'classify-category', target: 'spam-quarantine', status: 'blocked' },
  ],
  evidence: [
    {
      id: 'evidence-inbound-volleyball',
      kind: 'email',
      hotel: 'The Centurion',
      actor: 'Pretoria Girls Volleyball',
      action: 'Sent group booking request',
      timestamp: '2026-04-12T09:20:00.000Z',
      relatedNodeIds: ['email-received', 'extract-facts', 'group-availability'],
      detail: 'Two U16 girls volleyball teams need 22 rooms and nearby allocation.',
    },
    {
      id: 'evidence-sarah-edit',
      kind: 'weak-signal',
      hotel: 'The Centurion',
      actor: 'Sarah Mokoena',
      action: 'Chose Just this once',
      timestamp: '2026-04-12T09:48:00.000Z',
      signalStrength: 'weak',
      relatedNodeIds: ['group-youth-sports', 'group-gelato', 'group-calendar'],
      detail: 'Added room proximity, F&B gelato handoff, and manager approval note without promoting rule yet.',
    },
    {
      id: 'evidence-floor-leak',
      kind: 'internal-alert',
      hotel: 'The Centurion',
      actor: 'Maintenance Desk',
      action: 'Reported third-floor leak',
      timestamp: '2026-04-12T08:05:00.000Z',
      signalStrength: 'strong',
      relatedNodeIds: ['internal-risk-alert', 'group-room-plan', 'group-draft'],
      detail: 'Internal ops update should block floor 3 from suggested group allocations.',
    },
  ],
  riskAlerts: [
    {
      id: 'third-floor-leak',
      title: 'Third-floor leakage',
      severity: 'high',
      sourceCategory: 'internal',
      affectedCategory: 'group',
      affectedNodeIds: ['group-room-plan', 'group-draft'],
      detail: 'Internal maintenance email says third-floor rooms may be unavailable for group allocation.',
      recommendedAction: 'Block floor 3 in room-plan suggestions and attach warning to affected group drafts.',
    },
  ],
};

const DEFAULT_WORKFLOW_KEY: AiOpsBrainWorkflowKey = 'individual';

function isWorkflowKey(value: string | undefined): value is AiOpsBrainWorkflowKey {
  return Boolean(value && value in AI_OPS_BRAIN_WORKFLOWS);
}

export function getAiOpsBrainWorkflow(folder: string | undefined): AiOpsBrainWorkflow {
  return AI_OPS_BRAIN_WORKFLOWS[isWorkflowKey(folder) ? folder : DEFAULT_WORKFLOW_KEY];
}

export function getAiOpsBrainWorkflowForThread({
  routeFolder,
  threadCategory,
  isUrgent,
}: {
  routeFolder?: string;
  threadCategory?: CenturionMailCategory;
  isUrgent?: boolean;
}): AiOpsBrainWorkflow {
  if (isUrgent) return AI_OPS_BRAIN_WORKFLOWS.urgent;
  if (threadCategory) return AI_OPS_BRAIN_WORKFLOWS[threadCategory];
  return getAiOpsBrainWorkflow(routeFolder);
}

export function getAiOpsBrainGraph(): AiOpsBrainGraph {
  return AI_OPS_BRAIN_GRAPH;
}

export function getAiOpsBrainGraphForThread({
  threadCategory,
}: {
  routeFolder?: string;
  threadCategory?: CenturionMailCategory;
  isUrgent?: boolean;
} = {}): AiOpsBrainGraph {
  if (threadCategory === 'group') return AI_OPS_BRAIN_GRAPH;
  return {
    ...AI_OPS_BRAIN_GRAPH,
    focusPathId: threadCategory ? `${threadCategory}-workflow` : AI_OPS_BRAIN_GRAPH.focusPathId,
    nodes: AI_OPS_BRAIN_GRAPH.nodes.map((node) =>
      node.category === threadCategory ? { ...node, focus: 'hero' } : { ...node, focus: node.category === 'core' ? 'context' : undefined },
    ),
  };
}
