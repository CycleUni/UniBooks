import { describe, it, expect } from 'vitest';
import { redactSensitiveUrl } from './sensitive-url';

describe('redactSensitiveUrl', () => {
  it('redacts a reset token in a router path', () => {
    expect(redactSensitiveUrl('/tw/forgot-password?token=abc123')).toBe('/tw/forgot-password?token=redacted');
  });

  it('redacts the email-change token and keeps other parameters', () => {
    expect(redactSensitiveUrl('/tw/account/settings?tab=email&email_change_token=xyz'))
      .toBe('/tw/account/settings?tab=email&email_change_token=redacted');
  });

  it('redacts in an absolute URL', () => {
    expect(redactSensitiveUrl('https://unibooks.app/tw/verify?token=t&type=register'))
      .toBe('https://unibooks.app/tw/verify?token=redacted&type=register');
  });

  it('leaves a URL without sensitive parameters exactly as it was', () => {
    expect(redactSensitiveUrl('/tw/search?q=calculus%20book')).toBe('/tw/search?q=calculus%20book');
    expect(redactSensitiveUrl('/tw/home')).toBe('/tw/home');
  });

  it('redacts a token inside returnUrl and keeps where it leads', () => {
    const url = '/tw/login?returnUrl=' + encodeURIComponent('/tw/account/settings?email_change_token=secret-token&tab=1');
    const out = redactSensitiveUrl(url);
    expect(out).not.toContain('secret-token');
    const back = new URL(out, 'http://x').searchParams.get('returnUrl')!;
    expect(back).toBe('/tw/account/settings?email_change_token=redacted&tab=1');
  });

  it('leaves a returnUrl without tokens as it was', () => {
    const url = '/tw/login?returnUrl=%2Ftw%2Fsell';
    expect(redactSensitiveUrl(url)).toBe(url);
  });
});
