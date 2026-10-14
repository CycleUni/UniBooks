import { ApplicationRef, Injectable, NgZone, inject, PLATFORM_ID, effect, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { AuthStore } from '../auth.store';
import { I18nService } from '../i18n.service';
import { ThemeService } from './theme.service';
import { ToastService } from './toast.service';
import { parseApiError } from '../api-error.util';
import { whenPageSettled } from '../page-settled';
import { environment } from '../../../environments/environment';


/** The width Google accepts for its button (200–400 px), from the container's width. */
export function buttonWidthFor(container: HTMLElement): number {
  return Math.max(200, Math.min(Math.floor(container.clientWidth) || 280, 400));
}

@Injectable({
  providedIn: 'root'
})
export class GoogleAuthService {
  private authStore = inject(AuthStore);
  private i18n = inject(I18nService);
  private themeService = inject(ThemeService);
  private toast = inject(ToastService);
  private platformId = inject(PLATFORM_ID);
  private appRef = inject(ApplicationRef);
  private zone = inject(NgZone);

  /** How long the button shows it is opening the account chooser. GIS says
   *  nothing when that dialog is dismissed, so the state cannot wait for it. */
  static readonly OPENING_MS = 4000;

  /** The Google button is drawn; until then the auth page holds its place. */
  readonly buttonReady = signal(false);
  /** The button was pressed and the browser's account chooser is on its way.
   *  Without it the press looked like nothing happened for the second or so
   *  the browser takes to show the dialog. */
  readonly opening = signal(false);
  /** A Google credential is with the backend. Stays set after a success, as
   *  the auth page is about to leave; cleared on failure or sign-out. */
  readonly signingIn = signal(false);
  private openingTimer: ReturnType<typeof setTimeout> | null = null;
  private signingInToast = 0;
  private buttonElementId = '';
  private widthObserver: ResizeObserver | null = null;
  private observedContainer: HTMLElement | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private renderedWidth = 0;
  private wasAuthenticated = false;

  // Baked in at build time (GOOGLE_CLIENT_ID) so One Tap need not ask the
  // backend for it first; a build without it fetches it from /auth/config/.
  private googleClientId = environment.googleClientId || '';
  private isScriptLoaded = false;
  private isInitializing = false;
  private isGoogleInitialized = false;
  private loadedLang = '';
  /** The script load in flight, so overlapping callers share it. */
  private scriptLoading: { lang: string; promise: Promise<void> } | null = null;
  /** Set once the Google button is pressed; see setupGoogle(). */
  private buttonPressed = false;

  constructor() {
    effect(() => {
      // Re-initialize or re-prompt when auth state or language changes
      this.i18n.lang();
      const isAuth = this.authStore.isAuthenticated();
      // Only on signing out: this also re-runs on a language change, which
      // must not drop the state mid sign-in.
      if (this.wasAuthenticated && !isAuth) this.signingIn.set(false);
      this.wasAuthenticated = isAuth;
      
      if (isAuth && isPlatformBrowser(this.platformId)) {
        // User just logged in (via Google or password) — mark session
        // so One Tap won't show again. Cancel any in-flight prompt.
        sessionStorage.setItem('google_one_tap_done', '1');
        if ((window as any).google?.accounts?.id) {
          (window as any).google.accounts.id.cancel();
        }
      }
      
      // One Tap waits for the first page to be up (see whenPageSettled): it
      // fetches the auth config and Google's script, and a prompt a moment
      // later costs nothing. initializeGoogleAuth checks the session again.
      if (!isAuth && isPlatformBrowser(this.platformId)) {
        whenPageSettled(this.appRef).then(() => this.initializeGoogleAuth());
      }
    });
  }

  private loadGoogleScript(): Promise<void> {
    const currentLang = this.i18n.lang();
    if (this.isScriptLoaded && (window as any).google && this.loadedLang === currentLang) {
      return Promise.resolve();
    }
    // Started early alongside the auth config (see initializeGoogleAuth); a
    // second call while that load runs must not tear its script out.
    if (this.scriptLoading?.lang === currentLang) {
      return this.scriptLoading.promise;
    }

    const promise = new Promise<void>((resolve, reject) => {
      const existingScript = document.getElementById('google-jssdk');
      if (existingScript) {
        existingScript.remove();
      }
      
      // We must remove google object to force a clean re-initialization if language changes
      delete (window as any).google;
      this.isGoogleInitialized = false;

      const script = document.createElement('script');
      script.id = 'google-jssdk';
      script.src = `https://accounts.google.com/gsi/client?hl=${this.i18n.lang()}`;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        this.isScriptLoaded = true;
        this.loadedLang = currentLang;
        resolve();
      };
      script.onerror = (e) => reject(e);
      document.head.appendChild(script);
    });
    this.scriptLoading = { lang: currentLang, promise };
    promise.then(
      () => { if (this.scriptLoading?.promise === promise) this.scriptLoading = null; },
      () => { if (this.scriptLoading?.promise === promise) this.scriptLoading = null; }
    );
    return promise;
  }

  public initializeGoogleAuth() {
    if (!isPlatformBrowser(this.platformId) || this.isInitializing) return;
    
    // If user already completed a login this session, skip One Tap entirely
    if (sessionStorage.getItem('google_one_tap_done')) return;
    
    // If logged in, we shouldn't prompt One Tap
    if (this.authStore.isAuthenticated()) return;

    this.isInitializing = true;
    
    // Bind global handler
    (window as any).handleGoogleCredential = (response: any) => this.handleGoogleCredential(response);

    if (!this.googleClientId) {
      // Google's script does not need the client ID, so fetch both at once
      // rather than one after the other; setupGoogle picks up this load.
      this.loadGoogleScript().catch(() => {});
      this.authStore.getAuthConfig().subscribe({
        next: (config) => {
          if (config && config.google_client_id) {
            this.googleClientId = config.google_client_id;
            this.setupGoogle();
          } else {
            this.isInitializing = false;
          }
        },
        error: (err) => {
          console.error('Failed to load Google Auth config', err);
          this.isInitializing = false;
        }
      });
    } else {
      this.setupGoogle();
    }
  }

  private setupGoogle() {
    this.loadGoogleScript().then(() => {
      if ((window as any).google && this.googleClientId) {
        if (!this.isGoogleInitialized) {
          (window as any).google.accounts.id.initialize(this.initOptions());
          this.isGoogleInitialized = true;
        }
        
        // Show One Tap prompt — unless the button was pressed while the script
        // loaded. Under FedCM the browser runs one sign-in dialog at a time, and
        // a prompt arriving late cancelled the account chooser the button had
        // just opened.
        if (!this.buttonPressed) {
          (window as any).google.accounts.id.prompt();
        }
      }
      this.isInitializing = false;
    }).catch(err => {
      console.error('Failed to load Google SDK', err);
      this.isInitializing = false;
    });
  }

  // Whichever of setupGoogle / loadAndRenderButton runs first initializes
  // GIS, and GIS keeps that first configuration, so both share one set of
  // options. use_fedcm_for_prompt shows One Tap as the browser's own FedCM
  // dialog ("Sign in to … with google.com") instead of Google's iframe, which
  // keeps working once third-party cookies are gone; use_fedcm_for_button
  // does the same for the "Continue with Google" button, which opens the
  // browser's account chooser in place of Google's popup window. Browsers
  // without FedCM fall back to the iframe and the popup. Under FedCM the
  // browser owns the dialog, so cancel_on_tap_outside only affects that
  // fallback.
  private initOptions() {
    return {
      client_id: this.googleClientId,
      callback: (window as any).handleGoogleCredential,
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true,
      use_fedcm_for_button: true
    };
  }

  public renderButton(elementId: string) {
    if (!isPlatformBrowser(this.platformId)) return;
    this.buttonElementId = elementId;
    // A re-render (language, theme) draws over the button already there; only
    // an empty container — a fresh visit to the page — needs the placeholder.
    if (!document.getElementById(elementId)?.firstChild) this.buttonReady.set(false);
    
    // Bind global handler just in case
    (window as any).handleGoogleCredential = (response: any) => this.handleGoogleCredential(response);
    
    if (this.googleClientId) {
      this.loadAndRenderButton(elementId);
    } else {
      this.authStore.getAuthConfig().subscribe(config => {
        if (config?.google_client_id) {
          this.googleClientId = config.google_client_id;
          this.loadAndRenderButton(elementId);
        }
      });
    }
  }

  private get isDarkTheme(): boolean {
    if (!isPlatformBrowser(this.platformId)) return false;
    // resolved() already collapses 'system' to the OS preference, and does so
    // as a signal — the previous inline matchMedia read here was imperative,
    // so an OS appearance change while the page was open recoloured the site
    // but left the Google button rendered in the old variant.
    return this.themeService.resolved() === 'dark';
  }

  private loadAndRenderButton(elementId: string) {
    this.loadGoogleScript().then(() => {
      if ((window as any).google && this.googleClientId) {
        if (!this.isGoogleInitialized) {
          (window as any).google.accounts.id.initialize(this.initOptions());
          this.isGoogleInitialized = true;
        }
        const container = document.getElementById(elementId);
        if (container) {
          container.innerHTML = '';
          const langCode = this.i18n.lang() === 'en' ? 'en' : 'zh-TW';
          const btnTheme = this.isDarkTheme ? 'filled_black' : 'outline';
          
          const targetWidth = buttonWidthFor(container);
          this.renderedWidth = targetWidth;
          this.watchWidth(container, elementId);

          (window as any).google.accounts.id.renderButton(
            container,
            {
              theme: btnTheme, size: 'large', type: 'standard', text: 'continue_with', locale: langCode, width: targetWidth,
              click_listener: () => this.zone.run(() => this.onButtonPressed())
            }
          );
          this.buttonReady.set(true);
        }
      }
    });
  }

  /**
   * Google draws the button at a fixed pixel width (200–400; it takes no
   * percentage), measured from the container when drawn. Redraw it when the
   * container's width changes enough to change that number: a phone rotated,
   * a window resized, the side panel opened. Debounced, and skipped while
   * the container is detached or hidden (width 0).
   */
  private watchWidth(container: HTMLElement, elementId: string) {
    if (typeof ResizeObserver === 'undefined') return;
    if (this.observedContainer === container) return;
    this.widthObserver?.disconnect();
    this.observedContainer = container;
    this.widthObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = null;
        if (!container.isConnected) {
          this.widthObserver?.disconnect();
          this.observedContainer = null;
          return;
        }
        if (!container.clientWidth || buttonWidthFor(container) === this.renderedWidth) return;
        // Never pull the button out from under a sign-in in progress.
        if (this.opening() || this.signingIn()) return;
        this.loadAndRenderButton(elementId);
      }, 150);
    });
    this.widthObserver.observe(container);
  }

  private onButtonPressed() {
    this.buttonPressed = true;
    this.opening.set(true);
    if (this.openingTimer) clearTimeout(this.openingTimer);
    this.openingTimer = setTimeout(() => {
      this.openingTimer = null;
      this.opening.set(false);
    }, GoogleAuthService.OPENING_MS);
  }

  private clearOpening() {
    if (this.openingTimer) clearTimeout(this.openingTimer);
    this.openingTimer = null;
    this.opening.set(false);
  }

  /** GIS calls back from its own frame, outside Angular's zone. */
  private handleGoogleCredential(response: any) {
    this.zone.run(() => this.signInWithCredential(response));
  }

  private signInWithCredential(response: any) {
    if (response && response.credential) {
      this.clearOpening();
      this.signingIn.set(true);
      // The auth page shows this on its button; anywhere else One Tap was
      // the only thing on screen, and it closes as soon as an account is
      // picked, so say what is happening until the backend answers.
      if (!this.buttonElementId || !document.getElementById(this.buttonElementId)) {
        this.signingInToast = this.toast.info(this.i18n.t('auth.googleSigningIn'), 0);
      }
      const dismissToast = () => {
        if (this.signingInToast) this.toast.dismiss(this.signingInToast);
        this.signingInToast = 0;
      };
      this.authStore.loginWithGoogle(response.credential).subscribe({
        next: () => {
          dismissToast();
          // A reply without the sign-in code signs no one in, and nothing would then
          // clear the state the auth page is showing.
          if (!this.authStore.isAuthenticated()) this.signingIn.set(false);
          // Mark session so One Tap won't show again this session
          sessionStorage.setItem('google_one_tap_done', '1');
          // Cancel One Tap UI immediately
          if ((window as any).google?.accounts?.id) {
            (window as any).google.accounts.id.cancel();
          }
          // No navigation here. This used to compare against '/account',
          // which stopped matching the moment routes gained their /:region
          // prefix — so One Tap left the user sitting on the login wall.
          // AuthFormComponent now watches AuthStore instead and owns the
          // "we are signed in, leave the auth page" decision, which is the
          // only place that knows about returnUrl anyway.
        },
        error: (err) => {
          dismissToast();
          this.signingIn.set(false);
          console.error('Google login failed', err);
          // The button lives outside any one page, so a failure here used to
          // reach nobody but the console — the user pressed "continue with
          // Google" and the page simply sat there. The backend refuses a
          // Google account whose address it has not verified
          // (auth.errEmailNotVerified, 403), which is exactly the case that
          // needs explaining.
          this.toast.error(parseApiError(err, this.i18n, 'auth.errGoogleLoginFailed'));
        }
      });
    }
  }
}
