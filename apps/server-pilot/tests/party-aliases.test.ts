import { extractPartyMentions, listedPartiesFor, suggestPartyFromSender } from '../src/ai/party-aliases.js';
import { describe, expect, it } from 'vitest';

describe('suggestPartyFromSender', () => {
  it('suggests Rennies Travel for a sender at renniesbcdtravel.com, with no id until HMS confirms one', () => {
    expect(suggestPartyFromSender('Jane Doe <jane@renniesbcdtravel.com>')).toEqual({
      kind: 'agency',
      name: 'Rennies Travel',
      nativeId: null,
      idStatus: 'unverified',
    });
  });

  it('carries a listed HMS id only where the table gives one', () => {
    expect(suggestPartyFromSender('ops@mycwt.co.za')).toEqual({
      kind: 'agency',
      name: 'CWT JNB',
      nativeId: '290',
      idStatus: 'listed',
    });
    expect(suggestPartyFromSender('ops@360travel.co.za')).toEqual({
      kind: 'agency',
      name: '360 degrees Travel',
      nativeId: '113',
      idStatus: 'listed',
    });
    expect(suggestPartyFromSender('ops@nexustravel.co.za')).toMatchObject({ nativeId: '27', idStatus: 'listed' });
  });

  it('suggests Tourvest as a company for both of its domains, and matches a subdomain of them', () => {
    expect(suggestPartyFromSender('a@tourvest-mice.co.za')).toEqual({
      kind: 'company',
      name: 'Tourvest',
      nativeId: '206',
      idStatus: 'listed',
    });
    expect(suggestPartyFromSender('a@mail.tourvestdm.com')).toMatchObject({
      kind: 'company',
      nativeId: '206',
    });
  });

  it('marks the unlisted agencies unverified, with no id', () => {
    for (const sender of ['a@destinitravel.co.za', 'a@atlantiscorporate.co.za', 'a@planettours.co.za']) {
      expect(suggestPartyFromSender(sender)).toMatchObject({ nativeId: null, idStatus: 'unverified' });
    }
  });

  it('suggests nothing for an unknown domain, a look-alike domain, or text with no address', () => {
    expect(suggestPartyFromSender('a@gmail.com')).toBeNull();
    expect(suggestPartyFromSender('a@notrenniesbcdtravel.com')).toBeNull();
    expect(suggestPartyFromSender('no address here')).toBeNull();
    expect(suggestPartyFromSender(undefined)).toBeNull();
  });
});

describe('extractPartyMentions', () => {
  const body = [
    'Hi team,',
    '',
    'Travel Agency Details: RENNIES TRAVEL (PTY) LTD',
    'Organization Details: Bidvest Facilities Management Pty Ltd',
    'Please book 2 rooms for Bidvest Facilities Management employees from 12 November.',
    'Thanks',
  ].join('\n');

  it('reads the travel agency and organization lines, in the order they appear', () => {
    expect(extractPartyMentions(body).slice(0, 2)).toEqual([
      { kind: 'agency', name: 'RENNIES TRAVEL (PTY) LTD', source: 'travel_agency_details' },
      { kind: 'company', name: 'Bidvest Facilities Management Pty Ltd', source: 'organization_details' },
    ]);
  });

  it('reads a "for X employees" phrase as a company, and counts an exact name once', () => {
    expect(extractPartyMentions(`${body}\nTravel Agency Details: rennies travel (pty) ltd`)).toEqual([
      { kind: 'agency', name: 'RENNIES TRAVEL (PTY) LTD', source: 'travel_agency_details' },
      { kind: 'company', name: 'Bidvest Facilities Management Pty Ltd', source: 'organization_details' },
      { kind: 'company', name: 'Bidvest Facilities Management', source: 'employee_line' },
    ]);
  });

  it('names no company for a number or a lower-case word before "employees"', () => {
    expect(extractPartyMentions('Please book rooms for 25 employees from 12 Nov.')).toEqual([]);
    expect(extractPartyMentions('Rooms for many employees, for 4 people.')).toEqual([]);
  });

  it('stays fast on hostile spacing: 2000-character lines finish well inside 50 ms each', () => {
    const hostile = [
      `for${' '.repeat(2000)}x`,
      `Travel Agency Details:a${' '.repeat(2000)}b`,
      `Organization Details:${' '.repeat(2000)}`,
      `for ${'A '.repeat(1000)}employe`,
      `for${' '.repeat(1000)}Acme${' '.repeat(1000)}employee`,
    ];
    for (const body of hostile) {
      const started = performance.now();
      extractPartyMentions(body);
      expect(performance.now() - started).toBeLessThan(50);
    }
    // The long line is cut before matching, so the name it can yield stays bounded.
    const [long] = extractPartyMentions(`Travel Agency Details: ${'Acme '.repeat(200)}`);
    expect(long?.name.length ?? 0).toBeLessThanOrEqual(120);
  });

  it('skips a generic "for all employees" phrase, and an empty or non-text body', () => {
    expect(extractPartyMentions('Rooms for all employees please.')).toEqual([]);
    expect(extractPartyMentions('Organization Details:   ')).toEqual([]);
    expect(extractPartyMentions(null)).toEqual([]);
  });
});

describe('listedPartiesFor', () => {
  const WOOLWORTHS = { kind: 'company', nativeId: '49', name: 'Woolworths Holdings' };
  const TOURVEST = { kind: 'company', nativeId: '206', name: 'TOURVEST TRAVEL SERVICES' };
  const DEGREES_360 = { kind: 'agency', nativeId: '113', name: '360 degrees Travel' };

  it('matches the name as the email gives it, with an alias, or with the legal suffix', () => {
    expect(listedPartiesFor('Woolworths')).toEqual([WOOLWORTHS]);
    expect(listedPartiesFor('woolworths sa')).toEqual([WOOLWORTHS]);
    expect(listedPartiesFor('360 Degrees Travel (Pty) Ltd')).toEqual([DEGREES_360]);
    expect(listedPartiesFor('Tourvest')).toEqual([TOURVEST]);
  });

  it('matches each 360 alias as a whole word, so 3600 finds nothing', () => {
    expect(listedPartiesFor('360degrees')).toEqual([DEGREES_360]);
    expect(listedPartiesFor('360 travel')).toEqual([DEGREES_360]);
    expect(listedPartiesFor('3600 travel')).toEqual([]);
  });

  it('starts at three characters: "Wool" finds Woolworths, "Wo" and shorter find nothing', () => {
    expect(listedPartiesFor('Wool')).toEqual([WOOLWORTHS]);
    expect(listedPartiesFor('Wo')).toEqual([]);
    expect(listedPartiesFor('ab')).toEqual([]);
    expect(listedPartiesFor('')).toEqual([]);
    expect(listedPartiesFor('  ! ')).toEqual([]);
  });

  it('offers nothing for a party the table does not list', () => {
    expect(listedPartiesFor('Pick n Pay')).toEqual([]);
    expect(listedPartiesFor('Nexus')).toEqual([]);
  });
});
