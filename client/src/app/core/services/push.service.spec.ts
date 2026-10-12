import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';

import { PushService } from './push.service';

const STORAGE_KEY = 'unibooks.push-device';
const FCM_CONFIG = {
  api_key: 'key', project_id: 'proj', app_id: 'app', messaging_sender_id: '1', vapid_key: 'vapid',
};

describe('PushService', () => {
  let service: PushService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(PushService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  async function answerConfig(fcm: unknown) {
    // The config request is made a microtask after the call.
    await Promise.resolve();
    http.expectOne('/auth/config/').flush({ google_client_id: 'g', fcm });
  }

  it('is unavailable until the backend has a Firebase project', async () => {
    const result = service.availability();
    await answerConfig(null);
    expect(await result).toBe('unavailable');
  });

  it('is unavailable when the config request fails, rather than throwing', async () => {
    const result = service.availability();
    await Promise.resolve();
    http.expectOne('/auth/config/').flush('nope', { status: 500, statusText: 'err' });
    expect(await result).toBe('unavailable');
  });

  it('asks an iPhone outside the Home Screen to install first', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      maxTouchPoints: 5,
      standalone: false,
    });
    const result = service.availability();
    await answerConfig(FCM_CONFIG);
    expect(await result).toBe('needs-install');
  });

  describe('which account enabled push here', () => {
    beforeEach(() => {
      vi.stubGlobal('Notification', { permission: 'granted' });
    });

    it('is enabled only for the account that set it up', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: '7', token: 't', at: Date.now() }));
      expect(service.isEnabledHere(7)).toBe(true);
      expect(service.isEnabledHere('7')).toBe(true);
      expect(service.isEnabledHere(8)).toBe(false);
      expect(service.isEnabledHere(undefined)).toBe(false);
    });

    it('is not enabled once the browser permission has been revoked', () => {
      vi.stubGlobal('Notification', { permission: 'denied' });
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: '7', token: 't', at: Date.now() }));
      expect(service.isEnabledHere(7)).toBe(false);
    });

    it('ignores a corrupted stored value', () => {
      localStorage.setItem(STORAGE_KEY, '{not json');
      expect(service.isEnabledHere(7)).toBe(false);
    });
  });

  describe('unregisterThisDevice', () => {
    it('does nothing for a browser that never enabled push', async () => {
      await service.unregisterThisDevice();
      http.expectNone('/auth/me/push-devices/');
    });

    it('forgets the device and tells the backend which token to drop', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: '7', token: 'tok', at: Date.now() }));

      const done = service.unregisterThisDevice();
      await Promise.resolve();
      const req = http.expectOne('/auth/me/push-devices/');
      expect(req.request.method).toBe('DELETE');
      expect(req.request.body).toEqual({ token: 'tok' });
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      req.flush(null, { status: 204, statusText: 'No Content' });

      // Then the config lookup for dropping the Firebase token; none set up.
      await Promise.resolve();
      await Promise.resolve();
      http.expectOne('/auth/config/').flush({ fcm: null });
      await done;
    });
  });

  describe('refreshRegistration', () => {
    beforeEach(() => {
      vi.stubGlobal('Notification', { permission: 'granted' });
    });

    it('leaves a recent registration alone', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: '7', token: 't', at: Date.now() }));
      await service.refreshRegistration(7);
      http.expectNone('/auth/config/');
    });

    it('leaves another account alone on a shared browser', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: '7', token: 't', at: 0 }));
      await service.refreshRegistration(8);
      http.expectNone('/auth/config/');
    });

    it('does nothing when push was never enabled here', async () => {
      await service.refreshRegistration(7);
      http.expectNone('/auth/config/');
    });
  });
});
