import fs from 'node:fs';

const CORPUS_PATH = process.env.CORPUS_PATH || '/tmp/past-week-corpus-fresh.json';
const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));

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
  'confirm-reconcile',
  'spam',
];

export function determineGroundTruth(thread) {
  const latest = thread.latestInbound || {};
  const from = (latest.from || '').toLowerCase().trim();
  const subject = (thread.subject || latest.subject || '').toLowerCase().trim();
  const body = (latest.textBody || '').toLowerCase();

  let gtCategory = 'bookings';
  let gtUrgent = false;
  let gtSpam = false;
  let rationale = '';

  const isRealGuest = (
    from.includes('expedia') || from.includes('booking.com') || from.includes('lekkeslaap') ||
    subject.includes('guest message') || subject.includes('booking finalised') ||
    subject.includes('quotation for accommodation')
  );

  const isFortiMailDigest = (
    from.includes('fortimail') || subject.includes('spam quarantine digest') || body.includes('fortimail quarantine')
  );

  const isColdMarketing = !isRealGuest && (
    from.includes('lawnrolls') || from.includes('newsletter') || from.includes('noreply@marketing') ||
    from.includes('solarsolutions') || from.includes('industrial') || from.includes('promotions@') ||
    from.includes('lux-awards.com') || from.includes('constantcontact') || from.includes('cimsoweb') ||
    from.includes('cimso.com') || from.includes('outboxed.co.za') || from.includes('thatslinen.co.za') ||
    from.includes('kievitskroon.co.za') || from.includes('antbear.com') || from.includes('dining-out.co.za') ||
    from.includes('treatco.co.za') || from.includes('linenco.co.za') || from.includes('pritihome.com') ||
    from.includes('cleaningspecialistscenturion') || from.includes('airconcentre.co.za') ||
    from.includes('crystalmount.co.za') || from.includes('tourismreview.eu') || from.includes('fedhasa.co.za') ||
    from.includes('prodis.co.za') || from.includes('hellolifestyle.co.za') || from.includes('daisy.co.za') ||
    from.includes('bluevasesales.com') || from.includes('africatourismpartners.com') ||
    from.includes('tvlinc.com') || from.includes('pritiinternational.com') || from.includes('hoteltechreport.com') ||
    from.includes('visitorslistdata.com') || from.includes('theromantictourist.com') || from.includes('itlogic.co.za') ||
    from.includes('bmsend.com') || from.includes('jagdambamotors.com') || from.includes('diandutoit5@gmail.com') ||
    from.includes('eatout.co.za') || from.includes('expertclean.co.za') || from.includes('za-icl.co.za') ||
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
    subject.includes('brandy is having its moment') || subject.includes('the pantry staples') ||
    subject.includes('spring 2026 is here') || subject.includes('ai-driven budgeting') ||
    (body.includes('unsubscribe') && (
      body.includes('promotional offer') || body.includes('discount on all') || body.includes('exclusive deal') ||
      body.includes('marketing campaign') || body.includes('lawn seeds') || body.includes('office furniture') ||
      body.includes('pre-registration') || body.includes('fibre connectivity') || body.includes('painting experience')
    ))
  );

  const isJobApp = (
    subject.includes('application for') || subject.includes('job application') || subject.includes('curriculum vitae') ||
    subject.includes('cv - ') || subject.includes('applying for') || subject.includes('in-service training') ||
    subject.includes('internship') || subject.includes('learnership') || subject.includes('work integrated learning') ||
    body.includes('hereby apply for the position') || body.includes('attached my cv') || body.includes('attached is my cv') ||
    body.includes('application for employment') || body.includes('application for the post') || body.includes('in-service training') ||
    body.includes('learnership programme') || body.includes('internship programme') || body.includes('wil placement')
  );

  const isVoucher = (
    (subject.includes('voucher') || body.includes('accommodation voucher') || body.includes('travel voucher') ||
     from.includes('nexus') || from.includes('travx') || from.includes('rennies') ||
     (from.includes('tourvest') && !from.includes('tourvest-mice')) ||
     from.includes('wings.travel') || from.includes('fcmtravel') || from.includes('bcdtravel') ||
     subject.includes('order no:') || subject.includes('purchase order') || from.includes('scanner@legacyhotels.co.za') ||
     body.includes('voucher number') || body.includes('order number')) &&
    !subject.includes('invoice') && !body.includes('tax invoice') && !body.includes('please invoice')
  );

  const isMoneyBilling = (
    !subject.includes('quotation') && !subject.includes('quote') && !subject.includes('rooming list') &&
    !subject.includes('night audit') && !from.includes('centurionnight@') &&
    (
      subject.includes('proof of payment') || subject.includes('pop ') || subject.includes('pop-') || subject.includes('pop:') ||
      subject.includes('remittance') || subject.includes('tax invoice') || subject.includes('proforma invoice') ||
      subject.includes('statement of account') || subject.includes('order confirmation from nedbank') ||
      subject.includes('h-pay: payment result') || subject.includes('bank letter') ||
      subject.includes('invoice') || subject.includes('outstanding payment') || subject.includes('open folio') ||
      from.includes('epay-noreply@nedbank') || from.includes('nedbank') || from.includes('standardbank') ||
      from.includes('fnb.co.za') || from.includes('absa.co.za') || from.includes('paygate') ||
      body.includes('proof of payment') || body.includes('payment receipt') || body.includes('remittance advice') ||
      body.includes('kindly send tax invoice') || body.includes('please send tax invoice') || body.includes('credit card authorization') ||
      body.includes('below pop for') || body.includes('payment link') || body.includes('payment well received') ||
      body.includes('pop attached') || body.includes('find attached pop') ||
      (body.includes('banking details') && (subject.includes('bank') || body.includes('confirm banking details') || body.includes('send banking details') || body.includes('payment')))
    )
  );

  const isRoutineOTA = (
    subject.includes('your email did not reach the guest') ||
    from.includes('webbeds.com') ||
    from.includes('erevmax.co.uk') ||
    (from.includes('synxis') && !subject.includes('guest message')) ||
    (from.includes('profitroom') && (subject.includes('purchase confirmation') || subject.includes('booking confirmed') || subject.includes('reservation'))) ||
    (from.includes('travelit') && (subject.includes('booking') || subject.includes('travelit'))) ||
    (from.includes('property.booking.com') && !subject.includes('guest message') && !subject.includes('needs something')) ||
    (from.includes('booking.com') && !subject.includes('guest message') && !subject.includes('needs something') && !body.includes('request to change') &&
     (subject.includes('confirmed') || subject.includes('booking notification') || subject.includes('delivery notification') || subject.includes('new booking'))) ||
    (from.includes('trip.com') && subject.includes('reservation')) ||
    (from.includes('tbo.com') && subject.includes('booking'))
  );

  const isCancellation = !isRoutineOTA && (
    subject.includes('cancellation') || subject.includes('cancel reservation') || subject.includes('cancelled') ||
    subject.includes('please cancel') || subject.includes('kindly cancel') ||
    /\b(?:please|kindly|could you|can you)\s+(?:\w+\s+){0,4}(?:cancel|release)\b/i.test(body) ||
    body.includes('please cancel this reservation') || body.includes('kindly cancel this booking') ||
    body.includes('would like to cancel') || body.includes('request for cancellation') ||
    body.includes('cannot stay over') || body.includes('double booking')
  );

  const isComplaint = (
    subject.includes('complaint') || subject.includes('unacceptable service') || subject.includes('poor service') ||
    body.includes('terrible experience') || body.includes('demand a refund') || body.includes('unacceptable conduct')
  );

  const isSystemBounce = (
    from.includes('mailer-daemon') || from.includes('postmaster') || subject.includes('undelivered mail')
  );

  const isGuestExperience = (
    from.includes('guestrevu') || from.includes('tripadvisor') || from.includes('revinate') ||
    subject.includes('guest satisfaction survey') || subject.includes('review of the centurion hotel') ||
    subject.includes('new review') || body.includes('how was your stay') || body.includes('post-stay survey')
  );

  const isGroupOrEvent = (
    subject.includes('conference') || subject.includes('banquet') || subject.includes('quotation for conferencing') ||
    subject.includes('rooming list') || subject.includes('delegates') || subject.includes('group accommodation') ||
    from.includes('tourvest-mice') ||
    /\b(?:[1-9][0-9]+)\s*pax\b/i.test(body) || /\b(?:[1-9][0-9]+)\s*rooms\b/i.test(body) ||
    body.includes('conference package') || body.includes('day conference') || body.includes('banqueting') ||
    body.includes('boardroom') || body.includes('venue hire') || body.includes('group booking of') ||
    subject.includes('wedding') || subject.includes('cocktail function')
  );

  const isStayManagement = (
    subject.includes('amendment') || subject.includes('date change') || subject.includes('change of dates') ||
    subject.includes('extend stay') || subject.includes('early check-in') || subject.includes('late check-out') ||
    subject.includes('special request') || subject.includes('downgrade for mr') || subject.includes('pre stay') ||
    subject.includes('site inspection') || subject.includes('guest message') || subject.includes('breakfast pack') ||
    from.includes('expediapartnercentral') ||
    body.includes('would like to change the dates') || body.includes('mistake with the booking dates') ||
    body.includes('extend my reservation') || body.includes('add breakfast') || body.includes('airport transfer') ||
    body.includes('airport shuttle') || body.includes('mobility issues') ||
    (from.includes('booking.com') && (subject.includes('needs something') || body.includes('request to change')))
  );

  const isInternalOps = (
    (from.includes('@legacyhotels.co.za') || from.includes('support@legacyhotels.co.za') || from.includes('scans@legacyhotels.co.za')) &&
    !body.includes('please quote as per') && !body.includes('kindly quote as per') && !body.includes('attached rfq') &&
    !body.includes('can you please send me a quotation') &&
    (subject.includes('dinner allowance') || subject.includes('night audit') || subject.includes('duty manager') ||
     subject.includes('dm report') || subject.includes('scans') ||
     subject.includes('roster') || subject.includes('daily revenue report') || subject.includes('handover') ||
     subject.includes('meeting minutes') || subject.includes('maintenance') || subject.includes('out of office') ||
     subject.includes('re: nava') || subject.includes('signed agreement proposal') || body.includes('out of office') ||
     subject.includes('discrepancy report') || subject.includes('unexpected stayover') || subject.includes('no-show report') ||
     subject.includes('restart') || subject.includes('server') || subject.includes('taskalfa') || subject.includes('front office update') ||
     body.includes('currently out of the office') || body.includes('attending a workshop with no access'))
  );

  const isStaffForwardRFQ = (
    from.includes('@legacyhotels.co.za') &&
    (subject.includes('quote') || body.includes('please quote') || body.includes('kindly quote') || body.includes('for quotation'))
  );

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
  } else if (isRoutineOTA) {
    gtCategory = 'automated-channel';
    rationale = 'Automated OTA / Channel manager / SynXis system notification';
  } else if (isMoneyBilling) {
    gtCategory = 'money-billing';
    rationale = 'Proof of payment, tax invoice request, or merchant receipt';
  } else if (isVoucher) {
    gtCategory = 'documents-delivery';
    rationale = 'Travel agency billing voucher or corporate order';
  } else if (isGuestExperience) {
    gtCategory = 'guest-experience';
    rationale = 'Guest feedback survey or online review notification';
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
    rationale += ` | URGENT`;
  }

  return { category: gtCategory, spam: gtSpam, urgent: gtUrgent, rationale };
}

function calcMetrics(preds, groundTruths) {
  let correct = 0;
  const perCat = {};
  for (const c of CATEGORIES) {
    perCat[c] = { tp: 0, fp: 0, fn: 0, support: 0, predCount: 0 };
  }
  for (let i = 0; i < preds.length; i++) {
    const p = preds[i].spam ? 'spam' : preds[i].category;
    const g = groundTruths[i].spam ? 'spam' : groundTruths[i].category;
    if (perCat[g]) perCat[g].support++;
    if (perCat[p]) perCat[p].predCount++;
    if (p === g) {
      correct++;
      if (perCat[p]) perCat[p].tp++;
    } else {
      if (perCat[p]) perCat[p].fp++;
      if (perCat[g]) perCat[g].fn++;
    }
  }
  const summary = CATEGORIES.map((c) => {
    const { tp, fp, fn, support, predCount } = perCat[c];
    const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
    const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0;
    return { category: c, support, predCount, tp, fp, fn, precision: prec, recall: rec, f1 };
  });
  return { total: preds.length, accuracy: correct / preds.length, perCategory: summary };
}

const gts = corpus.map(determineGroundTruth);

// 1. Raw Bedrock Model alone
const rawPreds = corpus.map((t) => ({
  category: t.aiRun?.raw?.primaryFolder || 'bookings',
  spam: Boolean(t.aiRun?.raw?.isSpam),
}));
const rawMetrics = calcMetrics(rawPreds, gts);

// 2. Round 2 (Current RDS Database State)
const r2Preds = corpus.map((t) => {
  const cats = t.categorySlugs || [];
  let primary = 'bookings';
  for (const c of cats) {
    if (CATEGORIES.includes(c) && c !== 'spam') {
      primary = c;
      break;
    }
  }
  return { category: primary, spam: Boolean(t.isSpam) };
});
const r2Metrics = calcMetrics(r2Preds, gts);

console.log('================ ALL-FOLDER COMPARISON: RAW NOVA LITE vs ROUND 2 ================');
console.log(`Overall Accuracy: Raw Nova Lite = ${(rawMetrics.accuracy * 100).toFixed(2)}% (${Math.round(rawMetrics.accuracy * corpus.length)}/${corpus.length}) | Round 2 = ${(r2Metrics.accuracy * 100).toFixed(2)}% (${Math.round(r2Metrics.accuracy * corpus.length)}/${corpus.length})`);

const table = CATEGORIES.map((c) => {
  const raw = rawMetrics.perCategory.find((x) => x.category === c);
  const r2 = r2Metrics.perCategory.find((x) => x.category === c);
  return {
    category: c,
    support: raw.support,
    rawTP: raw.tp,
    rawPrec: (raw.precision * 100).toFixed(1) + '%',
    rawRec: (raw.recall * 100).toFixed(1) + '%',
    rawF1: (raw.f1 * 100).toFixed(1) + '%',
    r2TP: r2.tp,
    r2Prec: (r2.precision * 100).toFixed(1) + '%',
    r2Rec: (r2.recall * 100).toFixed(1) + '%',
    r2F1: (r2.f1 * 100).toFixed(1) + '%',
    f1Delta: ((r2.f1 - raw.f1) * 100 >= 0 ? '+' : '') + ((r2.f1 - raw.f1) * 100).toFixed(1) + '%',
  };
});
console.table(table);

fs.writeFileSync('/tmp/trajectory-table.json', JSON.stringify({ rawMetrics, r2Metrics, table }, null, 2), 'utf8');
