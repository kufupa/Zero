// Composable read-only readers for an existing Stay 360 reservation.
export { readConfirmationFromStay360 as readShallow } from './stay360-confirmation.mjs';
export { readRecordViewFromStay360 as readRecord } from './stay360-record-view.mjs';
export { readGuestDetailsFromStay360 as readGuest } from './stay360-guest-details.mjs';
export { readGuestFormsFromStay360 as readGuestForm } from './stay360-guest-form.mjs';
export { openStay360RecordTab } from './stay360-record-tabs.mjs';
