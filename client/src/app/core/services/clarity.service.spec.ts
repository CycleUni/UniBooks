import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ClarityService } from './clarity.service';
import { MAX_WAIT_MS } from '../page-settled';
import { environment } from '../../../environments/environment';

describe('ClarityService', () => {
  const tag = () => document.querySelector('script[src^="https://www.clarity.ms/tag/"]');
  const settled = () => vi.advanceTimersByTimeAsync(MAX_WAIT_MS + 3000);
  const configuredId = environment.clarityProjectId;

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.useFakeTimers();
  });

  afterEach(() => {
    environment.clarityProjectId = configuredId;
    vi.useRealTimers();
    tag()?.remove();
    delete (window as any).clarity;
    history.replaceState(null, '', '/');
  });

  it('is off without a project id', async () => {
    environment.clarityProjectId = '';
    TestBed.inject(ClarityService);
    await settled();
    expect(tag()).toBeNull();
  });

  it('loads the tag for the project once the page has settled', async () => {
    environment.clarityProjectId = 'abc123';
    TestBed.inject(ClarityService);
    expect(tag()).toBeNull();
    await settled();
    expect(tag()?.getAttribute('src')).toBe('https://www.clarity.ms/tag/abc123');
  });

  it('stays off the admin console', async () => {
    environment.clarityProjectId = 'abc123';
    history.replaceState(null, '', '/tw/admin/users');
    TestBed.inject(ClarityService);
    await settled();
    expect(tag()).toBeNull();
  });

  it('stays off a page opened through a one-time token link', async () => {
    environment.clarityProjectId = 'abc123';
    history.replaceState(null, '', '/tw/reset-password?token=secret');
    TestBed.inject(ClarityService);
    await settled();
    expect(tag()).toBeNull();
  });
});
