import { DestroyRef, WritableSignal, inject, signal } from '@angular/core';

/**
 * The phone breakpoint, in the one place script needs it. The stylesheets use
 * the same `max-width: 900px` for the app-style mobile layout (app bar, bottom
 * sheets, the account menu); keep them in step.
 */
export const PHONE_QUERY = '(max-width: 900px)';

/** Whether the viewport is in the phone layout. False outside a browser. */
export function isPhoneViewport(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(PHONE_QUERY).matches;
}

/**
 * Calls `listener` whenever the viewport crosses the phone breakpoint (a
 * window resized, a tablet rotated). Returns a function that stops watching.
 *
 * Listens for resize as well as the media query's own change event, which
 * not every environment dispatches (device emulation in some dev tools), and
 * reports only actual crossings.
 */
export function watchPhoneViewport(listener: (isPhone: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(PHONE_QUERY);
  let last = query.matches;
  const check = () => {
    const now = window.matchMedia(PHONE_QUERY).matches;
    if (now !== last) {
      last = now;
      listener(now);
    }
  };
  query.addEventListener('change', check);
  window.addEventListener('resize', check);
  return () => {
    query.removeEventListener('change', check);
    window.removeEventListener('resize', check);
  };
}

/**
 * Returns a reactive signal tracking whether the viewport is currently within
 * the phone layout (<= 900px).
 *
 * Automatically tracks media query and window resize changes, and unsubscribes
 * when the calling injection context (or explicit DestroyRef) is destroyed.
 */
export function injectIsPhone(destroyRef?: DestroyRef): WritableSignal<boolean> {
  const ref = destroyRef ?? inject(DestroyRef);
  const isPhone = signal(isPhoneViewport());
  const unwatch = watchPhoneViewport(matches => isPhone.set(matches));
  ref.onDestroy(unwatch);
  return isPhone;
}
