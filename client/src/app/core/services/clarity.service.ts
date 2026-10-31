import { ApplicationRef, Injectable, Injector, effect, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { environment } from '../../../environments/environment';
import { whenPageSettled } from '../page-settled';
import { redactSensitiveUrl } from '../sensitive-url';
import { RegionService } from '../region.service';

/**
 * Microsoft Clarity: session replays and heatmaps, loaded straight from
 * clarity.ms (unlike GA there is no first-party gateway for it).
 *
 * A replay records the page as the visitor sees it, so it stays off where
 * that would capture a credential or other people's data:
 *   - a page opened through an emailed link that carries a one-time token
 *     (Clarity records the address as it is);
 *   - a visit that starts in the admin console.
 * Admin pages reached later in the same visit, chat, checkout, orders and
 * account settings are masked in their templates with
 * `data-clarity-mask="True"`. Inputs are masked by Clarity itself.
 * Only production builds carry the project id (scripts/set-env.js).
 *
 * GoogleAnalyticsService forwards its events, user id and user properties
 * here, so replays can be filtered by the same funnel steps GA reports.
 */
@Injectable({
  providedIn: 'root',
})
export class ClarityService {
  private platformId = inject(PLATFORM_ID);
  private appRef = inject(ApplicationRef);
  // Looked up on use, not injected: RegionService's own dependencies lead back
  // to AuthStore, which injects GoogleAnalyticsService, which injects this.
  private injector = inject(Injector);
  /** Whether this visit is recorded; every call below is a no-op otherwise. */
  private recording = false;

  constructor() {
    this.init();
  }

  private init(): void {
    const projectId = environment.clarityProjectId;
    if (!projectId || !isPlatformBrowser(this.platformId)) return;
    if (this.mustNotRecord(window.location.pathname, window.location.href)) return;

    this.recording = true;
    // Clarity's own bootstrap snippet: a queueing stub now, so events from
    // the first page are kept, then the tag.
    const w = window as any;
    if (!w.clarity) {
      w.clarity = function () {
        // eslint-disable-next-line prefer-rest-params
        (w.clarity.q = w.clarity.q || []).push(arguments);
      };
    }
    // Like gtag: nothing on screen needs it, so it waits for the first page.
    whenPageSettled(this.appRef).then(() => {
      if (document.querySelector('script[src^="https://www.clarity.ms/tag/"]')) return;
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://www.clarity.ms/tag/${encodeURIComponent(projectId)}`;
      document.head.appendChild(script);
      this.tagRegion();
    });
  }

  /** A named step (GA's event name), to filter replays and heatmaps by. */
  event(name: string): void {
    this.call('event', name);
  }

  /** A custom tag on this session. */
  set(key: string, value: string): void {
    this.call('set', key, value);
  }

  /** Links the visitor's sessions across devices. Clarity hashes the id in the browser. */
  identify(userId: string): void {
    this.call('identify', userId);
  }

  /** Keeps this session's replay when Clarity samples recordings. */
  upgrade(reason: string): void {
    this.call('upgrade', reason);
  }

  /** The site region (TW / HK), as GA tags every event, kept up to date. */
  private tagRegion(): void {
    try {
      const regions = this.injector.get(RegionService);
      effect(() => {
        const region = regions.region().toUpperCase();
        if (region) this.set('region', region);
      }, { injector: this.injector });
    } catch {
      // No region data (tests, early boot): the session goes untagged.
    }
  }

  private call(...args: unknown[]): void {
    if (!this.recording) return;
    (window as any).clarity?.(...args);
  }

  private mustNotRecord(pathname: string, href: string): boolean {
    return /\/admin(\/|$)/.test(pathname) || redactSensitiveUrl(href) !== href;
  }
}
