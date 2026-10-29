// Waits for HMS to finish a Save. While the save runs, HMS masks the Guest Stay record with "Processing request."
// and fills the Confirmation Number when it ends. A save is confirmed only when the mask is gone and the number
// is set. Anything else at the deadline is unconfirmed: HMS may still have saved the booking, so callers must
// not report it as failed.

export const SAVE_WAIT_MS = 90_000;
export const SAVE_POLL_MS = 1_500;
export const SAVE_SETTLE_MS = 10_000;

const NEW_STATUS = 'New';
const MASK_TEXT = /Processing request/i;
const CONFIRMATION_FIELD = 'input[name="confirmationnumber"]:visible';
const STATUS_FIELD = 'input[name="status"]:visible';

async function readField(page, selector) {
  return page
    .locator(selector)
    .first()
    .inputValue({ timeout: 1500 })
    .then(
      (value) => value.trim(),
      () => '',
    );
}

// One reading of the record: is the processing mask up, what the Confirmation Number and Status show.
export async function readSaveSnapshot(page, options = {}) {
  const confirmationNumber = await readField(page, CONFIRMATION_FIELD);
  options.onConfirmation?.(confirmationNumber);
  const status = await readField(page, STATUS_FIELD);
  const maskVisible = (await page.getByText(MASK_TEXT).filter({ visible: true }).count()) > 0;
  return { maskVisible, confirmationNumber, status };
}

function unconfirmedReason({ maskVisible, status }) {
  if (maskVisible) return 'still_processing';
  if (status && status !== NEW_STATUS) return 'status_without_confirmation';
  return 'no_confirmation';
}

// Confirmed when the mask is gone and the Confirmation Number is set. Unconfirmed when the deadline passes first.
// The dependencies are injectable so the rules can be tested without a browser.
export async function waitForSaveConfirmation(page, options = {}) {
  const {
    timeoutMs = SAVE_WAIT_MS,
    pollMs = SAVE_POLL_MS,
    now = () => Date.now(),
    sleep = (ms) => page.waitForTimeout(ms),
    read = readSaveSnapshot,
  } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const snapshot = await read(page);
    if (!snapshot.maskVisible && snapshot.confirmationNumber) {
      return {
        confirmed: true,
        confirmationNumber: snapshot.confirmationNumber,
        status: snapshot.status,
        reason: null,
      };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return {
        confirmed: false,
        confirmationNumber: snapshot.confirmationNumber,
        status: snapshot.status,
        reason: unconfirmedReason(snapshot),
      };
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

// After a confirmed save, HMS can show New for a moment. Returns the first status other than New, or the last
// one read once SAVE_SETTLE_MS has passed.
export async function readSettledStatus(page, options = {}) {
  const {
    timeoutMs = SAVE_SETTLE_MS,
    pollMs = 1_000,
    now = () => Date.now(),
    sleep = (ms) => page.waitForTimeout(ms),
  } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = await readField(page, STATUS_FIELD);
    if ((status && status !== NEW_STATUS) || now() >= deadline) return status;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}
