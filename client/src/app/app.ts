import { Component, inject, signal, PLATFORM_ID, DestroyRef, NgZone } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { RouterOutlet, Router, NavigationEnd, NavigationError } from '@angular/router';
import { TPipe } from './core/i18n.service';
import { UiLayout } from './shared/ui/layout.component';
import { UiToastHost } from './shared/ui/toast-host.component';
import { UiConfirmDialog } from './shared/ui/confirm-dialog.component';
import { UiMeetupDetailsHost } from './shared/ui/meetup-details-host.component';
import { NavigationHistoryService } from './core/services/navigation-history.service';
import { GoogleAuthService } from './core/services/google-auth.service';
import { GoogleAnalyticsService } from './core/services/google-analytics.service';
import { SeoService } from './core/services/seo.service';
import { SwUpdate, VersionReadyEvent, VersionInstallationFailedEvent } from '@angular/service-worker';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs/operators';
import { interval, fromEvent } from 'rxjs';

export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
export const VISIBILITY_CHECK_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Whether a navigation failed because a lazy route's code could not be
 * loaded: a missing chunk, or index.html served in its place. Chrome, Firefox
 * and Safari each word it differently.
 */
export function isChunkLoadError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Expected a JavaScript(-or-Wasm)? module script|Loading chunk [\w-]+ failed/i.test(message);
}

/**
 * The chunk a failed dynamic import named, where the browser says (Chrome and
 * Firefox put the URL in the message; Safari does not).
 */
export function chunkUrlFromError(error: unknown): string | null {
  const message = String((error as { message?: unknown })?.message ?? error ?? '');
  return message.match(/https?:\/\/\S+?\.js\b/)?.[0] ?? null;
}

/** App shell: the persistent layout (header/footer) wraps the router outlet,
 * so route changes swap only the page content instead of re-rendering the
 * whole chrome. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, UiLayout, UiToastHost, UiConfirmDialog, UiMeetupDetailsHost, TPipe],
  template: `
    <ui-layout>
      <router-outlet />
    </ui-layout>
    <!-- Outside <ui-layout>, not inside it: both hosts are position:fixed, and
         a fixed descendant is still clipped by an ancestor's overflow or
         transform. The layout owns full-bleed routes and its own scroll
         containers, so anchoring these to the shell keeps them pinned to the
         real viewport on every route — the same reason .update-prompt below
         lives here. Mounted once so a toast survives the navigation that a
         per-page host would take down with it. -->
    <ui-toast-host />
    <ui-confirm-dialog />
    <ui-meetup-details-host />
    @if (updateReady()) {
      <div class="update-prompt">
        <span>{{ 'app.updateAvailable' | t }}</span>
        <button (click)="reloadPage()">{{ 'app.updateReload' | t }}</button>
      </div>
    }
  `,
  styles: [`
    .update-prompt {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--surface-raised);
      border: 1px solid var(--line-strong);
      box-shadow: var(--shadow-card-lg);
      padding: var(--space-3) var(--space-4);
      border-radius: var(--radius-control);
      display: flex;
      align-items: center;
      gap: var(--space-4);
      z-index: 9999;
      font-size: var(--text-base);
    }
    .update-prompt button {
      background: var(--btn-primary-bg);
      color: var(--btn-primary-ink);
      border: none;
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-control);
      cursor: pointer;
      font-weight: 500;
    }
    .update-prompt button:hover {
      background: var(--btn-primary-bg-hover);
    }
  `]
})
export class App {
  private navHistory = inject(NavigationHistoryService);
  private googleAuth = inject(GoogleAuthService); // Initializes One Tap globally
  private googleAnalytics = inject(GoogleAnalyticsService); // Initializes GA globally
  // Owns the document title, description, canonical and og: tags; it only
  // has to exist, so it is created here with the shell.
  private seo = inject(SeoService);
  private swUpdate = inject(SwUpdate);
  private destroyRef = inject(DestroyRef);
  private platformId = inject(PLATFORM_ID);
  private zone = inject(NgZone);

  private router = inject(Router);

  updateReady = signal(false);
  private lastCheckTime = Date.now();
  private checkingInstallFailure = false;
  /** Set when the update prompt comes from a failed install rather than a
   * ready one; see handleInstallationFailed(). */
  private unregisterBeforeReload = false;

  constructor() {
    this.recoverFromMissingChunks();

    // Without this, a tab left open across a deploy keeps running the old
    // build indefinitely — and since each build's JS/CSS chunk filenames are
    // content-hashed, the stale service worker's asset manifest ends up
    // referencing files the CDN no longer serves, surfacing as fetch
    // failures (e.g. net::ERR_CACHE_MISS / net::ERR_FAILED) instead of just
    // an outdated UI. 
    // 
    // To solve this without disrupting the user's current task (e.g., filling a form),
    // we immediately call activateUpdate() so the service worker serves the new assets 
    // for subsequent requests, and then show a prompt. We also automatically reload 
    // the page on the next route change when state loss is no longer a concern.
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates
        .pipe(
          filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe(() => {
          this.swUpdate.activateUpdate().then(() => {
            this.updateReady.set(true);
          });
        });

      // A new version the worker downloads but cannot install. The case that
      // made this necessary: HTTPS-filtering software (AdGuard's desktop app,
      // some antivirus) injects a <script> into every HTML response, carrying
      // the request URL — and the worker fetches index.html with a random
      // ngsw-cache-bust parameter, so the injected text, and with it the hash,
      // differs on every attempt. The worker rejects the version as corrupt
      // and degrades, and on that browser the site never updates or prompts.
      // Nothing the site serves can stop the rewrite, so recover instead: if
      // this page is older than what is deployed, offer the update, and
      // reload without the worker so the page comes from the network.
      this.swUpdate.versionUpdates
        .pipe(
          filter((evt): evt is VersionInstallationFailedEvent => evt.type === 'VERSION_INSTALLATION_FAILED'),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe(() => this.handleInstallationFailed());

      this.router.events
        .pipe(
          filter(event => event instanceof NavigationEnd),
          filter(() => this.updateReady()),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe(() => {
          this.reloadPage();
        });

      // 1. Periodic update check: periodically poll for new versions while running.
      // The timer runs outside the zone: a pending interval inside it kept the
      // app from ever reporting stable, so everything waiting on that — One Tap
      // and analytics (whenPageSettled), the worker's registerWhenStable — sat
      // out its full timeout on every page load.
      this.zone.runOutsideAngular(() =>
        interval(UPDATE_CHECK_INTERVAL_MS)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(() => this.zone.run(() => this.checkForUpdate()))
      );

      // 2. Visibility / resume check: check for updates when a background tab or PWA becomes visible again.
      if (isPlatformBrowser(this.platformId) && typeof document !== 'undefined') {
        fromEvent(document, 'visibilitychange')
          .pipe(
            filter(() => document.visibilityState === 'visible'),
            takeUntilDestroyed(this.destroyRef)
          )
          .subscribe(() => {
            const now = Date.now();
            if (now - this.lastCheckTime >= VISIBILITY_CHECK_THROTTLE_MS) {
              this.checkForUpdate();
            }
          });
      }

      // 3. Handle unrecoverable state: recover when cached assets/manifest are broken beyond repair.
      this.swUpdate.unrecoverable
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          // A plain location.reload() may continue to be intercepted and served by the broken
          // service worker or corrupted offline cache. Unregistering active service workers
          // ensures the subsequent page load hits the network directly for fresh assets.
          if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
            navigator.serviceWorker
              .getRegistrations()
              .then(registrations => Promise.all(registrations.map(r => r.unregister())))
              .catch(() => {})
              .finally(() => {
                location.reload();
              });
          } else {
            location.reload();
          }
        });
    }
  }

  /**
   * A route whose code no longer exists: a tab still running the build before
   * a deploy asks for one of that build's lazy chunks, which the deploy
   * removed. The SPA fallback answers it with index.html, the import fails,
   * and the router reports a NavigationError — which the reload-on-update
   * above, listening for NavigationEnd, never saw, so the link just did
   * nothing. The service worker only fetches lazy chunks when they are first
   * needed, so this is the path an old tab takes. Load the target URL as a
   * full page instead, which runs the current build. Once per URL within ten
   * seconds, so a chunk that is genuinely broken cannot reload in a loop.
   *
   * The failed chunk is refetched with cache: 'reload' first. A browser may
   * hold index.html under that chunk's URL with a year-long immutable cache
   * (see public/asset-recovery.js, which does the same for the initial
   * bundles); a plain reload would read that copy again and fail again.
   */
  private recoverFromMissingChunks(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.router.events
      .pipe(
        filter((event): event is NavigationError => event instanceof NavigationError),
        filter(event => isChunkLoadError(event.error)),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(event => {
        const key = 'unibooks.chunkReload';
        try {
          const last = JSON.parse(sessionStorage.getItem(key) || 'null');
          if (last && last.url === event.url && Date.now() - last.at < 10_000) return;
          sessionStorage.setItem(key, JSON.stringify({ url: event.url, at: Date.now() }));
        } catch {
          // No sessionStorage: reload anyway; the browser's own history
          // stops a loop from being more than a nuisance.
        }
        const chunkUrl = chunkUrlFromError(event.error);
        const refreshed = chunkUrl
          ? fetch(chunkUrl, { cache: 'reload' }).then(() => undefined, () => undefined)
          : Promise.resolve();
        refreshed.then(() => location.assign(event.url));
      });
  }

  private checkForUpdate(): void {
    this.lastCheckTime = Date.now();
    this.swUpdate.checkForUpdate().catch(() => {
      // Ignore errors caused by network failures, offline status, or SW not ready.
    });
  }

  /**
   * Reacts to VERSION_INSTALLATION_FAILED. Two things make the obvious
   * "show the prompt" wrong on its own:
   *   - On an affected browser *every* update check fails, including the one
   *     run after the page was already reloaded from the network. So the
   *     page first asks whether it is behind, by looking for its own
   *     content-hashed main/styles bundles in the deployed ngsw.json;
   *     without that, every page load would prompt and every route change
   *     would reload.
   *   - The worker's degraded state lives in memory. Once the browser stops
   *     and restarts it, it serves the old cached build again, so a plain
   *     reload is not guaranteed to reach the network. Hence the reload
   *     unregisters the worker first, the same recovery `unrecoverable` uses.
   */
  private async handleInstallationFailed(): Promise<void> {
    if (this.updateReady() || this.checkingInstallFailure) return;
    this.checkingInstallFailure = true;
    try {
      const own = Array.from(
        document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[rel="stylesheet"][href]'),
        el => new URL(el instanceof HTMLScriptElement ? el.src : el.href, location.href).pathname,
      ).filter(path => /^\/(main|styles)-[A-Z0-9]+\.(js|css)$/.test(path));
      // Nothing to compare (e.g. a build without hashed filenames): do not
      // guess, since guessing wrong means a reload on every navigation.
      if (own.length === 0) return;

      const res = await fetch(`/ngsw.json?ngsw-cache-bust=${Math.random()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const manifest: { assetGroups?: { urls: string[] }[] } = await res.json();
      const deployed = new Set((manifest.assetGroups ?? []).flatMap(group => group.urls));
      if (own.every(path => deployed.has(path))) return;

      this.unregisterBeforeReload = true;
      this.updateReady.set(true);
    } catch {
      // Offline or a malformed manifest: leave the page as it is.
    } finally {
      this.checkingInstallFailure = false;
    }
  }

  reloadPage() {
    if (!this.unregisterBeforeReload || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      location.reload();
      return;
    }
    navigator.serviceWorker
      .getRegistrations()
      .then(registrations => Promise.all(registrations.map(r => r.unregister())))
      .catch(() => {})
      .finally(() => location.reload());
  }
}
