import { TestBed } from '@angular/core/testing';
import { NgZone, PLATFORM_ID } from '@angular/core';
import { of } from 'rxjs';
import { IdlePreloadingStrategy, preloadAllowed } from './idle-preloading.strategy';

describe('IdlePreloadingStrategy', () => {
  let strategy: IdlePreloadingStrategy;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: 'browser' }] });
    strategy = TestBed.inject(IdlePreloadingStrategy);
  });

  afterEach(() => vi.useRealTimers());

  it('loads a route marked preload, but only after the start-up delay and idle time', async () => {
    const load = vi.fn(() => of('loaded'));
    strategy.preload({ path: 'search', data: { preload: true } }, load).subscribe();
    expect(load).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(IdlePreloadingStrategy.START_DELAY_MS + 5000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  // A delay timed inside the zone kept the app from reporting stable, which
  // held back everything waiting on stable (One Tap, analytics).
  it('times the start-up delay outside the zone', () => {
    const outside = vi.spyOn(TestBed.inject(NgZone), 'runOutsideAngular');
    strategy.preload({ path: 'search', data: { preload: true } }, () => of('loaded')).subscribe();
    expect(outside).toHaveBeenCalled();
  });

  it('never loads an unmarked route, such as the admin console', async () => {
    const load = vi.fn(() => of('loaded'));
    strategy.preload({ path: 'admin' }, load).subscribe();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('preloadAllowed', () => {
  const nav = (connection?: object) => ({ connection } as unknown as Navigator);

  it('allows preloading when the browser says nothing about the connection', () => {
    expect(preloadAllowed(nav())).toBe(true);
    expect(preloadAllowed(nav({ effectiveType: '4g' }))).toBe(true);
  });

  it('respects Save-Data and slow links', () => {
    expect(preloadAllowed(nav({ saveData: true, effectiveType: '4g' }))).toBe(false);
    expect(preloadAllowed(nav({ effectiveType: '2g' }))).toBe(false);
    expect(preloadAllowed(nav({ effectiveType: 'slow-2g' }))).toBe(false);
    expect(preloadAllowed(nav({ effectiveType: '3g' }))).toBe(true);
  });
});
