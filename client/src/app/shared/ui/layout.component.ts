import { RegionLinkDirective } from '../../core/region-link.directive';
import { stripRegionPrefix, isSameRegion } from '../../core/region-path';
import { injectIsPhone, isPhoneViewport } from '../../core/viewport';
import { isBottomSheetOpen } from './bottom-sheet.component';
import { Component, effect, inject, ChangeDetectorRef, NgZone, OnDestroy, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { UiDropdown, DropdownOption } from './dropdown.component';
import { UiPrefsSelector } from './prefs-selector.component';
import { RegionService } from '../../core/region.service';
import { MetadataService } from '../../core/services/metadata.service';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { SchoolStateService, SchoolOption, CityOption } from '../../core/services/school-state.service';
import { MessageService } from '../../core/services/message.service';
import { I18nService, TPipe } from '../../core/i18n.service';
import { Lang } from '../../core/i18n';
import { Subscription } from 'rxjs';
import { ThemeService, ThemeMode } from '../../core/services/theme.service';
import { MobileLayoutService } from '../../core/services/mobile-layout.service';
import { aboutUrl as aboutSiteUrl } from '../../core/about-site';
import { UiAppBar } from './app-bar.component';
import { UiLangSuggestion } from './lang-suggestion.component';
import { NavigationHistoryService } from '../../core/services/navigation-history.service';
import { TAB_SECTIONS } from '../../core/view-transitions';
import { schoolKeywords } from '../../core/school-search';

@Component({
  selector: 'ui-layout',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, FormsModule, UiDropdown, TPipe, UiPrefsSelector, UiAppBar, UiLangSuggestion],
  templateUrl: './layout.component.html',
  styleUrls: ['./layout.component.css']
})
export class UiLayout implements OnDestroy {
  /** The selected school's code ('' = all schools). */
  selectedSchool = '';
  schools: DropdownOption[] = [];
  rawSchools: SchoolOption[] = [];
  unreadCount = 0;
  readonly theme = inject(ThemeService);
  readonly mobileLayout = inject(MobileLayoutService);

  /** Whether the mobile top header is translated offscreen while scrolling down. */
  appBarHidden = false;
  private zone = inject(NgZone);

  get aboutUrl(): string {
    return aboutSiteUrl(this.i18n.lang());
  }

  get termsUrl(): string {
    return aboutSiteUrl(this.i18n.lang(), 'about/terms');
  }

  get privacyUrl(): string {
    return aboutSiteUrl(this.i18n.lang(), 'about/privacy');
  }

  get themeOptions() {
    return [
      { value: 'system', label: this.i18n.t('nav.themeSystem') || 'System' },
      { value: 'light', label: this.i18n.t('nav.themeLight') || 'Light' },
      { value: 'dark', label: this.i18n.t('nav.themeDark') || 'Dark' }
    ];
  }

  private metadataService = inject(MetadataService);
  private authStore = inject(AuthStore);
  private accountService = inject(AccountService);
  private schoolStateService = inject(SchoolStateService);
  private messageService = inject(MessageService);
  private cdr = inject(ChangeDetectorRef);

  readonly i18n = inject(I18nService);
  readonly regionService = inject(RegionService);
  private router = inject(Router);

  /**
   * Routes that own the whole viewport rather than sitting inside the page.
   * Messages is a two-pane app surface with its own internal scrolling: the
   * site footer underneath it pushed that surface into a boxed panel with the
   * page scrolling around it, so the chat read as a small page inside a page.
   */
  private static readonly FULL_BLEED_ROUTES = ['/messages'];

  /** Routes on which the site footer bar is shown at all. */
  private static readonly FOOTER_ROUTES = ['/', '/search'];

  /** True while a full-bleed route is active; suppresses the footer. */
  fullBleed = false;

  /** True on routes that show the footer bar (home and search). */
  showFooter = false;

  /**
   * A page pushed on top of a tab (a book, a listing, a seller, checkout, an
   * account page...) rather than a tab's own screen. On phones its header becomes ui-app-bar
   * in place of the logo header, and the page's own back link and breadcrumb
   * are hidden (see their components).
   */
  isSubPage = false;

  /**
   * The route declares `data: { actionBar: true }`: its page pins its primary
   * actions to the bottom on phones (ui-action-bar), which take the tab bar's
   * place. Read from the route at navigation time, not from the bar being
   * rendered, so the tab bar is already gone while the page loads and
   * throughout the page transition.
   */
  hasActionBar = false;

  private navHistory = inject(NavigationHistoryService);

  /**
   * An action-bar page takes the tab bar's place only while back can leave
   * it. Opened from a shared link, with nowhere in the app to go back to, the
   * tab bar stays and the action bar sits above it — otherwise the page
   * would have no way out at all.
   */
  get actionBarReplacesTabs(): boolean {
    return this.hasActionBar && this.navHistory.canGoBack;
  }

  /** The route declares `data: { hidePrefs: true }`: no language/region
   *  pickers under the page (the checkout flow). */
  hidePrefs = false;

  /** Pages whose region and language pickers stay on phones. */
  private static readonly PHONE_PREFS_ROUTES = ['/login', '/register'];

  private readonly isPhone = injectIsPhone();

  /**
   * Whether the region and language pickers go under this page. Phones keep
   * them in the account menu instead; a signed-out visitor has no menu — the
   * account tab opens sign-in — so the sign-in and sign-up pages keep them.
   */
  get showPrefs(): boolean {
    if (!this.isPhone()) return true;
    if (this.authStore.isAuthenticated()) return false;
    const path = this.pathOf(this.router.url).replace(/\/$/, '');
    return UiLayout.PHONE_PREFS_ROUTES.includes(path);
  }


  private unreadCountSubscription: Subscription;
  /** Route of the page on screen, so query-only navigations are not page changes. */
  private currentPath = '';

  private routerSubscription?: Subscription;
  private selectedSchoolSubscription?: Subscription;

  get selectedSchoolLabel(): string {
    const found = this.schools.find(s => s.value === this.selectedSchool);
    return found?.label || this.i18n.t('layout.allSchools') || '全部大學';
  }

  get userName(): string {
    if (!this.authStore.isAuthenticated()) return '';
    // AuthStore.user is now auto-fetched on bootstrap and after login —
    // it's the canonical source of truth for the current user
    const profile = this.authStore.user();
    if (!profile) return '';
    return profile.display_name || profile.email || '';
  }

  /** Signed in, but the profile has not arrived (or failed and is being
   *  retried). Rendering the plain account label here made the header look
   *  exactly like a signed-out one, most visibly for staff, whose admin link
   *  also waits on the profile. */
  get profilePending(): boolean {
    return this.authStore.isAuthenticated() && !this.authStore.user();
  }

  get isStaff(): boolean {
    if (!this.authStore.isAuthenticated()) return false;
    return this.authStore.user()?.is_staff === true;
  }

  constructor() {
    // Set for the initial URL as well as every later navigation: NavigationEnd
    // does not fire for the route the app boots on.
    this.applyFullBleed();
    this.applyFooterVisibility();
    this.applyRouteState();
    this.currentPath = this.pathOf(this.router.url);
    // A school picked somewhere other than this selector — the home page's
    // "see all universities" under a city fallback — must show here too, or
    // the header keeps naming the school the page has stopped filtering by.
    this.selectedSchoolSubscription = this.schoolStateService.selectedSchool$.subscribe(code => {
      if (code !== this.selectedSchool) {
        this.selectedSchool = code;
        this.cdr.markForCheck();
      }
    });
    this.routerSubscription = this.router.events.subscribe(event => {
      if (event instanceof NavigationEnd) {
        this.applyFullBleed();
        this.applyFooterVisibility();
        this.applyRouteState();
        // Only a different page gets the bottom bar back. A page that puts
        // its own state in the query string — the messages page opening a
        // chat as `?chat=<id>` — navigates without leaving, and resetting on
        // that undid the hiding it had just asked for: the bar only
        // disappeared after a reload, when no navigation followed.
        const path = this.pathOf(event.urlAfterRedirects);
        if (path !== this.currentPath) {
          this.currentPath = path;
          this.mobileLayout.setHideBottomNav(false);
        }
        this.setAppBarHidden(false);
        this.lastScrollY = 0;
        this.accumulatedUp = 0;
        this.accumulatedDown = 0;
        this.cdr.markForCheck();
        this.messageService.retryHubIfOwed();
        if (this.metadataOwed) {
          this.loadMetadata();
        }
      }
    });
    // Outside the zone: a scroll event inside it runs change detection for
    // the whole app at every frame of a scroll. setAppBarHidden() comes back
    // in only when the bar actually changes.
    if (typeof window !== 'undefined') {
      this.zone.runOutsideAngular(() => window.addEventListener('scroll', this.onScroll, { passive: true }));
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      document.addEventListener('focusin', this.onFocusIn);
    }

    // Runs on init and again whenever the language changes, so school labels
    // are re-fetched in the newly selected language — and whenever the region
    // changes, since each region has its own schools. It used to follow the
    // language only, so a visitor whose last region was Taiwan opened /hk to
    // a selector of Taiwan's schools, and switching region never replaced
    // them; with codes only unique per region, picking "HKU" there sent
    // Taiwan's HKU to the Hong Kong pages.
    effect(() => {
      this.i18n.lang();
      const region = this.regionService.region();
      untracked(() => {
        if (region !== this.metadataRegion) {
          this.metadataRegion = region;
          // The old region's list and selection mean nothing here: show only
          // "all schools" until this region's list arrives, and let it pick
          // this region's saved or verified school afresh.
          this.schoolStateService.hasInitialized = false;
          this.rawSchools = [];
          this.schools = this.schools.filter(s => s.value === '');
          this.selectedSchool = '';
        }
        this.loadMetadata();
      });
    });

    // The single per-user notification connection lives here (the persistent
    // app shell, never destroyed by route navigation) rather than in the
    // Messages page component, so it survives switching to any other page —
    // "logged in" is the only thing that should start/stop it, not which
    // route is active. Re-runs whenever isAuthenticated changes (login/logout
    // in this tab, or in another tab via AuthStore's storage-event sync).
    effect(() => {
      if (this.authStore.isAuthenticated()) {
        untracked(() => this.messageService.openHub());
      } else {
        untracked(() => this.messageService.closeHub());
        // Clear manual school selection on logout - next session uses bound school
        this.schoolStateService.clearManualSchool();
      }
    });

    this.unreadCountSubscription = this.messageService.unreadCount$.subscribe(count => {
      this.unreadCount = count;
      this.cdr.markForCheck();
    });

    // Automatically set the school to the user's verified school once the profile loads
    // (if they haven't manually chosen a school yet).
    effect(() => {
      const profile = this.authStore.user();
      const region = this.regionService.region();
      const verification = profile?.verifications?.find(v => isSameRegion(v.region, region) && !!v.verified_at);
      const userSchoolId = verification?.school;
      if (userSchoolId && this.rawSchools.length > 0 && this.schoolStateService.getManualSchool() === null) {
        const userSchool = this.rawSchools.find(s => s.id === userSchoolId);
        if (userSchool && this.selectedSchool !== userSchool.code) {
          this.selectedSchool = userSchool.code;
          this.schoolStateService.setSchool(this.selectedSchool);
          this.cdr.markForCheck();
        }
      }
      // A signed-in visitor's opening school can come from their profile, so
      // the school list alone does not settle it (see loadMetadata). Settled
      // here once both are in.
      if (profile && this.schoolStateService.hasInitialized) {
        untracked(() => this.schoolStateService.markReady());
      }
    });
  }

  private applyFullBleed() {
    const url = stripRegionPrefix(this.router.url);
    this.fullBleed = UiLayout.FULL_BLEED_ROUTES.some(r => url === r || url.startsWith(r + '/'));
  }

  /** The route part of a URL: no query string, no fragment, no region prefix. */
  private pathOf(url: string): string {
    return stripRegionPrefix(url).split(/[?#]/)[0];
  }

  /** Per-route layout state: the app bar, and the flags a route declares in
   *  its data (actionBar, hidePrefs). */
  private applyRouteState() {
    // A tab's own screen is its root (/, /search, /account...); anything
    // deeper — /account/orders — or outside the tabs is pushed on top of one.
    const segments = this.pathOf(this.router.url).replace(/\/$/, '').split('/');
    this.isSubPage = !(segments.length <= 2 && TAB_SECTIONS.has(segments[1] ?? ''));
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    this.hasActionBar = route.data['actionBar'] === true;
    this.hidePrefs = route.data['hidePrefs'] === true;
  }

  private applyFooterVisibility() {
    const url = stripRegionPrefix(this.router.url);
    this.showFooter = UiLayout.FOOTER_ROUTES.some(r => url === r || (r !== '/' && url.startsWith(r + '/')));
  }

  ngOnDestroy() {
    this.routerSubscription?.unsubscribe();
    this.selectedSchoolSubscription?.unsubscribe();
    this.unreadCountSubscription.unsubscribe();
    this.metadataSubscription?.unsubscribe();
    if (typeof window !== 'undefined') {
      window.removeEventListener('scroll', this.onScroll);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      document.removeEventListener('focusin', this.onFocusIn);
    }
  }

  private lastScrollY = 0;
  private accumulatedUp = 0;
  private accumulatedDown = 0;
  private scrollTicking = false;

  private readonly onScroll = () => {
    if (!isPhoneViewport()) {
      if (this.appBarHidden) {
        this.setAppBarHidden(false);
      }
      return;
    }
    if (!this.scrollTicking) {
      this.scrollTicking = true;
      requestAnimationFrame(() => {
        this.handleScroll();
        this.scrollTicking = false;
      });
    }
  };

  private readonly onFocusIn = () => {
    if (this.hasInputFocus()) {
      this.setAppBarHidden(false);
    }
  };

  private handleScroll() {
    if (typeof window === 'undefined') return;
    const currentY = Math.max(0, window.scrollY || document.documentElement?.scrollTop || 0);
    const headerHeight = 52;

    // Always visible at the very top of the page
    if (currentY <= 0) {
      this.setAppBarHidden(false);
      this.lastScrollY = currentY;
      this.accumulatedUp = 0;
      this.accumulatedDown = 0;
      return;
    }

    // Always visible while a bottom sheet is open or an input inside the page has focus
    if (isBottomSheetOpen() || this.hasInputFocus()) {
      this.setAppBarHidden(false);
      this.lastScrollY = currentY;
      this.accumulatedUp = 0;
      this.accumulatedDown = 0;
      return;
    }

    const delta = currentY - this.lastScrollY;

    if (delta > 0) {
      // Scrolling down
      this.accumulatedUp = 0;
      this.accumulatedDown += delta;
      // After scrolling down past its height, hide it
      if (currentY > headerHeight && this.accumulatedDown >= 8) {
        this.setAppBarHidden(true);
      }
    } else if (delta < 0) {
      // Scrolling up
      this.accumulatedDown = 0;
      this.accumulatedUp += Math.abs(delta);
      // Reveal on any upward scroll (small hysteresis ~8px) or back at the top
      if (this.accumulatedUp >= 8 || currentY <= headerHeight) {
        this.setAppBarHidden(false);
      }
    }

    this.lastScrollY = currentY;
  }

  private setAppBarHidden(hidden: boolean) {
    if (this.appBarHidden !== hidden) {
      this.zone.run(() => {
        this.appBarHidden = hidden;
        this.cdr.markForCheck();
      });
    }
  }

  private hasInputFocus(): boolean {
    if (typeof document === 'undefined') return false;
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
  }

  /** A hub that failed to open gets another chance when the visitor returns. */
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      this.messageService.retryHubIfOwed();
    }
  };

  onThemeChange(mode: string) {
    this.theme.setMode(mode as ThemeMode);
  }

  /** Set when loading metadata gave up, until a later load succeeds. */
  private metadataOwed = false;
  /** The region the loaded school list belongs to. */
  private metadataRegion: string | null = null;
  private metadataSubscription: Subscription | null = null;

  /**
   * How long the page waits for the opening school before loading with
   * whatever is selected. The metadata call retries for most of a minute on
   * a cold backend; the home page should not stay empty that long.
   */
  private static readonly SCHOOL_READY_TIMEOUT_MS = 2500;
  private schoolReadyTimer: ReturnType<typeof setTimeout> | null = null;

  private loadMetadata() {
    // A signed-out visitor who has picked no school (or only "all schools")
    // opens on '' whatever the list says: there is no profile to name a
    // school and no saved code to check. Settling now lets the home page
    // start its requests alongside this one instead of a round trip after
    // it — the difference a phone on a slow link notices most.
    if (
      !this.schoolStateService.ready &&
      !this.authStore.isAuthenticated() &&
      !this.schoolStateService.hasManualPick()
    ) {
      this.schoolStateService.setSchool('');
      this.schoolStateService.markReady();
    }
    if (!this.schoolReadyTimer && !this.schoolStateService.ready) {
      this.schoolReadyTimer = setTimeout(() => this.schoolStateService.markReady(), UiLayout.SCHOOL_READY_TIMEOUT_MS);
    }
    this.metadataSubscription?.unsubscribe();
    this.metadataSubscription = this.metadataService.getMetadataWithRetry().subscribe({
      error: (err) => {
        // Out of retries (or a real error). Log it rather than leaving it
        // uncaught, and try again the next time the visitor navigates.
        console.error('Failed to load metadata for the school selector', err);
        this.metadataOwed = true;
        this.schoolStateService.markReady();
      },
      next: (data) => {
        this.metadataOwed = false;
        if (data.schools && data.schools.length > 0) {
          const cities: CityOption[] = data.cities || [];
          this.schoolStateService.setSchools(data.schools, cities);
          this.rawSchools = data.schools;
          this.schools = [
            { value: '', label: this.i18n.t('layout.allSchools') || '全部大學' },
            ...this.schoolOptionsByCity(data.schools, cities),
          ];

          // Keep the user's current selection across language switches
          const current = this.schoolStateService.currentSchool;
          if (this.schoolStateService.hasInitialized) {
            if (this.schools.some(s => s.value === current)) {
              this.selectedSchool = current;
              this.cdr.markForCheck();
            }
            return;
          }

          this.schoolStateService.hasInitialized = true;

          // Check for manual school selection from sessionStorage (single-session
          // memory, per region). getManualSchool() has already turned a
          // full name saved before codes into its code, or dropped it.
          const manualSchool = this.schoolStateService.getManualSchool();
          if (manualSchool !== null && this.schools.some(s => s.value === manualSchool)) {
            this.selectedSchool = manualSchool;
            this.schoolStateService.setSchool(this.selectedSchool);
            this.schoolStateService.markReady();
            this.cdr.markForCheck();
            return;
          }

          // Default to "All Schools" — unless the user's profile has already
          // resolved by now. The effect below only re-runs when the profile
          // signal itself changes, so if the profile arrived *before* this
          // metadata call finished, that effect already ran once with an
          // empty `rawSchools` and did nothing — it will never fire again to
          // correct us. Checking the signal directly here closes that gap
          // regardless of which of the two requests happens to resolve first.
          const profile = this.authStore.user();
          const region = this.regionService.region();
          const verification = profile?.verifications?.find(v => isSameRegion(v.region, region) && !!v.verified_at);
          const userSchoolId = verification?.school;
          const userSchool = userSchoolId ? this.rawSchools.find(s => s.id === userSchoolId) : undefined;
          this.selectedSchool = userSchool ? userSchool.code : '';
          this.schoolStateService.setSchool(this.selectedSchool);
          // Signed in but the profile not back yet: it may name a verified
          // school, and settling on '' now made the pages load for "all
          // schools" and again for that school a moment later. The profile
          // effect above settles it instead (or the timeout, if it never comes).
          if (!this.authStore.isAuthenticated() || profile) {
            this.schoolStateService.markReady();
          }
          this.cdr.markForCheck();
        } else {
          // A region with no schools has nothing to select.
          this.schoolStateService.markReady();
        }
      }
    });
  }

  /**
   * The schools grouped under their cities, in the cities' order, with any
   * school that has no city last under "Uncategorized". By code, not name: the code
   * is what goes out as ?school= and into sessionStorage.
   */
  private schoolOptionsByCity(schools: SchoolOption[], cities: CityOption[]): DropdownOption[] {
    const option = (s: SchoolOption, group?: string): DropdownOption =>
      ({ value: s.code, label: s.display_name || s.name, group, keywords: schoolKeywords(s) });
    // A payload from before cities: nothing to group by.
    if (cities.length === 0) return schools.map(s => option(s));
    const known = new Set(cities.map(c => c.code));
    const grouped = cities.flatMap(c => schools
      .filter(s => s.city === c.code)
      .map(s => option(s, c.display_name || c.name)));
    const other = this.i18n.t('layout.otherCity');
    const rest = schools.filter(s => !s.city || !known.has(s.city)).map(s => option(s, other));
    return [...grouped, ...rest];
  }

  onSchoolChange(school: string) {
    // User manually changed school - save to sessionStorage for this session
    if (school !== this.schoolStateService.currentSchool) {
      this.schoolStateService.setManualSchool(school);
    }
  }
}
