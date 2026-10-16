import { ApplicationRef, NgZone } from '@angular/core';

/**
 * Resolves once the opening page is up and the browser has a moment to spare:
 * the app is stable (its routes and the page's requests are done), then idle.
 *
 * For third-party scripts nothing on screen needs — analytics, the Google One
 * Tap prompt. Started at boot, they shared a phone's bandwidth with the app's
 * own code and data and held back its first paint; gtag alone is larger than
 * the app's main bundle.
 *
 * Capped at MAX_WAIT_MS in case the app never reports stable (a request that
 * never ends), and shared, so every caller waits on the same moment. The cap's
 * timer runs outside the zone: inside it, the timer was itself a pending task
 * that kept the app from reporting stable, so every wait ran the full cap.
 */
export function whenPageSettled(appRef: ApplicationRef): Promise<void> {
  return whenPageStable(appRef).then(whenIdle);
}

/**
 * Like whenPageSettled, without the idle wait. For the Google One Tap prompt,
 * which the user is waiting to see: its script is small and it only needs the
 * first page's requests out of the way, not a quiet main thread.
 */
export function whenPageStable(appRef: ApplicationRef): Promise<void> {
  let stable = STABLE.get(appRef);
  if (!stable) {
    const cap = appRef.injector.get(NgZone).runOutsideAngular(() => delay(MAX_WAIT_MS));
    stable = Promise.race([appRef.whenStable(), cap]);
    STABLE.set(appRef, stable);
  }
  return stable;
}

export const MAX_WAIT_MS = 10000;

const STABLE = new WeakMap<ApplicationRef, Promise<void>>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The browser's next idle period; Safari has no requestIdleCallback. */
function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (
      globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
    ).requestIdleCallback;
    if (ric) {
      ric(() => resolve(), { timeout: 3000 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}
