import { ApplicationRef } from '@angular/core';
import { MAX_WAIT_MS, whenPageSettled } from './page-settled';

const runOutsideAngular = vi.fn((fn: () => unknown) => fn());

function fakeAppRef(stable: Promise<void>): ApplicationRef {
  const zone = { runOutsideAngular };
  return { whenStable: () => stable, injector: { get: () => zone } } as unknown as ApplicationRef;
}

describe('whenPageSettled', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for the app to be stable, then for idle time', async () => {
    let markStable!: () => void;
    const settled = vi.fn();
    whenPageSettled(fakeAppRef(new Promise((r) => (markStable = r)))).then(settled);

    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS - 1);
    expect(settled).not.toHaveBeenCalled();

    markStable();
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting for stable after the cap', async () => {
    const settled = vi.fn();
    whenPageSettled(fakeAppRef(new Promise(() => {}))).then(settled);

    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + 3000);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  // Inside the zone the cap's own timer counted as pending work, so the app
  // could not report stable before the cap ran out.
  it('starts the cap outside the zone', () => {
    runOutsideAngular.mockClear();
    whenPageSettled(fakeAppRef(new Promise(() => {})));
    expect(runOutsideAngular).toHaveBeenCalledTimes(1);
  });

  it('hands every caller the same moment', () => {
    const appRef = fakeAppRef(Promise.resolve());
    expect(whenPageSettled(appRef)).toBe(whenPageSettled(appRef));
  });
});
