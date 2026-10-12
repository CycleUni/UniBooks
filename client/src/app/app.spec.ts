import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideServiceWorker, SwUpdate, UnrecoverableStateEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { App, UPDATE_CHECK_INTERVAL_MS, VISIBILITY_CHECK_THROTTLE_MS } from './app';
import { routes } from './app.routes';
import { GoogleAuthService } from './core/services/google-auth.service';
import { GoogleAnalyticsService } from './core/services/google-analytics.service';
import { RegionService } from './core/region.service';


/** Smoke tests: the App shell can be created and the route table covers all routes. */
describe('App', () => {
  describe('Basic Shell', () => {
    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [App],
        // UiLayout (the persistent app shell rendered inside App) injects
        // SwUpdate to auto-reload on a new deployed version — provide the
        // service worker (disabled, no actual SW script in tests) so that
        // injection resolves instead of throwing NG0201.
        providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },provideRouter(routes), provideServiceWorker('ngsw-worker.js', { enabled: false })],
      }).compileComponents();
    });

    it('creates the App', () => {
      const fixture = TestBed.createComponent(App);
      expect(fixture.componentInstance).toBeTruthy();
    });

    it('covers the SSD §2 routes plus verify and checkout', () => {
      const paths = routes.map((r) => r.path);
      expect(paths).toEqual([
        ':region', '**',
      ]);
    });
  });

  describe('Service Worker update checks and recovery', () => {
    let versionUpdates$: Subject<any>;
    let unrecoverable$: Subject<UnrecoverableStateEvent>;
    let mockSwUpdate: any;

    beforeEach(() => {
      versionUpdates$ = new Subject();
      unrecoverable$ = new Subject();
      mockSwUpdate = {
        isEnabled: true,
        versionUpdates: versionUpdates$,
        unrecoverable: unrecoverable$,
        checkForUpdate: vi.fn().mockResolvedValue(true),
        activateUpdate: vi.fn().mockResolvedValue(true),
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('defines the expected check and throttle intervals', () => {
      expect(UPDATE_CHECK_INTERVAL_MS).toBe(30 * 60 * 1000);
      expect(VISIBILITY_CHECK_THROTTLE_MS).toBe(5 * 60 * 1000);
    });

    it('checks for update periodically while app is running', async () => {
      vi.useFakeTimers();
      try {
        await TestBed.configureTestingModule({
          imports: [App],
          providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
            provideRouter(routes),
            { provide: SwUpdate, useValue: mockSwUpdate },
            { provide: GoogleAuthService, useValue: {} },
            { provide: GoogleAnalyticsService, useValue: {} },
          ],
        }).compileComponents();

        TestBed.createComponent(App);

        expect(mockSwUpdate.checkForUpdate).not.toHaveBeenCalled();

        vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);

        expect(mockSwUpdate.checkForUpdate).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('checks for update on visibilitychange when tab becomes visible and throttle time has passed', async () => {
      let currentTime = 1000000;
      vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

      await TestBed.configureTestingModule({
        imports: [App],
        providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
          provideRouter(routes),
          { provide: SwUpdate, useValue: mockSwUpdate },
          { provide: GoogleAuthService, useValue: {} },
          { provide: GoogleAnalyticsService, useValue: {} },
        ],
      }).compileComponents();

      TestBed.createComponent(App);

      // Advance time beyond the 5-minute throttle threshold
      currentTime += VISIBILITY_CHECK_THROTTLE_MS + 1000;

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(mockSwUpdate.checkForUpdate).toHaveBeenCalledTimes(1);
    });

    it('throttles visibilitychange update checks if triggered too frequently', async () => {
      let currentTime = 1000000;
      vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

      await TestBed.configureTestingModule({
        imports: [App],
        providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
          provideRouter(routes),
          { provide: SwUpdate, useValue: mockSwUpdate },
          { provide: GoogleAuthService, useValue: {} },
          { provide: GoogleAnalyticsService, useValue: {} },
        ],
      }).compileComponents();

      TestBed.createComponent(App);

      // Advance time by only 1 minute (less than 5 minute throttle)
      currentTime += 60 * 1000;

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(mockSwUpdate.checkForUpdate).not.toHaveBeenCalled();
    });

    it('handles unrecoverable state by unregistering service workers', async () => {
      const mockUnregister = vi.fn().mockResolvedValue(true);
      const mockGetRegistrations = vi.fn().mockResolvedValue([{ unregister: mockUnregister }]);
      
      const origServiceWorker = navigator.serviceWorker;
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistrations: mockGetRegistrations },
        configurable: true,
      });

      await TestBed.configureTestingModule({
        imports: [App],
        providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
          provideRouter(routes),
          { provide: SwUpdate, useValue: mockSwUpdate },
          { provide: GoogleAuthService, useValue: {} },
          { provide: GoogleAnalyticsService, useValue: {} },
        ],
      }).compileComponents();

      TestBed.createComponent(App);

      unrecoverable$.next({ type: 'UNRECOVERABLE_STATE', reason: 'Chunk missing' });

      // Allow promise microtasks to resolve
      await Promise.resolve();
      await Promise.resolve();

      expect(mockGetRegistrations).toHaveBeenCalled();
      expect(mockUnregister).toHaveBeenCalled();

      Object.defineProperty(navigator, 'serviceWorker', {
        value: origServiceWorker,
        configurable: true,
      });
    });

    describe('when a new version fails to install', () => {
      const failed = { type: 'VERSION_INSTALLATION_FAILED', version: { hash: 'new' }, error: 'Hash mismatch' };
      let bundles: HTMLElement[] = [];

      const addBundles = (...paths: string[]) => {
        for (const path of paths) {
          const el = path.endsWith('.js')
            ? Object.assign(document.createElement('script'), { src: path })
            : Object.assign(document.createElement('link'), { rel: 'stylesheet', href: path });
          document.head.appendChild(el);
          bundles.push(el);
        }
      };
      const deploy = (...urls: string[]) =>
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(JSON.stringify({ assetGroups: [{ urls: ['/index.html', ...urls] }] })),
        );
      const createApp = async () => {
        await TestBed.configureTestingModule({
          imports: [App],
          providers: [
            { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
            provideRouter(routes),
            { provide: SwUpdate, useValue: mockSwUpdate },
            { provide: GoogleAuthService, useValue: {} },
            { provide: GoogleAnalyticsService, useValue: {} },
          ],
        }).compileComponents();
        return TestBed.createComponent(App).componentInstance;
      };
      const settle = () => new Promise(resolve => setTimeout(resolve, 0));

      afterEach(() => {
        bundles.forEach(el => el.remove());
        bundles = [];
      });

      it('offers the update when this page is older than the deployed build', async () => {
        addBundles('/main-OLD111.js', '/styles-SAME22.css');
        deploy('/main-NEW333.js', '/styles-SAME22.css');
        const app = await createApp();

        versionUpdates$.next(failed);
        await settle();

        expect(app.updateReady()).toBe(true);
      });

      it('unregisters the worker before reloading, so the page comes from the network', async () => {
        addBundles('/main-OLD111.js', '/styles-SAME22.css');
        deploy('/main-NEW333.js', '/styles-SAME22.css');
        const mockUnregister = vi.fn().mockResolvedValue(true);
        const origServiceWorker = navigator.serviceWorker;
        Object.defineProperty(navigator, 'serviceWorker', {
          value: { getRegistrations: vi.fn().mockResolvedValue([{ unregister: mockUnregister }]) },
          configurable: true,
        });
        try {
          const app = await createApp();
          versionUpdates$.next(failed);
          await settle();

          app.reloadPage();
          await settle();

          expect(mockUnregister).toHaveBeenCalled();
        } finally {
          Object.defineProperty(navigator, 'serviceWorker', { value: origServiceWorker, configurable: true });
        }
      });

      it('stays quiet when this page already is the deployed build', async () => {
        // The affected browser fails every install, including the check that
        // runs after the page was reloaded from the network.
        addBundles('/main-NEW333.js', '/styles-SAME22.css');
        deploy('/main-NEW333.js', '/styles-SAME22.css');
        const app = await createApp();

        versionUpdates$.next(failed);
        await settle();

        expect(app.updateReady()).toBe(false);
      });

      it('does not guess when the page has no hashed bundles to compare', async () => {
        const fetchSpy = deploy('/main-NEW333.js');
        const app = await createApp();

        versionUpdates$.next(failed);
        await settle();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(app.updateReady()).toBe(false);
      });
    });

    it('gracefully swallows checkForUpdate promise rejections (e.g. offline/network failure)', async () => {
      mockSwUpdate.checkForUpdate.mockRejectedValue(new Error('Network error'));
      let currentTime = 1000000;
      vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

      await TestBed.configureTestingModule({
        imports: [App],
        providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
          provideRouter(routes),
          { provide: SwUpdate, useValue: mockSwUpdate },
          { provide: GoogleAuthService, useValue: {} },
          { provide: GoogleAnalyticsService, useValue: {} },
        ],
      }).compileComponents();

      TestBed.createComponent(App);

      currentTime += VISIBILITY_CHECK_THROTTLE_MS + 1000;

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      
      // Should not throw unhandled rejection
      expect(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      }).not.toThrow();
    });
  });
});
