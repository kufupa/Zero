/** Pane-scoped replay facts. Never inspect the selected email body as proof of extraction. */
import type { Page } from 'playwright';

type Stay = { rooms: number | null; arrival: string; departure: string; dinner: boolean };
export type ReplayDetails = { stays: Stay[]; guests: string[]; requests: string[]; amendments: string[] };

/** Read only rendered workflow controls and extracted request summaries. */
export async function readReplayDetails(page: Page): Promise<ReplayDetails> {
  return page.evaluate(() => {
    const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
    const text = (element: Element | null | undefined) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const stays = [...document.querySelectorAll('article[aria-label^="Stay "][aria-label$=" details"]')]
      .filter(visible).map((article) => {
        const header = text(article.querySelector('header > p'));
        // Reject a missing split or a total that conflicts with the email total.
        const roomsMatch = /^(\d+) rooms?\s*·/.exec(header);
        const rooms = roomsMatch && !header.includes('Email requested') ? Number(roomsMatch[1]) : null;
        const buttons = [...article.querySelectorAll('button')];
        const date = (prefix: string) => text(buttons.find((button) => text(button).startsWith(prefix)));
        const meal = article.querySelector<HTMLSelectElement>('select[aria-label="Meal plan"]');
        const dinner = article.querySelector<HTMLInputElement>('input[aria-label="Dinner allowance"]');
        return { rooms, arrival: date('Check-in'), departure: date('Check-out'),
          dinner: meal?.value === 'dinner_bb' || dinner?.checked === true };
      });
    const collect = (selector: string) => [...document.querySelectorAll(selector)].filter(visible).map(text).filter(Boolean);
    return {
      stays,
      guests: collect('ul[aria-label="Stay guests"] > li'),
      requests: [
        ...collect('section[aria-label="Check before sending"] > div > p:first-child'),
        ...collect('section[aria-label="Prepared requests"] > div > p:first-child'),
        ...collect('section[aria-label="Prepared requests"] > div > ul > li'),
      ],
      amendments: collect('[data-testid="amend-request-summary"]'),
    };
  });
}

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const plain = (text: string) => text.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
const negated = /\b(?:no|not|never|without|cannot|can't|declined|unrequested)\b/i;

/** Unknown or malformed checks fail closed. Failures never contain guest text. */
export function replayDetailFailures(checks: unknown, details: ReplayDetails | null, sourceRequired: boolean): string[] {
  if (!Array.isArray(checks) || (!checks.length && !sourceRequired)) return ['detail_checks_missing'];
  if (!details || !Array.isArray(details.stays) || !Array.isArray(details.guests) ||
    !Array.isArray(details.requests) || !Array.isArray(details.amendments)) return ['detail_observation_missing'];
  const failures: string[] = [];
  checks.forEach((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { failures.push(`invalid_detail_${index}`); return; }
    const check = value as Record<string, unknown>;
    const stay = positiveInteger(check.stay) ? details.stays[check.stay - 1] : undefined;
    let valid = true, matched = false;
    if (check.kind === 'stay_count') {
      valid = positiveInteger(check.count);
      matched = valid && details.stays.length === check.count;
    } else if (check.kind === 'room_count') {
      valid = positiveInteger(check.stay) && positiveInteger(check.count);
      matched = valid && stay?.rooms === check.count;
    } else if (check.kind === 'stay_dates') {
      valid = positiveInteger(check.stay) && (nonempty(check.arrival) || nonempty(check.departure)) &&
        (check.arrival === undefined || nonempty(check.arrival)) && (check.departure === undefined || nonempty(check.departure));
      matched = valid && Boolean(stay) && (!nonempty(check.arrival) || plain(stay!.arrival).includes(plain(check.arrival))) &&
        (!nonempty(check.departure) || plain(stay!.departure).includes(plain(check.departure)));
    } else if (check.kind === 'dinner') {
      valid = positiveInteger(check.stay); matched = valid && stay?.dinner === true;
    } else if (check.kind === 'guests') {
      valid = Array.isArray(check.names) && check.names.length > 0 && check.names.every(nonempty);
      matched = valid && (check.names as string[]).every((name) => details.guests.some((guest) =>
        plain(guest).split(/[^\p{L}\p{N}]+/u).includes(plain(name))));
    } else if (check.kind === 'ask' || check.kind === 'amendment') {
      valid = Array.isArray(check.all) && check.all.length > 0 && check.all.every((group) =>
        Array.isArray(group) && group.length > 0 && group.every(nonempty));
      const observed = check.kind === 'ask' ? details.requests : details.amendments;
      matched = valid && observed.some((item) => !negated.test(item) && (check.all as string[][]).every((group) =>
        group.some((term) => plain(item).includes(plain(term)))));
    } else valid = false;
    if (!valid) failures.push(`invalid_detail_${index}`);
    else if (!matched) failures.push(`wrong_detail_${index}`);
  });
  return failures;
}
