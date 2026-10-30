// Composable read-only readers for an existing Stay 360 reservation.
export { readConfirmationFromStay360 as readShallow } from '../playwright-quote/stay360-confirmation.mjs';
export { readRecordViewFromStay360 as readRecord } from '../playwright-quote/stay360-record-view.mjs';
export { readGuestDetailsFromStay360 as readGuest } from '../playwright-quote/stay360-guest-details.mjs';
export { readGuestFormsFromStay360 as readGuestForm } from './stay360-guest-form.mjs';
export { readDocumentsFromStay360 as readDocuments } from './stay360-documents.mjs';
export { openStay360RecordTab } from './stay360-record-tabs.mjs';
