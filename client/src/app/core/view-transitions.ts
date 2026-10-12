import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, Router, ViewTransitionInfo } from '@angular/router';
import { prefersReducedMotion } from './reduced-motion';

/**
 * Page transitions for withViewTransitions(). The animations themselves are
 * the ::view-transition rules in styles.css; this only decides which one a
 * navigation gets, by setting data-nav-transition on <html> for its duration:
 *
 *   forward  opening something from a page (a book, a listing, a seller):
 *            the new page slides in from the right, like a pushed screen
 *   back     browser/OS back: the reverse
 *   fade     switching between bottom-tab sections or regions, which are
 *            siblings rather than a stack, so nothing should slide
 *
 * Navigations that keep the same path (filters, sort, ?chat= in messages)
 * skip the transition: the page is updating in place, not being replaced.
 */

/**
 * First path segment after the region of each bottom-tab section. Pages
 * outside these are pushed on top of a tab: they slide in here, and on mobile
 * the layout gives them a back/title bar instead of the logo header.
 */
export const TAB_SECTIONS: ReadonlySet<string> = new Set(['', 'search', 'sell', 'messages', 'account']);

/**
 * Navigation state marking a move up to a page's parent screen (the account
 * menu from My listings — NavigationHistoryService.goBack). It is a new
 * navigation rather than a history step, but reads as going back, so it
 * animates as one.
 */
export const NAV_UP_STATE = 'navUp';

function segments(root: ActivatedRouteSnapshot): string[] {
  let leaf = root;
  while (leaf.firstChild) leaf = leaf.firstChild;
  return leaf.pathFromRoot.flatMap(s => s.url.map(u => u.path));
}

// The section a path belongs to: the first segment after the region.
function section(path: string[]): string {
  return path[1] ?? '';
}

// iOS Safari animates its own edge-swipe back gesture; running ours after it
// would play the page change twice. The home-screen app has no such gesture.
function browserAnimatesBack(): boolean {
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
  return isIos && !window.matchMedia('(display-mode: standalone)').matches;
}

export function onViewTransitionCreated({ transition, from, to }: ViewTransitionInfo): void {
  const router = inject(Router);
  const before = segments(from);
  const after = segments(to);

  if (prefersReducedMotion() || before.join('/') === after.join('/')) {
    transition.skipTransition();
    return;
  }

  const navigation = router.currentNavigation();
  const isBack = navigation?.trigger === 'popstate' || navigation?.extras?.state?.[NAV_UP_STATE] === true;
  // Only a real history step can be Safari's edge swipe; going up is a tap.
  if (navigation?.trigger === 'popstate' && browserAnimatesBack()) {
    transition.skipTransition();
    return;
  }

  // Moving into a different tab section is a tab switch (tapping the bar, or
  // back between two tabs), whatever depth it lands on: the Account tab
  // redirects to /account/listings. Back from a pushed page (a book) to its
  // tab still slides back.
  const regionChanged = before[0] !== after[0];
  const fromSection = section(before);
  const toSection = section(after);
  const tabSwitch = fromSection !== toSection && TAB_SECTIONS.has(toSection) && (TAB_SECTIONS.has(fromSection) || !isBack);
  const kind = regionChanged || tabSwitch ? 'fade' : isBack ? 'back' : 'forward';

  const root = document.documentElement;
  root.dataset['navTransition'] = kind;
  transition.finished.finally(() => {
    if (root.dataset['navTransition'] === kind) delete root.dataset['navTransition'];
  });
}
