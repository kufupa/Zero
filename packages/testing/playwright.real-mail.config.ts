/**
 * Thin alias for the real-mail UI gate.
 * Prefer REAL_MAIL_UI_GATE=1 + playwright.config.ts (avoids dual @playwright/test resolve).
 */
process.env.REAL_MAIL_UI_GATE = '1';
export { default } from './playwright.config';
