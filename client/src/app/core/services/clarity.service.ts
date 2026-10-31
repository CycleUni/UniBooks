import { ApplicationRef, Injectable, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { environment } from '../../../environments/environment';
import { whenPageSettled } from '../page-settled';
import { redactSensitiveUrl } from '../sensitive-url';

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
 */
@Injectable({
  providedIn: 'root',
})
export class ClarityService {
  private platformId = inject(PLATFORM_ID);
  private appRef = inject(ApplicationRef);

  constructor() {
    this.init();
  }

  private init(): void {
    const projectId = environment.clarityProjectId;
    if (!projectId || !isPlatformBrowser(this.platformId)) return;
    if (this.mustNotRecord(window.location.pathname, window.location.href)) return;

    // Like gtag: nothing on screen needs it, so it waits for the first page.
    whenPageSettled(this.appRef).then(() => {
      const w = window as any;
      if (w.clarity) return;
      // Clarity's own bootstrap snippet: a queueing stub, then the tag.
      w.clarity = function () {
        // eslint-disable-next-line prefer-rest-params
        (w.clarity.q = w.clarity.q || []).push(arguments);
      };
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://www.clarity.ms/tag/${encodeURIComponent(projectId)}`;
      document.head.appendChild(script);
    });
  }

  private mustNotRecord(pathname: string, href: string): boolean {
    return /\/admin(\/|$)/.test(pathname) || redactSensitiveUrl(href) !== href;
  }
}
