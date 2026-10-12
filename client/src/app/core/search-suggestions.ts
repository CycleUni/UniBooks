import { Injectable, signal } from '@angular/core';

/**
 * Suggested searches, as i18n keys: the home hero's "popular searches" and
 * the search screen before anything has been typed.
 */
export const POPULAR_SEARCH_KEYS = ['home.tagCalculus', 'home.tagEconomics', 'home.tagAnatomy'] as const;

const STORAGE_KEY = 'unibooks.search.recent';
const MAX_RECENT = 5;

/**
 * The visitor's own recent searches, newest first, kept in this browser only.
 * Recorded by the search page whenever it runs a query, whichever way it was
 * started (typed, the home hero, a suggestion, a barcode scan).
 */
@Injectable({ providedIn: 'root' })
export class RecentSearches {
  readonly items = signal<readonly string[]>(this.read());

  add(query: string): void {
    const q = query.trim();
    if (!q) return;
    const lower = q.toLowerCase();
    this.write([q, ...this.items().filter(item => item.toLowerCase() !== lower)].slice(0, MAX_RECENT));
  }

  remove(query: string): void {
    this.write(this.items().filter(item => item !== query));
  }

  clear(): void {
    this.write([]);
  }

  private read(): string[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string').slice(0, MAX_RECENT) : [];
    } catch {
      return [];
    }
  }

  private write(items: string[]): void {
    this.items.set(items);
    try {
      if (items.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage unavailable (private mode): the list still works for this visit.
    }
  }
}
