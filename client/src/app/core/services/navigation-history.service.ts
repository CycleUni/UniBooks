import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { Location, isPlatformBrowser } from '@angular/common';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { filter } from 'rxjs/operators';
import { NAV_UP_STATE, TAB_SECTIONS } from '../view-transitions';

/** A URL's page: its path, without the query string or fragment. */
function pageOf(url: string): string {
  return url.split(/[?#]/)[0].replace(/(.)\/$/, '$1');
}

/**
 * The screen a page sits under, if it has a fixed one: a page inside a tab's
 * section is a level below that tab's own screen (/hk/account/listings is
 * under /hk/account, the account menu). Pages reached from anywhere — a book,
 * a listing, a seller — have none; back is simply where you came from.
 */
export function parentPageOf(url: string): string | null {
  const [, region, section, child] = pageOf(url).split('/');
  return region && section && child && TAB_SECTIONS.has(section) ? `/${region}/${section}` : null;
}

/**
 * Where "back" goes: the previous *page*, not the previous URL.
 *
 * Plenty of history entries stay on one page — a search's filters and paging,
 * an account list's sort — so stepping back one URL at a time left the back
 * button undoing a filter instead of leaving the page. This records the page
 * of every history entry seen this session, keyed by the router's page id
 * (history.state.ɵrouterPageId, kept by canceledNavigationResolution:
 * 'computed' in app.config.ts), and goes back past every entry of the current
 * page in one step.
 *
 * Only entries seen this session are known: after a reload, or on arriving
 * from outside, there is no earlier page to name, and canGoBack is false —
 * the app bar then hides its back button rather than leave the site.
 *
 * A page with a fixed parent screen (parentPageOf) goes up to it instead:
 * My listings goes back to the account menu, even when it was opened from
 * search. Through history when the parent is the previous page, so going back
 * and forth doesn't stack copies of it.
 */
@Injectable({ providedIn: 'root' })
export class NavigationHistoryService {
  private router = inject(Router);
  private location = inject(Location);

  /** Page of each history entry seen this session, by router page id. */
  private readonly pages = signal<ReadonlyMap<number, string>>(new Map());
  private readonly currentId = signal(0);
  private lastTrigger: NavigationStart['navigationTrigger'] = 'imperative';

  /**
   * How many history entries back the previous page is: past every entry of
   * the current page. 0 when no earlier page is known.
   */
  private readonly stepsToPreviousPage = computed(() => {
    const pages = this.pages();
    const current = this.currentId();
    const here = pages.get(current);
    for (let id = current - 1; id >= 0; id--) {
      const page = pages.get(id);
      if (page === undefined) return 0;
      if (page !== here) return current - id;
    }
    return 0;
  });

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;

    // Created after the first navigation finished: record where we are.
    if (this.router.navigated) this.record(this.router.url);

    this.router.events
      .pipe(filter((e): e is NavigationStart => e instanceof NavigationStart))
      .subscribe(e => (this.lastTrigger = e.navigationTrigger));
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(e => this.record(e.urlAfterRedirects));
  }

  /** Where back leads: the page's parent screen, or the previous page. */
  private readonly previousPage = computed(() => {
    const steps = this.stepsToPreviousPage();
    return steps > 0 ? this.pages().get(this.currentId() - steps) ?? null : null;
  });

  private readonly parentPage = computed(() => {
    const here = this.pages().get(this.currentId());
    return here ? parentPageOf(here) : null;
  });

  /** Whether back has anywhere in the app to go. */
  get canGoBack(): boolean {
    return this.parentPage() !== null || this.stepsToPreviousPage() > 0;
  }

  goBack() {
    const parent = this.parentPage();
    const steps = this.stepsToPreviousPage();
    if (parent && this.previousPage() !== parent) {
      this.router.navigateByUrl(parent, { state: { [NAV_UP_STATE]: true } });
    } else if (steps > 0) {
      this.location.historyGo(-steps);
    }
  }

  private record(url: string) {
    const id = (this.location.getState() as { ɵrouterPageId?: number } | null)?.ɵrouterPageId ?? 0;
    const pages = new Map(this.pages());
    // A new navigation (not back/forward) discards the forward history, as
    // the browser does.
    if (this.lastTrigger !== 'popstate') {
      for (const known of pages.keys()) if (known > id) pages.delete(known);
    }
    pages.set(id, pageOf(url));
    this.pages.set(pages);
    this.currentId.set(id);
  }
}
