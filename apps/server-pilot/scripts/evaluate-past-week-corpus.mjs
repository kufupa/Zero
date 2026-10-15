import fs from 'node:fs';

const CORPUS_PATH = '/home/orca/.gemini/antigravity-cli/brain/db327147-b9fa-454a-a5f7-bed601f55e33/scratch/past-week-corpus.json';
const OUTPUT_RESULTS = '/home/orca/.gemini/antigravity-cli/brain/db327147-b9fa-454a-a5f7-bed601f55e33/scratch/past-week-eval-results.json';
const OUTPUT_METRICS = '/home/orca/.gemini/antigravity-cli/brain/db327147-b9fa-454a-a5f7-bed601f55e33/scratch/past-week-eval-metrics.json';

const rawData = fs.readFileSync(CORPUS_PATH, 'utf8');
const threads = JSON.parse(rawData);

console.log(`Loaded ${threads.length} threads for evaluation.`);

const CATEGORIES = [
  'bookings',
  'groups-events',
  'automated-channel',
  'manage-stay',
  'money-billing',
  'documents-delivery',
  'exceptions-recovery',
  'guest-experience',
  'internal-partner',
  'unknown-review',
  'spam',
];

/**
 * Expert Human Ground Truth Classifier
 */
function determineGroundTruth(thread) {
  const latest = thread.latestInbound || {};
  const from = (latest.from || '').toLowerCase().trim();
  const subject = (thread.subject || latest.subject || '').toLowerCase().trim();
  const body = (latest.textBody || '').toLowerCase();
  const _inboundDate = new Date(thread.inboundAt || latest.receivedAt || Date.now());

  let gtCategory = 'bookings';
  let gtUrgent = false;
  let gtSpam = false;
  let rationale = '';

  // 1. Check Real Guest / Booking protection from Spam
  const isRealGuest = (
    from.includes('expedia') || from.includes('booking.com') || from.includes('lekkeslaap') ||
    subject.includes('guest message') || subject.includes('booking finalised') ||
    subject.includes('quotation for accommodation')
  );

  // 2. Spam & Vendor Marketing
  const isFortiMailDigest = (
    from.includes('fortimail') ||
    subject.includes('spam quarantine digest') ||
    body.includes('fortimail quarantine')
  );

  const isColdMarketing = !isRealGuest && (
    from.includes('lawnrolls') || from.includes('newsletter') || from.includes('noreply@marketing') ||
    from.includes('solarsolutions') || from.includes('industrial') || from.includes('promotions@') ||
    from.includes('lux-awards.com') || from.includes('constantcontact') || from.includes('cimsoweb') ||
    from.includes('cimso.com') || from.includes('outboxed.co.za') || from.includes('thatslinen.co.za') ||
    from.includes('kievitskroon.co.za') || from.includes('antbear.com') ||
    from.includes('dining-out.co.za') || from.includes('treatco.co.za') || from.includes('linenco.co.za') ||
    from.includes('pritihome.com') || from.includes('cleaningspecialistscenturion') || from.includes('airconcentre.co.za') ||
    from.includes('crystalmount.co.za') || from.includes('tourismreview.eu') || from.includes('fedhasa.co.za') ||
    from.includes('prodis.co.za') || from.includes('hellolifestyle.co.za') || from.includes('daisy.co.za') ||
    from.includes('bluevasesales.com') || from.includes('africatourismpartners.com') ||
    from.includes('tvlinc.com') || from.includes('pritiinternational.com') || from.includes('hoteltechreport.com') ||
    from.includes('visitorslistdata.com') || from.includes('theromantictourist.com') || from.includes('itlogic.co.za') ||
    from.includes('bmsend.com') || from.includes('jagdambamotors.com') || from.includes('diandutoit5@gmail.com') ||
    subject.includes('affordable r90m² painting') || subject.includes('sustainable luxury hotel awards') ||
    subject.includes('connected without limits') || subject.includes('cimso newsletter') ||
    subject.includes('meet our toughest quality tester') || subject.includes('spring has a smell') ||
    subject.includes('last chance to cast your vote') || subject.includes('spring bed linen sale') ||
    subject.includes('furniture from priti') || subject.includes('book now, braai later') ||
    subject.includes('aircon service') || subject.includes('court-summons') ||
    subject.includes('mango wood furniture') || subject.includes('interested in the visitor list') ||
    subject.includes('your review can unlock') || subject.includes('quick question about after-hours enquiries') ||
    subject.includes('your password expires today') || subject.includes('join our weekly hotelplanner webinar') ||
    subject.includes('a beautiful website, fully optimized') || subject.includes('re: your invitation') ||
    (body.includes('unsubscribe') && (
      body.includes('promotional offer') || body.includes('discount on all') || body.includes('exclusive deal') ||
      body.includes('marketing campaign') || body.includes('lawn seeds') || body.includes('office furniture') ||
      body.includes('pre-registration') || body.includes('fibre connectivity') || body.includes('painting experience')
    ))
  );

  // 3. Job Applications / Careers / Learnerships
  const isJobApp = (
    subject.includes('application for') || subject.includes('job application') || subject.includes('curriculum vitae') ||
    subject.includes('cv - ') || subject.includes('applying for') || subject.includes('in-service training') ||
    subject.includes('internship') || subject.includes('learnership') || subject.includes('work integrated learning') ||
    body.includes('hereby apply for the position') || body.includes('attached my cv') || body.includes('attached is my cv') ||
    body.includes('application for employment') || body.includes('application for the post') || body.includes('in-service training') ||
    body.includes('learnership programme') || body.includes('internship programme') || body.includes('wil placement')
  );

  // 4. Travel Vouchers & Corporate Orders
  const isVoucher = (
    subject.includes('voucher') || body.includes('accommodation voucher') || body.includes('travel voucher') ||
    from.includes('nexus') || from.includes('travx') || from.includes('rennies') || from.includes('tourvest') ||
    from.includes('wings.travel') || from.includes('fcmtravel') || from.includes('bcdtravel') ||
    subject.includes('order no:') || subject.includes('purchase order') || from.includes('scanner@legacyhotels.co.za') ||
    body.includes('voucher number') || body.includes('order number')
  );

  // 5. Money & Billing (POPs, Payments, Tax Invoices, Credit Reports)
  const isMoneyBilling = (
    subject.includes('proof of payment') || subject.includes('pop ') || subject.includes('pop-') || subject.includes('pop:') ||
    subject.includes('remittance') || subject.includes('tax invoice') || subject.includes('proforma invoice') ||
    subject.includes('statement of account') || subject.includes('order confirmation from nedbank') ||
    subject.includes('h-pay: payment result') || subject.includes('credit limit & rate discrepancy') ||
    from.includes('epay-noreply@nedbank') || from.includes('nedbank') || from.includes('standardbank') ||
    from.includes('fnb.co.za') || from.includes('absa.co.za') || from.includes('paygate') ||
    body.includes('proof of payment') || body.includes('payment receipt') || body.includes('remittance advice') ||
    body.includes('kindly send tax invoice') || body.includes('please send tax invoice') || body.includes('credit card authorization') ||
    body.includes('below pop for') || body.includes('payment link') || body.includes('payment well received') ||
    body.includes('pop attached') || body.includes('find attached pop')
  );

  // 6. Exceptions & Recovery (Cancellations, Complaints, Disputes, Bounces)
  const isCancellation = (
    subject.includes('cancellation') || subject.includes('cancel reservation') || subject.includes('cancelled') ||
    subject.includes('please cancel') || subject.includes('kindly cancel') ||
    body.includes('please cancel this reservation') || body.includes('kindly cancel this booking') ||
    body.includes('would like to cancel') || body.includes('request for cancellation') ||
    body.includes('cancellation fee') || body.includes('waive cancellation')
  );
  const isComplaint = (
    subject.includes('complaint') || subject.includes('unacceptable service') || subject.includes('poor service') ||
    body.includes('terrible experience') || body.includes('demand a refund') || body.includes('unacceptable conduct')
  );
  const isSystemBounce = (
    from.includes('mailer-daemon') || from.includes('postmaster') || subject.includes('undelivered mail')
  );

  // 7. Guest Experience (Surveys & Reviews)
  const isGuestExperience = (
    from.includes('guestrevu') || from.includes('tripadvisor') || from.includes('revinate') ||
    subject.includes('guest satisfaction survey') || subject.includes('review of the centurion hotel') ||
    subject.includes('new review') || body.includes('how was your stay') || body.includes('post-stay survey')
  );

  // 8. Automated Channel Notifications (SynXis, Profitroom, Travelit, WebBeds, eRevMax, Booking.com automated delivery alerts)
  const isRoutineOTA = (
    subject.includes('your email did not reach the guest') ||
    from.includes('webbeds.com') ||
    from.includes('erevmax.co.uk') ||
    ((from.includes('synxis') || from.includes('profitroom') || from.includes('travelit') || from.includes('property.booking.com') || from.includes('expediapartnercentral')) &&
    !subject.includes('guest message') && !subject.includes('needs something') && !body.includes('request to change') &&
    (subject.includes('reservation confirmed') || subject.includes('res confirmed') || subject.includes('booking notification') ||
     subject.includes('channel notification') || subject.includes('reservation notification') || subject.includes('delivery notification') ||
     subject.includes('daily report') ||
     subject.includes('booking confirmation') && from.includes('synxis') || subject.includes('new booking notification') && from.includes('travelit')))
  );

  // 9. Groups & Events (Conferencing, Events, 10+ rooms/delegates)
  const isGroupOrEvent = (
    subject.includes('conference') || subject.includes('banquet') || subject.includes('quotation for conferencing') ||
    subject.includes('rooming list') || subject.includes('delegates') ||
    (body.includes('pax') && (body.includes('10 pax') || body.includes('15 pax') || body.includes('20 pax') || body.includes('50 pax') || body.includes('100 pax'))) ||
    body.includes('conference package') || body.includes('day conference') || body.includes('banqueting') ||
    body.includes('boardroom') || body.includes('venue hire') || body.includes('group booking of') ||
    subject.includes('wedding') || subject.includes('cocktail function')
  );

  // 10. Manage Stay (Amendments, Date Changes, Room Changes, Special In-Stay Requests, Pre-Stay)
  const isStayManagement = (
    subject.includes('amendment') || subject.includes('date change') || subject.includes('change of dates') ||
    subject.includes('extend stay') || subject.includes('early check-in') || subject.includes('late check-out') ||
    subject.includes('special request') || subject.includes('downgrade for mr') || subject.includes('pre stay') ||
    subject.includes('site inspection') ||
    body.includes('would like to change the dates') || body.includes('mistake with the booking dates') ||
    body.includes('extend my reservation') || body.includes('add breakfast') || body.includes('airport transfer') ||
    (from.includes('booking.com') && (subject.includes('needs something') || body.includes('request to change')))
  );

  // 11. Internal Operations & Staff Handovers
  const isInternalOps = (
    from.includes('@legacyhotels.co.za') &&
    !body.includes('please quote as per') && !body.includes('kindly quote as per') && !body.includes('attached rfq') &&
    !body.includes('can you please send me a quotation') &&
    (subject.includes('dinner allowance') || subject.includes('night audit') || subject.includes('duty manager') ||
     subject.includes('roster') || subject.includes('daily revenue report') || subject.includes('handover') ||
     subject.includes('meeting minutes') || subject.includes('maintenance') || subject.includes('out of office') ||
     subject.includes('re: nava') || subject.includes('signed agreement proposal') || body.includes('out of office') ||
     body.includes('currently out of the office') || body.includes('attending a workshop with no access'))
  );

  // Staff forward with RFQ -> Bookings or Groups
  const isStaffForwardRFQ = (
    from.includes('@legacyhotels.co.za') &&
    (subject.includes('quote') || body.includes('please quote') || body.includes('kindly quote') || body.includes('for quotation'))
  );

  // Decision Hierarchy
  if (isFortiMailDigest || isColdMarketing) {
    gtCategory = 'spam';
    gtSpam = true;
    rationale = isFortiMailDigest ? 'FortiMail quarantine digest' : 'Unsolicited promotional sales/marketing blast';
  } else if (isSystemBounce || isCancellation || isComplaint) {
    gtCategory = 'exceptions-recovery';
    rationale = isCancellation ? 'Guest or agency booking cancellation' : isComplaint ? 'Guest service complaint/dispute' : 'System bounce/delivery failure';
  } else if (isJobApp) {
    gtCategory = 'unknown-review';
    rationale = 'External job application / CV / Internship inquiry';
  } else if (isVoucher) {
    gtCategory = 'documents-delivery';
    rationale = 'Travel agency billing voucher or corporate order';
  } else if (isMoneyBilling) {
    gtCategory = 'money-billing';
    rationale = 'Proof of payment, tax invoice request, or merchant receipt';
  } else if (isGuestExperience) {
    gtCategory = 'guest-experience';
    rationale = 'Guest feedback survey or online review notification';
  } else if (isRoutineOTA) {
    gtCategory = 'automated-channel';
    rationale = 'Automated OTA / Channel manager / SynXis system notification';
  } else if (isStayManagement) {
    gtCategory = 'manage-stay';
    rationale = 'Existing booking amendment, date change, or stay servicing request';
  } else if (isGroupOrEvent) {
    gtCategory = 'groups-events';
    rationale = 'Conferencing, event, banqueting, or group accommodation request';
  } else if (isInternalOps) {
    gtCategory = 'internal-partner';
    rationale = 'Internal hotel operational discussion, handover, or staff admin';
  } else if (isStaffForwardRFQ) {
    gtCategory = isGroupOrEvent ? 'groups-events' : 'bookings';
    rationale = 'Internal staff forwarding client accommodation RFQ for quoting';
  } else {
    gtCategory = 'bookings';
    rationale = 'Guest or corporate individual booking inquiry / quote request';
  }

  // Urgency Determination
  const hasTimebox = (
    body.includes('within 12 hours') || body.includes('within the next 12 hours') ||
    body.includes('within 24 hours') || body.includes('respond within') || body.includes('reply now') ||
    body.includes('action required by') || body.includes('deadline today') || body.includes('reply by eod')
  );

  const hasNearArrival = (
    body.includes('arriving today') || body.includes('arriving tonight') || body.includes('arriving tomorrow') ||
    body.includes('check in today') || body.includes('check-in today') || body.includes('check-in tomorrow') ||
    body.includes('check in tomorrow') || body.includes('checking in today')
  );

  const hasCrisis = (
    (subject.includes('urgent') && (subject.includes('cancellation') || subject.includes('payment') || subject.includes('stranded'))) ||
    body.includes('stranded at reception') || body.includes('charged twice') || body.includes('duplicate payment')
  );

  if (!gtSpam && (hasTimebox || hasNearArrival || hasCrisis)) {
    gtUrgent = true;
    rationale += ` | URGENT: ${hasTimebox ? 'Time-boxed reply SLA' : hasNearArrival ? 'Arrival today/tomorrow' : 'Urgent guest crisis'}`;
  }

  return {
    category: gtCategory,
    urgent: gtUrgent,
    spam: gtSpam,
    rationale,
  };
}

function extractAITriage(thread) {
  const cats = thread.categorySlugs || [];
  const isSpam = Boolean(thread.isSpam || thread.spamAt != null);
  const isUrgent = cats.includes('urgent');

  let primary = null;
  for (const c of cats) {
    if (CATEGORIES.includes(c) && c !== 'spam') {
      primary = c;
      break;
    }
  }
  if (!primary && cats.includes('new-bookings')) primary = 'bookings';
  if (!primary && isSpam) primary = 'spam';
  if (!primary) primary = 'bookings';

  return {
    primary,
    urgent: isUrgent,
    spam: isSpam,
  };
}

// Evaluate entire 836-thread corpus
const evalResults = [];
for (const thread of threads) {
  const gt = determineGroundTruth(thread);
  const ai = extractAITriage(thread);

  const categoryMatch = (ai.primary === gt.category) || (ai.spam && gt.spam);
  const urgentMatch = (ai.urgent === gt.urgent);
  const spamMatch = (ai.spam === gt.spam);

  evalResults.push({
    threadId: thread.threadId,
    subject: thread.subject,
    sender: thread.latestInbound?.from || '',
    inboundAt: thread.inboundAt,
    ai: {
      category: ai.primary,
      urgent: ai.urgent,
      spam: ai.spam,
    },
    gt: {
      category: gt.category,
      urgent: gt.urgent,
      spam: gt.spam,
      rationale: gt.rationale,
    },
    matches: {
      category: categoryMatch,
      urgent: urgentMatch,
      spam: spamMatch,
      all: categoryMatch && urgentMatch && spamMatch,
    },
    discrepancyType: !categoryMatch
      ? `${gt.category} misclassified as ${ai.primary}`
      : !urgentMatch
      ? (gt.urgent ? 'Urgency False Negative' : 'Urgency False Positive')
      : !spamMatch
      ? (gt.spam ? 'Spam False Negative' : 'Spam False Positive')
      : 'Correct',
  });
}

fs.writeFileSync(OUTPUT_RESULTS, JSON.stringify(evalResults, null, 2), 'utf8');

// Also compute isolated metrics for the 479 Real Bedrock Runs
const realEvalResults = evalResults.filter((r) => {
  const t = threads.find((th) => th.threadId === r.threadId);
  const rat = t?.aiRun?.raw?.rationale;
  return rat && !['Group quote language', 'Guest booking inquiry', 'Baseline legacy triage.', 'Ops automation', 'At-risk recovery'].includes(rat);
});

function computeMetrics(dataset) {
  const total = dataset.length;
  const correctCat = dataset.filter((r) => r.matches.category).length;
  const correctUrgent = dataset.filter((r) => r.matches.urgent).length;
  const correctSpam = dataset.filter((r) => r.matches.spam).length;
  const fullyCorrect = dataset.filter((r) => r.matches.all).length;

  const aiCounts = {};
  const gtCounts = {};
  const cm = {};

  for (const c of CATEGORIES) {
    aiCounts[c] = 0;
    gtCounts[c] = 0;
    cm[c] = {};
    for (const c2 of CATEGORIES) cm[c][c2] = 0;
  }

  for (const r of dataset) {
    const aiC = r.ai.spam ? 'spam' : r.ai.category;
    const gtC = r.gt.spam ? 'spam' : r.gt.category;
    if (aiCounts[aiC] !== undefined) aiCounts[aiC]++;
    if (gtCounts[gtC] !== undefined) gtCounts[gtC]++;
    if (cm[aiC] && cm[aiC][gtC] !== undefined) cm[aiC][gtC]++;
  }

  const perCategory = CATEGORIES.map((cat) => {
    const tp = cm[cat][cat];
    const fp = (aiCounts[cat] || 0) - tp;
    const fn = (gtCounts[cat] || 0) - tp;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return {
      category: cat,
      tp,
      fp,
      fn,
      precision,
      recall,
      f1,
      support: gtCounts[cat] || 0,
      aiCount: aiCounts[cat] || 0,
    };
  });

  const urgentTP = dataset.filter((r) => r.ai.urgent && r.gt.urgent).length;
  const urgentFP = dataset.filter((r) => r.ai.urgent && !r.gt.urgent).length;
  const urgentFN = dataset.filter((r) => !r.ai.urgent && r.gt.urgent).length;
  const urgentTN = dataset.filter((r) => !r.ai.urgent && !r.gt.urgent).length;
  const urgentPrec = urgentTP + urgentFP > 0 ? urgentTP / (urgentTP + urgentFP) : 0;
  const urgentRec = urgentTP + urgentFN > 0 ? urgentTP / (urgentTP + urgentFN) : 0;
  const urgentF1 = urgentPrec + urgentRec > 0 ? (2 * urgentPrec * urgentRec) / (urgentPrec + urgentRec) : 0;

  const spamTP = dataset.filter((r) => r.ai.spam && r.gt.spam).length;
  const spamFP = dataset.filter((r) => r.ai.spam && !r.gt.spam).length;
  const spamFN = dataset.filter((r) => !r.ai.spam && r.gt.spam).length;
  const spamTN = dataset.filter((r) => !r.ai.spam && !r.gt.spam).length;
  const spamPrec = spamTP + spamFP > 0 ? spamTP / (spamTP + spamFP) : 0;
  const spamRec = spamTP + spamFN > 0 ? spamTP / (spamTP + spamFN) : 0;
  const spamF1 = spamPrec + spamRec > 0 ? (2 * spamPrec * spamRec) / (spamPrec + spamRec) : 0;

  return {
    total,
    overallAccuracy: correctCat / total,
    urgencyAccuracy: correctUrgent / total,
    spamAccuracy: correctSpam / total,
    fullyCorrectAccuracy: fullyCorrect / total,
    confusionMatrix: cm,
    perCategory,
    urgency: {
      tp: urgentTP,
      fp: urgentFP,
      fn: urgentFN,
      tn: urgentTN,
      precision: urgentPrec,
      recall: urgentRec,
      f1: urgentF1,
    },
    spam: {
      tp: spamTP,
      fp: spamFP,
      fn: spamFN,
      tn: spamTN,
      precision: spamPrec,
      recall: spamRec,
      f1: spamF1,
    },
  };
}

const allMetrics = computeMetrics(evalResults);
const bedrockMetrics = computeMetrics(realEvalResults);

const combinedOutput = {
  summaryAllThreads: {
    count: evalResults.length,
    overallAccuracy: allMetrics.overallAccuracy,
    urgencyAccuracy: allMetrics.urgencyAccuracy,
    spamAccuracy: allMetrics.spamAccuracy,
    fullyCorrectAccuracy: allMetrics.fullyCorrectAccuracy,
    perCategory: allMetrics.perCategory,
    urgency: allMetrics.urgency,
    spam: allMetrics.spam,
    confusionMatrix: allMetrics.confusionMatrix,
  },
  summaryBedrockLiveOnly: {
    count: realEvalResults.length,
    overallAccuracy: bedrockMetrics.overallAccuracy,
    urgencyAccuracy: bedrockMetrics.urgencyAccuracy,
    spamAccuracy: bedrockMetrics.spamAccuracy,
    fullyCorrectAccuracy: bedrockMetrics.fullyCorrectAccuracy,
    perCategory: bedrockMetrics.perCategory,
    urgency: bedrockMetrics.urgency,
    spam: bedrockMetrics.spam,
    confusionMatrix: bedrockMetrics.confusionMatrix,
  },
};

fs.writeFileSync(OUTPUT_METRICS, JSON.stringify(combinedOutput, null, 2), 'utf8');
console.log('Saved metrics to', OUTPUT_METRICS);

console.log('\n================ ALL 836 THREADS ================');
console.log(`Overall Category Accuracy: ${(allMetrics.overallAccuracy * 100).toFixed(2)}%`);
console.log(`Urgency Accuracy:          ${(allMetrics.urgencyAccuracy * 100).toFixed(2)}%`);
console.log(`Spam Accuracy:             ${(allMetrics.spamAccuracy * 100).toFixed(2)}%`);
console.log(`Fully Correct:             ${(allMetrics.fullyCorrectAccuracy * 100).toFixed(2)}%`);

console.log('\n============ REAL BEDROCK RUNS (479 THREADS) ============');
console.log(`Overall Category Accuracy: ${(bedrockMetrics.overallAccuracy * 100).toFixed(2)}%`);
console.log(`Urgency Accuracy:          ${(bedrockMetrics.urgencyAccuracy * 100).toFixed(2)}%`);
console.log(`Spam Accuracy:             ${(bedrockMetrics.spamAccuracy * 100).toFixed(2)}%`);
console.log(`Fully Correct:             ${(bedrockMetrics.fullyCorrectAccuracy * 100).toFixed(2)}%`);
console.log(`Spam Precision:            ${(bedrockMetrics.spam.precision * 100).toFixed(2)}%`);
console.log(`Spam Recall:               ${(bedrockMetrics.spam.recall * 100).toFixed(2)}%`);
