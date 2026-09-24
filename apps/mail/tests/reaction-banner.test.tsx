/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import {
  ReactionBanner,
  detectReactionNotification,
} from '../components/mail/reactions/reaction-banner';
import type { ParsedMessage } from '@/types';

describe('ReactionBanner', () => {
  it('renders emoji, reactor name and quoted snippet', () => {
    render(
      <ReactionBanner
        emoji="👍"
        reactorName="John Doe"
        quotedSnippet="Are we still meeting at 3pm?"
      />,
    );

    const banner = screen.getByRole('status');
    expect(banner).toBeDefined();
    expect(banner.getAttribute('aria-label')).toBe(
      'John Doe reacted with 👍 to your message',
    );
    expect(screen.getByText('John Doe')).toBeDefined();
    expect(screen.getByText(/reacted to your message:/)).toBeDefined();
    expect(screen.getByText('Are we still meeting at 3pm?')).toBeDefined();
  });

  it('detectReactionNotification detects Outlook reaction format', () => {
    const emailData: ParsedMessage = {
      id: 'msg-1',
      title: 'Re: Meeting',
      subject: 'Re: Meeting',
      tags: [],
      sender: { name: 'Alice Smith', email: 'alice@hotel.com' },
      to: [{ email: 'bob@hotel.com' }],
      cc: null,
      bcc: null,
      tls: true,
      receivedOn: '2026-09-09T10:00:00Z',
      unread: false,
      body: '👍 Alice Smith reacted to your message:\n"Let me know what time works"',
      processedHtml: '<p>👍 Alice Smith reacted to your message:</p>',
      blobUrl: '',
      decodedBody: '<p>👍 Alice Smith reacted to your message:</p>',
    };

    const detected = detectReactionNotification(emailData);
    expect(detected).not.toBeNull();
    expect(detected?.emoji).toBe('👍');
    expect(detected?.reactorName).toBe('Alice Smith');
    expect(detected?.quotedSnippet).toContain('Let me know what time works');
  });

  it('detectReactionNotification returns null for regular emails', () => {
    const emailData: ParsedMessage = {
      id: 'msg-2',
      title: 'Hello',
      subject: 'Hello',
      tags: [],
      sender: { name: 'Charlie', email: 'charlie@hotel.com' },
      to: [{ email: 'bob@hotel.com' }],
      cc: null,
      bcc: null,
      tls: true,
      receivedOn: '2026-09-09T10:00:00Z',
      unread: false,
      body: 'Hi, please see the attached document.',
      processedHtml: '<p>Hi, please see the attached document.</p>',
      blobUrl: '',
    };

    const detected = detectReactionNotification(emailData);
    expect(detected).toBeNull();
  });
});
