import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
import { catchError, shareReplay } from 'rxjs/operators';
import { throwError } from 'rxjs';

/** The Firebase web-app config the backend hands out (null until it is set up). */
export interface FcmConfig {
  api_key: string;
  project_id: string;
  app_id: string;
  messaging_sender_id: string;
  vapid_key: string;
}

/**
 * What the Notifications page can offer on this device.
 *  - `unavailable`: the backend has no Firebase project yet, or this browser
 *    cannot do push at all. The page shows nothing.
 *  - `needs-install`: iOS only delivers web push to a site added to the Home
 *    Screen, so the page says that instead of a switch that cannot work.
 *  - `blocked`: the browser permission is denied; only the user can undo that.
 *  - `ready`: the switch works.
 */
export type PushAvailability = 'unavailable' | 'needs-install' | 'blocked' | 'ready';

/** `denied`: the permission prompt was refused. `failed`: anything else. */
export type PushEnableResult = 'enabled' | 'denied' | 'failed';

/** Which account turned push on for this browser, and with which token. */
interface StoredDevice {
  userId: string;
  token: string;
  /** When the token was last sent to the backend, ms since the epoch. */
  at: number;
}

const STORAGE_KEY = 'unibooks.push-device';
/**
 * The backend only needs telling again if the token rotated, which Firebase
 * does rarely; once a week keeps a rotated token from silencing the device
 * for long without a request on every visit.
 */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Browser push notifications through Firebase Cloud Messaging.
 *
 * The notification itself is built by the service worker (public/sw.js) from
 * a data-only message, so there is no `onMessage` handling here: the server
 * only pushes to a user who has the site closed, and a user with it open has
 * the in-app badge.
 *
 * Firebase is imported on demand. It is large and only a user on the
 * Notifications page, or one who already turned push on, ever needs it.
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID);

  private config$: Observable<{ fcm: FcmConfig | null }> | null = null;

  async availability(): Promise<PushAvailability> {
    if (!isPlatformBrowser(this.platformId)) return 'unavailable';
    const config = await this.loadConfig();
    if (!config) return 'unavailable';
    if (this.isIosOutsideHomeScreen()) return 'needs-install';
    if (!(await this.browserSupportsPush())) return 'unavailable';
    return Notification.permission === 'denied' ? 'blocked' : 'ready';
  }

  /** Whether this browser was set up for push by `userId`. */
  isEnabledHere(userId: string | number | undefined): boolean {
    const stored = this.readStored();
    return !!stored && !!userId && stored.userId === String(userId) && Notification.permission === 'granted';
  }

  /** Asks for permission, then registers this browser with the backend. */
  async enable(userId: string | number): Promise<PushEnableResult> {
    try {
      const config = await this.loadConfig();
      if (!config || !(await this.browserSupportsPush())) return 'failed';

      // Must come from a user gesture on some browsers, which is why this is
      // only ever called from the switch.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return 'denied';

      const token = await this.fetchToken(config);
      if (!token) return 'failed';
      await firstValueFrom(this.http.post('/auth/me/push-devices/', { token }));
      this.writeStored({ userId: String(userId), token, at: Date.now() });
      return 'enabled';
    } catch (err) {
      console.error('Failed to enable push notifications', err);
      return 'failed';
    }
  }

  /** Stops pushes to this browser: tells the backend, then drops the token. */
  async disable(): Promise<void> {
    await this.unregisterThisDevice();
  }

  /**
   * Tells the backend this browser should no longer be pushed to and drops its
   * token. Also what sign-out calls: the request goes out before the session
   * is cleared, so it still carries the access token. Best effort — failing to
   * reach the backend must never block a sign-out.
   */
  async unregisterThisDevice(): Promise<void> {
    const stored = this.readStored();
    if (!stored) return;
    this.clearStored();
    try {
      await firstValueFrom(this.http.request('DELETE', '/auth/me/push-devices/', { body: { token: stored.token } }));
    } catch (err) {
      console.error('Failed to unregister push device', err);
    }
    try {
      const config = await this.loadConfig();
      if (!config) return;
      const { deleteToken } = await import('firebase/messaging');
      await deleteToken(await this.messaging(config));
    } catch {
      // The token is already forgotten on the backend; Firebase expiring it
      // on its own is the worst case.
    }
  }

  /**
   * Re-sends this browser's token if it is a week old or has changed, for the
   * account that turned push on here. A no-op for everyone else — another
   * account on a shared browser has to switch it on for itself.
   */
  async refreshRegistration(userId: string | number): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) return;
    const stored = this.readStored();
    if (!stored || stored.userId !== String(userId)) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (Date.now() - stored.at < REFRESH_AFTER_MS) return;
    try {
      const config = await this.loadConfig();
      if (!config) return;
      const token = await this.fetchToken(config);
      if (!token) return;
      await firstValueFrom(this.http.post('/auth/me/push-devices/', { token }));
      this.writeStored({ userId: stored.userId, token, at: Date.now() });
    } catch (err) {
      console.error('Failed to refresh push registration', err);
    }
  }

  private loadConfig(): Promise<FcmConfig | null> {
    if (!this.config$) {
      this.config$ = this.http.get<{ fcm: FcmConfig | null }>('/auth/config/').pipe(
        catchError((err) => {
          this.config$ = null;
          return throwError(() => err);
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return firstValueFrom(this.config$).then((c) => c?.fcm ?? null, () => null);
  }

  private async browserSupportsPush(): Promise<boolean> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
    const { isSupported } = await import('firebase/messaging');
    return isSupported();
  }

  /** iPhone/iPad Safari, outside an installed Home Screen web app. */
  private isIosOutsideHomeScreen(): boolean {
    const ua = navigator.userAgent;
    // iPadOS reports itself as a Mac; a Mac with a touch screen is an iPad.
    const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (!ios) return false;
    const standalone = (navigator as { standalone?: boolean }).standalone === true
      || window.matchMedia?.('(display-mode: standalone)').matches;
    return !standalone;
  }

  private async messaging(config: FcmConfig) {
    const { getApp, getApps, initializeApp } = await import('firebase/app');
    const { getMessaging } = await import('firebase/messaging');
    const app = getApps().length
      ? getApp()
      : initializeApp({
          apiKey: config.api_key,
          projectId: config.project_id,
          appId: config.app_id,
          messagingSenderId: config.messaging_sender_id,
        });
    return getMessaging(app);
  }

  /**
   * Firebase would register its own `firebase-messaging-sw.js`; handing it the
   * app's existing worker instead keeps one worker per origin, so Angular's
   * update handling and the push handlers share public/sw.js.
   */
  private async fetchToken(config: FcmConfig): Promise<string | null> {
    const registration = await navigator.serviceWorker.getRegistration();
    // No worker in `ng serve`: Angular only registers it in production builds.
    if (!registration) return null;
    const { getToken } = await import('firebase/messaging');
    const token = await getToken(await this.messaging(config), {
      vapidKey: config.vapid_key,
      serviceWorkerRegistration: registration,
    });
    return token || null;
  }

  private readStored(): StoredDevice | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as StoredDevice) : null;
    } catch {
      return null;
    }
  }

  private writeStored(device: StoredDevice) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
    } catch {
      // Without it the page just shows the switch off on the next visit.
    }
  }

  private clearStored() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // See writeStored.
    }
  }
}
