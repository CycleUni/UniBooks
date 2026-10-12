import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';

describe('ThemeService', () => {
  let listeners: ((e: MediaQueryListEvent) => void)[] = [];
  let currentMatches = false;

  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
    listeners = [];
    currentMatches = false;

    // Mock window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: currentMatches,
      media: query,
      onchange: null,
      addListener: (fn: any) => listeners.push(fn),
      removeListener: () => {},
      addEventListener: (type: string, fn: any) => {
        if (type === 'change') listeners.push(fn);
      },
      removeEventListener: () => {},
      dispatchEvent: () => true,
    })) as any;
  });

  afterEach(() => {
    localStorage.clear();
  });

  function createService(): ThemeService {
    return TestBed.runInInjectionContext(() => new ThemeService());
  }

  it('defaults to system mode and resolves to light when OS prefers light', () => {
    currentMatches = false;
    const service = createService();

    expect(service.mode()).toBe('system');
    expect(service.resolved()).toBe('light');
  });

  it('resolves to dark in system mode when OS prefers dark', () => {
    currentMatches = true;
    const service = createService();

    expect(service.mode()).toBe('system');
    expect(service.resolved()).toBe('dark');
  });

  it('resolves to light when mode is explicitly set to light, even if OS prefers dark', () => {
    currentMatches = true;
    const service = createService();

    service.setMode('light');
    expect(service.mode()).toBe('light');
    expect(service.resolved()).toBe('light');
    expect(localStorage.getItem('unibooks_theme')).toBe('light');
  });

  it('resolves to dark when mode is explicitly set to dark, even if OS prefers light', () => {
    currentMatches = false;
    const service = createService();

    service.setMode('dark');
    expect(service.mode()).toBe('dark');
    expect(service.resolved()).toBe('dark');
    expect(localStorage.getItem('unibooks_theme')).toBe('dark');
  });

  it('removes storage key when setting mode back to system', () => {
    const service = createService();
    service.setMode('dark');
    expect(localStorage.getItem('unibooks_theme')).toBe('dark');

    service.setMode('system');
    expect(service.mode()).toBe('system');
    expect(localStorage.getItem('unibooks_theme')).toBeNull();
  });

  it('updates resolved live when the OS theme changes in system mode', () => {
    currentMatches = false;
    const service = createService();

    expect(service.mode()).toBe('system');
    expect(service.resolved()).toBe('light');

    // Simulate OS switching to dark mode
    for (const listener of listeners) {
      listener({ matches: true } as MediaQueryListEvent);
    }
    expect(service.resolved()).toBe('dark');

    // Simulate OS switching back to light mode
    for (const listener of listeners) {
      listener({ matches: false } as MediaQueryListEvent);
    }
    expect(service.resolved()).toBe('light');
  });

  it('ignores live OS theme changes when explicit light or dark mode is active', () => {
    currentMatches = false;
    const service = createService();
    service.setMode('light');

    expect(service.resolved()).toBe('light');

    // Simulate OS switching to dark mode
    for (const listener of listeners) {
      listener({ matches: true } as MediaQueryListEvent);
    }
    // Should still resolve to light because mode is explicitly light
    expect(service.resolved()).toBe('light');
  });

  it('handles environment gracefully when matchMedia is unavailable', () => {
    const origMatchMedia = window.matchMedia;
    (window as any).matchMedia = undefined;

    try {
      const service = createService();
      expect(service.resolved()).toBe('light');
    } finally {
      window.matchMedia = origMatchMedia;
    }
  });
});
