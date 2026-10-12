import { TestBed } from '@angular/core/testing';
import { DestroyRef } from '@angular/core';
import { isPhoneViewport, watchPhoneViewport, injectIsPhone, PHONE_QUERY } from './viewport';

describe('viewport helpers', () => {
  let listeners: Array<() => void> = [];
  let matchesValue = false;

  beforeEach(() => {
    listeners = [];
    matchesValue = false;
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: matchesValue,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === 'change') listeners.push(cb);
      }),
      removeEventListener: vi.fn((event: string, cb: () => void) => {
        listeners = listeners.filter(l => l !== cb);
      }),
      dispatchEvent: vi.fn(),
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('isPhoneViewport', () => {
    it('returns true when window.matchMedia matches phone query', () => {
      matchesValue = true;
      expect(isPhoneViewport()).toBe(true);
    });

    it('returns false when window.matchMedia does not match', () => {
      matchesValue = false;
      expect(isPhoneViewport()).toBe(false);
    });

    it('returns false when matchMedia is not a function', () => {
      vi.stubGlobal('matchMedia', undefined);
      expect(isPhoneViewport()).toBe(false);
    });
  });

  describe('watchPhoneViewport', () => {
    it('invokes listener when viewport crosses breakpoint', () => {
      matchesValue = false;
      const callback = vi.fn();
      const unwatch = watchPhoneViewport(callback);

      expect(callback).not.toHaveBeenCalled();

      // Viewport changes to phone
      matchesValue = true;
      listeners.forEach(cb => cb());

      expect(callback).toHaveBeenCalledWith(true);

      // Viewport changes back to desktop
      matchesValue = false;
      listeners.forEach(cb => cb());

      expect(callback).toHaveBeenCalledWith(false);
      unwatch();
    });

    it('cleans up listeners on unwatch', () => {
      matchesValue = false;
      const callback = vi.fn();
      const unwatch = watchPhoneViewport(callback);

      unwatch();

      matchesValue = true;
      listeners.forEach(cb => cb());

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('injectIsPhone', () => {
    it('initializes signal from current viewport and updates on change', () => {
      matchesValue = true;
      TestBed.runInInjectionContext(() => {
        const isPhone = injectIsPhone();
        expect(isPhone()).toBe(true);

        matchesValue = false;
        listeners.forEach(cb => cb());
        expect(isPhone()).toBe(false);
      });
    });

    it('unsubscribes automatically when DestroyRef is destroyed', () => {
      matchesValue = false;
      let destroyCallbacks: Array<() => void> = [];
      const mockDestroyRef = {
        onDestroy: (cb: () => void) => destroyCallbacks.push(cb)
      } as unknown as DestroyRef;

      const isPhone = injectIsPhone(mockDestroyRef);
      expect(isPhone()).toBe(false);

      // Trigger destroy
      destroyCallbacks.forEach(cb => cb());

      // Changing viewport after destroy should not update signal
      matchesValue = true;
      listeners.forEach(cb => cb());
      expect(isPhone()).toBe(false);
    });
  });
});
