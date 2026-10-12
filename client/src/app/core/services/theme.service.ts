import { Injectable, computed, effect, signal } from '@angular/core';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'unibooks_theme';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  mode = signal<ThemeMode>(this.readStored());
  private systemDark = signal<boolean>(this.getSystemDarkPreference());

  readonly resolved = computed<'light' | 'dark'>(() => {
    const currentMode = this.mode();
    if (currentMode === 'light') return 'light';
    if (currentMode === 'dark') return 'dark';
    return this.systemDark() ? 'dark' : 'light';
  });

  constructor() {
    effect(() => this.apply(this.mode()));
    effect(() => this.applyFavicon(this.resolved()));
    this.listenToSystemTheme();
  }

  setMode(mode: ThemeMode) {
    this.mode.set(mode);
    if (typeof localStorage !== 'undefined') {
      try {
        if (mode === 'system') localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, mode);
      } catch {
        // Storage may be unavailable (private browsing, disabled cookies) —
        // the in-memory signal still drives the current tab correctly.
      }
    }
  }

  private readStored(): ThemeMode {
    if (typeof localStorage === 'undefined') return 'system';
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  }

  private apply(mode: ThemeMode) {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
  }

  // Swaps the tab icon by href rather than a prefers-color-scheme query inside
  // the SVG: Chrome rasterizes a favicon once and never re-evaluates that
  // query, but it does reload the icon when the link's href changes. This also
  // lets the icon follow an explicit site theme, not just the OS one.
  private applyFavicon(theme: 'light' | 'dark') {
    if (typeof document === 'undefined') return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
    if (!link) return;
    const href = theme === 'dark' ? '/icons/favicon-dark.svg' : '/icons/favicon.svg';
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }

  private getSystemDarkPreference(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined') {
      return false;
    }
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  }

  private listenToSystemTheme() {
    if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined') {
      return;
    }
    try {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const update = (e: MediaQueryListEvent | MediaQueryList) => {
        this.systemDark.set(e.matches);
      };
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', update);
      } else if (typeof (mediaQuery as any).addListener === 'function') {
        (mediaQuery as any).addListener(update);
      }
    } catch {
      // matchMedia may not be available or throw in certain test environments
    }
  }
}
