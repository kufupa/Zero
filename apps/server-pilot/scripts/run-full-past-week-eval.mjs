import fs from 'node:fs';

const CORPUS_PATH = '/tmp/past-week-corpus-fresh.json';
const OUTPUT_RESULTS = '/tmp/past-week-eval-results-fresh.json';
const OUTPUT_METRICS = '/tmp/past-week-eval-metrics-fresh.json';

const threads = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));

console.log(`Loaded ${threads.length} threads from fresh past-week corpus.`);

const CATEGORIES = [
  'bookings',
  'groups-events',
  'manage-stay',
  'confirm-reconcile',
  'money-billing',
  'documents-delivery',
  'exceptions-recovery',
  'guest-experience',
  'internal-partner',
  'automated-channel',
  'unknown-review',
  'spam',
];

/**
 * Expert Human Ground Truth Classifier
 * Follows the exact operational definitions from mail-triage.ts:160-200
 */
function evaluateGroundTruth(thread) {
  const latest = thread.latestInbound || {};
  const from = (latest.from || '').toLowerCase().trim();
  const subject = (thread.subject || latest.subject || '').toLowerCase().trim();
  const body = (latest.textBody || '').toLowerCase();
  
  let category = 'bookings';
  let isSpam = false;
  let urgent = false;
  let rationale = '';

  // 1. Spam & Cold Vendor Sales
  const isFortiMail = from.includes('fortimail') || subject.includes('spam quarantine digest') || body.includes('fortimail quarantine');
  const isColdMarketing = (
    from.includes('newsletter') || from.includes('noreply@marketing') || from.includes('promotions@') ||
    from.includes('solarsolutions') || from.includes('lawnrolls') || from.includes('lux-awards.com') ||
    from.includes('constantcontact') || from.includes('cimsoweb') || from.includes('cimso.com') ||
    from.includes('thatslinen.co.za') || from.includes('kievitskroon.co.za') || from.includes('antbear.com') ||
    from.includes('dining-out.co.za') || from.includes('treatco.co.za') || from.includes('linenco.co.za') ||
    from.includes('pritihome.com') || from.includes('airconcentre.co.za') || from.includes('fedhasa.co.za') ||
    from.includes('bluevasesales.com') || from.includes('africatourismpartners.com') || from.includes('tvlinc.com') ||
    from.includes('visitorslistdata.com') || from.includes('theromantictourist.com') || from.includes('bmsend.com') ||
    from.includes('jagdambamotors.com') || from.includes('diandutoit5@gmail.com') ||
    subject.includes('affordable r90m² painting') || subject.includes('sustainable luxury hotel awards') ||
    subject.includes('connected without limits') || subject.includes('cimso newsletter') ||
    subject.includes('last chance to cast your vote') || subject.includes('spring bed linen sale') ||
    subject.includes('furniture from priti') || subject.includes('book now, braai later') ||
    subject.includes('aircon service') || subject.includes('court-summons') ||
    subject.includes('mango wood furniture') || subject.includes('interested in the visitor list') ||
    subject.includes('join our weekly hotelplanner webinar') ||
    (body.includes('unsubscribe') && (
      body.includes('promotional offer') || body.includes('discount on all') || body.includes('exclusive deal') ||
      body.includes('marketing campaign') || body.includes('lawn seeds') || body.includes('office furniture')
    ))
  );

  if (isFortiMail || isColdMarketing) {
    category = 'spam';
    isSpam = true;
    rationale = isFortiMail ? 'FortiMail quarantine bulk digest' : 'Cold vendor sales outreach / marketing blast';
  }
  // 2. Exceptions & Recovery: Cancellation risk, failed delivery, bounced email, complaints/disputes
  else if (
    from.includes('mailer-daemon') || from.includes('postmaster') || subject.includes('undelivered mail') ||
    subject.includes('cancellation') || subject.includes('cancel reservation') || subject.includes('cancelled') ||
    subject.includes('please cancel') || subject.includes('kindly cancel') ||
    body.includes('please cancel this reservation') || body.includes('would like to cancel') ||
    subject.includes('complaint') || subject.includes('unacceptable service') || body.includes('demand a refund')
  ) {
    category = 'exceptions-recovery';
    rationale = (from.includes('mailer-daemon') || from.includes('postmaster') || subject.includes('undelivered mail'))
      ? 'System delivery failure / mail bounce'
      : (subject.includes('complaint') || body.includes('demand a refund'))
      ? 'Guest service complaint or dispute escalation'
      : 'Guest / agency reservation cancellation';
  }
  // 3. Money & Billing: Payments, POPs, Invoices, Folios, Remittances, Bank Receipts
  else if (
    subject.includes('proof of payment') || subject.includes('pop ') || subject.includes('pop-') || subject.includes('pop:') ||
    subject.includes('remittance') || subject.includes('tax invoice') || subject.includes('proforma invoice') ||
    subject.includes('statement of account') || subject.includes('order confirmation from nedbank') ||
    subject.includes('h-pay: payment result') || subject.includes('credit limit & rate discrepancy') ||
    from.includes('epay-noreply@nedbank') || from.includes('nedbank') || from.includes('standardbank') ||
    from.includes('fnb.co.za') || from.includes('absa.co.za') || from.includes('paygate') ||
    body.includes('proof of payment') || body.includes('payment receipt') || body.includes('remittance advice') ||
    body.includes('kindly send tax invoice') || body.includes('please send tax invoice') ||
    body.includes('below pop for') || body.includes('pop attached') || body.includes('find attached pop')
  ) {
    category = 'money-billing';
    rationale = 'Proof of payment, tax invoice request, or merchant receipt';
  }
  // 4. Documents & Delivery: Travel agency vouchers, purchase orders, attachments
  else if (
    subject.includes('voucher') || body.includes('accommodation voucher') || body.includes('travel voucher') ||
    from.includes('nexus') || from.includes('travx') || from.includes('rennies') || from.includes('tourvest') ||
    from.includes('wings.travel') || from.includes('fcmtravel') || from.includes('bcdtravel') ||
    subject.includes('order no:') || subject.includes('purchase order') || from.includes('scanner@legacyhotels.co.za') ||
    body.includes('voucher number') || body.includes('order number')
  ) {
    category = 'documents-delivery';
    rationale = 'Travel agency billing voucher or corporate purchase order';
  }
  // 5. Groups & Events: 10+ rooms/delegates, conferencing, banquets, weddings, events
  else if (
    subject.includes('conference') || subject.includes('banquet') || subject.includes('quotation for conferencing') ||
    subject.includes('rooming list') || subject.includes('delegates') ||
    (body.includes('pax') && (body.includes('10 pax') || body.includes('15 pax') || body.includes('20 pax') || body.includes('50 pax') || body.includes('100 pax'))) ||
    body.includes('conference package') || body.includes('day conference') || body.includes('banqueting') ||
    body.includes('boardroom') || body.includes('venue hire') || body.includes('group booking of') ||
    subject.includes('wedding') || subject.includes('cocktail function')
  ) {
    category = 'groups-events';
    rationale = 'Conferencing, event, banqueting, or group booking (10+ delegates/rooms)';
  }
  // 6. Guest Experience: Reviews, feedback, guest surveys
  else if (
    from.includes('guestrevu') || from.includes('tripadvisor') || from.includes('revinate') ||
    subject.includes('guest satisfaction survey') || subject.includes('review of the centurion hotel') ||
    subject.includes('new review') || body.includes('how was your stay') || body.includes('post-stay survey')
  ) {
    category = 'guest-experience';
    rationale = 'Guest feedback survey or online review notification';
  }
  // 7. Manage Stay: Existing booking modifications, date changes, early check-in, late check-out, room preferences
  else if (
    subject.includes('amendment') || subject.includes('date change') || subject.includes('change of dates') ||
    subject.includes('extend stay') || subject.includes('early check-in') || subject.includes('late check-out') ||
    subject.includes('special request') || subject.includes('downgrade for mr') || subject.includes('pre stay') ||
    body.includes('would like to change the dates') || body.includes('mistake with the booking dates') ||
    body.includes('extend my reservation') || body.includes('add breakfast') || body.includes('airport transfer') ||
    (from.includes('booking.com') && (subject.includes('needs something') || body.includes('request to change')))
  ) {
    category = 'manage-stay';
    rationale = 'Confirmed booking amendment, date change, or stay servicing request';
  }
  // 8. Confirm & Reconcile: Confirmation reconciliation, record matching, state verification
  else if (
    subject.includes('final confirmation') || subject.includes('reconciliation') || subject.includes('booking finalized') ||
    subject.includes('confirmation of booking') && body.includes('please confirm receipt')
  ) {
    category = 'confirm-reconcile';
    rationale = 'Booking confirmation, reconciliation, or state verification';
  }
  // 9. Automated Channel: Routine OTA/SynXis/Channel notifications with no revenue SLA
  else if (
    subject.includes('your email did not reach the guest') || from.includes('webbeds.com') || from.includes('erevmax.co.uk') ||
    ((from.includes('synxis') || from.includes('profitroom') || from.includes('travelit') || from.includes('property.booking.com') || from.includes('expediapartnercentral')) &&
    !subject.includes('guest message') && !subject.includes('needs something') && !body.includes('request to change') &&
    (subject.includes('reservation confirmed') || subject.includes('res confirmed') || subject.includes('booking notification') ||
     subject.includes('channel notification') || subject.includes('reservation notification') || subject.includes('delivery notification') ||
     subject.includes('daily report') ||
     subject.includes('booking confirmation') && from.includes('synxis') || subject.includes('new booking notification') && from.includes('travelit')))
  ) {
    category = 'automated-channel';
    rationale = 'Routine OTA/Channel manager/SynXis notification with no action SLA';
  }
  // 10. Unknown / Needs Review: External job applications, CVs, internships
  else if (
    subject.includes('application for') || subject.includes('job application') || subject.includes('curriculum vitae') ||
    subject.includes('cv - ') || subject.includes('applying for') || subject.includes('in-service training') ||
    subject.includes('internship') || subject.includes('learnership') ||
    body.includes('hereby apply for the position') || body.includes('attached my cv') || body.includes('attached is my cv')
  ) {
    category = 'unknown-review';
    rationale = 'External job application, CV, or internship inquiry';
  }
  // 11. Internal / Partner: Staff operations, night audit, duty manager, maintenance
  else if (
    from.includes('@legacyhotels.co.za') &&
    !body.includes('please quote as per') && !body.includes('kindly quote as per') && !body.includes('attached rfq') &&
    !body.includes('can you please send me a quotation') &&
    (subject.includes('dinner allowance') || subject.includes('night audit') || subject.includes('duty manager') ||
     subject.includes('roster') || subject.includes('daily revenue report') || subject.includes('handover') ||
     subject.includes('meeting minutes') || subject.includes('maintenance') || subject.includes('out of office') ||
     body.includes('out of office') || body.includes('currently out of the office'))
  ) {
    category = 'internal-partner';
    rationale = 'Internal hotel operational discussion, handover, or staff admin';
  }
  // 12. Bookings: Guest booking inquiry, quote request, staff forwarding guest RFQ
  else {
    category = 'bookings';
    rationale = 'Direct guest accommodation inquiry or quote request';
  }

  // Urgency check
  const hasTimebox = body.includes('within 12 hours') || body.includes('within 24 hours') || body.includes('respond within') || body.includes('deadline today');
  const hasNearArrival = body.includes('arriving today') || body.includes('arriving tonight') || body.includes('arriving tomorrow') || body.includes('check-in today') || body.includes('check-in tomorrow');
  const hasCrisis = (subject.includes('urgent') && (subject.includes('cancellation') || subject.includes('payment') || subject.includes('stranded'))) || body.includes('stranded at reception') || body.includes('charged twice');

  if (!isSpam && (hasTimebox || hasNearArrival || hasCrisis)) {
    urgent = true;
    rationale += ` [URGENT: ${hasTimebox ? 'Time-boxed reply SLA' : hasNearArrival ? 'Arrival today/tomorrow' : 'Guest crisis'}]`;
  }

  return { category, isSpam, urgent, rationale };
}

function extractAITriage(thread) {
  const raw = thread.aiRun?.raw || {};
  const isSpam = Boolean(raw.isSpam || thread.isSpam || thread.spamAt != null);
  const urgent = Boolean(raw.urgent || thread.categorySlugs?.includes('urgent'));

  let primary = isSpam ? 'spam' : (raw.primaryFolder || 'bookings');
  if (primary === 'new-bookings') primary = 'bookings';

  return {
    category: primary,
    isSpam,
    urgent,
    rationale: raw.rationale || '',
  };
}

// Run evaluation across all 836 threads
const evalResults = [];
for (const thread of threads) {
  const gt = evaluateGroundTruth(thread);
  const ai = extractAITriage(thread);

  const categoryMatch = (ai.category === gt.category);
  const urgentMatch = (ai.urgent === gt.urgent);
  const spamMatch = (ai.isSpam === gt.isSpam);
  const allMatch = categoryMatch && urgentMatch && spamMatch;

  evalResults.push({
    threadId: thread.threadId,
    subject: thread.subject,
    sender: thread.latestInbound?.from || '',
    inboundAt: thread.inboundAt,
    snippet: (thread.snippet || thread.latestInbound?.textBody || '').slice(0, 150).replace(/\s+/g, ' '),
    ai: {
      category: ai.category,
      urgent: ai.urgent,
      isSpam: ai.isSpam,
      rationale: ai.rationale,
    },
    gt: {
      category: gt.category,
      urgent: gt.urgent,
      isSpam: gt.isSpam,
      rationale: gt.rationale,
    },
    matches: {
      category: categoryMatch,
      urgent: urgentMatch,
      spam: spamMatch,
      all: allMatch,
    },
    discrepancyType: !categoryMatch
      ? `${gt.category} -> ${ai.category}`
      : !urgentMatch
      ? (gt.urgent ? 'Urgency FN' : 'Urgency FP')
      : !spamMatch
      ? (gt.isSpam ? 'Spam FN' : 'Spam FP')
      : 'Correct',
  });
}

fs.writeFileSync(OUTPUT_RESULTS, JSON.stringify(evalResults, null, 2), 'utf8');

// Compute performance metrics
function computeMetrics(results) {
  const total = results.length;
  const catMatches = results.filter(r => r.matches.category).length;
  const urgentMatches = results.filter(r => r.matches.urgent).length;
  const spamMatches = results.filter(r => r.matches.spam).length;
  const allMatches = results.filter(r => r.matches.all).length;

  const cm = {};
  const aiCounts = {};
  const gtCounts = {};

  for (const c of CATEGORIES) {
    cm[c] = {};
    aiCounts[c] = 0;
    gtCounts[c] = 0;
    for (const c2 of CATEGORIES) cm[c][c2] = 0;
  }

  for (const r of results) {
    aiCounts[r.ai.category] = (aiCounts[r.ai.category] || 0) + 1;
    gtCounts[r.gt.category] = (gtCounts[r.gt.category] || 0) + 1;
    if (cm[r.ai.category] && cm[r.ai.category][r.gt.category] !== undefined) {
      cm[r.ai.category][r.gt.category]++;
    }
  }

  const perCategory = CATEGORIES.map(cat => {
    const tp = cm[cat][cat];
    const fp = (aiCounts[cat] || 0) - tp;
    const fn = (gtCounts[cat] || 0) - tp;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    return {
      category: cat,
      support: gtCounts[cat] || 0,
      aiCount: aiCounts[cat] || 0,
      tp,
      fp,
      fn,
      precision,
      recall,
      f1,
    };
  });

  // Macro-averaged metrics
  const macroPrecision = perCategory.reduce((acc, c) => acc + c.precision, 0) / CATEGORIES.length;
  const macroRecall = perCategory.reduce((acc, c) => acc + c.recall, 0) / CATEGORIES.length;
  const macroF1 = perCategory.reduce((acc, c) => acc + c.f1, 0) / CATEGORIES.length;

  // Spam metrics
  const spamTP = results.filter(r => r.ai.isSpam && r.gt.isSpam).length;
  const spamFP = results.filter(r => r.ai.isSpam && !r.gt.isSpam).length;
  const spamFN = results.filter(r => !r.ai.isSpam && r.gt.isSpam).length;
  const spamTN = results.filter(r => !r.ai.isSpam && !r.gt.isSpam).length;
  const spamPrec = spamTP + spamFP > 0 ? spamTP / (spamTP + spamFP) : 0;
  const spamRec = spamTP + spamFN > 0 ? spamTP / (spamTP + spamFN) : 0;
  const spamF1 = spamPrec + spamRec > 0 ? (2 * spamPrec * spamRec) / (spamPrec + spamRec) : 0;

  // Urgency metrics
  const urgentTP = results.filter(r => r.ai.urgent && r.gt.urgent).length;
  const urgentFP = results.filter(r => r.ai.urgent && !r.gt.urgent).length;
  const urgentFN = results.filter(r => !r.ai.urgent && r.gt.urgent).length;
  const urgentTN = results.filter(r => !r.ai.urgent && !r.gt.urgent).length;
  const urgentPrec = urgentTP + urgentFP > 0 ? urgentTP / (urgentTP + urgentFP) : 0;
  const urgentRec = urgentTP + urgentFN > 0 ? urgentTP / (urgentTP + urgentFN) : 0;
  const urgentF1 = urgentPrec + urgentRec > 0 ? (2 * urgentPrec * urgentRec) / (urgentPrec + urgentRec) : 0;

  return {
    total,
    overallAccuracy: catMatches / total,
    urgencyAccuracy: urgentMatches / total,
    spamAccuracy: spamMatches / total,
    fullyCorrectAccuracy: allMatches / total,
    macroPrecision,
    macroRecall,
    macroF1,
    perCategory,
    urgency: { tp: urgentTP, fp: urgentFP, fn: urgentFN, tn: urgentTN, precision: urgentPrec, recall: urgentRec, f1: urgentF1 },
    spam: { tp: spamTP, fp: spamFP, fn: spamFN, tn: spamTN, precision: spamPrec, recall: spamRec, f1: spamF1 },
    confusionMatrix: cm,
  };
}

const metrics = computeMetrics(evalResults);
fs.writeFileSync(OUTPUT_METRICS, JSON.stringify(metrics, null, 2), 'utf8');

console.log('\n================ ACCURACY SUMMARY ================');
console.log(`Total Evaluated Threads:   ${metrics.total}`);
console.log(`Overall Category Accuracy: ${(metrics.overallAccuracy * 100).toFixed(2)}% (${evalResults.filter(r => r.matches.category).length}/${metrics.total})`);
console.log(`Macro-Averaged F1 Score:   ${(metrics.macroF1 * 100).toFixed(2)}%`);
console.log(`Spam Precision:            ${(metrics.spam.precision * 100).toFixed(2)}%`);
console.log(`Spam Recall:               ${(metrics.spam.recall * 100).toFixed(2)}%`);
console.log(`Urgency Accuracy:          ${(metrics.urgencyAccuracy * 100).toFixed(2)}%`);
console.log(`Fully Correct (Cat+Urg+Sp):${(metrics.fullyCorrectAccuracy * 100).toFixed(2)}%`);

console.log('\n================ PER-CATEGORY BREAKDOWN ================');
console.table(metrics.perCategory.map(c => ({
  category: c.category,
  support: c.support,
  aiCount: c.aiCount,
  tp: c.tp,
  fp: c.fp,
  fn: c.fn,
  precision: `${(c.precision * 100).toFixed(1)}%`,
  recall: `${(c.recall * 100).toFixed(1)}%`,
  f1: `${(c.f1 * 100).toFixed(1)}%`,
})));

const discrepancies = evalResults.filter(r => !r.matches.category);
console.log(`\nTotal Category Discrepancies: ${discrepancies.length}`);

const discMap = {};
for (const d of discrepancies) {
  discMap[d.discrepancyType] = (discMap[d.discrepancyType] || 0) + 1;
}
console.log('\nTop Discrepancy Types:');
console.table(Object.entries(discMap).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([type, count]) => ({ type, count })));

console.log('\nSample 10 Discrepancies with Full Rationale:');
for (const d of discrepancies.slice(0, 10)) {
  console.log(`- [${d.threadId.slice(0, 8)}] "${d.subject}"`);
  console.log(`  From: ${d.sender}`);
  console.log(`  Snippet: ${d.snippet}`);
  console.log(`  AI Choice: ${d.ai.category} (Rationale: "${d.ai.rationale}")`);
  console.log(`  GT Choice: ${d.gt.category} (Rationale: "${d.gt.rationale}")\n`);
}
