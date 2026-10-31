import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { ClarityService } from './clarity.service';
import { MAX_WAIT_MS } from '../page-settled';
import { environment } from '../../../environments/environment';
import { RegionService } from '../region.service';

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

  const queued = () => ((window as any).clarity?.q ?? []).map((args: IArguments) => Array.from(args));

  it('queues calls made before the tag has loaded', () => {
    environment.clarityProjectId = 'abc123';
    const clarity = TestBed.inject(ClarityService);
    clarity.event('begin_checkout');
    clarity.upgrade('begin_checkout');
    clarity.identify('42');
    clarity.set('logged_in', 'true');
    expect(tag()).toBeNull();
    expect(queued()).toEqual([
      ['event', 'begin_checkout'],
      ['upgrade', 'begin_checkout'],
      ['identify', '42'],
      ['set', 'logged_in', 'true'],
    ]);
  });

  it('tags the session with the site region once the tag loads', async () => {
    environment.clarityProjectId = 'abc123';
    TestBed.configureTestingModule({ providers: [{ provide: RegionService, useValue: { region: signal('hk') } }] });
    TestBed.inject(ClarityService);
    await settled();
    TestBed.tick();
    expect(queued()).toContainEqual(['set', 'region', 'HK']);
  });

  it('sends nothing for a visit it does not record', async () => {
    environment.clarityProjectId = 'abc123';
    history.replaceState(null, '', '/tw/admin/users');
    const clarity = TestBed.inject(ClarityService);
    clarity.event('login');
    clarity.identify('42');
    expect((window as any).clarity).toBeUndefined();
  });
});
