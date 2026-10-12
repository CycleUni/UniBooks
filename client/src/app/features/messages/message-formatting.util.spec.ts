import { formatInboxTime, isMeetupDetailsMessage, isMeetupRequest, systemMessageKey } from './message-formatting.util';

describe('formatInboxTime', () => {
  // Local-time constructors throughout, so the day boundaries these check are
  // the viewer's own and the spec passes in any runner timezone.
  const now = new Date(2026, 8, 14, 23, 30); // Mon 14 Sep 2026, 23:30

  it('shows the time of day for a message from today', () => {
    expect(formatInboxTime(new Date(2026, 8, 14, 9, 5).toISOString(), 'en-US', now)).toBe('09:05');
  });

  it('treats a timestamp slightly ahead of the local clock as today', () => {
    expect(formatInboxTime(new Date(2026, 8, 14, 23, 31).toISOString(), 'en-US', now)).toBe('23:31');
  });

  it('shows a short weekday within the last week', () => {
    const yesterday = new Date(2026, 8, 13, 23, 59).toISOString();
    expect(formatInboxTime(yesterday, 'en-US', now)).toBe('Sun');
    expect(formatInboxTime(yesterday, 'zh-TW', now)).toBe('週日');
  });

  it('shows month/day for older messages from this year, and the year once it differs', () => {
    expect(formatInboxTime(new Date(2026, 8, 7, 12, 0).toISOString(), 'en-US', now)).toBe('9/7');
    expect(formatInboxTime(new Date(2025, 11, 31, 12, 0).toISOString(), 'en-US', now)).toBe('2025/12/31');
  });

  it('returns an empty string for a missing or unparseable value', () => {
    expect(formatInboxTime('', 'en-US', now)).toBe('');
    expect(formatInboxTime(null, 'en-US', now)).toBe('');
    expect(formatInboxTime('not a date', 'en-US', now)).toBe('');
  });
});

describe('systemMessageKey', () => {
  it('reads the key of a system notice', () => {
    expect(systemMessageKey('[SYSTEM:order.notify.admin_cancelled] System Notification')).toBe('order.notify.admin_cancelled');
  });

  it('ignores ordinary text, even text that mentions a marker', () => {
    expect(systemMessageKey('hello')).toBeNull();
    expect(systemMessageKey('see [SYSTEM:x] later')).toBeNull();
    expect(systemMessageKey('')).toBeNull();
  });
});

describe('meetup cards are only drawn for server-placed tokens', () => {
  it('draws a card for a body that starts with the token', () => {
    expect(isMeetupRequest('[SYSTEM:order.notify.seller_approved] System Notification')).toBe(true);
    expect(isMeetupDetailsMessage('[SYSTEM:order.notify.meetup_updated] System Notification')).toBe(true);
  });

  it('does not draw one for a token a user typed mid-message', () => {
    // The chat refuses these tokens only at the start of a user's message.
    expect(isMeetupRequest('ok [SYSTEM:order.notify.seller_approved]')).toBe(false);
    expect(isMeetupDetailsMessage('see [MEETUP_ACCEPT]')).toBe(false);
  });
});
