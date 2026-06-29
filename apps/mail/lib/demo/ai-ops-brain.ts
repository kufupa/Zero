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

export type AiOpsBrainReviewStep = {
  id: string;
  title: string;
  actor: string;
  status: 'done' | 'current' | 'queued';
  nodeId: string;
  summary: string;
  reason: string;
  sources: string[];
  action: string;
};

export type AiOpsBrainDelta = {
  title: string;
  before: string;
  after: string;
  actor: string;
  hotel: string;
  affectedNodeIds: string[];
};

export type AiOpsBrainTour = {
  id: 'categories' | 'risk-alerts' | 'learning-signals';
  label: string;
  title: string;
  description: string;
  nodeIds: string[];
};

export type AiOpsBrainFocusRunSegment = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string;
  detail: string;
};

export type AiOpsBrainFocusRun = {
  title: string;
  subtitle: string;
  primaryNodeIds: string[];
  segments: AiOpsBrainFocusRunSegment[];
};

export type AiOpsBrainTraceItem = {
  id: string;
  title: string;
  type: 'evidence' | 'decision' | 'correction' | 'stored-rule';
  nodeId: string;
  eyebrow: string;
  summary: string;
  detail: string;
  actor: string;
  timestamp: string;
  sources: string[];
  actionLabel?: string;
  commentPrompt?: string;
};

export type AiOpsBrainOperatorTraceEvent = {
  id: string;
  title: string;
  status: 'checked' | 'decision' | 'missed';
  kind: 'email' | 'api' | 'logic' | 'draft' | 'gap';
  actor: 'Nava';
  timestamp: string;
  summary: string;
  detail: string;
  nodeId: string;
  evidence: string[];
  output: string;
};

export type AiOpsBrainWorkflowProposalNode = {
  id: string;
  label: string;
  status: 'new' | 'changed' | 'existing';
  detail: string;
};

export type AiOpsBrainWorkflowProposal = {
  trigger: string;
  checks: string[];
  action: string;
  guardrail: string;
  defaultScope: string;
  scopeOptions: string[];
  ruleText: string;
  beforePath: string[];
  proposedNodes: AiOpsBrainWorkflowProposalNode[];
  /** Hero line for workflow preview: what the hotel gains (policy-neutral). */
  valueHeadline?: string;
  /** Supporting copy: outcomes vs old path (may be longer than ruleText). */
  valueDetail?: string;
  /** Human anchor: which correction / thread taught Nava (demo narrative). */
  teachingMoment?: string;
};

export type AiOpsBrainStoredRule = {
  id: string;
  title: string;
  status: 'proposed' | 'stored' | 'needs-review';
  hotel: string;
  actor: string;
  editType: string;
  scope: string;
  evidence: string[];
  reviewState: string;
  affectedSystems: string[];
  lastTrained: string;
  appliedCount: number;
  contradictedCount: number;
  ruleText: string;
};

export type AiOpsBrainDemoStepDetailKind =
  | 'node'
  | 'api-room-plan'
  | 'api-calendar'
  | 'diff'
  | 'training'
  | 'hotel';

export type AiOpsBrainDemoStep = {
  id: string;
  title: string;
  narration: string;
  nodeId: string;
  detailKind: AiOpsBrainDemoStepDetailKind;
};

export type AiOpsBrainNodeDetailCard = {
  nodeId: string;
  headline: string;
  input: string[];
  decision: string;
  output: string[];
  proof: string[];
};

export type AiOpsBrainApiMock = {
  id: string;
  nodeId: string;
  title: string;
  method: string;
  path: string;
  requestSummary: string;
  responseLines: string[];
  effect: string;
};

export type AiOpsBrainDraftDiff = {
  navaLabel: string;
  navaBody: string;
  sarahLabel: string;
  sarahBody: string;
  operationalChange: string;
};

export type AiOpsBrainTrainingOverlay = {
  ruleStatus: AiOpsBrainStoredRule['status'];
  appliedCount: number;
  contradictedCount: number;
  reviewState: string;
};

export type AiOpsBrainTrainingOutcomes = {
  weakSignal: AiOpsBrainTrainingOverlay;
  promoted: AiOpsBrainTrainingOverlay;
};

export type AiOpsBrainYcDemoBeat = {
  id: string;
  title: string;
  userAction: string;
  say: string;
  whyItMatters: string;
};

export type AiOpsBrainConnectorStory = {
  id: string;
  system: 'PMS' | 'Room map' | 'F&B calendar';
  label: string;
  status: 'connected' | 'needs-owner';
  usedFor: string;
  demoLine: string;
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
  reviewSteps: AiOpsBrainReviewStep[];
  brainDelta: AiOpsBrainDelta;
  tours: AiOpsBrainTour[];
  focusRun: AiOpsBrainFocusRun;
  reviewTrace: AiOpsBrainTraceItem[];
  operatorTrace: AiOpsBrainOperatorTraceEvent[];
  workflowProposal: AiOpsBrainWorkflowProposal;
  storedRule: AiOpsBrainStoredRule;
  demoSteps: AiOpsBrainDemoStep[];
  nodeDetails: Record<string, AiOpsBrainNodeDetailCard>;
  apiMocks: AiOpsBrainApiMock[];
  draftDiff: AiOpsBrainDraftDiff;
  trainingOutcomes: AiOpsBrainTrainingOutcomes;
  ycDemoScript: AiOpsBrainYcDemoBeat[];
  connectorStory: AiOpsBrainConnectorStory[];
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
    { id: 'e-calendar-approval', source: 'group-calendar', target: 'group-gm-approval', status: 'suggested' },
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
  reviewSteps: [
    {
      id: 'review-email',
      title: 'Email received',
      actor: 'Pretoria Girls Volleyball',
      status: 'done',
      nodeId: 'email-received',
      summary: 'Two U16 teams ask for 22 rooms near each other.',
      reason: 'group request -> room block flow',
      sources: ['Inbound email', 'Historical group quotes'],
      action: 'Facts extracted',
    },
    {
      id: 'review-room-plan',
      title: 'Room proximity',
      actor: 'Nava',
      status: 'done',
      nodeId: 'group-room-plan',
      summary: 'Room Plan API keeps teams same wing and avoids floor 3.',
      reason: 'if youth team -> keep rooms nearby',
      sources: ['Room plan API', 'Third-floor leak alert'],
      action: 'Attach allocation warning',
    },
    {
      id: 'review-gelato',
      title: 'Gelato opportunity',
      actor: 'Nava',
      status: 'current',
      nodeId: 'group-gelato',
      summary: 'Players + warm weekend can support temporary gelato stand.',
      reason: 'if youth_sports && April -> ask F&B capacity',
      sources: ['Sarah edit', 'F&B calendar', 'Gelato stand anecdote'],
      action: 'Ask manager before promising guest',
    },
    {
      id: 'review-draft',
      title: 'Draft reply',
      actor: 'Sarah Mokoena',
      status: 'queued',
      nodeId: 'group-draft',
      summary: 'Reply quotes rooms, asks about proximity, and avoids promising unapproved stand.',
      reason: 'quote guest; route ops work internally',
      sources: ['Group quote format', 'Manager approval SOP'],
      action: 'Review and send',
    },
  ],
  brainDelta: {
    title: 'Brain changed',
    before: 'Youth sports branch was a weak signal at 61%.',
    after: 'Group-booking workflow now checks ancillary fit, F&B capacity, and manager approval before guest wording.',
    actor: 'Sarah Mokoena',
    hotel: 'The Centurion',
    affectedNodeIds: ['group-youth-sports', 'group-gelato', 'group-calendar', 'group-gm-approval'],
  },
  tours: [
    {
      id: 'categories',
      label: 'Categories',
      title: 'Five inbox lanes',
      description: 'Every inbound email lands in internal, individual, group, travel agent, or safety workflows.',
      nodeIds: ['classify-category', 'internal-handover', 'individual-rate', 'group-availability', 'travel-agent-contract', 'spam-quarantine'],
    },
    {
      id: 'risk-alerts',
      label: 'Risk alerts',
      title: 'Internal ops changes affect guest drafts',
      description: 'A third-floor leak blocks room-plan suggestions before Nava promises allocation.',
      nodeIds: ['internal-risk-alert', 'group-room-plan', 'group-draft'],
    },
    {
      id: 'learning-signals',
      label: 'Learning signals',
      title: 'Human edits strengthen the SOP',
      description: 'Skipped edits stay weak. Repeated edits ask the user to promote a new rule.',
      nodeIds: ['group-youth-sports', 'group-gelato', 'group-calendar', 'group-learn'],
    },
  ],
  focusRun: {
    title: 'Volleyball group booking run',
    subtitle: 'Nava turns one edited draft into hotel memory.',
    primaryNodeIds: [
      'email-received',
      'group-availability',
      'group-room-plan',
      'group-gelato',
      'group-calendar',
      'group-gm-approval',
      'group-draft',
      'group-learn',
    ],
    segments: [
      {
        id: 'segment-inbound-availability',
        sourceNodeId: 'email-received',
        targetNodeId: 'group-availability',
        label: '3 evidence reads',
        detail: 'Extract facts, classify group request, then check PMS inventory.',
      },
      {
        id: 'segment-availability-room-plan',
        sourceNodeId: 'group-availability',
        targetNodeId: 'group-room-plan',
        label: '2 ops checks',
        detail: 'Hold provisional block and exclude third-floor rooms from allocation.',
      },
      {
        id: 'segment-room-plan-gelato',
        sourceNodeId: 'group-room-plan',
        targetNodeId: 'group-gelato',
        label: 'youth sports rule',
        detail: 'Room proximity and team context trigger F&B upsell review.',
      },
      {
        id: 'segment-gelato-calendar',
        sourceNodeId: 'group-gelato',
        targetNodeId: 'group-calendar',
        label: 'F&B calendar',
        detail: 'Tentative hold so F&B can accept or decline before guest copy mentions gelato.',
      },
      {
        id: 'segment-calendar-approval',
        sourceNodeId: 'group-calendar',
        targetNodeId: 'group-gm-approval',
        label: 'approval gate',
        detail: 'Non-standard gelato setup needs manager approval before guest promise.',
      },
      {
        id: 'segment-approval-draft',
        sourceNodeId: 'group-gm-approval',
        targetNodeId: 'group-draft',
        label: 'draft guarded',
        detail: 'Guest reply quotes rooms without promising unapproved stand.',
      },
      {
        id: 'segment-draft-learn',
        sourceNodeId: 'group-draft',
        targetNodeId: 'group-learn',
        label: 'stored SOP',
        detail: 'Sarah approves training so this workflow applies to future youth groups.',
      },
    ],
  },
  reviewTrace: [
    {
      id: 'trace-evidence',
      title: 'Evidence read',
      type: 'evidence',
      nodeId: 'email-received',
      eyebrow: 'Inbound email + history',
      summary: 'Two U16 volleyball teams need 22 nearby rooms for April 12-14.',
      detail: 'Nava reads the inbound request, prior group quote format, PMS inventory, and internal third-floor leak alert before drafting.',
      actor: 'Nava',
      timestamp: '09:21',
      sources: ['Inbound volleyball email', 'Historical group quote format', 'PMS inventory', 'Third-floor leak alert'],
      actionLabel: 'Evidence attached',
    },
    {
      id: 'trace-decision',
      title: 'Decision made',
      type: 'decision',
      nodeId: 'group-room-plan',
      eyebrow: 'Ops decision',
      summary: 'Keep teams in the same wing and avoid floor 3.',
      detail: 'The request is not just a quote. Room proximity affects guest experience, and the leak changes which rooms should be offered.',
      actor: 'Nava',
      timestamp: '09:23',
      sources: ['Room plan API', 'Maintenance alert'],
      actionLabel: 'Allocation constraint applied',
    },
    {
      id: 'trace-correction',
      title: 'Human correction',
      type: 'correction',
      nodeId: 'group-gelato',
      eyebrow: 'Sarah edited draft',
      summary: 'Add gelato stand review for youth sports group before sending.',
      detail: 'Sarah says youth teams often buy snacks after matches. Nava should flag F&B and ask manager approval before mentioning it to the guest.',
      actor: 'Sarah Mokoena',
      timestamp: '09:48',
      sources: ['Draft diff', 'Sarah comment', 'F&B calendar'],
      actionLabel: 'Add comment',
      commentPrompt: 'Explain when this should happen again...',
    },
    {
      id: 'trace-stored-rule',
      title: 'Stored SOP preview',
      type: 'stored-rule',
      nodeId: 'group-learn',
      eyebrow: 'Company memory',
      summary: 'Store ancillary + approval workflow for future group requests.',
      detail: 'Similar family or youth group bookings should check whether an ancillary service fits, confirm F&B capacity, and require manager approval before draft send.',
      actor: 'Nava',
      timestamp: '09:50',
      sources: ['Approved correction', 'Manager approval SOP'],
      actionLabel: 'Approve + train',
    },
  ],
  operatorTrace: [
    {
      id: 'trace-email',
      title: 'Read request',
      status: 'checked',
      kind: 'email',
      actor: 'Nava',
      timestamp: '09:21',
      summary: '22 rooms, volleyball group, Apr 12-14.',
      detail: 'Nava parsed dates, room count, group context, and the guest-facing ask from the inbound email.',
      nodeId: 'email-received',
      evidence: ['Inbound email', 'Thread history'],
      output: 'Group booking request routed to reservations.',
    },
    {
      id: 'trace-pms',
      title: 'Checked PMS availability',
      status: 'checked',
      kind: 'api',
      actor: 'Nava',
      timestamp: '09:22',
      summary: '22-room provisional hold available.',
      detail: 'PMS returned enough inventory to draft a hold without over-promising final allocation.',
      nodeId: 'group-availability',
      evidence: ['PMS availability API', 'Rate table'],
      output: 'Hold rooms, confirm final allocation later.',
    },
    {
      id: 'trace-room-logic',
      title: 'Planned standard allocation review',
      status: 'decision',
      kind: 'logic',
      actor: 'Nava',
      timestamp: '09:23',
      summary: 'Standard review before final room allocation.',
      detail: 'Nava kept the reply safe but did not ask what extra operational checks this group profile should trigger.',
      nodeId: 'group-room-plan',
      evidence: ['Room plan rule', 'Maintenance alert'],
      output: 'No guest-facing room proximity promise yet.',
    },
    {
      id: 'trace-draft',
      title: 'Drafted reply',
      status: 'decision',
      kind: 'draft',
      actor: 'Nava',
      timestamp: '09:24',
      summary: 'Hold rooms, confirm final allocation after review.',
      detail: 'The draft answered the booking request but missed the reason Sarah later added more operational context.',
      nodeId: 'group-draft',
      evidence: ['Draft body', 'Prior quote format'],
      output: 'Safe baseline reply.',
    },
    {
      id: 'trace-missed-ancillary',
      title: 'Not checked: ancillary opportunity',
      status: 'missed',
      kind: 'gap',
      actor: 'Nava',
      timestamp: '09:25',
      summary: 'No F&B or guest-experience opportunity checked.',
      detail: 'Nava did not ask whether this group profile creates a hotel-specific ancillary service workflow.',
      nodeId: 'group-gelato',
      evidence: ['No F&B calendar read', 'No event-capacity check'],
      output: 'Missing teaching point for Sarah.',
    },
    {
      id: 'trace-missed-approval',
      title: 'Not checked: approval gate',
      status: 'missed',
      kind: 'gap',
      actor: 'Nava',
      timestamp: '09:25',
      summary: 'No manager approval before guest-facing upsell.',
      detail: 'Nava did not know that non-standard F&B offers need approval before they appear in guest wording.',
      nodeId: 'group-gm-approval',
      evidence: ['No manager task', 'No approval state'],
      output: 'Missing guardrail for workflow proposal.',
    },
  ],
  workflowProposal: {
    valueHeadline: 'Fewer risky guest promises, same polite replies',
    valueDetail:
      'Nava can still confirm rooms in friendly language. What changes is behind the scenes: before any ancillary idea (extra F&B, experiences) appears in guest copy, Nava runs internal capacity and manager checks — so ops agrees first, then wording updates.',
    teachingMoment:
      'Sarah adjusted the volleyball group reply: same-wing rooms plus a gelato idea that needed F&B and manager sign-off before it belonged in guest-facing text.',
    trigger: 'similar group booking with children/families where season, weather, or guest profile could create an ancillary opportunity.',
    checks: ['F&B capacity', 'Manager approval', 'Guest-facing wording guardrail'],
    action: 'Create an internal F&B review before final guest wording.',
    guardrail: 'Do not mention or promise the ancillary option before guest-facing wording is approved.',
    defaultScope: 'This hotel',
    scopeOptions: ['This hotel', 'All hotels', 'Ask next time'],
    ruleText:
      'For similar group bookings with children/families, check ancillary F&B opportunities and manager approval before guest-facing wording.',
    beforePath: ['Group request', 'PMS hold', 'Standard review', 'Guest draft'],
    proposedNodes: [
      {
        id: 'proposal-ancillary-check',
        label: 'Ancillary opportunity check',
        status: 'new',
        detail: 'Ask whether group profile, season, or guest mix creates a hotel-specific service opportunity.',
      },
      {
        id: 'proposal-fb-capacity',
        label: 'F&B capacity check',
        status: 'new',
        detail: 'Check whether F&B can support the proposed service before it reaches guest copy.',
      },
      {
        id: 'proposal-manager-approval',
        label: 'Manager approval gate',
        status: 'new',
        detail: 'Require approval before Nava suggests or promises the option externally.',
      },
    ],
  },
  storedRule: {
    id: 'rule-group-ancillary-approval',
    title: 'Group ancillary opportunity check',
    status: 'proposed',
    hotel: 'The Centurion',
    actor: 'Sarah Mokoena',
    editType: 'Missing reasoning label',
    scope: 'Group bookings -> children/families -> ancillary services',
    evidence: ['Nava reasoning trace', 'Sarah teaching note', 'F&B calendar', 'Manager approval policy'],
    reviewState: 'Needs manager approval before guest promise',
    affectedSystems: ['PMS room plan', 'F&B calendar', 'Manager approval', 'Guest draft'],
    lastTrained: '2026-04-12T09:50:00.000Z',
    appliedCount: 0,
    contradictedCount: 0,
    ruleText:
      'For similar group bookings with children/families, check ancillary F&B opportunities and manager approval before guest-facing wording.',
  },
  demoSteps: [
    {
      id: 'demo-1-inbound',
      title: 'Inbound group request',
      narration:
        'Two U16 volleyball teams email for 22 rooms April 12–14. Nava parses sender, dates, headcount, and flags this as a group lane before anyone touches PMS.',
      nodeId: 'email-received',
      detailKind: 'node',
    },
    {
      id: 'demo-2-hold',
      title: 'Provisional block + inventory',
      narration:
        'Nava checks PMS for a 22-room provisional hold and surfaces rate context. Nothing is promised to the guest until allocation rules pass.',
      nodeId: 'group-availability',
      detailKind: 'node',
    },
    {
      id: 'demo-3-room-api',
      title: 'Room Plan API call',
      narration:
        'Room proximity is not vibes. Nava calls the room-plan integration, applies the third-floor leak constraint, and writes the allocation warning into the run.',
      nodeId: 'group-room-plan',
      detailKind: 'api-room-plan',
    },
    {
      id: 'demo-4-upsell',
      title: 'Youth sports upsell branch',
      narration:
        'Youth sports + April triggers an F&B gelato opportunity. Nava creates an internal signal, not a guest promise, until a human approves.',
      nodeId: 'group-gelato',
      detailKind: 'node',
    },
    {
      id: 'demo-5-calendar',
      title: 'F&B calendar hold',
      narration:
        'If the stand is real, it needs a calendar owner. Nava books a tentative hold and asks F&B for yes/no capacity before the draft mentions it.',
      nodeId: 'group-calendar',
      detailKind: 'api-calendar',
    },
    {
      id: 'demo-6-approval',
      title: 'Manager gate',
      narration:
        'Non-standard revenue moves hit GM approval. Nava blocks guest-facing language until this gate is satisfied or explicitly skipped.',
      nodeId: 'group-gm-approval',
      detailKind: 'node',
    },
    {
      id: 'demo-7-draft',
      title: 'Draft before / after Sarah',
      narration:
        'Sarah edits the draft: add proximity language and internal gelato review. That is an operational workflow change, not tone polish.',
      nodeId: 'group-draft',
      detailKind: 'diff',
    },
    {
      id: 'demo-8-train',
      title: 'Train the brain',
      narration:
        'Choose whether this stays a one-off weak signal or becomes hotel memory. Approve + train updates the graph and stored SOP for future youth groups.',
      nodeId: 'group-learn',
      detailKind: 'training',
    },
    {
      id: 'demo-9-hotel',
      title: 'Whole hotel brain',
      narration:
        'Zoom out to see categories, risk alerts, and learning signals on one map. The metadata rail proves what the hotel now stores.',
      nodeId: 'classify-category',
      detailKind: 'hotel',
    },
  ],
  nodeDetails: {
    'email-received': {
      nodeId: 'email-received',
      headline: 'Trigger: inbound mail',
      input: ['Raw MIME from Outlook / Google', 'Thread id and folder = group'],
      decision: 'Parse headers + body, normalize to thread object.',
      output: ['Structured facts for classifier and PMS checks.'],
      proof: ['Demo corpus thread: Pretoria Girls Volleyball', 'Timestamp 09:20'],
    },
    'group-availability': {
      nodeId: 'group-availability',
      headline: 'PMS inventory check',
      input: ['22 rooms, Apr 12–14, two teams', 'Group lane from classifier'],
      decision: 'if rooms > 10 then provisional hold + rate snapshot.',
      output: ['Hold id GR-2026-0412-01', 'Available types: Twin, Queen'],
      proof: ['PMS inventory snapshot', 'No guest-facing send yet'],
    },
    'group-room-plan': {
      nodeId: 'group-room-plan',
      headline: 'Room proximity + risk merge',
      input: ['Team count + wing preference', 'Internal leak alert for floor 3'],
      decision: 'Exclude blocked floors, prefer same wing for youth sports.',
      output: ['Allocation suggestion JSON', 'Warning line for draft'],
      proof: ['Room plan API response', 'Maintenance ticket #M-4401'],
    },
    'group-gelato': {
      nodeId: 'group-gelato',
      headline: 'F&B upsell signal',
      input: ['Youth sports tag', 'April seasonality', 'Past gelato stand revenue note'],
      decision: 'if youth_sports && April then suggest F&B review task.',
      output: ['Internal F&B task draft', 'No guest promise until approval'],
      proof: ['Sarah prior edit pattern', 'F&B calendar free slot scan'],
    },
    'group-calendar': {
      nodeId: 'group-calendar',
      headline: 'Calendar hold',
      input: ['Proposed stand window', 'F&B owner role'],
      decision: 'Create tentative event, require human accept.',
      output: ['Calendar event id CAL-GEL-0412-T', 'Decision_needed flag'],
      proof: ['Google Calendar API mock', 'Attendee list: F&B lead'],
    },
    'group-gm-approval': {
      nodeId: 'group-gm-approval',
      headline: 'GM approval gate',
      input: ['Non-standard concession', 'Draft impact summary'],
      decision: 'if new stand language in guest draft then require GM.',
      output: ['Approve | Reject | Hold', 'Audit trail row'],
      proof: ['Manager approval SOP v3', 'Sarah as acting approver in demo'],
    },
    'group-draft': {
      nodeId: 'group-draft',
      headline: 'Guest reply composition',
      input: ['Hold id', 'Allocation warning', 'Approval state for gelato'],
      decision: 'Quote rooms, attach internal tasks, never promise unapproved stand.',
      output: ['Guest-visible draft', 'Internal handoff bundle'],
      proof: ['Group quote template', 'Diff vs Nava baseline'],
    },
    'group-learn': {
      nodeId: 'group-learn',
      headline: 'Learning capture',
      input: ['Draft diff', 'Actor + hotel scope', 'Human label on edit type'],
      decision: 'if repeated weak signals then prompt promote rule.',
      output: ['Weak signal row or promoted SOP revision'],
      proof: ['Teach Nava event log', 'Affected node ids for graph delta'],
    },
    'classify-category': {
      nodeId: 'classify-category',
      headline: 'Five-lane router',
      input: ['Structured facts', 'Sender domain', 'Urgency hints'],
      decision: 'Route to internal, individual, group, travel agent, or spam.',
      output: ['Lane id for downstream workflows'],
      proof: ['Centurion category model v12'],
    },
  },
  apiMocks: [
    {
      id: 'mock-room-plan',
      nodeId: 'group-room-plan',
      title: 'Room plan allocation',
      method: 'POST',
      path: '/v1/properties/centurion/allocations/suggest',
      requestSummary: '{ guests: 48, teams: 2, avoid_floors: [3], prefer: "same_wing" }',
      responseLines: [
        '{',
        '  "suggested_wing": "East",',
        '  "excluded_units": ["301-318"],',
        '  "warning": "floor_3_maintenance",',
        '  "confidence": 0.91',
        '}',
      ],
      effect: 'Floor 3 excluded from suggestions; East wing preferred for both teams.',
    },
    {
      id: 'mock-fb-calendar',
      nodeId: 'group-calendar',
      title: 'F&B tentative hold',
      method: 'POST',
      path: '/calendar/v3/calendars/fb-ops@centurion/events',
      requestSummary: '{ summary: "Gelato stand review", start: "2026-04-12T16:00Z", attendees: ["fb-lead@..."] }',
      responseLines: [
        '{',
        '  "id": "evt_gelato_review_0412",',
        '  "status": "tentative",',
        '  "responseRequested": true',
        '}',
      ],
      effect: 'F&B gets a real calendar artifact to accept or decline before guest copy mentions gelato.',
    },
  ],
  draftDiff: {
    navaLabel: 'Nava baseline',
    navaBody:
      'Dear Marlize,\n\nThank you for considering The Centurion for your volleyball group.\n\nWe can hold 22 rooms for your dates. We will confirm final allocation after standard review.\n\nWarm regards,\nReservations\nThe Centurion',
    sarahLabel: 'Sarah edit (sent for demo)',
    sarahBody:
      'We will try to keep both teams on the same wing. Our team will also review a possible gelato stand for the players before we confirm wording with you.',
    operationalChange:
      "Sarah's sent edit teaches Nava to check room proximity, ancillary fit, F&B capacity, and manager approval before guest wording.",
  },
  trainingOutcomes: {
    weakSignal: {
      ruleStatus: 'proposed',
      appliedCount: 0,
      contradictedCount: 0,
      reviewState: 'Logged as weak signal — promote if this repeats',
    },
    promoted: {
      ruleStatus: 'stored',
      appliedCount: 1,
      contradictedCount: 0,
      reviewState: 'Live for youth sports group requests at this property',
    },
  },
  ycDemoScript: [
    {
      id: 'open-volleyball-thread',
      title: 'Open the pinned volleyball group email',
      userAction: 'Search or click the YC demo thread: “Volleyball group booking: 22 rooms, 12-14 April.”',
      say: 'This is normal hotel inbox work: group quote, parent logistics, rooms close together.',
      whyItMatters: 'YC sees the wedge starts inside Outlook, not inside a dashboard.',
    },
    {
      id: 'show-bad-draft',
      title: 'Show Nava’s baseline draft',
      userAction: 'Point at the draft card: it has rooms and rate language, but misses operational follow-through.',
      say: 'This answer is fine as email automation. It is not hotel operations yet.',
      whyItMatters: 'Sets up why a simple reply assistant is not enough.',
    },
    {
      id: 'make-sarah-edit',
      title: 'Make Sarah’s workflow edit',
      userAction: "Click Edit draft, then Apply Sarah's edit. The editor changes copy without manual typing.",
      say: 'Sarah is not changing tone. She is teaching how this hotel actually works.',
      whyItMatters: 'The edit becomes workflow logic: room-plan API, F&B calendar, manager approval, draft guardrail.',
    },
    {
      id: 'teach-workflow',
      title: 'Click Teach Nava',
      userAction: 'Click Teach Nava, then Approve + train in the brain view.',
      say: 'Nava converts that edit into a hotel-specific workflow, with evidence and approval state.',
      whyItMatters: 'This is the core product loop: work happens once, then compounds.',
    },
    {
      id: 'show-api-connectors',
      title: 'Show lightweight API connectors',
      userAction: 'Open Connect API on Room plan or Calendar node.',
      say: 'For real hotels this connects to PMS, room map, and F&B calendar. In demo mode we show exactly which fields Nava needs.',
      whyItMatters: 'Proves API thinking without turning YC demo into an integration walkthrough.',
    },
    {
      id: 'show-multi-hotel-scope',
      title: 'Show multi-hotel scope',
      userAction: 'Zoom out to hotel brain and mention the same workflow primitives across properties.',
      say: 'The primitive is reusable, but the policy is hotel-scoped. Centurion learns gelato; another property can learn spa, shuttle, or family-room rules.',
      whyItMatters: 'Makes scalability credible: shared architecture, local hotel memory.',
    },
  ],
  connectorStory: [
    {
      id: 'connector-pms',
      system: 'PMS',
      label: 'Availability + provisional hold',
      status: 'connected',
      usedFor: 'Read room types, block inventory, quote without overbooking.',
      demoLine: 'Connected in demo: PMS returns 22-room hold and B&B availability.',
    },
    {
      id: 'connector-room-map',
      system: 'Room map',
      label: 'Room proximity map',
      status: 'connected',
      usedFor: 'Keep youth teams near each other and exclude maintenance floors.',
      demoLine: 'Connected in demo: room map excludes floor 3 and suggests East wing.',
    },
    {
      id: 'connector-fb-calendar',
      system: 'F&B calendar',
      label: 'F&B capacity check',
      status: 'needs-owner',
      usedFor: 'Create tentative gelato stand review before guest-facing promise.',
      demoLine: 'Needs owner approval: Nava prepares calendar hold, F&B accepts or declines.',
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
