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
  let settled = SETTLED.get(appRef);
  if (!settled) {
    const cap = appRef.injector.get(NgZone).runOutsideAngular(() => delay(MAX_WAIT_MS));
    settled = Promise.race([appRef.whenStable(), cap]).then(whenIdle);
    SETTLED.set(appRef, settled);
  }
  return settled;
}

export const MAX_WAIT_MS = 10000;

const SETTLED = new WeakMap<ApplicationRef, Promise<void>>();

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
